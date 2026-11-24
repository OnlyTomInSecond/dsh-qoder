/**
 * A small self-hosted settings page for this plugin.
 *
 * The Models page only renders a credential field for the two provider
 * families DSH ships, so a Qoder profile registered as `{ apiKeyEnv }` gets a
 * hint instead of an input. Rather than patching DSH's client, the plugin
 * serves its own page from the Host it already runs in: the same
 * `ctx.credentials` writes the Models page would perform, plus the
 * Credit-relevant Config fields, over plain HTML.
 *
 * Everything here is Host-side. `ctx.webServer` is optional (a headless
 * composition has none), the page registers for the lifetime of the service,
 * and `auth` stays at its default (`required`) because the form writes secrets.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { advertisedContextTiers } from "./qoder/catalog.js";
import { MAX_OUTPUT_TOKENS_LIMIT, qoderSettingsFromEnv, type QoderSettings } from "./qoder/settings.js";
import { debugLog } from "./qoder/debug.js";
import { getQoderRegionConfig, QODER_MODES, type QoderMode } from "./qoder/region.js";

/** Route of the plugin's configuration page. */
export const CONFIG_PAGE_PATH = "/qoder/settings";

/** Largest accepted form body; the page only posts a handful of short fields. */
const MAX_BODY_BYTES = 64 * 1024;

/** Credential references the page writes, one per region, in lookup order. */
const TOKEN_REFS: Record<QoderMode, readonly string[]> = {
  global: ["QODER_API_KEY", "QODER_ACCESS_TOKEN"],
  cn: ["QODER_CN_API_KEY", "QODERCN_API_KEY", "QODERCN_ACCESS_TOKEN"],
};

interface CredentialInfoLike {
  configured: boolean;
  writable: boolean;
  masked?: string;
}

/** The slice of `ctx.credentials` this page reads and writes. */
export interface CredentialsLike {
  describe(ref: string): Promise<CredentialInfoLike>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

/** One path-addressed edit accepted by `ctx.settings.mutate`. */
type SettingsPathOp =
  | { op: "set"; path: readonly string[]; value: unknown }
  | { op: "unset"; path: readonly string[] };

interface SettingsDescriptorLike {
  ns: string;
  revision: number;
  value: unknown;
}

/** The slice of `ctx.settings` this page needs. */
export interface SettingsLike {
  describe(): SettingsDescriptorLike[];
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
}

/** The slice of `ctx.webServer` this page registers into. */
export interface WebServerLike {
  register(route: {
    kind: "exact" | "prefix";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    auth?: "required" | "anonymous" | "deny";
  }): () => void;
}

export interface ConfigPageOptions {
  /** Settings namespace (the plugin's profile entry id). */
  ns: string;
  /** Applied after a credentials write so the next request re-resolves it. */
  onCredentialsChanged: (mode: QoderMode) => void;
  /** Whether the route is currently added (mirrors the adapter's own gate). */
  configured: (mode: QoderMode) => boolean;
  /**
   * Environment overrides in force for this process. Injected so a test can
   * pin them; defaults to the real environment read the same way a request does.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Read a request body, refusing anything larger than the page will ever post. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse one form submission into a plain record. */
function parseForm(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

/**
 * A number field: absent/blank means "use the default", so it unsets.
 * `min` is 0 for the one field where zero is meaningful (delta coalescing 0
 * means "flush every event"), 1 for every other knob.
 */
function numberField(form: URLSearchParams, name: string, min = 1): number | undefined {
  const raw = form.get(name)?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) && value >= min ? value : undefined;
}

function checked(form: URLSearchParams, name: string): boolean {
  return form.get(name) === "on" || form.get(name) === "true" || form.get(name) === "1";
}

/** Current resolved Config values for the page's fields. */
function readSettings(settings: SettingsLike | undefined, ns: string): Partial<QoderSettings> {
  const descriptor = settings?.describe().find((entry) => entry.ns === ns);
  const value = descriptor?.value;
  return value && typeof value === "object" ? (value as Partial<QoderSettings>) : {};
}

/**
 * The context-window edits for one submission.
 *
 * Three modes, matching how the pi plugin's `/qoder-settings context` works:
 *
 *   catalog   no override; the catalog's own default tier decides (cheapest)
 *   max       the largest tier the catalog advertises
 *   custom    an explicit token count, clamped to the largest tier downstream
 *
 * `catalog` and `max` are the same pair of fields (`contextWindow: null`,
 * `useMaxContext: bool`), so switching between them never leaves a stale
 * explicit value behind.
 */
function contextWindowOps(form: URLSearchParams, problems: string[]): SettingsPathOp[] {
  const choice = form.get("contextWindowMode")?.trim() ?? "catalog";
  if (choice === "catalog") return [{ op: "unset", path: ["contextWindow"] }, { op: "set", path: ["useMaxContext"], value: false }];
  if (choice === "max") return [{ op: "unset", path: ["contextWindow"] }, { op: "set", path: ["useMaxContext"], value: true }];
  if (choice !== "custom") return [];
  const window = numberField(form, "contextWindow");
  if (window === undefined) {
    problems.push("自定义上下文窗口需要一个大于 0 的整数。");
    return [];
  }
  return [{ op: "set", path: ["contextWindow"], value: window }, { op: "set", path: ["useMaxContext"], value: false }];
}

/** Write the page's Config fields through one revision-checked mutation. */
async function saveSettings(
  settings: SettingsLike | undefined,
  ns: string,
  form: URLSearchParams,
): Promise<string[]> {
  if (!settings) return ["Settings service unavailable; the options were not saved."];
  const descriptor = settings.describe().find((entry) => entry.ns === ns);
  if (!descriptor) return [`No configurable plugin entry "${ns}".`];

  const problems: string[] = [];
  const ops: SettingsPathOp[] = [];
  const windowOps = contextWindowOps(form, problems);
  ops.push(...windowOps);

  const output = numberField(form, "maxOutputTokens");
  if (output !== undefined && output > MAX_OUTPUT_TOKENS_LIMIT) {
    problems.push(`Max output tokens must be at most ${MAX_OUTPUT_TOKENS_LIMIT}.`);
  } else if (output !== undefined) {
    ops.push({ op: "set", path: ["maxOutputTokens"], value: output });
  }

  const idle = numberField(form, "streamIdleTimeoutMs");
  if (idle !== undefined) ops.push({ op: "set", path: ["streamIdleTimeoutMs"], value: idle });
  const delta = numberField(form, "streamDeltaIntervalMs", 0);
  if (delta !== undefined) ops.push({ op: "set", path: ["streamDeltaIntervalMs"], value: delta });

  const reasoning = form.get("replayReasoning")?.trim();
  if (reasoning === "none" || reasoning === "last" || reasoning === "all") {
    ops.push({ op: "set", path: ["replayReasoning"], value: reasoning });
  }
  ops.push({ op: "set", path: ["debug"], value: checked(form, "debug") });

  if (problems.length > 0) return problems;
  await settings.mutate(ns, ops, descriptor.revision);
  return [];
}

/**
 * Record the provider profile a saved token belongs to.
 *
 * `listModels()` answers only for an added route, and "added" is the presence
 * of `providers.<route>` in this plugin's Config. A token typed on this page
 * therefore also marks the profile, which is what the Models page's own card
 * would have done.
 */
async function addProfile(
  settings: SettingsLike | undefined,
  ns: string,
  mode: QoderMode,
): Promise<void> {
  if (!settings) return;
  const descriptor = settings.describe().find((entry) => entry.ns === ns);
  if (!descriptor) return;
  const key = getQoderRegionConfig(mode).providerID;
  const providers = (descriptor.value as { providers?: Record<string, unknown> } | undefined)?.providers;
  if (providers?.[key] !== undefined) return;
  await settings.mutate(ns, [{
    op: "set",
    path: ["providers", key],
    value: { apiKeyEnv: TOKEN_REFS[mode][0] },
  }], descriptor.revision);
}

/** Apply the token fields: a typed token is stored, an explicit clear removes it. */
async function saveTokens(
  credentials: CredentialsLike | undefined,
  settings: SettingsLike | undefined,
  options: ConfigPageOptions,
  form: URLSearchParams,
): Promise<string[]> {
  if (!credentials) return [];
  for (const mode of QODER_MODES) {
    const name = `token_${mode}`;
    const token = form.get(name)?.trim();
    if (checked(form, `${name}_clear`)) {
      for (const ref of TOKEN_REFS[mode]) await credentials.unset(ref).catch(() => undefined);
      options.onCredentialsChanged(mode);
      continue;
    }
    if (!token) continue;
    // Write the first reference (the one the Models card would derive) and drop
    // any legacy alias, so one account never has two competing tokens.
    await credentials.set(TOKEN_REFS[mode][0], token);
    for (const ref of TOKEN_REFS[mode].slice(1)) await credentials.unset(ref).catch(() => undefined);
    await addProfile(settings, options.ns, mode);
    options.onCredentialsChanged(mode);
  }
  return [];
}

/**
 * The context-window control: pick the catalog default, the largest tier, or a
 * custom value.
 *
 * The presets are the tiers this region's catalog actually advertises, so the
 * numbers are Qoder's own rather than a guess. An environment override is
 * called out because it outranks anything the page writes.
 */
function contextWindowField(settings: Partial<QoderSettings>, options: ConfigPageOptions): string {
  const pinned = qoderSettingsFromEnv(options.env).contextWindow;
  const tiers = QODER_MODES.flatMap((mode) => advertisedContextTiers(mode));
  const presets = [...new Set(tiers)].sort((a, b) => a - b);
  const choice = pinned !== undefined ? "custom"
    : settings.contextWindow !== undefined ? "custom"
      : settings.useMaxContext ? "max" : "catalog";
  const is = (mode: string): string => (choice === mode ? " selected" : "");
  const labels = presets.map((tokens) => `${tokens / 1000}K`).join(" / ");
  return `
      <fieldset class="window">
        <legend>上下文窗口</legend>
        <label class="inline">
          <input type="radio" name="contextWindowMode" value="catalog"${is("catalog")}>
          目录默认档${presets.length === 0 ? "" : `（${labels} 中的默认档，最省）`}
        </label>
        <label class="inline">
          <input type="radio" name="contextWindowMode" value="max"${is("max")}>
          目录最大档${presets.length === 0 ? "" : `（${presets.at(-1)! / 1000}K，更多压缩余量，更贵）`}
        </label>
        <label class="inline">
          <input type="radio" name="contextWindowMode" value="custom"${is("custom")}>
          自定义
        </label>
        <div class="customWindow">
          <input type="number" name="contextWindow" min="1" step="1" value="${settings.contextWindow ?? ""}"
                 placeholder="${presets.length === 0 ? "输入 token 数" : "留空则沿用所选档位"}"
                 ${presets.length === 0 ? "" : `list="contextWindowTiers"`}>
          <datalist id="contextWindowTiers">
            ${presets.map((tokens) => `<option value="${tokens}">${tokens / 1000}K</option>`).join("")}
          </datalist>
          <span class="muted">超过目录最大档会被夹到 ${presets.length === 0 ? "该值" : `${presets.at(-1)! / 1000}K`}</span>
        </div>
        ${pinned === undefined ? "" : `<p class="notice err">环境变量 QODER_CONTEXT_WINDOW=${pinned} 正在覆盖此设置。</p>`}
      </fieldset>`;
}

function renderPage(options: ConfigPageOptions, state: {
  settings: Partial<QoderSettings>;
  credentials: Record<string, CredentialInfoLike | undefined>;
  message?: string;
  errors: readonly string[];
}): string {
  const { settings, credentials, message, errors } = state;
  const number = (value: number | undefined): string => (value === undefined ? "" : String(value));
  const selected = (value: string): string => (settings.replayReasoning === value ? " selected" : "");
  const regionCard = (mode: QoderMode): string => {
    const region = getQoderRegionConfig(mode);
    const ref = TOKEN_REFS[mode][0];
    const info = credentials[ref];
    const added = options.configured(mode);
    const status = info?.configured
      ? `已配置 ${escapeHtml(info.masked ?? "")}`
      : "未配置";
    return `
      <section class="card">
        <header>
          <h2>${mode === "cn" ? "Qoder CN" : "Qoder"}</h2>
          <span class="badge ${added ? "on" : "off"}">${added ? "已添加" : "未添加"}</span>
        </header>
        <p class="muted">网关 ${escapeHtml(region.baseUrl)}　凭据引用 <code>${escapeHtml(ref)}</code></p>
        <p class="status ${info?.configured ? "ok" : "warn"}">${status}</p>
        <label>访问令牌
          <input type="password" name="token_${mode}" autocomplete="off" spellcheck="false"
                 placeholder="${info?.configured ? "已保存，留空表示不修改" : "pt-… 或 jt-…"}">
        </label>
        <label class="inline">
          <input type="checkbox" name="token_${mode}_clear"> 删除已保存的令牌
        </label>
      </section>`;
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qoder 设置</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 0; }
  .lede { margin: 0 0 24px; color: color-mix(in srgb, CanvasText 65%, Canvas); }
  .card { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 10px;
          padding: 16px 18px; margin: 0 0 16px; }
  .card header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; }
  .badge.on { color: #2e7d32; } .badge.off { color: color-mix(in srgb, CanvasText 50%, Canvas); }
  .muted { margin: 0 0 10px; font-size: 13px; color: color-mix(in srgb, CanvasText 62%, Canvas); }
  .status { margin: 0 0 12px; font-size: 13px; }
  .status.ok { color: #2e7d32; } .status.warn { color: #b26a00; }
  label { display: block; margin: 0 0 10px; font-size: 13px; }
  label.inline { display: flex; align-items: center; gap: 8px; }
  input[type=password], input[type=number], select {
    display: block; width: 100%; margin-top: 4px; padding: 7px 9px; font: inherit; font-size: 14px;
    border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); border-radius: 7px;
    background: color-mix(in srgb, CanvasText 4%, Canvas); color: inherit; }
  input[type=checkbox] { width: 15px; height: 15px; margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0 16px; }
  .actions { display: flex; gap: 10px; align-items: center; margin-top: 20px; }
  button { font: inherit; font-size: 14px; padding: 8px 18px; border-radius: 8px; cursor: pointer;
           border: 1px solid transparent; background: #3b6ef5; color: #fff; }
  button.secondary { background: transparent; color: inherit;
           border-color: color-mix(in srgb, CanvasText 25%, Canvas); }
  .notice { padding: 10px 12px; border-radius: 8px; margin: 0 0 16px; font-size: 13px; }
  .notice.ok { background: color-mix(in srgb, #2e7d32 14%, Canvas); }
  .notice.err { background: color-mix(in srgb, #c62828 14%, Canvas); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  fieldset { border: 0; padding: 0; margin: 0 0 18px; }
  legend { font-weight: 600; font-size: 14px; padding: 0; margin: 0 0 10px; }
  .window label.inline { margin: 0 0 6px; }
  input[type=radio] { width: 15px; height: 15px; margin: 0; }
  .customWindow { margin: 8px 0 0 23px; }
  .customWindow input { max-width: 220px; }
  .customWindow .muted { margin: 6px 0 0; }
</style>
</head>
<body>
<main>
  <h1>Qoder 设置</h1>
  <p class="lede">令牌保存在 DSH 凭据存储中，不写入配置文件。所有选项下一次请求即生效。</p>
  ${message ? `<p class="notice ok">${escapeHtml(message)}</p>` : ""}
  ${errors.length > 0 ? `<div class="notice err">${errors.map((e) => `<div>${escapeHtml(e)}</div>`).join("")}</div>` : ""}
  <form method="post" action="${CONFIG_PAGE_PATH}">
    ${QODER_MODES.map(regionCard).join("\n")}
    <section class="card">
      <header><h2>上下文与额度</h2></header>
      <p class="muted">这些选项决定每次请求烧多少 Credit。</p>
      ${contextWindowField(settings, options)}
      <div class="grid">
        <label>单次输出上限（tokens）
          <input type="number" name="maxOutputTokens" min="1" max="${MAX_OUTPUT_TOKENS_LIMIT}" step="1"
                 value="${number(settings.maxOutputTokens)}" placeholder="默认 32768">
        </label>
        <label>历史思考回放
          <select name="replayReasoning">
            <option value="none"${selected("none")}>none（最省）</option>
            <option value="last"${selected("last")}>last（仅当前工具轮）</option>
            <option value="all"${selected("all")}>all（qodercli 行为）</option>
          </select>
        </label>
        <label>流空闲超时（毫秒）
          <input type="number" name="streamIdleTimeoutMs" min="1" step="1" value="${number(settings.streamIdleTimeoutMs)}"
                 placeholder="默认 120000">
        </label>
        <label>增量合并间隔（毫秒）
          <input type="number" name="streamDeltaIntervalMs" min="0" step="1" value="${number(settings.streamDeltaIntervalMs)}"
                 placeholder="默认 50">
        </label>
      </div>
      <label class="inline"><input type="checkbox" name="debug"${settings.debug ? " checked" : ""}>
        输出诊断日志</label>
    </section>
    <div class="actions">
      <button type="submit">保存</button>
      <button type="reset" class="secondary">重置表单</button>
    </div>
  </form>
</main>
</body>
</html>`;
}

/**
 * Serve the configuration page while a web server exists.
 *
 * @param ctx - the plugin context; `inject` is used so a headless composition
 *   (no `webServer`) simply never registers anything.
 * @param options - namespace, profile access, and the post-write invalidation.
 */
export function registerConfigPage(
  ctx: {
    inject?(deps: string[], callback: (scope: { effect?(cb: () => unknown, label?: string): unknown }) => unknown): unknown;
    get?(name: string): unknown;
  },
  options: ConfigPageOptions,
): void {
  const register = (scope: { effect?(cb: () => unknown, label?: string): unknown }): void => {
    const webServer = ctx.get?.("webServer") as WebServerLike | undefined;
    if (!webServer?.register) return;
    const credentials = ctx.get?.("credentials") as CredentialsLike | undefined;
    const settings = ctx.get?.("settings") as SettingsLike | undefined;

    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = new URL(req.url ?? CONFIG_PAGE_PATH, "http://dsh.invalid");
      if (req.method === "POST") {
        let errors: string[] = [];
        try {
          const form = parseForm(await readBody(req));
          errors = [
            ...await saveTokens(credentials, settings, options, form),
            ...await saveSettings(settings, options.ns, form),
          ];
        } catch (error) {
          errors = [error instanceof Error ? error.message : String(error)];
        }
        if (errors.length > 0) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(renderPage(options, {
            settings: readSettings(settings, options.ns),
            credentials: await describeTokens(credentials),
            errors,
          }));
          return;
        }
        // Redirect after a write so a refresh does not repost the token.
        res.writeHead(303, { location: `${CONFIG_PAGE_PATH}?saved=1`, "cache-control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderPage(options, {
        settings: readSettings(settings, options.ns),
        credentials: await describeTokens(credentials),
        message: url.searchParams.get("saved") === "1" ? "已保存。" : undefined,
        errors: [],
      }));
    };

    const dispose = webServer.register({
      kind: "exact",
      path: CONFIG_PAGE_PATH,
      handler,
      // The default is already `required`; naming it keeps the intent explicit
      // for a page that writes secrets.
      auth: "required",
    });
    scope.effect?.(() => dispose, "llm-qoder: configuration page");
    debugLog(`Qoder configuration page served at ${CONFIG_PAGE_PATH}`);
  };

  if (typeof ctx.inject === "function") ctx.inject(["webServer"], register);
  else register({});
}

/** Describe every token reference the page shows. */
async function describeTokens(credentials: CredentialsLike | undefined): Promise<Record<string, CredentialInfoLike | undefined>> {
  if (!credentials) return {};
  const refs = QODER_MODES.map((mode) => TOKEN_REFS[mode][0]);
  const entries = await Promise.all(refs.map(async (ref) => {
    try {
      return [ref, await credentials.describe(ref)] as const;
    } catch {
      return [ref, undefined] as const;
    }
  }));
  return Object.fromEntries(entries);
}
