/**
 * Pure form logic for the Qoder configuration card.
 *
 * Kept out of the browser half so the same rules can be exercised in Node: the
 * card only wires these results into React state, and a smoke test drives them
 * directly.
 */

/** Upper bound on the per-request output cap, from the upstream ceiling. */
export const MAX_OUTPUT_TOKENS_LIMIT = 131_072;

/** How the context window is chosen, mirroring the pi plugin's `context <default|max|tokens>`. */
export type WindowMode = "catalog" | "max" | "custom";

/** One path-addressed edit to the plugin's Config section. */
export type SettingsPathOp =
  | { op: "set"; path: readonly string[]; value: unknown }
  | { op: "unset"; path: readonly string[] };

/** The Config fields this card edits, as the Host resolves them. */
export interface QoderConfigValues {
  contextWindow?: number;
  useMaxContext?: boolean;
  maxOutputTokens?: number;
  replayReasoning?: "none" | "last" | "all";
  streamIdleTimeoutMs?: number;
  streamDeltaIntervalMs?: number;
  debug?: boolean;
}

/** Credential references the card writes, one per region, in lookup order. */
export const TOKEN_REFS: ReadonlyArray<{ mode: "global" | "cn"; label: string; ref: string; gateway: string }> = [
  { mode: "global", label: "Qoder", ref: "QODER_API_KEY", gateway: "https://api3.qoder.sh/" },
  { mode: "cn", label: "Qoder CN", ref: "QODER_CN_API_KEY", gateway: "https://gateway.qoder.com.cn/" },
];

/** The Config key naming one region's profile, as `registerConfigurableProviders` addresses it. */
export function providerKeyOf(mode: "global" | "cn"): string {
  return mode === "cn" ? "qoder-cn" : "qoder";
}

/** Read the Config values out of a resolved section. */
export function valuesOf(value: unknown): QoderConfigValues {
  return value !== undefined && typeof value === "object" && value !== null ? (value as QoderConfigValues) : {};
}

/** The window mode the stored values describe. */
export function windowModeOf(settings: QoderConfigValues): WindowMode {
  if (settings.contextWindow !== undefined) return "custom";
  return settings.useMaxContext === true ? "max" : "catalog";
}

/**
 * Parse one numeric field.
 * @param text - the raw input.
 * @param min - smallest accepted value; 0 for the one knob where zero means something.
 * @returns the parsed integer, or undefined when the field is blank or invalid.
 */
export function numberAt(text: string, min = 1): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= min ? value : undefined;
}

/** Everything one submission carries. */
export interface CardDraft {
  mode: WindowMode;
  windowText: string;
  outputText: string;
  idleText: string;
  deltaText: string;
  reasoning: "none" | "last" | "all";
  debug: boolean;
}

/**
 * The Config edits for one submission.
 *
 * `catalog` and `max` write the same pair of fields, so switching between them
 * never leaves a stale explicit window behind. An explicit window is clamped to
 * the largest advertised tier by the Host, not here: the card does not read the
 * catalog.
 * @param draft - the values currently in the form.
 * @returns the operations to submit, or the first problem that blocks the write.
 */
export function draftOps(draft: CardDraft): { ops: SettingsPathOp[] } | { problem: string } {
  const ops: SettingsPathOp[] = [];
  if (draft.mode === "catalog") {
    ops.push({ op: "unset", path: ["contextWindow"] }, { op: "set", path: ["useMaxContext"], value: false });
  } else if (draft.mode === "max") {
    ops.push({ op: "unset", path: ["contextWindow"] }, { op: "set", path: ["useMaxContext"], value: true });
  } else {
    const window = numberAt(draft.windowText);
    if (window === undefined) return { problem: "自定义上下文窗口需要一个大于 0 的整数。" };
    ops.push({ op: "set", path: ["contextWindow"], value: window }, { op: "set", path: ["useMaxContext"], value: false });
  }

  const output = numberAt(draft.outputText);
  if (draft.outputText.trim() !== "" && output === undefined) return { problem: "输出上限需要一个大于 0 的整数。" };
  if (output !== undefined && output > MAX_OUTPUT_TOKENS_LIMIT) {
    return { problem: `输出上限不能超过 ${MAX_OUTPUT_TOKENS_LIMIT}。` };
  }
  if (output !== undefined) ops.push({ op: "set", path: ["maxOutputTokens"], value: output });

  const idle = numberAt(draft.idleText);
  if (draft.idleText.trim() !== "" && idle === undefined) return { problem: "流空闲超时需要一个大于 0 的整数。" };
  if (idle !== undefined) ops.push({ op: "set", path: ["streamIdleTimeoutMs"], value: idle });

  const delta = numberAt(draft.deltaText, 0);
  if (draft.deltaText.trim() !== "" && delta === undefined) return { problem: "增量合并间隔需要一个不小于 0 的整数。" };
  if (delta !== undefined) ops.push({ op: "set", path: ["streamDeltaIntervalMs"], value: delta });

  ops.push({ op: "set", path: ["replayReasoning"], value: draft.reasoning });
  ops.push({ op: "set", path: ["debug"], value: draft.debug });
  return { ops };
}

/**
 * The profile edits for the tokens this submission stores.
 *
 * `listModels()` answers from the token, but the Models page and
 * `hasProviderApiKey` address a route through its profile entry, so a token
 * typed here also records the profile. One region's entry is only written once.
 * @param tokens - the tokens being stored, keyed by region.
 * @param providers - the profiles the Config already holds.
 * @returns the operations that are still needed.
 */
export function profileOps(
  tokens: ReadonlyArray<{ mode: "global" | "cn"; ref: string }>,
  providers: unknown,
): SettingsPathOp[] {
  const existing = providers !== null && typeof providers === "object" ? (providers as Record<string, unknown>) : {};
  return tokens.flatMap((token) => (existing[providerKeyOf(token.mode)] === undefined
    ? [{ op: "set" as const, path: ["providers", providerKeyOf(token.mode)], value: { apiKeyEnv: token.ref } }]
    : []));
}

/** The tokens a submission actually stores; a blank field leaves the stored one alone. */
export function tokenDrafts(drafts: Readonly<Record<string, string>>): ReadonlyArray<{ mode: "global" | "cn"; ref: string; value: string }> {
  return TOKEN_REFS.flatMap((entry) => {
    const value = drafts[entry.ref]?.trim();
    return value ? [{ mode: entry.mode, ref: entry.ref, value }] : [];
  });
}
