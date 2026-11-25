import z from "@deepseek-ai/schemastery";
import { DELTA_FLUSH_INTERVAL_MS } from "./protocol/delta-coalescer.js";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS_LIMIT,
  MAX_STREAM_DELTA_MS,
  MAX_STREAM_TIMEOUT_MS,
} from "./limits.js";
import { readNumericOption } from "./util.js";

// The bounds and defaults live in `limits.ts`; they are re-exported here so the
// Host plugin keeps one import for its schema and its resolution logic.
export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS_LIMIT,
  MAX_STREAM_DELTA_MS,
  MAX_STREAM_TIMEOUT_MS,
};

/**
 * How much prior assistant thinking is replayed into the next request.
 *
 * Every replayed thinking token is billed again on every following round, so
 * `none` (drop it) is the default; `last` keeps only the open tool round and
 * `all` matches qodercli's behavior at the highest cost.
 */
export type ReasoningReplay = "none" | "last" | "all";

/**
 * Cost-relevant plugin options, ported from the pi plugin's `qoder-settings`.
 *
 * pi persists these in `~/.pi/agent/qoder/qoder-settings.json` because it has
 * no generic options page; a harness plugin declares them as volatile Config
 * fields instead, so the generated settings form edits them live and no file of
 * our own is needed. Precedence is **environment variable > Config > default**,
 * so an env var still wins for a one-off invocation.
 */
export interface QoderSettings {
  /** Context window to budget for; `undefined` means "use the catalog's default tier". */
  contextWindow: number | undefined;
  /** Legacy behavior: use the largest tier the catalog advertises. */
  useMaxContext: boolean;
  /** Per-request `max_tokens`. */
  maxOutputTokens: number;
  /** How much prior thinking is sent back with each request. */
  replayReasoning: ReasoningReplay;
  /** Milliseconds without a streamed byte before the request is treated as stalled. */
  streamIdleTimeoutMs: number;
  /** Minimum gap between streamed text/thinking deltas (0 = flush every event). */
  streamDeltaIntervalMs: number;
  /** Verbose diagnostics for best-effort failures. */
  debug: boolean;
}

const REASONING_REPLAY_VALUES: readonly ReasoningReplay[] = ["none", "last", "all"];

/** A Config field: a live volatile reference once parsed, plain in tests. */
type ConfigField<T> = T | { get(): T } | undefined;

/** Config fields this plugin resolves per operation (see {@link resolveQoderSettings}). */
export interface QoderConfigFields {
  contextWindow?: ConfigField<number>;
  useMaxContext?: ConfigField<boolean>;
  maxOutputTokens?: ConfigField<number>;
  replayReasoning?: ConfigField<ReasoningReplay>;
  streamIdleTimeoutMs?: ConfigField<number>;
  streamDeltaIntervalMs?: ConfigField<number>;
  debug?: ConfigField<boolean>;
}

/**
 * Schema of the options, so the settings form renders them and Loader hands
 * `apply` live references. Volatile: an edit applies to the next request
 * without remounting the plugin.
 */
export const qoderSettingsFields = {
  contextWindow: z.number().step(1).min(1).volatile(),
  useMaxContext: z.boolean().default(false).volatile(),
  maxOutputTokens: z
    .number()
    .step(1)
    .min(1)
    .max(MAX_OUTPUT_TOKENS_LIMIT)
    .default(DEFAULT_MAX_OUTPUT_TOKENS)
    .volatile(),
  replayReasoning: z.union(REASONING_REPLAY_VALUES).default("none").volatile(),
  streamIdleTimeoutMs: z
    .number()
    .min(Number.MIN_VALUE)
    .max(MAX_STREAM_TIMEOUT_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    .volatile(),
  streamDeltaIntervalMs: z
    .number()
    .min(0)
    .max(MAX_STREAM_DELTA_MS)
    .default(DELTA_FLUSH_INTERVAL_MS)
    .volatile(),
  debug: z.boolean().default(false).volatile(),
};

/** Read a Config field, whether Loader gave us a reference or a plain value. */
function valueOf<T>(field: ConfigField<T>): T | undefined {
  if (field === undefined) return undefined;
  if (typeof (field as { get?: unknown }).get === "function") return (field as { get(): T }).get();
  return field as T;
}

function truthy(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** `QODER_REPLAY_REASONING`, including the older boolean spellings. */
function replayFromEnv(env: Readonly<Record<string, string | undefined>>): ReasoningReplay | undefined {
  const raw = env.QODER_REPLAY_REASONING?.trim().toLowerCase();
  if (raw === "last") return "last";
  if (raw === "all" || raw === "1" || raw === "true" || raw === "yes") return "all";
  if (raw === "none" || raw === "off" || raw === "0" || raw === "false" || raw === "no") return "none";
  return undefined;
}

/**
 * The options an environment variable overrides, already validated.
 *
 * Split out of {@link resolveQoderSettings} so the configuration page can show
 * which knobs the launching environment has pinned: a value that comes from an
 * env var outranks anything the page writes, so the page must not pretend its
 * own input is in effect.
 *
 * A key is present only when the variable is set AND valid; the sentinels used
 * for the numeric reads (`0` for "at least 1", `-1` for "at least 0") are
 * filtered out here, so callers never have to know them.
 */
export function qoderSettingsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Partial<QoderSettings> {
  const window = readNumericOption("QODER_CONTEXT_WINDOW", env, 0, (value) => Number.isFinite(value) && value > 0);
  const output = readNumericOption(
    "QODER_MAX_OUTPUT_TOKENS",
    env,
    0,
    (value) => Number.isFinite(value) && value > 0 && value <= MAX_OUTPUT_TOKENS_LIMIT,
  );
  const idle = readNumericOption(
    "QODER_STREAM_IDLE_TIMEOUT_MS",
    env,
    0,
    (value) => Number.isFinite(value) && value > 0 && value <= MAX_STREAM_TIMEOUT_MS,
  );
  const delta = readNumericOption(
    "QODER_STREAM_DELTA_INTERVAL_MS",
    env,
    -1,
    (value) => Number.isFinite(value) && value >= 0 && value <= MAX_STREAM_DELTA_MS,
  );
  // `QODER_DEBUG` keeps its historical "set it to anything non-empty" behavior;
  // the Config flag is an explicit boolean.
  const debug = env.QODER_DEBUG?.trim();
  const replay = replayFromEnv(env);

  return {
    ...(window > 0 ? { contextWindow: Math.round(window) } : {}),
    ...(truthy(env.QODER_CONTEXT_MAX) ? { useMaxContext: true } : {}),
    ...(output > 0 ? { maxOutputTokens: output } : {}),
    ...(replay === undefined ? {} : { replayReasoning: replay }),
    ...(idle > 0 ? { streamIdleTimeoutMs: idle } : {}),
    ...(delta >= 0 ? { streamDeltaIntervalMs: delta } : {}),
    ...(debug !== undefined && debug !== "" && debug.toLowerCase() !== "0" ? { debug: true } : {}),
  };
}

/**
 * Resolve every option for one operation.
 *
 * Called per request (and per model-list read), so it must stay cheap: a few
 * reference reads and environment lookups, no I/O. A missing or invalid value
 * degrades to the default rather than failing the session, which is why the
 * environment half is read through {@link qoderSettingsFromEnv}, whose absent
 * keys simply fall through to the Config field and then the default.
 */
export function resolveQoderSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
  config?: QoderConfigFields,
): QoderSettings {
  const fromEnv = qoderSettingsFromEnv(env);
  return {
    contextWindow: fromEnv.contextWindow ?? valueOf(config?.contextWindow),
    useMaxContext: fromEnv.useMaxContext ?? valueOf(config?.useMaxContext) === true,
    maxOutputTokens: fromEnv.maxOutputTokens ?? valueOf(config?.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS,
    replayReasoning: fromEnv.replayReasoning ?? valueOf(config?.replayReasoning) ?? "none",
    streamIdleTimeoutMs: fromEnv.streamIdleTimeoutMs ?? valueOf(config?.streamIdleTimeoutMs) ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    streamDeltaIntervalMs: fromEnv.streamDeltaIntervalMs ?? valueOf(config?.streamDeltaIntervalMs) ?? DELTA_FLUSH_INTERVAL_MS,
    debug: fromEnv.debug ?? valueOf(config?.debug) === true,
  };
}

/**
 * The live Config fields, remembered once by `apply`.
 *
 * The fields are volatile references whose values change in place, so holding
 * the reference is enough: {@link currentQoderSettings} re-reads it per
 * operation and a settings edit reaches the next request without a remount or a
 * second plumbing path through the protocol layer.
 */
let liveConfig: QoderConfigFields | undefined;

/** Remember the plugin's Config fields for {@link currentQoderSettings}. */
export function bindQoderSettings(config: QoderConfigFields | undefined): void {
  liveConfig = config;
}

/** Resolve the options for one operation against the live Config fields. */
export function currentQoderSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): QoderSettings {
  return resolveQoderSettings(env, liveConfig);
}
