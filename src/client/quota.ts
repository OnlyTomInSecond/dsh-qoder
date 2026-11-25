/**
 * The card's account-quota reader.
 *
 * The figure is account-wide and lives on the Host, so the browser asks a route
 * for it instead of computing anything: `GET qoder/quota` answers one entry per
 * region, and this module keeps the last answer as an observable snapshot the
 * card renders. A refresh is one explicit call; nothing here polls, because a
 * quota number that changes on its own would re-render the whole page.
 *
 * Kept out of `index.ts` for the same reason as `form.ts`: a Node smoke test can
 * drive it with a fake `fetch` without a browser.
 */
import {
  QODER_QUOTA_ROUTE,
  type QoderQuotaPayload,
  type QoderQuotaRegion,
  type QoderQuotaView,
} from "../qoder/quota-shared.js";
import type { QoderMode } from "../qoder/region.js";

/** What the card renders for the quota block. */
export interface QoderQuotaState {
  /**
   * `idle` before the first read, `loading` while one is in flight, `ready`
   * once a balance is shown, `unavailable` when the last read failed, and
   * `unserved` when this card was given no source at all (a deployment whose
   * Host serves no route).
   */
  status: "idle" | "loading" | "ready" | "unavailable" | "unserved";
  /** One entry per region, in the Host's order; empty until the first answer. */
  regions: readonly QoderQuotaRegion[];
  /** Whether a read is in flight, including one started by a save. */
  busy: boolean;
  /** The Host's own refusal text when the route could not be read at all. */
  error?: string;
}

/** The observable face the slot renderer turns into `useQoderQuota`. */
export interface QoderQuotaFace {
  getSnapshot(): QoderQuotaState;
  subscribe(listener: () => void): () => void;
  /** Read the quota again; `force` asks upstream even inside its cache TTL. */
  refresh(force?: boolean): Promise<void>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The regions this package ships, so a missing host answer still renders rows. */
const REGION_ORDER: readonly { mode: QoderMode; label: string }[] = [
  { mode: "global", label: "Qoder" },
  { mode: "cn", label: "Qoder CN" },
];

/** Parse the route's answer, refusing anything that is not the documented shape. */
function parsePayload(value: unknown): QoderQuotaPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid quota answer");
  const regions = (value as { regions?: unknown }).regions;
  if (!Array.isArray(regions)) throw new Error("invalid quota answer");
  return { regions: regions.filter((entry): entry is QoderQuotaRegion => {
    if (entry === null || typeof entry !== "object") return false;
    const mode = (entry as { mode?: unknown }).mode;
    const quota = (entry as { quota?: unknown }).quota;
    return (mode === "global" || mode === "cn") && quota !== null && typeof quota === "object";
  }) };
}

/**
 * One snapshot source over the quota route.
 *
 * Failures never reject: a route this deployment does not serve and a refused
 * request both land in the snapshot, because the card has no other way to say
 * why the number is missing.
 */
export class QoderQuotaCard implements QoderQuotaFace {
  private readonly listeners = new Set<() => void>();
  private state: QoderQuotaState = { status: "idle", regions: [], busy: false };
  private inflight: Promise<void> | undefined;
  private disposed = false;

  /** @param fetcher - HTTP carrier; the browser passes `fetch`, tests a fake. */
  constructor(private readonly fetcher: Fetch = (input, init) => fetch(input, init)) {}

  getSnapshot(): QoderQuotaState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /**
   * Read every region's quota once.
   * @param force - ask the Host for a fresh upstream read; ignored while a read is in flight.
   * @returns settlement after the snapshot published the outcome.
   */
  refresh(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const url = force ? `${QODER_QUOTA_ROUTE}?refresh=1` : QODER_QUOTA_ROUTE;
    this.publish({ ...this.state, busy: true, error: undefined, status: this.state.status === "idle" ? "loading" : this.state.status });
    this.inflight = this.read(url).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async read(url: string): Promise<void> {
    try {
      const response = await this.fetcher(url, { headers: { accept: "application/json" } });
      // A deployment whose Host registers no route answers 404, and that is a
      // different fact from a refused read: this card can never show a balance
      // here, so the block says that instead of offering a retry that cannot
      // succeed.
      if (response.status === 404) {
        if (this.disposed) return;
        this.publish({ status: "unserved", regions: [], busy: false });
        return;
      }
      if (!response.ok) throw new Error(`quota read failed: HTTP ${String(response.status)}`);
      const payload = parsePayload(await response.json());
      if (this.disposed) return;
      this.publish({
        status: payload.regions.length === 0 ? "unavailable" : "ready",
        regions: payload.regions,
        busy: false,
      });
    } catch (error) {
      if (this.disposed) return;
      // Keep the rows already on screen: a failed refresh must not erase a
      // figure the person is reading, and the Host's own snapshot already says
      // whether it is stale.
      this.publish({
        ...this.state,
        status: this.state.regions.length === 0 ? "unavailable" : this.state.status,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private publish(next: QoderQuotaState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** One row the card renders: a region, its account label, and its figure. */
export interface QoderQuotaRow {
  mode: QoderMode;
  label: string;
  configured: boolean;
  view: QoderQuotaView;
}

/**
 * The rows to render, including regions the Host did not answer for.
 * @param state - the latest quota snapshot.
 * @returns one row per region in a stable order.
 */
export function quotaRows(state: QoderQuotaState): readonly QoderQuotaRow[] {
  const answered = new Map(state.regions.map((region) => [region.mode, region]));
  return REGION_ORDER.map(({ mode, label }) => {
    const region = answered.get(mode);
    return {
      mode,
      label,
      configured: region?.configured === true,
      view: region?.quota ?? { status: "unavailable" },
    };
  });
}

/**
 * Format one credit figure for display.
 *
 * Credits are small (a fraction per request) and totals are large, so the same
 * formatter serves both: two decimals below a unit, none above, never scientific.
 * @param value - the amount, or undefined when Qoder omitted it.
 * @returns the formatted amount, or `?` for a missing one.
 */
export function formatCredit(value: number | undefined): string {
  if (value === undefined) return "?";
  if (value > 0 && value < 0.01) return "<0.01";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}
