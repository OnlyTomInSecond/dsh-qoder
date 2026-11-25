/**
 * Bounds shared by the Host plugin's Config schema and the browser half's
 * configuration card.
 *
 * A separate module because the card is bundled for the browser: importing
 * `settings.ts` would drag schemastery and the protocol layer into the client
 * bundle, and copying the numbers would let the two faces drift, so a value the
 * card accepts could be one the Host refuses.
 */

/**
 * Upstream maximum output length. Aliyun Model Studio (the upstream behind
 * Qoder's CN catalog) documents 131072 for every exposed model in both normal
 * and thinking mode; the Qoder catalog publishes no per-model output cap, so
 * this ceiling bounds the configurable cap.
 */
export const MAX_OUTPUT_TOKENS_LIMIT = 131_072;

/** Upper bound for user-supplied stream timeouts, so a typo cannot hang a session. */
export const MAX_STREAM_TIMEOUT_MS = 3_600_000;

/** Upper bound for the delta flush interval. */
export const MAX_STREAM_DELTA_MS = 60_000;

/** qodercli-compatible per-request output cap; a bigger one only costs more. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/** Default stream idle timeout (also the `QODER_STREAM_IDLE_TIMEOUT_MS` fallback). */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
