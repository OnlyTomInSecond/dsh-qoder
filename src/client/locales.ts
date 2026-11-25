/**
 * The configuration card's copy, in the two languages this package ships.
 *
 * Registered into the DSH client locale service, so the card follows the
 * interface language like every other plugin page. Keys are flat and use
 * `{name}` placeholders, as the client locale service expects.
 */

/** Every key the card asks for. */
export type QoderLocaleKey =
  | "summary"
  | "section.tokens"
  | "section.window"
  | "section.quota"
  | "token.status.loading"
  | "token.status.configured"
  | "token.status.unconfigured"
  | "token.status.from"
  | "token.gateway"
  | "token.create"
  | "token.placeholder"
  | "token.placeholderConfigured"
  | "token.aria"
  | "window.hint"
  | "window.catalog"
  | "window.max"
  | "window.custom"
  | "window.customPlaceholder"
  | "window.customAria"
  | "number.output"
  | "number.idle"
  | "number.delta"
  | "reasoning"
  | "reasoning.none"
  | "reasoning.last"
  | "reasoning.all"
  | "debug"
  | "limits"
  | "save"
  | "saving"
  | "saved"
  | "conflict"
  | "unsavedProblem"
  | "notServed"
  | "loading"
  | "problem.integer"
  | "problem.max"
  | "field.window"
  | "field.output"
  | "field.idle"
  | "field.delta";

/** The dictionary shape one language supplies. */
export type QoderLocaleDict = Record<QoderLocaleKey, string>;

export const zh: QoderLocaleDict = {
  summary: "访问令牌、上下文窗口、输出上限与流式选项。",
  "section.tokens": "访问令牌",
  "section.window": "上下文窗口",
  "section.quota": "额度与流式",
  "token.status.loading": "读取中…",
  "token.status.configured": "已配置",
  "token.status.unconfigured": "未配置",
  "token.status.from": "来自 {ref}",
  "token.gateway": "网关 {url} · 凭据 {ref}",
  "token.create": "创建访问令牌",
  "token.placeholder": "粘贴个人访问令牌",
  "token.placeholderConfigured": "已保存，留空表示不修改",
  "token.aria": "{label} 访问令牌",
  "window.hint": "决定何时压缩上下文。目录默认档最省；超过目录公布的最大档会被夹取。",
  "window.catalog": "目录默认档",
  "window.max": "目录最大档（更多余量，更贵）",
  "window.custom": "自定义",
  "window.customPlaceholder": "token 数",
  "window.customAria": "自定义上下文窗口",
  "number.output": "单次输出上限（tokens）",
  "number.idle": "流空闲超时（毫秒）",
  "number.delta": "增量合并间隔（毫秒）",
  reasoning: "历史思考回放",
  "reasoning.none": "none（最省）",
  "reasoning.last": "last（仅当前工具轮）",
  "reasoning.all": "all（qodercli 行为）",
  debug: "输出诊断日志",
  limits: "留空表示使用默认值。输出上限 ≤ {output}，流空闲超时 ≤ {idle}，增量合并间隔 ≤ {delta}。",
  save: "保存",
  saving: "保存中…",
  saved: "已保存。令牌与选项下一次请求即生效。",
  conflict: "设置未被接受，可能已被其他页面修改，请稍后重试。",
  unsavedProblem: "还有未通过校验的输入，请先修正。",
  notServed: "此部署未对外提供该插件的设置；访问令牌仍可单独保存。",
  loading: "正在读取设置…",
  "problem.integer": "{field}需要一个不小于 {min} 的整数。",
  "problem.max": "{field}不能超过 {max}。",
  "field.window": "自定义上下文窗口",
  "field.output": "单次输出上限",
  "field.idle": "流空闲超时",
  "field.delta": "增量合并间隔",
};

export const en: QoderLocaleDict = {
  summary: "Access tokens, context window, output cap, and stream options.",
  "section.tokens": "Access tokens",
  "section.window": "Context window",
  "section.quota": "Limits and streaming",
  "token.status.loading": "Reading…",
  "token.status.configured": "Configured",
  "token.status.unconfigured": "Not configured",
  "token.status.from": "from {ref}",
  "token.gateway": "Gateway {url} · credential {ref}",
  "token.create": "Create a token",
  "token.placeholder": "Paste a personal access token",
  "token.placeholderConfigured": "Saved — leave blank to keep it",
  "token.aria": "{label} access token",
  "window.hint": "Decides when context is compacted. The catalog default is cheapest; a value above the largest published tier is clamped.",
  "window.catalog": "Catalog default tier",
  "window.max": "Largest catalog tier (more headroom, more cost)",
  "window.custom": "Custom",
  "window.customPlaceholder": "tokens",
  "window.customAria": "Custom context window",
  "number.output": "Output cap per request (tokens)",
  "number.idle": "Stream idle timeout (ms)",
  "number.delta": "Delta coalescing interval (ms)",
  reasoning: "Thinking replay",
  "reasoning.none": "none (cheapest)",
  "reasoning.last": "last (current tool round only)",
  "reasoning.all": "all (qodercli behavior)",
  debug: "Verbose diagnostics",
  limits: "Leave a field blank to use its default. Output cap ≤ {output}, idle timeout ≤ {idle}, coalescing interval ≤ {delta}.",
  save: "Save",
  saving: "Saving…",
  saved: "Saved. Tokens and options apply to the next request.",
  conflict: "The change was refused. Another page may have edited these settings; try again.",
  unsavedProblem: "A field is still invalid; fix it before saving.",
  notServed: "This deployment does not serve the plugin's settings; an access token can still be saved.",
  loading: "Reading settings…",
  "problem.integer": "{field} needs an integer of at least {min}.",
  "problem.max": "{field} cannot exceed {max}.",
  "field.window": "The custom context window",
  "field.output": "The output cap",
  "field.idle": "The idle timeout",
  "field.delta": "The coalescing interval",
};
