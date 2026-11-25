/**
 * Pure state, validation, and write planning for the Qoder configuration card,
 * plus the controller that connects them to DSH.
 *
 * Kept out of `index.ts` so a Node smoke test can drive the exact rules and the
 * exact save sequence the browser runs: the card only renders the controller's
 * snapshot and forwards edits to it.
 *
 * Two independent stores carry a save:
 *
 *   the plugin's Config section (`ctx.configForms`)  the window mode, output
 *       cap, replay policy, stream timeouts, and `debug`
 *   `ctx.remote.credentials`                         the token values
 *       themselves, under `QODER_API_KEY` / `QODER_CN_API_KEY`
 *
 * The Config fields are declared `.volatile()` by the Host plugin, so writing
 * one applies to the next request without a remount — and only volatile paths
 * are writable at all, which is why every edit is a path op.
 */
import {
  MAX_OUTPUT_TOKENS_LIMIT,
  MAX_STREAM_DELTA_MS,
  MAX_STREAM_TIMEOUT_MS,
} from "../qoder/limits.js";
import type { QoderLocaleKey } from "./locales.js";

/** Upper bound on the per-request output cap, re-exported for the card's own bound checks. */
export { MAX_OUTPUT_TOKENS_LIMIT };

/** How the context window is chosen, mirroring the pi plugin's `/qoder-settings context <default|max|tokens>`. */
export type WindowMode = "catalog" | "max" | "custom";

/** How much prior assistant thinking is replayed, mirroring `ReasoningReplay` in `qoder/settings.ts`. */
export type ReasoningReplay = "none" | "last" | "all";

/** One path-addressed edit to the plugin's Config section. */
export type SettingsPathOp =
  | { op: "set"; path: readonly string[]; value: unknown }
  | { op: "unset"; path: readonly string[] };

/** The Config fields this card edits, as the Host projects them. */
export interface QoderConfigValues {
  contextWindow?: number;
  useMaxContext?: boolean;
  maxOutputTokens?: number;
  replayReasoning?: ReasoningReplay;
  streamIdleTimeoutMs?: number;
  streamDeltaIntervalMs?: number;
  debug?: boolean;
}

/** One region's token reference. */
export interface TokenRef {
  mode: "global" | "cn";
  label: string;
  /** Credential reference the card writes. */
  ref: string;
  /** Every reference the Host resolves for this region, in lookup order; the first is the one the card writes. */
  aliases: readonly string[];
  gateway: string;
  /** Where the person creates a personal access token. */
  patUrl: string;
}

/** Credential references the card writes, one per region, in lookup order. */
export const TOKEN_REFS: readonly TokenRef[] = [
  {
    mode: "global",
    label: "Qoder",
    ref: "QODER_API_KEY",
    aliases: ["QODER_ACCESS_TOKEN", "QODER_API_KEY", "QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"],
    gateway: "https://api3.qoder.sh/",
    patUrl: "https://qoder.com/account/integrations",
  },
  {
    mode: "cn",
    label: "Qoder CN",
    ref: "QODER_CN_API_KEY",
    aliases: ["QODERCN_ACCESS_TOKEN", "QODER_CN_API_KEY", "QODERCN_API_KEY", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_PAT"],
    gateway: "https://gateway.qoder.com.cn/",
    patUrl: "https://qoder.com.cn/account/integrations",
  },
];

/**
 * The numeric knobs, in the order the card shows them. Labels and hints live in
 * the locale dictionary, keyed by `key`; only the bounds belong here, because
 * they are the Host schema's own bounds.
 */
export const NUMBER_FIELDS = [
  { key: "output", field: "maxOutputTokens", min: 1, max: MAX_OUTPUT_TOKENS_LIMIT },
  { key: "idle", field: "streamIdleTimeoutMs", min: 1, max: MAX_STREAM_TIMEOUT_MS },
  { key: "delta", field: "streamDeltaIntervalMs", min: 0, max: MAX_STREAM_DELTA_MS },
] as const;

/** Keys of {@link NUMBER_FIELDS}. */
export type NumberFieldKey = (typeof NUMBER_FIELDS)[number]["key"];

/** One credential row's state, as the card renders it. */
export interface TokenState {
  /** Whether the Host resolves any of this region's references. */
  configured: boolean;
  /** Reference that currently supplies the value, when the Host reports one. */
  source?: string;
  /** Whether the credential provider accepts a write. */
  writable: boolean;
  /** Provider-generated preview; never the full value. */
  masked?: string;
}

/** Everything the card renders. One immutable snapshot per change. */
export interface QoderCardState {
  /** `loading` until the Host projects the Config section, `unavailable` when it does not serve it at all. */
  status: "loading" | "ready" | "unavailable";
  /** Whether the Host accepts Config writes. */
  writable: boolean;
  /** Per-reference credential state, keyed by `ref`. */
  tokens: Readonly<Record<string, TokenState>>;
  /** Staged token inputs, keyed by `ref`; a blank value leaves the stored token alone. */
  drafts: Readonly<Record<string, string>>;
  /** Whether the first credential read has settled. */
  tokensLoaded: boolean;
  /** Whether the card may be edited: served, writable, and not mid-save. */
  editable: boolean;
  mode: WindowMode;
  /** Numeric field drafts, keyed by {@link NumberFieldKey}; `window` is the custom context window. */
  window: string;
  fields: Readonly<Record<NumberFieldKey, string>>;
  reasoning: ReasoningReplay;
  debug: boolean;
  busy: boolean;
  /** Set by the last successful save. */
  saved: boolean;
  /**
   * The first thing blocking a save. A `problem` is a rule the card itself
   * checks and the view translates; a `message` is the Host's own text (a
   * refused credential write, a transport failure), shown verbatim.
   */
  failure: { kind: "problem"; problem: CardProblem } | { kind: "message"; message: string } | undefined;
  /** Whether any region allows a credential write. */
  tokensWritable: boolean;
}

/** Read the Config values out of a projected section. */
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
 * @returns the parsed integer, or undefined when the field is blank or not a non-negative integer.
 */
export function numberAt(text: string, min = 1): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= min ? value : undefined;
}

/**
 * Everything one submission carries: the editable slice of the card's own
 * snapshot. Derived from {@link QoderCardState} rather than restated, because a
 * duplicated shape is how the window field once drifted from `window` to
 * `windowText` and made every mode change throw.
 */
export type CardDraft = Pick<QoderCardState, "mode" | "window" | "fields" | "reasoning" | "debug">;

/** Format a stored numeric value for its input; an absent one renders empty so the placeholder shows. */
function textOf(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * A validation failure, described rather than rendered: the card translates it
 * with the active locale, so the same rules serve every interface language.
 */
export type CardProblem =
  | { kind: "notInteger"; field: QoderLocaleKey; min: number }
  | { kind: "overMax"; field: QoderLocaleKey; max: number }
  /** The Host refused the Config write, typically on a stale revision. */
  | { kind: "conflict" }
  /** This deployment serves no writable Config section, so a knob edit cannot land. */
  | { kind: "notServed" };

/** The locale key naming one numeric field in a message. */
const FIELD_KEY: Record<NumberFieldKey, QoderLocaleKey> = {
  output: "field.output",
  idle: "field.idle",
  delta: "field.delta",
};

/**
 * The Config edits for one submission.
 *
 * Only fields that actually changed are written: a save that merely stores a
 * token must not pin every other knob to the value it already inherited, which
 * would turn the composition default into an explicit user override. `catalog`
 * and `max` write the same pair of fields, so switching between them never
 * leaves a stale explicit window behind; an explicit window is clamped to the
 * largest advertised tier by the Host, not here, because the card does not read
 * the catalog.
 * @param draft - the values currently in the form.
 * @param current - the values the Host resolved for the same fields.
 * @returns the operations to submit, or the first problem that blocks the write.
 */
export function draftOps(
  draft: CardDraft,
  current: QoderConfigValues = {},
): { ops: SettingsPathOp[] } | { problem: CardProblem } {
  const ops: SettingsPathOp[] = [];
  const mode = windowModeOf(current);
  if (mode !== draft.mode || draft.mode === "custom") {
    const window = numberAt(draft.window);
    // A custom window is always validated, even when the mode is unchanged:
    // a blank or fractional input must never reach the Host.
    if (draft.mode === "custom" && window === undefined) {
      return { problem: { kind: "notInteger", field: "field.window", min: 1 } };
    }
    if (mode !== draft.mode) {
      if (draft.mode === "custom") {
        ops.push({ op: "set", path: ["contextWindow"], value: window }, { op: "set", path: ["useMaxContext"], value: false });
      } else {
        ops.push(
          { op: "unset", path: ["contextWindow"] },
          { op: "set", path: ["useMaxContext"], value: draft.mode === "max" },
        );
      }
    } else if (window !== current.contextWindow) {
      ops.push({ op: "set", path: ["contextWindow"], value: window });
    }
  }

  for (const spec of NUMBER_FIELDS) {
    const text = draft.fields[spec.key] ?? "";
    if (text.trim() === "") continue;
    const value = numberAt(text, spec.min);
    if (value === undefined) return { problem: { kind: "notInteger", field: FIELD_KEY[spec.key], min: spec.min } };
    if (value > spec.max) return { problem: { kind: "overMax", field: FIELD_KEY[spec.key], max: spec.max } };
    if (value === current[spec.field]) continue;
    ops.push({ op: "set", path: [spec.field], value });
  }

  if (draft.reasoning !== (current.replayReasoning ?? "none")) {
    ops.push({ op: "set", path: ["replayReasoning"], value: draft.reasoning });
  }
  if (draft.debug !== (current.debug === true)) ops.push({ op: "set", path: ["debug"], value: draft.debug });
  return { ops };
}

/** The tokens a submission actually stores; a blank field leaves the stored one alone. */
export function tokenDrafts(
  drafts: Readonly<Record<string, string>>,
): ReadonlyArray<{ ref: string; value: string }> {
  return TOKEN_REFS.flatMap((entry) => {
    const value = drafts[entry.ref]?.trim();
    return value ? [{ ref: entry.ref, value }] : [];
  });
}

/* ------------------------------------------------------------------ *
 * Controller
 * ------------------------------------------------------------------ */

/** The Config form the Host projects for one entry (`ctx.configForms.get`). */
export interface CardForm {
  getSnapshot(): {
    status: "loading" | "ready" | "unavailable";
    value: unknown;
    revision: number | undefined;
    writable: boolean;
  };
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>;
}

/** The `credentials` Remote namespace, reduced to the two calls the card makes. */
export interface CardCredentials {
  describe(refs: string[]): Promise<Record<string, TokenState>>;
  set(ref: string, value: string): Promise<unknown>;
}

/** What the controller needs from the browser plugin context. */
export interface CardOptions {
  /** The Config form of this bundle's entry. */
  form: CardForm;
  credentials: CardCredentials;
}

/** One immutable snapshot source, as the slot renderer's `use<Name>` hook expects. */
export interface CardObservable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** The edit actions the controller offers; the observable face wraps these. */
export interface QoderCardActions {
  /** Stage one token value; a blank value leaves the stored one alone. */
  editToken(ref: string, value: string): void;
  setMode(mode: WindowMode): void;
  editWindow(text: string): void;
  editNumber(key: NumberFieldKey, text: string): void;
  setReasoning(value: ReasoningReplay): void;
  setDebug(value: boolean): void;
  /** Submit the staged edits; resolves after the Host answered. */
  save(): Promise<void>;
}

/** The controller face the card's slot registration injects. */
export interface QoderCardFace extends QoderCardActions {
  hooks: { qoderCard: CardObservable<QoderCardState> };
}

/**
 * Bridges the Config form, the credential Remote, and one staged draft onto a
 * single snapshot the card renders.
 *
 * A save writes credentials BEFORE the Config section, so a token that fails to
 * store never leaves knob edits applied for a region that still has no token.
 *
 * Every failure lands in the snapshot rather than rejecting: the card triggers
 * a save with `void save()`, so a rejected promise would leave the button
 * silently inert with no way to tell what happened.
 */
export class QoderCardController implements QoderCardActions {
  private readonly listeners = new Set<() => void>();
  private readonly drafts = new Map<string, string>();
  private readonly numbers = new Map<NumberFieldKey, string>();
  private modeEdit: WindowMode | undefined;
  private windowEdit: string | undefined;
  private reasoningEdit: ReasoningReplay | undefined;
  private debugEdit: boolean | undefined;
  private tokens: Record<string, TokenState> = {};
  private tokensLoaded = false;
  private busy = false;
  private saved = false;
  private failure: QoderCardState["failure"];
  private state: QoderCardState;
  private readonly unsubscribe: () => void;
  private disposed = false;

  /** @param options - the Config form and the credential Remote this card writes through. */
  constructor(private readonly options: CardOptions) {
    this.state = this.project();
    this.unsubscribe = options.form.subscribe(() => { this.derive(); });
    void this.refreshTokens();
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the snapshot the renderer binds as `useQoderCard`, and the card's edit actions.
   */
  face(): QoderCardFace {
    return {
      hooks: { qoderCard: { getSnapshot: () => this.state, subscribe: (listener) => this.subscribe(listener) } },
      editToken: (ref, value) => { this.editToken(ref, value); },
      setMode: (mode) => { this.setMode(mode); },
      editWindow: (text) => { this.editWindow(text); },
      editNumber: (key, text) => { this.editNumber(key, text); },
      setReasoning: (value) => { this.setReasoning(value); },
      setDebug: (value) => { this.setDebug(value); },
      save: () => this.save(),
    };
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Stop following the form and the credential Remote. */
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.listeners.clear();
  }

  editToken(ref: string, value: string): void {
    this.drafts.set(ref, value);
    this.saved = false;
    this.derive();
  }

  setMode(mode: WindowMode): void {
    this.modeEdit = mode;
    this.saved = false;
    this.derive();
  }

  editWindow(text: string): void {
    this.windowEdit = text;
    this.saved = false;
    this.derive();
  }

  editNumber(key: NumberFieldKey, text: string): void {
    this.numbers.set(key, text);
    this.saved = false;
    this.derive();
  }

  setReasoning(value: ReasoningReplay): void {
    this.reasoningEdit = value;
    this.saved = false;
    this.derive();
  }

  setDebug(value: boolean): void {
    this.debugEdit = value;
    this.saved = false;
    this.derive();
  }

  /** @returns the snapshot the card renders. */
  getSnapshot(): QoderCardState {
    return this.state;
  }

  /**
   * Validate and submit the staged draft.
   * @returns settlement after every write the Host answered.
   */
  async save(): Promise<void> {
    if (this.disposed || this.busy) return;
    const snapshot = this.options.form.getSnapshot();
    const current = valuesOf(snapshot.value);
    const stored = tokenDrafts(Object.fromEntries(this.drafts));
    // A deployment that does not serve the Config section (or a read-only
    // document) still owns a credential store, so tokens are saved there while
    // the section stays untouched.
    const configurable = snapshot.status === "ready" && snapshot.writable;
    this.saved = false;
    this.failure = undefined;
    // Planning runs before any write, so a refused knob cannot leave half a
    // save behind: the token stored and the Config section untouched. It is
    // planned against the resolved values even when the section is unreadable,
    // so an edit the card could never write is reported rather than dropped.
    let plan: { ops: SettingsPathOp[] } | { problem: CardProblem };
    try {
      plan = draftOps(this.state, current);
    } catch (error) {
      // Planning is pure, so a throw is a defect, not bad input. Reporting it
      // keeps the card diagnosable instead of silently doing nothing.
      this.failure = { kind: "message", message: error instanceof Error ? error.message : String(error) };
      this.derive();
      return;
    }
    if ("problem" in plan) {
      this.failure = { kind: "problem", problem: plan.problem };
      this.derive();
      return;
    }
    // An edit this deployment cannot accept must not answer "saved": the card
    // would claim a change that never reached the Host.
    const stranded = !configurable && plan.ops.length > 0;
    const ops = configurable ? plan.ops : [];
    if (stored.length === 0 && ops.length === 0) {
      // Nothing to write: report success so the card settles instead of
      // leaving a save button that would only repeat the no-op.
      this.clearDrafts();
      this.saved = !stranded;
      if (stranded) this.failure = { kind: "problem", problem: { kind: "notServed" } };
      this.derive();
      return;
    }
    this.busy = true;
    this.derive();
    try {
      // Credentials first: the token is what makes the model list non-empty, so
      // it must land before the Config write that changes knobs for it.
      for (const token of stored) await this.options.credentials.set(token.ref, token.value);
      if (ops.length > 0) {
        const accepted = await this.options.form.mutate(ops);
        if (!accepted) {
          this.failure = { kind: "problem", problem: { kind: "conflict" } };
          this.clearDrafts();
          if (stored.length > 0) await this.refreshTokens();
          return;
        }
      }
      this.clearDrafts();
      this.saved = !stranded;
      if (stranded) this.failure = { kind: "problem", problem: { kind: "notServed" } };
      if (stored.length > 0) await this.refreshTokens();
    } catch (error) {
      this.failure = { kind: "message", message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.busy = false;
      this.derive();
    }
  }

  /** Re-read whether each region has a token, and under which reference. */
  private async refreshTokens(): Promise<void> {
    const refs = TOKEN_REFS.flatMap((entry) => entry.aliases);
    try {
      const described = await this.options.credentials.describe(refs);
      if (this.disposed) return;
      const next: Record<string, TokenState> = {};
      for (const entry of TOKEN_REFS) {
        const sources = entry.aliases.flatMap((alias) => (described[alias] === undefined ? [] : [[alias, described[alias]] as const]));
        const configured = sources.find(([, info]) => info.configured === true);
        const writable = sources.every(([, info]) => info.writable !== false);
        next[entry.ref] = {
          configured: configured !== undefined,
          writable,
          ...(configured?.[1].masked === undefined ? {} : { masked: configured[1].masked }),
          ...(configured === undefined ? {} : { source: configured[0] }),
        };
      }
      this.tokens = next;
    } catch {
      if (this.disposed) return;
      // An unreadable credential seam is not a configured one; every input stays
      // usable and the Host is what refuses a write.
      this.tokens = Object.fromEntries(TOKEN_REFS.map((entry) => [
        entry.ref, { configured: false, writable: true },
      ]));
    }
    this.tokensLoaded = true;
    this.derive();
  }

  private clearDrafts(): void {
    this.drafts.clear();
    this.numbers.clear();
    this.modeEdit = undefined;
    this.windowEdit = undefined;
    this.reasoningEdit = undefined;
    this.debugEdit = undefined;
  }

  private derive(): void {
    if (this.disposed) return;
    this.state = this.project();
    for (const listener of [...this.listeners]) listener();
  }

  private project(): QoderCardState {
    const snapshot = this.options.form.getSnapshot();
    const values = valuesOf(snapshot.value);
    const editable = snapshot.status === "ready" && snapshot.writable;
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      tokens: this.tokens,
      drafts: Object.fromEntries(this.drafts),
      tokensLoaded: this.tokensLoaded,
      editable: editable && !this.busy,
      mode: this.modeEdit ?? windowModeOf(values),
      window: this.windowEdit ?? textOf(values.contextWindow),
      fields: {
        output: this.numbers.get("output") ?? textOf(values.maxOutputTokens),
        idle: this.numbers.get("idle") ?? textOf(values.streamIdleTimeoutMs),
        delta: this.numbers.get("delta") ?? textOf(values.streamDeltaIntervalMs),
      },
      reasoning: this.reasoningEdit ?? values.replayReasoning ?? "none",
      debug: this.debugEdit ?? values.debug === true,
      busy: this.busy,
      saved: this.saved,
      failure: this.failure,
      tokensWritable: Object.values(this.tokens).some((token) => token.writable),
    };
  }
}
