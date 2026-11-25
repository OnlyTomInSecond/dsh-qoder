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
  | "section.usage"
  | "usage.hint"
  | "usage.refresh"
  | "usage.loading"
  | "usage.unavailable"
  | "usage.noToken"
  | "usage.stale"
  | "usage.used"
  | "usage.remaining"
  | "usage.user"
  | "usage.addOn"
  | "usage.org"
  | "usage.expires"
  | "usage.unread"
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
  | "notServedEdit"
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
  summary: "访问令牌、本期额度、上下文窗口、输出上限与流式选项。",
  "section.tokens": "访问令牌",
  "section.window": "上下文窗口",
  "section.quota": "额度与流式",
  "section.usage": "本期额度",
  "usage.hint": "账号整期可用额度，包含其他 Qoder 客户端，不是本次会话的消耗。",
  "usage.refresh": "刷新额度",
  "usage.loading": "读取额度…",
  "usage.unavailable": "额度不可用",
  "usage.noToken": "该区域还没有访问令牌。",
  "usage.stale": "刷新失败，显示上次成功读取的额度。",
  "usage.used": "已用 {used}",
  "usage.remaining": "剩余 {remaining}",
  "usage.user": "个人",
  "usage.addOn": "加购",
  "usage.org": "组织资源包",
  "usage.expires": "{date} 到期",
  "usage.unread": "此部署没有 Web 服务，无法读取额度。",
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
  notServedEdit: "这个部署没有提供可写的配置项，选项未保存。",
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
  summary: "Access tokens, account quota, context window, output cap, and stream options.",
  "section.tokens": "Access tokens",
  "section.window": "Context window",
  "section.quota": "Limits and streaming",
  "section.usage": "Account quota",
  "usage.hint": "Account-wide period totals, including other Qoder clients; not this session's spend.",
  "usage.refresh": "Refresh quota",
  "usage.loading": "Reading quota…",
  "usage.unavailable": "Quota unavailable",
  "usage.noToken": "This region has no access token yet.",
  "usage.stale": "Refresh failed; showing the last successful account snapshot.",
  "usage.used": "{used} used",
  "usage.remaining": "{remaining} left",
  "usage.user": "Personal",
  "usage.addOn": "Add-on",
  "usage.org": "Organization",
  "usage.expires": "Expires {date}",
  "usage.unread": "This deployment serves no web server, so the quota cannot be read.",
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
  notServedEdit: "This deployment serves no writable Config section, so the options were not saved.",
  notServed: "This deployment does not serve the plugin's settings; an access token can still be saved.",
  loading: "Reading settings…",
  "problem.integer": "{field} needs an integer of at least {min}.",
  "problem.max": "{field} cannot exceed {max}.",
  "field.window": "The custom context window",
  "field.output": "The output cap",
  "field.idle": "The idle timeout",
  "field.delta": "The coalescing interval",
};
