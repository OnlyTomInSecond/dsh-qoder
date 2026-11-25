/**
 * Account-period quota for the Qoder card.
 *
 * The user quota, add-on credits, and org resource package are account-wide
 * figures, not this session's spend: request-level Credits already ride on each
 * assistant message. They come from one GET per account, so this module caches
 * per region and shares an in-flight read, exactly like the pi provider's
 * quota service but without its footer/command surface.
 *
 * Read-only: nothing here writes credentials or files.
 */
import { debugLog } from "./debug.js";
import { fetchQoderJson } from "./http.js";
import type { QoderQuotaBucket, QoderQuotaSnapshot, QoderQuotaView } from "./quota-shared.js";
import { getQoderUsageURL, type QoderMode } from "./region.js";

/** How long one account's quota figure is reused before another read. */
export const QODER_QUOTA_TTL_MS = 30_000;

interface Entry {
  access: string;
  view: QoderQuotaView;
  checkedAt?: number;
  pending?: Promise<QoderQuotaView>;
  controller?: AbortController;
}

const UNAVAILABLE = "Qoder quota unavailable";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function quotaNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeBucket(value: unknown, totalKey: "total" | "cap" = "total"): QoderQuotaBucket | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const total = quotaNumber(raw[totalKey]);
  const used = quotaNumber(raw.used);
  const remaining = quotaNumber(raw.remaining);
  if (total === undefined && used === undefined && remaining === undefined) return undefined;
  const unit = typeof raw.unit === "string" && raw.unit.trim() ? raw.unit.trim() : undefined;
  return { total, used, remaining, unit };
}

/**
 * Normalize one `/api/v2/quota/usage` answer.
 *
 * Missing values stay missing: no unit is guessed and no bucket is derived from
 * another, because a wrong number here is a wrong credit balance. `expiresAt` is
 * Unix milliseconds as Qoder supplies it; anything outside the Date range is
 * dropped so display formatting cannot throw.
 * @param value - the parsed response body.
 * @returns the snapshot, or undefined when the body carries no bucket at all.
 */
export function normalizeQoderQuotaSnapshot(value: unknown): QoderQuotaSnapshot | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const userQuota = normalizeBucket(raw.userQuota);
  const addOnQuota = normalizeBucket(raw.addOnQuota);
  const orgRaw = asRecord(raw.orgResourcePackage);
  const orgResourcePackage = normalizeBucket(orgRaw, orgRaw && "cap" in orgRaw ? "cap" : "total");
  if (!userQuota && !addOnQuota && !orgResourcePackage) return undefined;
  const expiration = quotaNumber(raw.expiresAt);
  const expiresAt = expiration !== undefined && expiration <= 8.64e15 ? expiration : undefined;
  return { userQuota, ...(addOnQuota ? { addOnQuota } : {}), orgResourcePackage, expiresAt };
}

/** Fetch one account's quota over the region's usage endpoint. */
async function fetchQuota(access: string, mode: QoderMode, signal: AbortSignal): Promise<QoderQuotaSnapshot> {
  const raw = await fetchQoderJson<unknown>(
    getQoderUsageURL(mode),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access}`, Accept: "application/json" },
    },
    { signal },
  );
  const snapshot = normalizeQoderQuotaSnapshot(raw);
  if (!snapshot) throw new Error(UNAVAILABLE);
  return snapshot;
}

/**
 * Per-region quota cache.
 *
 * One instance belongs to the Host plugin: the cache is keyed by region and
 * invalidated by the access token that produced it, so switching accounts can
 * never show the previous account's credits.
 */
export class QoderQuotaService {
  private readonly entries = new Map<QoderMode, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  /** @param options - clock and TTL seams for tests; production uses the wall clock. */
  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? QODER_QUOTA_TTL_MS;
  }

  /** Forget every cached figure (the plugin's own credentials changed). */
  clear(mode?: QoderMode): void {
    if (mode === undefined) {
      for (const entry of this.entries.values()) entry.controller?.abort();
      this.entries.clear();
      return;
    }
    this.entries.get(mode)?.controller?.abort();
    this.entries.delete(mode);
  }

  /**
   * Read one account's quota, reusing the cache inside its TTL.
   * @param mode - region whose account is asked for.
   * @param access - the account's access token; a different one invalidates the cache.
   * @param force - fetch even when the cache is still fresh.
   * @returns the current view; never rejects.
   */
  read(mode: QoderMode, access: string, force = false): Promise<QoderQuotaView> {
    let entry = this.entries.get(mode);
    if (entry && entry.access !== access) {
      this.clear(mode);
      entry = undefined;
    }
    if (!entry) {
      entry = { access, view: { status: "unavailable" } };
      this.entries.set(mode, entry);
    }
    if (!access) return Promise.resolve({ status: "unavailable", error: UNAVAILABLE });
    if (entry.pending) return entry.pending;
    if (!force && entry.checkedAt !== undefined && this.now() - entry.checkedAt < this.ttlMs) {
      return Promise.resolve(this.project(entry));
    }
    // Keep the previous snapshot (and its timestamp) so a failed refresh can
    // still answer with the last good figure, marked stale. `checkedAt` is
    // cleared because a read in flight is not yet a read.
    entry.view = {
      snapshot: entry.view.snapshot,
      updatedAt: entry.view.updatedAt,
      status: entry.view.snapshot ? "stale" : "unavailable",
    };
    entry.checkedAt = undefined;
    const controller = new AbortController();
    entry.controller = controller;
    entry.pending = this.refresh(entry, mode, access, controller);
    return entry.pending;
  }

  private project(entry: Entry): QoderQuotaView {
    if (entry.view.status === "fresh" && entry.checkedAt !== undefined
      && this.now() - entry.checkedAt >= this.ttlMs) {
      return { ...entry.view, status: "stale" };
    }
    return entry.view;
  }

  private async refresh(
    entry: Entry,
    mode: QoderMode,
    access: string,
    controller: AbortController,
  ): Promise<QoderQuotaView> {
    try {
      const snapshot = await fetchQuota(access, mode, controller.signal);
      // A read that was cleared or replaced must not revive its result.
      if (this.entries.get(mode) !== entry) return entry.view;
      entry.view = { status: "fresh", snapshot, updatedAt: this.now() };
      return entry.view;
    } catch (error) {
      debugLog(`Qoder quota read failed for ${mode}`, error);
      if (this.entries.get(mode) !== entry) return entry.view;
      entry.view = {
        snapshot: entry.view.snapshot,
        updatedAt: entry.view.updatedAt,
        status: entry.view.snapshot ? "stale" : "unavailable",
        error: UNAVAILABLE,
      };
      return entry.view;
    } finally {
      entry.checkedAt = this.now();
      entry.pending = undefined;
      entry.controller = undefined;
    }
  }
}
