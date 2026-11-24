// Offline check of the plugin's own configuration page: registers the route
// against fake Host services, then exercises GET, a token save, a clear, and a
// refused value. No network, no DSH install.
import { Readable } from "node:stream";
import { apply } from "../index.js";

const CONFIG_PAGE_PATH = "/qoder/settings";

/** The fake Host: an in-memory credential store, Config section, and route table. */
function createHost(initialProviders = {}) {
  const tokens = new Map();
  let revision = 1;
  let value = { providers: initialProviders };
  const writes = [];
  let route;

  const credentials = {
    async describe(ref) {
      return tokens.has(ref) ? { configured: true, writable: true, masked: "••••" } : { configured: false, writable: true };
    },
    async set(ref, token) { tokens.set(ref, token); },
    async unset(ref) { tokens.delete(ref); },
  };
  const settings = {
    describe() { return [{ ns: "llm-qoder", revision, value }]; },
    async mutate(ns, ops, expected) {
      if (expected !== undefined && expected !== revision) throw new Error(`conflict at ${expected}, now ${revision}`);
      writes.push(ops);
      for (const op of ops) {
        if (op.path[0] !== "providers") continue;
        value = { ...value, providers: { ...value.providers, [op.path[1]]: op.value } };
      }
      revision += 1;
    },
  };
  const webServer = { register(candidate) { route = candidate; return () => { route = undefined; }; } };

  let adapter;
  apply({
    llm: { registerAdapter(_providers, instance) { adapter = instance; return {}; } },
    get(name) {
      if (name === "credentials") return credentials;
      if (name === "settings") return settings;
      if (name === "webServer") return webServer;
      return undefined;
    },
    inject(_deps, callback) { callback({ effect() {} }); return {}; },
  }, { providers: { get: () => value.providers } });

  /** Issue one request against the registered page route. */
  async function request(method, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.method = method;
    req.url = CONFIG_PAGE_PATH;
    const out = { status: 0, headers: {}, body: "" };
    const res = {
      writeHead(status, headers) { out.status = status; Object.assign(out.headers, headers ?? {}); return res; },
      end(chunk) { if (chunk) out.body += chunk; },
    };
    await route.handler(req, res);
    return out;
  }

  return { request, tokens, writes, adapter, route: () => route, value: () => value };
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
}

const host = createHost();
check("route registered at the documented path", host.route()?.path === CONFIG_PAGE_PATH, host.route()?.path);
check("route requires authentication", host.route()?.auth === "required", host.route()?.auth);

const page = await host.request("GET");
check("GET answers HTML", page.status === 200 && page.headers["content-type"]?.startsWith("text/html"), `${page.status} ${page.headers["content-type"]}`);
check("page shows both regions", page.body.includes('name="token_global"') && page.body.includes('name="token_cn"'));
check("page shows the Credit knobs", page.body.includes('name="contextWindow"') && page.body.includes('name="replayReasoning"'));

const saved = await host.request("POST", "token_global=pt-smoke&contextWindowMode=custom&contextWindow=400000&replayReasoning=last&streamDeltaIntervalMs=0");
check("save redirects", saved.status === 303, saved.status);
check("token stored under the region ref", host.tokens.get("QODER_API_KEY") === "pt-smoke", host.tokens.get("QODER_API_KEY"));
check("profile marked as added", host.value().providers.qoder !== undefined, JSON.stringify(host.value().providers));
const optionOps = host.writes.at(-1).filter((op) => op.path[0] !== "providers");
check("custom window saved", optionOps.some((op) => op.path[0] === "contextWindow" && op.value === 400000));
check("zero delta interval is accepted", optionOps.some((op) => op.path[0] === "streamDeltaIntervalMs" && op.value === 0));

const refused = await host.request("POST", "maxOutputTokens=999999&contextWindowMode=custom&contextWindow=200000");
check("over-limit output is refused", refused.status === 400, refused.status);

// The three window modes: catalog clears both fields, max sets the flag,
// custom requires a number.
const setPath = (ops, path) => ops.find((op) => op.path[0] === path);
const catalogMode = await host.request("POST", "contextWindowMode=catalog");
const catalogOps = host.writes.at(-1);
check("catalog mode clears the explicit window", setPath(catalogOps, "contextWindow")?.op === "unset");
check("catalog mode clears the max flag", setPath(catalogOps, "useMaxContext")?.value === false);

const maxMode = await host.request("POST", "contextWindowMode=max");
const maxOps = host.writes.at(-1);
check("max mode clears the explicit window", setPath(maxOps, "contextWindow")?.op === "unset");
check("max mode sets the flag", setPath(maxOps, "useMaxContext")?.value === true);

const customBlank = await host.request("POST", "contextWindowMode=custom&contextWindow=");
check("custom mode without a number is refused", customBlank.status === 400, customBlank.status);

await host.request("POST", "token_global_clear=on&contextWindowMode=catalog");
check("clear removes the token", host.tokens.has("QODER_API_KEY") === false);

const reloaded = await host.request("GET");
check("page still renders after writes", reloaded.status === 200 && reloaded.body.includes('name="token_global"'));

// A headless composition has no webServer: registration must be a no-op, not a throw.
apply({
  llm: { registerAdapter() { return {}; } },
  get() { return undefined; },
  inject(_deps, callback) { callback({ effect() {} }); return {}; },
}, {});

console.log(failures === 0 ? "config page: OK" : `config page: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
