/**
 * DSH Host plugin exposing Qoder AI as harness LLM routes.
 *
 * The Qoder wire protocol (PAT/OAuth exchange, COSY signing, catalog, SSE
 * gateway, DSML/thinking handling) lives under `src/qoder/` together with the
 * small pi-ai-compatible type/helper subset it needs; this file is only the
 * harness adapter.
 */
import z from "@deepseek-ai/schemastery";
import { getCachedModelConfig, getCachedModels, isCacheStale, updateQoderModelsCache, withPriceFactorLabel } from "./qoder/catalog.js";
import { debugLog } from "./qoder/debug.js";
import { getQoderRegionConfig, QODER_MODES, type QoderMode } from "./qoder/region.js";
import { bindQoderSettings, currentQoderSettings, type QoderConfigFields, qoderSettingsFields } from "./qoder/settings.js";
import { streamQoder } from "./qoder/protocol/stream.js";
import { QoderAuthError, QoderCredentialStore } from "./qoder-credentials.js";
import { buildPiContext, prepareImages, type AttachmentBridge, type DshGenerateOptions, type HostBridge } from "./pi-context.js";
import { bridgeStream, QoderStreamError } from "./stream-bridge.js";

export const name = "llm-qoder";
export const inject = ["llm"];

export interface Config extends QoderConfigFields {
  /** Provider profiles added through Settings > Models; live, so edits apply without a remount. */
  providers?: { get(): Record<string, unknown> | undefined };
  /** Persist exchanged/refreshed credentials in the DSH credential record. Defaults to true. */
  persistCredentials?: boolean;
}

// A real schemastery schema, like llm-pi-ai's: the Models page rehydrates this
// node on the Client, and only a real schema serializes the ref graph that
// rehydration understands. A hand-rolled `toJSON` graph cannot carry nested
// dict nodes, so the Client could not resolve `providers.qoder`.
//
// `providers` is a dict, not a fixed object: a fixed object materializes every
// key as `{}`, which would make both providers look "added" before the user
// adds one. A dict only carries the keys actually written, so a profile's
// presence is what "added" means. It is volatile, so adding or removing a
// profile is a live settings edit rather than a plugin remount.
const QODER_PROFILE = z.object({
  apiKeyEnv: z.string(),
});

export const Config = z.object({
  providers: z.dict(QODER_PROFILE).default({}).volatile(),
  /** Persist exchanged/refreshed credentials in the DSH credential record. Defaults to true. */
  persistCredentials: z.boolean().default(true),
  // The Credit/stream knobs live in `qoder/settings.ts` because the protocol
  // layer resolves them per request; spreading the fields keeps one schema as
  // the single source of truth for their defaults and bounds.
  ...qoderSettingsFields,
});

interface SettingsChild {
  settings?: { configure(policy: { auto?: boolean }, owner?: unknown): () => void };
  effect?(callback: () => unknown, label?: string): unknown;
}

interface LlmContext {
  llm: {
    registerAdapter(providers: string[], adapter: unknown): unknown;
    registerConfigurableProviders?(entries: readonly unknown[]): unknown;
  };
  get?(service: string): unknown;
  inject?(deps: string[], callback: (child: SettingsChild) => unknown): unknown;
  on?(event: string, listener: (ref: string) => void): unknown;
  fiber?: { entry?: { options?: { id?: string } } };
}

const QODER_API = "qoder-api";

/** Do not retry a failed catalog refresh on every model pick. */
const CATALOG_RETRY_MS = 5 * 60_000;

const ATTRIBUTION = "deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)";

/**
 * Whether the Models page treats a route as added: its profile entry exists.
 *
 * Without the settings service (headless) there is no profile to add, so the
 * gate stands open and a token or the environment is the whole configuration.
 */
function profileGate(ctx: LlmContext, providers: Config["providers"]) {
  return (mode: QoderMode): boolean =>
    ctx.get?.("settings") === undefined || providers?.get()?.[mode === "cn" ? "qoder-cn" : "qoder"] !== undefined;
}
const modeOf = (provider: string): QoderMode => (provider === "qoder-cn" ? "cn" : "global");

function efforts(model: ReturnType<typeof getCachedModels>[number] | undefined) {
  if (!model?.reasoning) return undefined;
  const map = model.thinkingLevelMap;
  const ids = map
    ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => map[level as never])
    : ["off", "low", "medium", "high"];
  return ids.length === 0
    ? undefined
    : { efforts: ids.map((id) => ({ id, name: id === "off" ? "Off" : id[0].toUpperCase() + id.slice(1) })) };
}

function info(provider: string, modelId: string) {
  const mode = modeOf(provider);
  const models = getCachedModels(mode);
  const model = models.find((entry) => entry.id === modelId);
  if (!model) {
    const settings = currentQoderSettings();
    return {
      provider,
      id: modelId,
      name: modelId,
      inputModalities: ["text"],
      context: { contextWindow: settings.contextWindow ?? models[0]?.contextWindow ?? 200_000 },
      defaultMaxTokens: settings.maxOutputTokens,
    };
  }
  const reasoning = efforts(model);
  return {
    provider,
    id: model.id,
    name: withPriceFactorLabel(model.name, model.priceFactor),
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: model.input,
    context: { contextWindow: model.contextWindow },
    defaultMaxTokens: model.maxTokens,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

class QoderAdapter {
  private readonly catalog = new Map<QoderMode, Promise<void>>();
  private readonly retryAfter = new Map<QoderMode, number>();

  constructor(
    private readonly store: QoderCredentialStore,
    private readonly host: HostBridge,
    private readonly profilesAdded: (mode: QoderMode) => boolean,
  ) {}

  providerInfo(provider: string) {
    return { id: provider, name: modeOf(provider) === "cn" ? "Qoder CN" : "Qoder" };
  }

  providerRetryPolicy(_provider: string) {
    return undefined;
  }

  imageRequestPricing(_provider: string, _model: string) {
    return undefined;
  }

  imageRequestTarget(_provider: string, _model: string, image: { width: number; height: number; bytes: number }) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  async listModels(provider: string) {
    const mode = modeOf(provider);
    // Gate on a configured token rather than on "the profile was added": the
    // two are recorded independently (the profile in this plugin's Config, the
    // token in the credential store), and a stored token with a missing profile
    // entry used to hide every model. Offering nothing until a token exists
    // matches llm-pi-ai's behaviour for a missing key.
    if (!(await this.store.hasToken(mode))) return [];
    // Stale-while-revalidate: the picker reads the cached (or static) catalog
    // immediately and the refresh lands for the next read. Awaiting the live
    // fetch here made every switch after the one-hour TTL (and every retry
    // after a failed fetch) wait on Qoder's network round trip.
    this.refreshCatalog(mode);
    return getCachedModels(mode).map((model) => ({
      provider,
      id: model.id,
      name: withPriceFactorLabel(model.name, model.priceFactor),
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: model.input,
    }));
  }

  async resolveModel(provider: string, model: string) {
    const mode = modeOf(provider);
    this.refreshCatalog(mode);
    return info(provider, model);
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const resolved = await this.resolveModel(provider, model);
    signal?.throwIfAborted();
    return { model: resolved, stream: (options: DshGenerateOptions) => this.stream(options) };
  }

  stream(options: DshGenerateOptions) {
    return this.generate(options);
  }

  /** Refresh the live catalog in the background; the cached/static list serves meanwhile. */
  private refreshCatalog(mode: QoderMode): void {
    if (!isCacheStale(mode)) return;
    if (Date.now() < (this.retryAfter.get(mode) ?? 0)) return;
    if (this.catalog.has(mode)) return;
    const promise = (async () => {
      try {
        const credentials = await this.store.get(mode);
        await updateQoderModelsCache(
          credentials.access,
          credentials.userID || "qoder-user",
          credentials.name || getQoderRegionConfig(mode).userNameFallback,
          credentials.email || getQoderRegionConfig(mode).userEmailFallback,
          mode,
        );
        this.retryAfter.delete(mode);
      } catch (error) {
        this.retryAfter.set(mode, Date.now() + CATALOG_RETRY_MS);
        debugLog(`Qoder catalog refresh skipped for ${mode}`, error);
      }
    })().finally(() => this.catalog.delete(mode));
    this.catalog.set(mode, promise);
  }

  private async *generate(options: DshGenerateOptions) {
    const mode = modeOf(options.provider);
    // Either half of the configuration is enough: a profile added on the
    // Models page needs its token, and a token from the credential seam or the
    // launching environment needs no profile entry at all (which is the whole
    // one-shot `QODER_API_KEY=… dsh web` path).
    if (!this.profilesAdded(mode) && !(await this.store.hasToken(mode))) {
      throw new QoderAuthError(
        "Qoder provider is not configured. Paste a token on its card in Plugins, or set QODER_API_KEY.",
        "QODER_NOT_CONFIGURED",
      );
    }
    try {
      this.refreshCatalog(mode);
      const model = getCachedModels(mode).find((entry) => entry.id === options.model);
      if (!model || !getCachedModelConfig(options.model, mode)?.key) {
        throw new QoderStreamError(`Unknown Qoder model id: ${options.model}`, "UNKNOWN_MODEL");
      }
      const credentials = await this.store.get(mode);
      const context = buildPiContext(options, await prepareImages(options, this.host, options.signal), model.provider, model.id);
      const events = streamQoder(
        {
          id: model.id,
          name: model.name,
          api: QODER_API,
          provider: model.provider,
          baseUrl: model.baseUrl,
          input: model.input,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
        } as never,
        context,
        {
          apiKey: credentials.access,
          signal: options.signal,
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.reasoningEffort === undefined ? {} : { reasoning: options.reasoningEffort as never }),
          ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
          headers: { "user-agent": ATTRIBUTION },
        },
      );
      yield* bridgeStream(events, options.signal);
    } catch (error) {
      if (error instanceof QoderStreamError || error instanceof QoderAuthError) throw error;
      throw new QoderStreamError(
        options.signal?.aborted ? "Qoder request aborted" : error instanceof Error ? error.message : String(error),
        options.signal?.aborted ? "ABORTED" : "PROVIDER_ERROR",
      );
    }
  }
}

export function apply(ctx: LlmContext, rawConfig: unknown): void {
  const config = (rawConfig && typeof rawConfig === "object" ? rawConfig : {}) as Config;
  // Both regions are always offered, matching the pi provider: each is a
  // separate route with its own base URL, account, and credential reference,
  // and one being unconfigured costs nothing. The Models page decides which
  // ones a user actually adds.
  const routes = QODER_MODES.map((mode) => getQoderRegionConfig(mode).providerID);
  // The protocol layer resolves these per request; binding the (volatile)
  // fields here is what makes a settings edit reach the next request.
  bindQoderSettings(config);
  const store = new QoderCredentialStore(ctx, config.persistCredentials !== false);
  ctx.on?.("credentials/reference-updated", (ref) => {
    if (ref === "QODER_ACCESS_TOKEN" || ref === "QODER_API_KEY") store.invalidate("global");
    if (ref === "QODERCN_ACCESS_TOKEN" || ref === "QODER_CN_API_KEY" || ref === "QODERCN_API_KEY") store.invalidate("cn");
  });
  // The entry id is the settings namespace; deriving it keeps a renamed or
  // re-inserted profile entry addressable, as llm-pi-ai does.
  const settingsNs = ctx.fiber?.entry?.options?.id ?? "llm-qoder";
  ctx.inject?.(["settings"], (child) => {
    child.effect?.(() => child.settings?.configure({ auto: false }, ctx.fiber), `${settingsNs}: settings`);
  });
  ctx.llm.registerConfigurableProviders?.(QODER_MODES.map((mode) => ({
    provider: getQoderRegionConfig(mode).providerID,
    displayName: mode === "cn" ? "Qoder CN" : "Qoder",
    settingsNs,
    settingsPath: ["providers", mode === "cn" ? "qoder-cn" : "qoder"],
    nativeAuth: {
      env: mode === "cn"
        ? ["QODER_CN_API_KEY", "QODERCN_ACCESS_TOKEN", "QODERCN_API_KEY"]
        : ["QODER_API_KEY", "QODER_ACCESS_TOKEN"],
      oauth: false,
    },
  })));
  const host: HostBridge = {
    get attachments() {
      return ctx.get?.("attachments") as AttachmentBridge | undefined;
    },
  };
  // Read the live volatile config rather than rebuilding every settings form
  // on each model-list call. Without the settings service (headless), env or
  // recorded credentials are the whole configuration, so the profile gate
  // does not apply.
  const providers = config.providers;
  ctx.llm.registerAdapter(
    routes,
    new QoderAdapter(
      store,
      host,
      profileGate(ctx, providers),
    ),
  );
  debugLog(`registered Qoder routes: ${routes.join(", ")}`);
}
