// Offline check of the quota route the card reads: the route is registered only
// when the deployment has a web server, it answers one entry per region, it
// reports a region with no token instead of failing, and it reuses one upstream
// read inside its TTL. No network: `fetch` is stubbed with a Qoder-shaped body.
import { apply } from "../index.js";

let failures = 0;
function check(label, condition, detail) {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
}

/* ---- a Qoder-shaped quota answer --------------------------------------- */

const usageBody = {
  userQuota: { total: 1000, used: 127.5, remaining: 872.5, unit: "credits" },
  addOnQuota: { total: 50, used: 5, remaining: 45, unit: "credits" },
  orgResourcePackage: { cap: 200, used: 20, remaining: 180, unit: "credits" },
  expiresAt: 1790812800000,
};

let fetchCalls = 0;
let fetchStatus = 200;
globalThis.fetch = async (url) => {
  const parsed = new URL(String(url));
  // The credential store identifies a raw access token before the route asks
  // for quota, exactly as a real request would.
  if (parsed.pathname === "/api/v1/userinfo") {
    return new Response(JSON.stringify({ id: "u-1", email: "u@example.com", name: "User" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  fetchCalls += 1;
  check("the route reads the region's usage endpoint", parsed.pathname === "/api/v2/quota/usage", parsed.href);
  return new Response(fetchStatus === 200 ? JSON.stringify(usageBody) : "{}", {
    status: fetchStatus,
    headers: { "content-type": "application/json" },
  });
};

/* ---- fake Host services ------------------------------------------------- */

const tokens = new Map([["QODER_API_KEY", "jt-global"]]);
const credentials = {
  async describe(ref) { return { configured: tokens.has(ref), writable: true }; },
  async resolve(ref) { return tokens.has(ref) ? { value: tokens.get(ref) } : undefined; },
  async set(ref, value) { tokens.set(ref, value); },
  async unset(ref) { tokens.delete(ref); },
  async readRecord() { return undefined; },
  async modifyRecord() {},
};

let route;
let registrations = 0;
const webServer = {
  register(registration) {
    registrations += 1;
    route = registration;
    return () => { route = undefined; };
  },
};

const settings = { describe: () => [], mutate: async () => {} };
const child = {
  webServer,
  settings,
  effect(callback) { callback(); },
};
apply({
  llm: { registerAdapter() { return {}; } },
  get(name) {
    if (name === "credentials") return credentials;
    if (name === "settings") return settings;
    return undefined;
  },
  inject(deps, callback) {
    // The quota route asks for `webServer`; the settings registration asks for `settings`.
    return callback(deps.includes("webServer") ? child : { settings, effect() {} });
  },
}, {});

check("the route is registered when a web server exists", route?.path === "/qoder/quota", String(route?.path));
check("the route requires an admitted Peer", route?.auth === undefined || route.auth === "required", String(route?.auth));

/* ---- drive the handler -------------------------------------------------- */

/** One fake ServerResponse capturing status, headers, and body. */
function response() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { if (body !== undefined) this.body = String(body); },
  };
}

async function read(path = "/qoder/quota") {
  const res = response();
  await route.handler({ method: "GET", url: path, headers: {} }, res);
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : undefined };
}

const first = await read();
check("a successful read answers 200", first.status === 200, String(first.status));
check("the answer is not cacheable", first.headers["cache-control"] === "no-store", JSON.stringify(first.headers));
check("both regions are reported", first.json.regions.length === 2, JSON.stringify(first.json));
const global = first.json.regions.find((region) => region.mode === "global");
const cn = first.json.regions.find((region) => region.mode === "cn");
check("the configured region is fresh", global?.configured === true && global.quota.status === "fresh",
  JSON.stringify(global));
check("the user bucket survives normalization",
  global?.quota.snapshot?.userQuota?.remaining === 872.5 && global.quota.snapshot.userQuota.unit === "credits",
  JSON.stringify(global?.quota.snapshot));
check("the org bucket reads its `cap` field", global?.quota.snapshot?.orgResourcePackage?.total === 200,
  JSON.stringify(global?.quota.snapshot?.orgResourcePackage));
check("the expiry is carried through", global?.quota.snapshot?.expiresAt === 1790812800000,
  String(global?.quota.snapshot?.expiresAt));
check("a region with no token says so", cn?.configured === false && cn.quota.status === "unavailable",
  JSON.stringify(cn));

const callsAfterFirst = fetchCalls;
const second = await read();
check("a second read inside the TTL reuses the cached figure", fetchCalls === callsAfterFirst, String(fetchCalls));
check("the cached answer is still fresh", second.json.regions.find((r) => r.mode === "global")?.quota.status === "fresh");

await read("/qoder/quota?refresh=1");
check("an explicit refresh asks upstream again", fetchCalls === callsAfterFirst + 1, String(fetchCalls));

/* ---- failures keep the last figure -------------------------------------- */

fetchStatus = 500;
await read("/qoder/quota?refresh=1");
const failed = await read();
const failedGlobal = failed.json.regions.find((region) => region.mode === "global");
check("a failed refresh reports stale, not unavailable", failedGlobal?.quota.status === "stale",
  JSON.stringify(failedGlobal));
check("a failed refresh keeps the last snapshot", failedGlobal?.quota.snapshot?.userQuota?.remaining === 872.5,
  JSON.stringify(failedGlobal?.quota.snapshot));
check("a failed refresh is not cached as fresh", fetchCalls > callsAfterFirst + 1, String(fetchCalls));

/* ---- the route refuses anything but a read ------------------------------ */

const res = response();
await route.handler({ method: "POST", url: "/qoder/quota", headers: {} }, res);
check("a write is refused with 405", res.statusCode === 405, String(res.statusCode));
check("the refusal names the only method", res.headers.allow === "GET", String(res.headers.allow));

/* ---- a deployment without a web server keeps working -------------------- */

registrations = 0;
apply({
  llm: { registerAdapter() { return {}; } },
  get(name) { return name === "credentials" ? credentials : undefined; },
  // The child context exposes what a Headless composition has: no web server.
  inject(_deps, callback) { return callback({ settings, effect() {} }); },
}, {});
check("a child context with no web server registers no route", registrations === 0, String(registrations));

console.log(failures === 0 ? "quota route: OK" : `quota route: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
