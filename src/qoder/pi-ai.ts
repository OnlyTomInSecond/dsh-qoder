/**
 * Minimal, self-contained subset of the pi-ai contracts the ported Qoder
 * protocol understands.
 *
 * The protocol layer was originally written against `@earendil-works/pi-ai`.
 * This plugin is standalone, so the handful of types and helpers it actually
 * uses are vendored here instead of importing another package at build time.
 * The runtime helpers are behaviour-compatible with pi-ai 1.4.0.
 */

/* ------------------------------------------------------------------ *
 * Core types
 * ------------------------------------------------------------------ */

export type ProviderId = string;
export type Api = string;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
  thoughtSignature?: string;
  namespace?: string;
  argumentsError?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface ToolReference {
  name: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  constrainedSampling?: unknown;
}

export interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  timestamp: number;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: ProviderId;
  model: string;
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  thinkingLevel?: ModelThinkingLevel;
  diagnostics?: unknown[];
  usage: Usage;
  stopReason: StopReason;
  deferred?: unknown;
  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;
  timestamp: number;
  durationMs?: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  usage?: Usage;
  nestedCalls?: unknown;
  isError: boolean;
  timestamp: number;
  durationMs?: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

declare const transcriptContextBrand: unique symbol;

/** Normalized transcript consumed by the Qoder request builder. */
export type TranscriptContext = {
  messages: Message[];
  readonly [transcriptContextBrand]: true;
};

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: ProviderId;
  baseUrl: string;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  headers?: Record<string, string>;
}

/** Token budgets for thinking levels (only used structurally here). */
export type ThinkingBudgets = Partial<Record<ThinkingLevel, number>>;

export interface SimpleStreamOptions {
  apiKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string | null | undefined>;
  env?: Readonly<Record<string, string | undefined>>;
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkingLevel;
  sessionId?: string;
  timeoutMs?: number;
  toolChoice?: unknown;
  deferred?: unknown;
  thinkingBudgets?: ThinkingBudgets;
  parseTags?: boolean;
  fetch?: typeof fetch;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>;
  onResponse?: (
    response: { status: number; headers: Record<string, string> },
    model: Model<Api>,
  ) => void | Promise<void>;
  onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
  [key: string]: unknown;
}

/** OAuth-shaped credential used by the PAT exchange and token refresh paths. */
export interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
      message: AssistantMessage;
    }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/* ------------------------------------------------------------------ *
 * Assistant event stream
 * ------------------------------------------------------------------ */

class FifoQueue<T> {
  private readonly incoming: T[] = [];
  private readonly outgoing: T[] = [];

  get length(): number {
    return this.incoming.length + this.outgoing.length;
  }

  enqueue(value: T): void {
    this.incoming.push(value);
  }

  dequeue(): T | undefined {
    if (this.outgoing.length === 0) {
      while (this.incoming.length > 0) {
        this.outgoing.push(this.incoming.pop() as T);
      }
    }
    return this.outgoing.pop();
  }
}

type Waiter = (result: IteratorResult<AssistantMessageEvent>) => void;

/**
 * Async event stream of one assistant response. Mirrors pi-ai's stream:
 * completion is `done`/`error`, and the final message is timed from stream
 * creation unless it already carries `durationMs`.
 */
export class AssistantMessageEventStream {
  private readonly queue = new FifoQueue<AssistantMessageEvent>();
  private readonly waiting = new FifoQueue<Waiter>();
  private done = false;
  private readonly finalResultPromise: Promise<AssistantMessage>;
  private resolveFinalResult!: (message: AssistantMessage) => void;
  private readonly startedAt = Date.now();
  private readonly startedAtMonotonic = performance.now();

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === "done") {
      this.time(event.message);
      this.done = true;
      this.resolveFinalResult(event.message);
    } else if (event.type === "error") {
      this.time(event.error);
      this.done = true;
      this.resolveFinalResult(event.error);
    }

    const waiter = this.waiting.dequeue();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.enqueue(event);
    }
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result !== undefined) {
      this.time(result);
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.dequeue();
      waiter?.({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.dequeue() as AssistantMessageEvent;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) =>
          this.waiting.enqueue(resolve),
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalResultPromise;
  }

  private time(message: AssistantMessage): void {
    if (this.done || message.durationMs !== undefined || message.timestamp < this.startedAt) return;
    message.durationMs = Math.max(0, Math.round(performance.now() - this.startedAtMonotonic));
  }
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}

/* ------------------------------------------------------------------ *
 * Abort helpers
 * ------------------------------------------------------------------ */

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Stop waiting for an operation when its signal aborts, while still observing
 * the abandoned promise so a later rejection is handled.
 */
export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

/**
 * Combine independent abort sources into one signal. The returned cleanup
 * releases every listener; it must be called when the request ends.
 */
export function combineAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 0) {
    return { cleanup: () => {} };
  }
  if (activeSignals.length === 1) {
    return { signal: activeSignals[0], cleanup: () => {} };
  }
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => abort(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Header helper
 * ------------------------------------------------------------------ */

/**
 * Merge header sources case-insensitively, keeping the last value for each
 * name. `null` removes a header. Returns `undefined` when nothing remains.
 */
export function providerHeadersToRecord(
  ...headerSources: Array<Record<string, string | null | undefined> | undefined>
): Record<string, string> | undefined {
  const merged = new Map<string, [string, string]>();
  for (const source of headerSources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      const normalizedName = name.toLowerCase();
      // Map#delete keeps the original insertion order for the name; that only
      // matters for the very first insertion, so this matches pi-ai closely
      // enough while preserving the last spelling that was supplied.
      merged.delete(normalizedName);
      if (value !== null && value !== undefined) {
        merged.set(normalizedName, [name, value]);
      }
    }
  }
  return merged.size > 0 ? Object.fromEntries(merged.values()) : undefined;
}

/* ------------------------------------------------------------------ *
 * Transcript helpers
 * ------------------------------------------------------------------ */

function contentText(content: string | readonly (TextContent | ImageContent | ThinkingContent)[], separator = "\n"): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join(separator);
}

/** Render a system message as a complete prompt: content followed by sections. */
export function getSystemMessageText(message: SystemMessage): string {
  const parts = [contentText(message.content)];
  for (const text of Object.values(message.sections ?? {})) {
    if (text !== null) parts.push(text);
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}

function isSystemMessage(message: Message): message is SystemMessage {
  return message.role === "system";
}

/** Return the leading system message, if the transcript starts with one. */
export function getInitialSystemMessage(messages: readonly Message[]): SystemMessage | undefined {
  const first = messages[0];
  return first && isSystemMessage(first) ? first : undefined;
}

/** Drop the leading system message for APIs that carry the prompt separately. */
export function withoutInitialSystemMessage<T extends Message>(messages: readonly T[]): T[] {
  return getInitialSystemMessage(messages) ? messages.slice(1) : messages.slice();
}

function getCurrentTools(messages: readonly Message[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

/**
 * Replay every system message into one leading system message holding the
 * current prompt and tools.
 */
export function getCurrentSystemMessage(messages: readonly Message[]): SystemMessage | undefined {
  const content: string[] = [];
  const sections = new Map<string, string>();
  let timestamp: number | undefined;
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    timestamp ??= message.timestamp;
    const text = contentText(message.content);
    if (text.length > 0) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  const tools = getCurrentTools(messages);
  if (timestamp === undefined && tools.length === 0) return undefined;
  return {
    role: "system",
    content: content.join("\n\n"),
    ...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
    ...(tools.length > 0 ? { toolsAdded: tools } : {}),
    timestamp: timestamp ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * Thinking level helper
 * ------------------------------------------------------------------ */

const EXTENDED_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function getSupportedThinkingLevels(model: Model<Api>): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** Clamp a requested thinking level to the nearest level the model supports. */
export function clampThinkingLevel(model: Model<Api>, level: ThinkingLevel): ThinkingLevel {
  const availableLevels = getSupportedThinkingLevels(model);
  if (availableLevels.includes(level)) return level;
  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) return availableLevels[0] ?? "off";
  for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = EXTENDED_THINKING_LEVELS[i];
    if (availableLevels.includes(candidate)) return candidate;
  }
  return availableLevels[0] ?? "off";
}
