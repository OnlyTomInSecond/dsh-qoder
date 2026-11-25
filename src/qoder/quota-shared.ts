/**
 * Wire types and route names for the account-period quota, shared verbatim by
 * the Host route and the browser card.
 *
 * This module must stay browser-safe: it imports nothing at runtime (the one
 * import is a type), so the card can name the route without pulling the
 * protocol layer — and `node:fs`/`node:crypto` behind it — into the client
 * bundle.
 */
import type { QoderMode } from "./region.js";

/**
 * GET route serving the account-period quota. Absolute for the Host's route
 * table; see {@link QODER_QUOTA_ROUTE} for the document-relative form the
 * browser fetches.
 */
export const QODER_QUOTA_PATH = "/qoder/quota";

/** Document-relative form of {@link QODER_QUOTA_PATH}. */
export const QODER_QUOTA_ROUTE = QODER_QUOTA_PATH.slice(1);

/** One quota bucket as Qoder reports it; missing values stay missing. */
export interface QoderQuotaBucket {
  total?: number;
  used?: number;
  remaining?: number;
  unit?: string;
}

/** The account-period quota of one account. */
export interface QoderQuotaSnapshot {
  userQuota?: QoderQuotaBucket;
  addOnQuota?: QoderQuotaBucket;
  orgResourcePackage?: QoderQuotaBucket;
  /** Account-period expiration, in Unix milliseconds as supplied by Qoder. */
  expiresAt?: number;
}

/**
 * One read of the account quota.
 *
 * `stale` means the last read failed and the snapshot beside it is older than
 * the refresh interval: the card keeps showing it, labelled as cached, rather
 * than blanking a number it already knows.
 */
export interface QoderQuotaView {
  status: "fresh" | "stale" | "unavailable";
  snapshot?: QoderQuotaSnapshot;
  /** Wall-clock time of the successful read that produced `snapshot`. */
  updatedAt?: number;
  error?: string;
}

/** One region's quota, or why it has none. */
export interface QoderQuotaRegion {
  mode: QoderMode;
  configured: boolean;
  quota: QoderQuotaView;
}

/** Answer of the quota route. */
export interface QoderQuotaPayload {
  regions: QoderQuotaRegion[];
}
