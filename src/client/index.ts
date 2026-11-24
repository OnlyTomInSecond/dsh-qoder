/**
 * Browser half: the Qoder configuration card on this bundle's Plugins page.
 *
 * DSH's Models page only renders a credential field for the provider families
 * it ships, so a Qoder profile has nowhere to paste a token there. Rather than
 * ask anyone to patch the Models page, this bundle registers into
 * `plugins.bundle.config` — the slot the Plugins page reserves for a bundle's
 * own configuration — so both the token and the Credit knobs live in one place
 * the plugin owns.
 *
 * Two services carry the writes, both already used by the Models card:
 *
 *   ctx.configForms  the Config fields (context window, output cap, thinking
 *                    replay, stream timeouts, debug) plus the `providers`
 *                    entry a stored token marks as added, written against the
 *                    entry's revision
 *   ctx.remote.credentials  the tokens, under QODER_API_KEY / QODER_CN_API_KEY;
 *                    the page only ever learns whether one is configured
 *
 * Written with `createElement` rather than JSX so the browser half needs no JSX
 * runtime beyond `react`, which the shell's module table already provides.
 */

import {
  MAX_OUTPUT_TOKENS_LIMIT,
  TOKEN_REFS,
  draftOps,
  numberAt,
  profileOps,
  tokenDrafts,
  valuesOf,
  windowModeOf,
  type QoderConfigValues,
  type SettingsPathOp,
  type WindowMode,
} from "./form.js";

/** Settings namespace: the plugin entry id in the profile. */
export const NS = "llm-qoder";

/** The package name this bundle's `plugins.bundle.config` entry is keyed by. */
export const BUNDLE = "@local/dsh-llm-qoder";

/** Services the browser half requires (cordis fiber inject). */
export const inject = ["slots", "configForms", "remote", "remote.credentials"];

/* ------------------------------------------------------------------ *
 * Minimal structural types
 *
 * The shell supplies `react` and the client services through its module
 * table, so these describe only the shapes this file reads. Keeping them
 * local leaves the package with no build-time dependency on DSH internals.
 * ------------------------------------------------------------------ */

type Element = unknown;
type Cleanup = () => void;

interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): Element;
  useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void];
  useEffect(effect: () => void | Cleanup, deps?: readonly unknown[]): void;
}

interface ConfigFormSnapshot {
  status: "loading" | "ready" | "unavailable";
  value: unknown;
  revision: number | undefined;
  writable: boolean;
}

/** The form the Plugins page hands a configuration entry. */
interface ConfigPageForm {
  state: ConfigFormSnapshot;
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>;
}

/** Owner props of a `plugins.bundle.config` entry. */
interface BundleConfigProps {
  view?: "summary" | "page";
  form?: ConfigPageForm;
}

interface CredentialInfo {
  configured: boolean;
  writable: boolean;
  masked?: string;
}

interface CredentialsRemote {
  describe(refs: string[]): Promise<Record<string, CredentialInfo>>;
  set(ref: string, value: string): Promise<unknown>;
}

interface SlotsService {
  inject(name: string, register: () => Cleanup): Cleanup;
  register(options: Record<string, unknown>, component: unknown): Cleanup;
}

interface ConfigFormsService {
  whileServed(namespaces: readonly string[], register: () => Cleanup): Cleanup;
}

interface ClientContext {
  slots: SlotsService;
  configForms: ConfigFormsService;
  remote: { credentials: CredentialsRemote };
  effect(callback: () => unknown, label?: string): unknown;
}

/** The `react` module the shell's module table provides. */
declare const require: (specifier: string) => unknown;

const React = (require as (s: string) => ReactLike)("react");

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

const styles = {
  card: { display: "flex", flexDirection: "column", gap: "18px" },
  section: { display: "flex", flexDirection: "column", gap: "10px" },
  title: { fontSize: "13px", fontWeight: 600, margin: 0 },
  hint: { fontSize: "12px", lineHeight: 1.5, margin: 0, opacity: 0.65 },
  row: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" },
  label: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" },
  input: {
    padding: "6px 9px",
    fontSize: "13px",
    borderRadius: "7px",
    border: "1px solid color-mix(in srgb, CanvasText 22%, Canvas)",
    background: "color-mix(in srgb, CanvasText 4%, Canvas)",
    color: "inherit",
    width: "100%",
    boxSizing: "border-box",
  },
  button: {
    fontSize: "13px",
    padding: "7px 16px",
    borderRadius: "8px",
    border: "1px solid transparent",
    background: "#3b6ef5",
    color: "#fff",
    cursor: "pointer",
    alignSelf: "flex-start",
  },
  buttonDisabled: { opacity: 0.55, cursor: "default" },
  error: { fontSize: "12px", margin: 0, color: "#c62828" },
  notice: { fontSize: "12px", margin: 0, color: "#2e7d32" },
} as const;

/** Services captured by `apply`, read by the component. */
let credentialsRemote: CredentialsRemote | undefined;

const textOf = (value: number | undefined): string => (value === undefined ? "" : String(value));

/**
 * Render the bundle's configuration card.
 * @param props - the view the page asks for, and the Host form when it edits.
 * @returns the one-liner, or the editable card.
 */
function QoderConfigCard(props: BundleConfigProps): Element {
  const h = React.createElement;
  const form = props.form;
  const settings: QoderConfigValues = valuesOf(form?.state.value);

  const [tokens, setTokens] = React.useState<Record<string, CredentialInfo>>({});
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [mode, setMode] = React.useState<WindowMode>(() => windowModeOf(settings));
  const [windowText, setWindowText] = React.useState(() => textOf(settings.contextWindow));
  const [outputText, setOutputText] = React.useState(() => textOf(settings.maxOutputTokens));
  const [idleText, setIdleText] = React.useState(() => textOf(settings.streamIdleTimeoutMs));
  const [deltaText, setDeltaText] = React.useState(() => textOf(settings.streamDeltaIntervalMs));
  const [reasoning, setReasoning] = React.useState<"none" | "last" | "all">(settings.replayReasoning ?? "none");
  const [debug, setDebug] = React.useState(settings.debug === true);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | undefined>(undefined);
  const [saved, setSaved] = React.useState(false);

  // Only the configured/unconfigured facts cross the wire, so the inputs start
  // empty and a blank field means "leave the stored token alone".
  React.useEffect(() => {
    if (!credentialsRemote) return;
    let live = true;
    void credentialsRemote.describe(TOKEN_REFS.map((entry) => entry.ref)).then(
      (described) => { if (live) setTokens(described); },
      () => { if (live) setTokens({}); },
    );
    return () => { live = false; };
  }, []);

  if (props.view === "summary") {
    return h("span", null, "Qoder: 访问令牌、上下文窗口与额度选项。");
  }

  const notReady = form === undefined || form.state.status !== "ready" || form.state.writable === false;
  const disabled = notReady || busy;
  const output = numberAt(outputText);
  const invalid = [
    mode === "custom" && numberAt(windowText) === undefined ? "自定义上下文窗口需要一个大于 0 的整数。" : undefined,
    outputText.trim() !== "" && output === undefined ? "输出上限需要一个大于 0 的整数。" : undefined,
    output !== undefined && output > MAX_OUTPUT_TOKENS_LIMIT ? `输出上限不能超过 ${MAX_OUTPUT_TOKENS_LIMIT}。` : undefined,
  ].filter((entry): entry is string => entry !== undefined);

  /** One token row per region. */
  function tokenRow(entry: (typeof TOKEN_REFS)[number]): Element {
    const info = tokens[entry.ref];
    const configured = info?.configured === true;
    return h(
      "div",
      { key: entry.ref, style: styles.section },
      h("p", { style: styles.title }, entry.label),
      h("p", { style: styles.hint },
        `网关 ${entry.gateway} · 凭据 ${entry.ref} · ${configured ? `已配置${info?.masked ? ` ${info.masked}` : ""}` : "未配置"}`),
      h("input", {
        type: "password",
        style: styles.input,
        placeholder: configured ? "已保存，留空表示不修改" : "pt-… 或 jt-…",
        value: drafts[entry.ref] ?? "",
        autoComplete: "off",
        spellCheck: false,
        disabled,
        onChange: (event: { target: { value: string } }) => {
          const value = event.target.value;
          setDrafts((current) => ({ ...current, [entry.ref]: value }));
          setSaved(false);
        },
      }),
    );
  }

  const radio = (value: WindowMode, label: string): Element => h(
    "label",
    { style: styles.row, key: value },
    h("input", {
      type: "radio",
      name: "qoder-context-window",
      checked: mode === value,
      disabled,
      onChange: () => { setMode(value); setSaved(false); },
    }),
    h("span", null, label),
  );

  async function save(): Promise<void> {
    setFailure(undefined);
    setSaved(false);
    if (invalid.length > 0) {
      setFailure(invalid[0]);
      return;
    }
    if (!form) return;
    setBusy(true);
    try {
      const stored = tokenDrafts(drafts);
      const plan = draftOps({ mode, windowText, outputText, idleText, deltaText, reasoning, debug });
      if ("problem" in plan) {
        setFailure(plan.problem);
        return;
      }
      // Tokens record the profile entry the Models page and `hasProviderApiKey`
      // address; a submission that stores one also marks that route as added.
      const providers = (settings as { providers?: unknown }).providers;
      const ops = [...plan.ops, ...profileOps(stored, providers)];

      const accepted = await form.mutate(ops, form.state.revision);
      if (!accepted) {
        setFailure("设置未被接受，可能已被其他页面修改，请刷新后重试。");
        return;
      }

      // Tokens travel through the credential seam, not the Config document.
      if (credentialsRemote) {
        for (const token of stored) await credentialsRemote.set(token.ref, token.value);
        setTokens(await credentialsRemote.describe(TOKEN_REFS.map((entry) => entry.ref)));
      }
      setDrafts({});
      setSaved(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return h(
    "div",
    { style: styles.card },
    form === undefined || form.state.status === "ready"
      ? null
      : h("p", { style: styles.hint }, form.state.status === "loading" ? "正在读取设置…" : "此部署未对外提供该设置。"),

    ...TOKEN_REFS.map(tokenRow),

    h(
      "div",
      { style: styles.section },
      h("p", { style: styles.title }, "上下文窗口"),
      h("p", { style: styles.hint }, "决定何时压缩上下文。目录默认档最省；档位由 Qoder 目录公布，超过最大档会被夹取。"),
      radio("catalog", "目录默认档"),
      radio("max", "目录最大档（更多压缩余量，更贵）"),
      radio("custom", "自定义"),
      h("input", {
        type: "number",
        style: { ...styles.input, maxWidth: "220px" },
        min: 1,
        step: 1,
        placeholder: "token 数",
        value: windowText,
        disabled: disabled || mode !== "custom",
        onChange: (event: { target: { value: string } }) => { setWindowText(event.target.value); setSaved(false); },
      }),
    ),

    h(
      "div",
      { style: styles.section },
      h("p", { style: styles.title }, "额度与流式"),
      h(
        "div",
        { style: styles.grid },
        h("label", { style: styles.label }, "单次输出上限（tokens）", h("input", {
          type: "number", style: styles.input, min: 1, max: MAX_OUTPUT_TOKENS_LIMIT, step: 1,
          placeholder: "默认 32768", value: outputText, disabled,
          onChange: (event: { target: { value: string } }) => { setOutputText(event.target.value); setSaved(false); },
        })),
        h("label", { style: styles.label }, "历史思考回放", h("select", {
          style: styles.input, value: reasoning, disabled,
          onChange: (event: { target: { value: string } }) => {
            setReasoning(event.target.value as "none" | "last" | "all");
            setSaved(false);
          },
        },
        h("option", { value: "none" }, "none（最省）"),
        h("option", { value: "last" }, "last（仅当前工具轮）"),
        h("option", { value: "all" }, "all（qodercli 行为）"))),
        h("label", { style: styles.label }, "流空闲超时（毫秒）", h("input", {
          type: "number", style: styles.input, min: 1, step: 1,
          placeholder: "默认 120000", value: idleText, disabled,
          onChange: (event: { target: { value: string } }) => { setIdleText(event.target.value); setSaved(false); },
        })),
        h("label", { style: styles.label }, "增量合并间隔（毫秒）", h("input", {
          type: "number", style: styles.input, min: 0, step: 1,
          placeholder: "默认 50，0 表示不合并", value: deltaText, disabled,
          onChange: (event: { target: { value: string } }) => { setDeltaText(event.target.value); setSaved(false); },
        })),
      ),
      h("label", { style: styles.row },
        h("input", {
          type: "checkbox", checked: debug, disabled,
          onChange: () => { setDebug(!debug); setSaved(false); },
        }),
        h("span", null, "输出诊断日志")),
    ),

    failure === undefined ? null : h("p", { style: styles.error }, failure),
    saved ? h("p", { style: styles.notice }, "已保存。令牌与选项下一次请求即生效。") : null,
    h("button", {
      type: "button",
      style: { ...styles.button, ...(disabled ? styles.buttonDisabled : {}) },
      disabled,
      onClick: () => { void save(); },
    }, busy ? "保存中…" : "保存"),
  );
}

/**
 * Register the configuration card on this bundle's Plugins page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  credentialsRemote = ctx.remote.credentials;
  // The page renders `plugins.bundle.config` for a bundle only while a client
  // plugin claims that package name, and `whileServed` keeps the claim alive
  // only while the Host actually serves this plugin's settings entry.
  ctx.effect(
    () => ctx.configForms.whileServed([NS], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
      name: "plugins.bundle.config",
      key: BUNDLE,
    }, QoderConfigCard))),
    "llm-qoder: configuration card",
  );
}
