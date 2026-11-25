/**
 * Browser half: the Qoder configuration card on this bundle's Plugins page.
 *
 * The card is the plugin's ONLY configuration surface. This bundle keeps Qoder
 * out of the Models page on purpose (it declares no configurable provider), so
 * a region is turned on by storing its token here rather than by adding a
 * provider row there; `listModels()` answers from the token. Registering into
 * `plugins.bundle.config` — the slot the Plugins page reserves for a bundle's
 * own configuration — is what gives both the token and the Credit knobs one
 * place the plugin owns.
 *
 * Three facts shape how the card is wired, and all three differ from the
 * official plugin pages:
 *
 * 1. `plugins.bundle.config` is rendered WITHOUT a `form` prop. The page hands
 *    a `ConfigPageForm` to `plugins.item` and `plugins.row.config` entries,
 *    whose namespace is the entry id it looks the form up by. A bundle
 *    configuration is keyed by the PACKAGE name, which is not a settings
 *    namespace, so the card binds its own form through `ctx.configForms.get`
 *    and follows the snapshot that form publishes.
 * 2. `ctx.remote.*` answers with a `RemoteResult`, not the raw value: a
 *    refusal is `{ok: false, error}` rather than a rejection, so every call
 *    here unwraps it — otherwise a refused write would look like a success.
 * 3. The card owns its copy through the client locale service, like every
 *    other settings page, instead of hard-coding one language.
 *
 * Written with `createElement` rather than JSX so the browser half needs no
 * build-time JSX toolchain; `react` is the one module the shell's table
 * provides.
 */

import { MAX_STREAM_DELTA_MS, MAX_STREAM_TIMEOUT_MS, MAX_OUTPUT_TOKENS_LIMIT } from "../qoder/limits.js";
import {
  NUMBER_FIELDS,
  TOKEN_REFS,
  QoderCardController,
  type CardProblem,
  type NumberFieldKey,
  type QoderCardFace,
  type QoderCardState,
  type ReasoningReplay,
  type SettingsPathOp,
  type TokenState,
  type WindowMode,
} from "./form.js";
import { en, zh, type QoderLocaleDict, type QoderLocaleKey } from "./locales.js";
import { formatCredit, quotaRows, QoderQuotaCard } from "./quota.js";

/** Locale namespace this card owns. */
export const LOCALE_NS = "llmQoder";

/** Settings namespace: the Host plugin entry id this bundle's patch inserts. */
export const NS = "llm-qoder";

/** The package name this bundle's `plugins.bundle.config` entry is keyed by. */
export const BUNDLE = "@local/dsh-llm-qoder";

/** Services the browser half requires (cordis fiber inject). */
export const inject = ["slots", "locale", "configForms", "remote", "remote.credentials"];

/* ------------------------------------------------------------------ *
 * Minimal structural types
 *
 * The shell supplies `react` and the client services through its module
 * table, so these describe only the shapes this file reads. Keeping them
 * local leaves the package with no build-time dependency on DSH internals.
 * ------------------------------------------------------------------ */

type Element = unknown;
type Cleanup = () => void;
type Translate = (key: QoderLocaleKey, params?: Record<string, unknown>) => string;

interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): Element;
}

/** The Remote answer envelope (`RemoteResult`), structurally. */
interface RemoteResultLike<T> {
  ok: boolean;
  value?: T;
  error?: { message?: string; code?: string };
}

interface CredentialsNamespace {
  describe(refs: string[]): Promise<RemoteResultLike<Record<string, TokenState>>>;
  set(ref: string, value: string): Promise<RemoteResultLike<void>>;
}

interface ConfigFormLike {
  getSnapshot(): {
    status: "loading" | "ready" | "unavailable";
    value: unknown;
    revision: number | undefined;
    writable: boolean;
  };
  subscribe(listener: () => void): () => void;
  mutate(ops: readonly SettingsPathOp[], revision?: number): Promise<boolean>;
}

interface SlotsService {
  inject(name: string, register: () => Cleanup): Cleanup;
  register(options: Record<string, unknown>, component: unknown): Cleanup;
}

interface LocaleService {
  register(ns: string, dictionaries: Record<string, QoderLocaleDict>): Cleanup;
  bind(ns: string): Translate;
}

interface ConfigFormsService {
  get(namespace: string): ConfigFormLike;
  whileServed(namespaces: readonly string[], register: () => Cleanup): Cleanup;
}

interface ClientContext {
  slots: SlotsService;
  locale: LocaleService;
  configForms: ConfigFormsService;
  remote: { credentials: CredentialsNamespace };
  effect(callback: () => unknown, label?: string): unknown;
}

/** The `react` module the shell's module table provides. */
declare const require: (specifier: string) => unknown;

const React = (require as (s: string) => ReactLike)("react");

/** The message of a refused Remote answer. */
function refusalOf(result: RemoteResultLike<unknown>): string {
  const message = result.error?.message;
  return message === undefined || message === "" ? "the Host refused the write" : message;
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

const styles = {
  card: { display: "flex", flexDirection: "column", gap: "18px" },
  section: { display: "flex", flexDirection: "column", gap: "10px" },
  title: { fontSize: "13px", fontWeight: 600, margin: 0 },
  hint: { fontSize: "12px", lineHeight: 1.5, margin: 0, opacity: 0.65 },
  link: { fontSize: "12px", color: "inherit", textDecoration: "underline", opacity: 0.8 },
  row: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" },
  label: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" },
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

/** Props the renderer binds for a `plugins.bundle.config` entry. */
interface CardProps extends QoderCardFace {
  view?: "summary" | "page";
  t: Translate;
  /** The renderer turns the injected `hooks.qoderCard` observable into this hook. */
  useQoderCard: <T>(selector: (snapshot: QoderCardState) => T) => T;
}

/** Render one structured problem in the active language. */
function problemText(problem: CardProblem, t: Translate): string {
  if (problem.kind === "conflict") return t("conflict");
  if (problem.kind === "notServed") return t("notServedEdit");
  if (problem.kind === "overMax") return t("problem.max", { field: t(problem.field), max: problem.max });
  return t("problem.integer", { field: t(problem.field), min: problem.min });
}

/**
 * Render the bundle's configuration card.
 * @param props - the view the page asks for, the card snapshot, its actions, and the translator.
 * @returns the one-liner, or the editable card.
 */
function QoderConfigCard(props: CardProps): Element {
  const h = React.createElement;
  const { t } = props;
  const state: QoderCardState = props.useQoderCard((snapshot: QoderCardState) => snapshot);

  if (props.view === "summary") return h("span", null, t("summary"));

  const disabled = !state.editable || state.busy;
  const canSave = !state.busy && (state.editable || state.tokensWritable);

  /** One token row per region. */
  function tokenRow(entry: (typeof TOKEN_REFS)[number]): Element {
    const info: TokenState | undefined = state.tokens[entry.ref];
    const configured = info?.configured === true;
    const canWrite = info?.writable !== false && !state.busy;
    const status = !state.tokensLoaded
      ? t("token.status.loading")
      : configured
        ? [
          t("token.status.configured"),
          info?.masked === undefined ? "" : ` ${info.masked}`,
          info?.source === undefined || info.source === entry.ref ? "" : ` (${t("token.status.from", { ref: info.source })})`,
        ].join("")
        : t("token.status.unconfigured");
    return h(
      "div",
      { key: entry.ref, style: styles.section, "data-qoder-region": entry.mode },
      h("p", { style: styles.title }, entry.label),
      h(
        "p",
        { style: styles.hint },
        `${t("token.gateway", { url: entry.gateway, ref: entry.ref })} · ${status} · `,
        h("a", { href: entry.patUrl, target: "_blank", rel: "noreferrer", style: styles.link }, t("token.create")),
      ),
      h("input", {
        type: "password",
        style: styles.input,
        placeholder: configured ? t("token.placeholderConfigured") : t("token.placeholder"),
        value: state.drafts[entry.ref] ?? "",
        autoComplete: "off",
        spellCheck: false,
        "aria-label": t("token.aria", { label: entry.label }),
        disabled: !canWrite,
        onChange: (event: { target: { value: string } }) => { props.editToken(entry.ref, event.target.value); },
      }),
    );
  }

  const radio = (value: WindowMode, label: string): Element => h(
    "label",
    { style: styles.row, key: value },
    h("input", {
      type: "radio",
      name: "qoder-context-window",
      checked: state.mode === value,
      disabled,
      onChange: () => { props.setMode(value); },
    }),
    h("span", null, label),
  );

  /** One numeric knob. */
  const numberField = (spec: (typeof NUMBER_FIELDS)[number]): Element => h(
    "label",
    { style: styles.label, key: spec.key },
    t(`number.${spec.key}` as QoderLocaleKey),
    h("input", {
      type: "number",
      style: styles.input,
      min: spec.min,
      max: spec.max,
      step: 1,
      placeholder: String(spec.min === 0 ? 0 : ""),
      value: state.fields[spec.key],
      disabled,
      onChange: (event: { target: { value: string } }) => {
        props.editNumber(spec.key as NumberFieldKey, event.target.value);
      },
    }),
  );

  if (state.status === "ready") return card();
  return h(
    "div",
    { style: styles.card },
    h("p", { style: styles.hint }, state.status === "loading" ? t("loading") : t("notServed")),
    // Credentials are a separate store: a deployment that serves no Config
    // section can still hold a token, so the rows stay.
    ...TOKEN_REFS.map(tokenRow),
    state.failure === undefined ? null : failureLine(state.failure),
    saveControl(),
  );

  function failureLine(failure: NonNullable<QoderCardState["failure"]>): Element {
    const text = failure.kind === "message" ? failure.message : problemText(failure.problem, t);
    return h("p", { style: styles.error, role: "alert" }, text);
  }

  function saveControl(): Element {
    return h("div", { style: { display: "flex", alignItems: "center", gap: "12px" } },
      h("button", {
        type: "button",
        style: { ...styles.button, ...(canSave ? {} : styles.buttonDisabled) },
        disabled: !canSave,
        onClick: () => { void props.save(); },
      }, state.busy ? t("saving") : t("save")),
      state.saved ? h("p", { style: styles.notice }, t("saved")) : null);
  }

  /**
   * The account-quota block: one row per region, plus a refresh action.
   *
   * The figure is account-wide and served by the Host, so this block only
   * formats what it was given. A region without a token says so instead of
   * showing `?`, and a snapshot the Host marked stale keeps its numbers with the
   * cached note underneath — a failed refresh must not erase a balance the
   * person is reading.
   * @returns the quota section.
   */
  function quotaSection(): Element {
    const quota = state.quota;
    const rows = quotaRows(quota);
    /** One bucket as `used/total · remaining unit`. */
    const bucketLine = (bucket: { used?: number; total?: number; remaining?: number; unit?: string }): string => {
      const parts: string[] = [];
      if (bucket.used !== undefined || bucket.total !== undefined) {
        parts.push(t("usage.used", { used: `${formatCredit(bucket.used)}/${formatCredit(bucket.total)}` }));
      }
      if (bucket.remaining !== undefined) {
        const remaining = `${formatCredit(bucket.remaining)}${bucket.unit === undefined ? "" : ` ${bucket.unit}`}`;
        parts.push(t("usage.remaining", { remaining }));
      }
      return parts.join(" · ");
    };
    const regionRow = (row: ReturnType<typeof quotaRows>[number]): Element => {
      const snapshot = row.view.snapshot;
      let body: Element;
      if (!row.configured) {
        body = h("p", { style: styles.hint }, t("usage.noToken"));
      } else if (snapshot === undefined) {
        body = h("p", { style: styles.hint },
          quota.busy ? t("usage.loading") : quota.status === "unavailable" ? t("usage.unread") : t("usage.unavailable"));
      } else {
        body = h(
          "div",
          { style: styles.section },
          ...(snapshot.userQuota === undefined ? [] : [h("p", { style: styles.row }, bucketLine(snapshot.userQuota))]),
          ...(snapshot.addOnQuota === undefined
            ? []
            : [h("p", { style: styles.hint }, `${t("usage.addOn")} · ${bucketLine(snapshot.addOnQuota)}`)]),
          ...(snapshot.orgResourcePackage === undefined
            ? []
            : [h("p", { style: styles.hint }, `${t("usage.org")} · ${bucketLine(snapshot.orgResourcePackage)}`)]),
          ...(snapshot.expiresAt === undefined
            ? []
            : [h("p", { style: styles.hint }, t("usage.expires", {
              date: new Date(snapshot.expiresAt).toLocaleDateString(),
            }))]),
          ...(row.view.status === "stale" ? [h("p", { style: styles.hint }, t("usage.stale"))] : []),
        );
      }
      return h(
        "div",
        { key: row.mode, style: styles.section, "data-qoder-quota": row.mode },
        h("p", { style: styles.title }, row.label),
        body,
      );
    };
    return h(
      "div",
      { style: styles.section },
      h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" } },
        h("p", { style: styles.title }, t("section.usage")),
        h("button", {
          type: "button",
          style: { ...styles.button, ...(quota.busy ? styles.buttonDisabled : {}) },
          disabled: quota.busy,
          onClick: () => { void props.refreshQuota(true); },
        }, quota.busy ? t("usage.loading") : t("usage.refresh"))),
      h("p", { style: styles.hint }, t("usage.hint")),
      ...rows.map(regionRow),
    );
  }

  function card(): Element {
    return h(
      "div",
      { style: styles.card },
      h(
        "div",
        { style: styles.section },
        h("p", { style: styles.title }, t("section.tokens")),
        ...TOKEN_REFS.map(tokenRow),
      ),
      quotaSection(),
      h(
        "div",
        { style: styles.section },
        h("p", { style: styles.title }, t("section.window")),
        h("p", { style: styles.hint }, t("window.hint")),
        radio("catalog", t("window.catalog")),
        radio("max", t("window.max")),
        radio("custom", t("window.custom")),
        h("input", {
          type: "number",
          style: { ...styles.input, maxWidth: "220px" },
          min: 1,
          step: 1,
          placeholder: t("window.customPlaceholder"),
          "aria-label": t("window.customAria"),
          value: state.window,
          disabled: disabled || state.mode !== "custom",
          onChange: (event: { target: { value: string } }) => { props.editWindow(event.target.value); },
        }),
      ),
      h(
        "div",
        { style: styles.section },
        h("p", { style: styles.title }, t("section.quota")),
        h("div", { style: styles.grid }, ...NUMBER_FIELDS.map(numberField),
          h("label", { style: styles.label }, t("reasoning"),
            h("select", {
              style: styles.input,
              value: state.reasoning,
              disabled,
              onChange: (event: { target: { value: string } }) => {
                props.setReasoning(event.target.value as ReasoningReplay);
              },
            },
            h("option", { value: "none" }, t("reasoning.none")),
            h("option", { value: "last" }, t("reasoning.last")),
            h("option", { value: "all" }, t("reasoning.all"))))),
        h("p", { style: styles.hint }, t("limits", {
          output: MAX_OUTPUT_TOKENS_LIMIT, idle: MAX_STREAM_TIMEOUT_MS, delta: MAX_STREAM_DELTA_MS,
        })),
        h("label", { style: styles.row },
          h("input", {
            type: "checkbox",
            checked: state.debug,
            disabled,
            onChange: () => { props.setDebug(!state.debug); },
          }),
          h("span", null, t("debug"))),
      ),
      state.failure === undefined ? null : failureLine(state.failure),
      saveControl(),
    );
  }
}

/**
 * Register the configuration card on this bundle's Plugins page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "llm-qoder: dictionaries");
  // Bound here rather than declared on the registration: the card owns this one
  // dictionary namespace, so handing `t` through its inject face keeps the slot
  // registration free of a locale dependency the page does not need to know about.
  const t = ctx.locale.bind(LOCALE_NS);
  // The card reads the balance from the Host's own route: the access token never
  // reaches the browser, and a deployment without that route reports quota as
  // unavailable instead of failing the card.
  const quota = new QoderQuotaCard((input, init) => fetch(input, init));
  ctx.effect(() => () => { quota.dispose(); }, "llm-qoder: quota reader");
  const controller = new QoderCardController({
    form: ctx.configForms.get(NS),
    quota,
    credentials: {
      // The Remote answers with a result envelope; the controller's contract is
      // the value or a thrown failure, so a refusal becomes an error the card
      // can show instead of a silent no-op.
      async describe(refs) {
        const result = await ctx.remote.credentials.describe(refs);
        if (!result.ok) throw new Error(refusalOf(result));
        return result.value ?? {};
      },
      async set(ref, value) {
        const result = await ctx.remote.credentials.set(ref, value);
        if (!result.ok) throw new Error(refusalOf(result));
      },
    },
  });
  ctx.effect(() => () => { controller.dispose(); }, "llm-qoder: configuration controller");
  const face: QoderCardFace & { t: Translate } = { ...controller.face(), t };
  // The page renders `plugins.bundle.config` for a bundle only while a client
  // plugin claims that package name, and `whileServed` keeps the claim alive
  // only while the Host actually serves this plugin's settings entry.
  ctx.effect(
    () => ctx.configForms.whileServed([NS], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
      name: "plugins.bundle.config",
      key: BUNDLE,
      inject: () => face,
    }, QoderConfigCard))),
    "llm-qoder: configuration card",
  );
}
