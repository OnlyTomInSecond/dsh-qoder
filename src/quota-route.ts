/**
 * The `GET /qoder/quota` route the configuration card reads the account-period
 * quota from.
 *
 * Why a route rather than a Remote method: a bundle like this one owns no
 * generated Typert contribution, so it cannot register a `ctx.remote.*`
 * namespace without a build pipeline it does not have. A plain authenticated
 * route is the smallest surface that still keeps the access token on the Host —
 * the browser asks for a number and never sees a credential.
 *
 * The route is optional: a Headless composition has no `webServer`, and the
 * card then reports quota as unavailable instead of the plugin failing.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { debugLog } from "./qoder/debug.js";
import { QoderQuotaService } from "./qoder/quota.js";
import { QODER_QUOTA_PATH, type QoderQuotaPayload, type QoderQuotaRegion } from "./qoder/quota-shared.js";
import { QODER_MODES, type QoderMode } from "./qoder/region.js";
import type { QoderCredentialStore } from "./qoder-credentials.js";

/** The admitted Peer a route handler is given, as this route reads it. */
interface AdmittedPeer {
  principal: { kind: string };
}

/** The slice of `ctx.webServer` this route registers into. */
export interface WebServerLike {
  register(route: {
    kind: "exact" | "prefix";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse, peer?: AdmittedPeer) => void | Promise<void>;
    auth?: "required" | "anonymous" | "deny";
  }): () => void;
}

/** JSON response; quota is live account state, so nothing is cacheable. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/** What the plugin keeps alive for as long as it serves the route. */
export interface QuotaRoute {
  /** Drop one region's cached figure, because its credentials changed. */
  invalidate(mode: QoderMode): void;
  /** Remove the route and forget every cached figure. */
  dispose(): void;
}

/**
 * One region's quota, or why it has none.
 * @param store - credential store that resolves this region's account.
 * @param quota - the per-region cache behind the route.
 * @param mode - region to answer for.
 * @param force - ask upstream even when the cache is fresh.
 * @returns the region entry; a missing token or a failed exchange is reported, never thrown.
 */
async function regionQuota(
  store: QoderCredentialStore,
  quota: QoderQuotaService,
  mode: QoderMode,
  force: boolean,
): Promise<QoderQuotaRegion> {
  if (!(await store.hasToken(mode))) {
    return { mode, configured: false, quota: { status: "unavailable", error: "No token for this region" } };
  }
  try {
    // The same resolution a request uses, so a displayed balance belongs to the
    // account that would be billed. It can exchange a PAT or refresh a grant,
    // which is why the failure path below reports instead of throwing.
    const credentials = await store.get(mode);
    return { mode, configured: true, quota: await quota.read(mode, credentials.access, force) };
  } catch (error) {
    debugLog(`Qoder quota credentials unavailable for ${mode}`, error);
    const message = error instanceof Error ? error.message : String(error);
    return { mode, configured: true, quota: { status: "unavailable", error: message } };
  }
}

/**
 * Register the quota route for the lifetime of the plugin.
 * @param webServer - the Host's route carrier, when this deployment has one.
 * @param store - credential store the route resolves accounts through.
 * @returns the live route, or undefined when this deployment serves no web routes.
 */
export function registerQuotaRoute(webServer: WebServerLike | undefined, store: QoderCredentialStore): QuotaRoute | undefined {
  if (!webServer) return undefined;
  const quota = new QoderQuotaService();
  const dispose = webServer.register({
    kind: "exact",
    path: QODER_QUOTA_PATH,
    handler: async (req, res, peer) => {
      // `auth: required` admits every authenticated Peer, and a paired browser
      // of another owner is authenticated too. A credit balance is the account
      // holder's data, so only the owner reads it — the same fence the host's
      // own owner-only routes use.
      if (peer?.principal.kind !== "owner") {
        sendJson(res, 403, { code: "forbidden", message: "owner access required" });
        return;
      }
      // HEAD is answered too: Node omits the body itself, and refusing it would
      // report a GET-only route as not readable.
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("allow", "GET, HEAD");
        res.end();
        return;
      }
      // A refresh is an explicit user action, so the flag is read exactly once.
      const force = new URL(String(req.url), "http://localhost").searchParams.get("refresh") === "1";
      const payload: QoderQuotaPayload = {
        regions: await Promise.all(QODER_MODES.map((mode) => regionQuota(store, quota, mode, force))),
      };
      sendJson(res, 200, payload);
    },
  });
  return {
    invalidate: (mode) => { quota.clear(mode); },
    dispose: () => {
      quota.clear();
      dispose();
    },
  };
}
