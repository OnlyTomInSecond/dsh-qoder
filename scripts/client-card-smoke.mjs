// Drives the built browser half (`lib/client.js`) the way DSH's client module
// system does, without a browser or a DSH install: the bundle registers itself
// through `window.__ModuleLoader__.load`, `react` comes from the injected
// require, and the slot/configForms/remote services are fakes that record what
// the card asks them for.
//
// The point is the wiring, not the pixels: a registered card must reach the
// plugin's Config form and the credentials Remote, and a refused Remote answer
// must surface instead of passing for success.
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

let failures = 0;
function check(label, condition, detail) {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
}

/* ---- react stand-in ---------------------------------------------------- */

/** Build a plain tree instead of a DOM node, so props (and their handlers) stay readable. */
function element(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat() };
}
// Rendering calls the component directly, so an effect has no commit to wait
// for: running it inline is the mount path this test exercises.
const React = { createElement: element, useEffect: (effect) => { effect(); } };

/* ---- the bundle, loaded like the shell loads it ------------------------ */

const registrations = [];
const window = { __ModuleLoader__: { load: (registration) => { registrations.push(registration); } } };
// The card's quota reader asks the Host's route; the sandbox supplies a fetch
// with a Qoder-shaped answer so the block renders real numbers.
const quotaFetch = { calls: [], body: undefined, status: 404 };
const fetchStub = async (input) => {
  quotaFetch.calls.push(String(input));
  const status = quotaFetch.status;
  if (status !== 200) return { ok: false, status, json: async () => ({}) };
  return { ok: true, status, json: async () => quotaFetch.body };
};
const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
runInNewContext(source, { window, console, fetch: fetchStub });
check("the bundle registers exactly one module", registrations.length === 1, String(registrations.length));
const registration = registrations[0];
check("the module id is the package name", registration.id === "@local/dsh-llm-qoder", registration.id);
const client = registration.factory((specifier) => {
  if (specifier === "react") return React;
  throw new Error(`client-modules: require("${specifier}") missed the module table`);
});
check("the client half exports apply", typeof client.apply === "function");
check(
  "the client half injects the services the card writes through",
  Array.isArray(client.inject)
  && ["slots", "configForms", "remote", "remote.credentials"].every((name) => client.inject.includes(name)),
  JSON.stringify(client.inject),
);

/* ---- fake Host services ------------------------------------------------ */

/** One Config section, projected and mutable like `ctx.configForms.get` returns. */
function makeForm(initial) {
  const listeners = new Set();
  let snapshot = { status: "ready", value: initial, revision: 3, writable: true };
  return {
    form: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      mutate: async (ops) => { snapshot = { ...snapshot, value: applyOps(snapshot.value, ops), revision: snapshot.revision + 1 }; for (const l of listeners) l(); return true; },
    },
    set(next) { snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener(); },
    get snapshot() { return snapshot; },
  };
}

/** The Host's ordered path ops, over a plain object. */
function applyOps(value, ops) {
  const root = structuredClone(value ?? {});
  for (const op of ops) {
    let node = root;
    for (const key of op.path.slice(0, -1)) {
      if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
      node = node[key];
    }
    const leaf = op.path[op.path.length - 1];
    if (op.op === "unset") delete node[leaf];
    else node[leaf] = op.value;
  }
  return root;
}

const calls = { described: [], set: [], mutate: [] };
const creds = new Map();
const credentials = {
  describe: async (refs) => {
    calls.described.push(refs);
    return {
      ok: true,
      value: Object.fromEntries(refs.map((ref) => [ref, {
        configured: creds.has(ref), writable: true, ...(creds.has(ref) ? { masked: "pt-***" } : {}),
      }])),
    };
  },
  set: async (ref, value) => {
    if (ref === "QODER_CN_API_KEY" && value === "refuse-me") return { ok: false, error: { message: "credential/rejected" } };
    calls.set.push([ref, value]);
    creds.set(ref, value);
    return { ok: true, value: undefined };
  },
};

const section = makeForm({ maxOutputTokens: 4096, replayReasoning: "none", debug: false });
const mutateOps = [];
const form = {
  ...section.form,
  mutate: async (ops, revision) => {
    mutateOps.push({ ops, revision });
    calls.mutate.push(ops.map((op) => [op.op, op.path.join("."), op.value]));
    return await section.form.mutate(ops, revision);
  },
};

/** Fake client locale service: registers dictionaries and binds a translate function. */
const dictionaries = new Map();
const locale = {
  register: (ns, dicts) => { dictionaries.set(ns, dicts); return () => { dictionaries.delete(ns); }; },
  bind: (ns) => (key, params) => {
    const dict = dictionaries.get(ns)?.en ?? {};
    const template = dict[key] ?? key;
    return params === undefined ? template : template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
  },
};

let cardRegistration;
let served;
const ctx = {
  locale,
  slots: {
    inject: (_name, register) => { served = register(); return () => { served?.(); }; },
    register: (options, component) => { cardRegistration = { options, component }; return () => { cardRegistration = undefined; }; },
  },
  configForms: {
    get: (namespace) => { check("the card binds the plugin's settings namespace", namespace === "llm-qoder", namespace); return form; },
    whileServed: (namespaces, register) => {
      check("the card waits for the plugin's served namespace", namespaces.length === 1 && namespaces[0] === "llm-qoder", JSON.stringify(namespaces));
      return register();
    },
  },
  remote: { credentials },
  effect: (callback) => callback(),
};

client.apply(ctx);

check("the card claims `plugins.bundle.config`", cardRegistration?.options.name === "plugins.bundle.config", JSON.stringify(cardRegistration?.options));
check("the card is keyed by the package name", cardRegistration?.options.key === "@local/dsh-llm-qoder", String(cardRegistration?.options.key));
const face = cardRegistration?.options.inject?.();
check("the registration injects the card face", face !== undefined && typeof face.save === "function");
check("the face exposes the snapshot hook", face !== undefined && face.hooks !== undefined && face.hooks.qoderCard !== undefined);
check("the snapshot hook is not called as a function type twice", typeof face?.hooks?.qoderCard.getSnapshot === "function");
// Activating the client half is not someone opening the card: the balance is
// read on the first page render, not at mount.
await (async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve)); })();
check("activating the client half reads no quota", quotaFetch.calls.length === 0, JSON.stringify(quotaFetch.calls));

/* ---- the rendered card ------------------------------------------------- */

/** Render the component with the standard props the renderer would bind. */
function render(view) {
  return cardRegistration.component({
    view,
    ...face,
    useQoderCard: (selector) => selector(face.hooks.qoderCard.getSnapshot()),
  });
}

/** Every element in a rendered tree, flattened. */
function walk(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out; }
  if (node === null || node === undefined || typeof node !== "object") return out;
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}

check("summary renders one line", typeof render("summary") === "object" && render("summary").type === "span");

/* ---- the quota block ---------------------------------------------------- */

/** Let the deferred first read and its snapshot publication settle. */
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve)); };

// A summary render is the bundle's row one-liner, not someone opening the card:
// it must not read the balance.
await settle();
check("a summary render reads no quota", quotaFetch.calls.length === 0, JSON.stringify(quotaFetch.calls));

// Opening the page does read it, from the Host's own route.
render("page");
await settle();
check("the page reads the quota route", quotaFetch.calls[0] === "qoder/quota", JSON.stringify(quotaFetch.calls));
// The gap between the first commit and the effect that starts the read is not a
// fact about the account: it must not claim the regions have no token.
const idleQuota = { status: "idle", regions: [], busy: false };
const idleTree = walk(cardRegistration.component({
  view: "page",
  ...face,
  // Only the quota block is idle here: the rest of the snapshot stays real, so
  // the token rows still render and the assertion is about the quota block.
  useQoderCard: (selector) => selector({ ...face.hooks.qoderCard.getSnapshot(), quota: idleQuota }),
}));
const idleTexts = idleTree.filter((node) => node.type === "p")
  .map((node) => node.children.filter((child) => typeof child === "string").join(""));
check("an idle read renders as loading, not as an unconfigured region",
  idleTexts.some((text) => text.includes("Reading quota")), JSON.stringify(idleTexts));
check("a missing route reports the deployment as unserved",
  face.hooks.qoderCard.getSnapshot().quota.status === "unserved",
  JSON.stringify(face.hooks.qoderCard.getSnapshot().quota));

quotaFetch.status = 200;
quotaFetch.body = {
  regions: [
    { mode: "global", configured: true, quota: {
      status: "fresh",
      snapshot: { userQuota: { total: 1000, used: 127.5, remaining: 872.5, unit: "credits" }, expiresAt: 1790812800000 },
      updatedAt: 1,
    } },
    { mode: "cn", configured: false, quota: { status: "unavailable", error: "No token for this region" } },
  ],
};
await face.refreshQuota(true);
check("a refresh asks upstream through the route", quotaFetch.calls.at(-1) === "qoder/quota?refresh=1",
  JSON.stringify(quotaFetch.calls));
const quotaState = face.hooks.qoderCard.getSnapshot().quota;
check("the read publishes both regions", quotaState.regions.length === 2, JSON.stringify(quotaState));
check("a configured region is ready", quotaState.regions.find((r) => r.mode === "global")?.quota.status === "fresh");

const quotaNodes = walk(render("page")).filter((node) => node.props?.["data-qoder-quota"] !== undefined);
check("the card renders one quota row per region", quotaNodes.length === 2, String(quotaNodes.length));
const quotaText = JSON.stringify(quotaNodes);
check("the balance shows the used/total split", quotaText.includes("127.5/1,000"), quotaText);
check("the balance shows what is left, with its unit", quotaText.includes("872.5 credits"), quotaText);
check("a region without a token says so", quotaText.includes("no access token"), quotaText);
check("the leading balance names its bucket", quotaText.includes("Personal · 127.5/1,000"), quotaText);

// An enterprise plan reports only an organization resource package, and that is
// the only balance the person can act on: it must be the prominent line, not a
// muted footnote under a missing personal quota.
const enterprise = walk(cardRegistration.component({
  view: "page",
  ...face,
  useQoderCard: (selector) => selector({
    ...face.hooks.qoderCard.getSnapshot(),
    quota: {
      status: "ready",
      busy: false,
      regions: [{
        mode: "global", configured: true, quota: {
          status: "fresh", updatedAt: 1,
          snapshot: {
            orgResourcePackage: { total: 3558, used: 21, remaining: 3537, unit: "credits" },
            expiresAt: 1796054400000,
          },
        },
      }],
    },
  }),
}));
const enterpriseRow = enterprise.find((node) => node.props?.["data-qoder-quota"] === "global");
// The row's own <p> is the region title, so the body lines start at the second.
const enterpriseLines = walk(enterpriseRow).filter((node) => node.type === "p").slice(1)
  .map((node) => node.children.join(""));
check("an organization-only account leads with its package",
  enterpriseLines[0]?.includes("Organization · 21/3,558"), JSON.stringify(enterpriseLines));
check("an organization-only account never claims an unavailable quota",
  !enterpriseLines.some((text) => text.includes("Quota unavailable")), JSON.stringify(enterpriseLines));
check("the block states the figure is account-wide",
  JSON.stringify(walk(render("page"))).includes("Account-wide period totals"));
const refreshButton = walk(render("page")).find((node) => node.type === "button" && JSON.stringify(node.children).includes("Refresh"));
check("the block offers a refresh action", refreshButton !== undefined);
const refreshCalls = quotaFetch.calls.length;
refreshButton.props.onClick();
await settle();
check("the refresh action re-reads the quota", quotaFetch.calls.length === refreshCalls + 1,
  JSON.stringify(quotaFetch.calls.slice(refreshCalls)));

// A failed read keeps the rows and their numbers: a balance someone is reading
// must not be replaced by an error line.
quotaFetch.status = 500;
await face.refreshQuota(true);
const afterFailure = face.hooks.qoderCard.getSnapshot().quota;
check("a failed refresh keeps the last rows", afterFailure.regions.length === 2, JSON.stringify(afterFailure));
check("a failed refresh reports its cause", typeof afterFailure.error === "string", JSON.stringify(afterFailure.error));
check("a failed refresh re-enables the refresh action",
  walk(render("page")).find((node) => node.type === "button" && JSON.stringify(node.children).includes("Refresh") ||
    JSON.stringify(node.children).includes("Reading")).props.disabled === false);

// Restore a good answer for the rest of the run.
quotaFetch.status = 200;
quotaFetch.body = { regions: [] };
await face.refreshQuota(true);

const summary = walk(render("page"));
const tokenInputs = summary.filter((node) => node.type === "input" && node.props.type === "password");
check("the page has one token input per region", tokenInputs.length === 2, String(tokenInputs.length));
check("the token inputs are editable before any token exists", tokenInputs.every((node) => node.props.disabled === false));

// Typing a token stages it without writing anything: the draft is what a save sends.
tokenInputs[0].props.onChange({ target: { value: " pt-typed " } });
await new Promise((resolve) => setTimeout(resolve));
check("typing a token writes nothing", calls.set.length === 0, JSON.stringify(calls.set));
const afterTyping = walk(render("page")).filter((node) => node.type === "input" && node.props.type === "password");
check("the typed token shows in its own field", afterTyping[0].props.value === " pt-typed ", JSON.stringify(afterTyping[0].props.value));
check("the other region keeps its empty field", afterTyping[1].props.value === "");

// Saving writes the credential; a save that changes no knob leaves the
// Config section alone.
await face.save();
check("a staged token is stored under its reference", calls.set[0]?.[0] === "QODER_API_KEY", JSON.stringify(calls.set));
check("the stored token is trimmed", calls.set[0]?.[1] === "pt-typed", JSON.stringify(calls.set));
const written = mutateOps.flatMap((entry) => entry.ops.map((op) => [op.op, op.path.join("."), op.value]));
check("a save that only stores a token writes no Config field", written.length === 0, JSON.stringify(written));
check("the saved snapshot reports success", face.hooks.qoderCard.getSnapshot().saved === true);
check("the saved snapshot clears the staged token",
  face.hooks.qoderCard.getSnapshot().drafts.QODER_API_KEY === undefined);
check("the region now reads as configured",
  face.hooks.qoderCard.getSnapshot().tokens.QODER_API_KEY?.configured === true,
  JSON.stringify(face.hooks.qoderCard.getSnapshot().tokens));
const configuredInputs = walk(render("page")).filter((node) => node.type === "input" && node.props.type === "password");
check("a configured region offers the keep-it placeholder",
  configuredInputs[0].props.placeholder.includes("Saved"), configuredInputs[0].props.placeholder);
check("a configured region shows a masked preview",
  walk(render("page")).some((node) => Array.isArray(node.children)
    && node.children.some((child) => typeof child === "string" && child.includes("pt-***"))),
  JSON.stringify(walk(render("page")).flatMap((node) => node.children).filter((c) => typeof c === "string")));

// A refused credential write must surface, and must not write the Config section.
const before = mutateOps.length;
const cnInput = walk(render("page")).filter((node) => node.type === "input" && node.props.type === "password")[1];
cnInput.props.onChange({ target: { value: "refuse-me" } });
await face.save();
check("a refused credential write is shown", face.hooks.qoderCard.getSnapshot().failure !== undefined,
  String(face.hooks.qoderCard.getSnapshot().failure));
check("a refused credential write skips the Config write", mutateOps.length === before, String(mutateOps.length));

// A blank optional field writes nothing; an invalid one blocks the save.
// The field shows the Host's resolved value, so clearing it is what makes the
// next save leave the field alone.
// Number inputs in render order: the custom window, then the numeric knobs.
const numberInputs = () => walk(render("page")).filter((node) => node.type === "input" && node.props.type === "number");
const outputInput = () => numberInputs()[1];
face.editNumber("output", "0");
const blocked = await face.save().then(() => face.hooks.qoderCard.getSnapshot());
check("an out-of-range output cap blocks the save",
  blocked.failure?.kind === "problem" && blocked.failure.problem.kind === "notInteger",
  JSON.stringify(blocked.failure));
check("the blocked rule names the field and its bound",
  blocked.failure.kind === "problem" && blocked.failure.problem.field === "field.output" && blocked.failure.problem.min === 1,
  JSON.stringify(blocked.failure));
check("a blocked save writes nothing", mutateOps.length === before, String(mutateOps.length));
// Correct the refused CN token so the next save is not blocked by it.
face.editToken("QODER_CN_API_KEY", "");
face.editNumber("output", "");
face.editNumber("delta", "0");
await face.save();
const afterFix = face.hooks.qoderCard.getSnapshot();
check("a corrected draft saves", afterFix.failure === undefined, String(afterFix.failure));
const lastOps = mutateOps[mutateOps.length - 1].ops.map((op) => [op.op, op.path.join("."), op.value]);
check("a zero delta interval is written", lastOps.some(([, path, value]) => path === "streamDeltaIntervalMs" && value === 0), JSON.stringify(lastOps));
check("a cleared output cap writes nothing", !lastOps.some(([, path]) => path === "maxOutputTokens"), JSON.stringify(lastOps));
check("the field renders the stored cap again", outputInput()?.props.value === "4096", JSON.stringify(outputInput()?.props.value));

// Switching the context window and saving must reach the Host. This is the
// interaction that used to die silently: `draftOps` read a `windowText` field the
// controller never supplied, so any mode *change* threw before the write, and
// the card — which calls `void save()` — showed nothing at all.
const radioInputs = () => walk(render("page")).filter((node) => node.type === "input" && node.props.type === "radio");
check("the page offers three window modes", radioInputs().length === 3, String(radioInputs().length));
const opsBeforeMode = mutateOps.length;
const savedBeforeMode = calls.set.length;
radioInputs()[1].props.onChange({ target: { checked: true } });
check("choosing a mode stages it without writing", mutateOps.length === opsBeforeMode && calls.set.length === savedBeforeMode);
await face.save();
const afterMode = face.hooks.qoderCard.getSnapshot();
check("a mode change writes the Config section", mutateOps.length === opsBeforeMode + 1,
  `${mutateOps.length - opsBeforeMode} write(s)`);
const modeOps = mutateOps.at(-1).ops.map((op) => [op.op, op.path.join("."), op.value]);
check("the max mode sets its flag", modeOps.some(([, path, value]) => path === "useMaxContext" && value === true),
  JSON.stringify(modeOps));
check("the max mode drops any explicit window", modeOps.some(([op, path]) => op === "unset" && path === "contextWindow"),
  JSON.stringify(modeOps));
check("a mode change reports no failure", afterMode.failure === undefined, JSON.stringify(afterMode.failure));
check("a mode change reports success", afterMode.saved === true, JSON.stringify(afterMode));
check("the max radio is the selected one", radioInputs()[1].props.checked === true);

// A Host that does not serve the namespace keeps the knobs closed but the
// credential rows usable: tokens live in a different store.
section.set({ status: "unavailable", writable: false });
const unavailable = face.hooks.qoderCard.getSnapshot();
check("an unserved namespace is not editable", unavailable.editable === false, JSON.stringify(unavailable));
const unservedInputs = walk(render("page")).filter((node) => node.type === "input" && node.props.type === "password");
check("tokens stay writable without a served namespace", unservedInputs.every((node) => node.props.disabled === false),
  JSON.stringify(unservedInputs.map((node) => node.props.disabled)));
const saveButton = walk(render("page")).find((node) => node.type === "button");
check("a token can still be saved", saveButton.props.disabled === false);
// The quota block is the Host's other store, so it survives a deployment that
// serves no writable Config section.
check("the quota block survives an unserved Config section",
  walk(render("page")).filter((node) => node.props?.["data-qoder-quota"] !== undefined).length === 2);
const opsBefore = mutateOps.length;
const setBefore = calls.set.length;
unservedInputs[0].props.onChange({ target: { value: "pt-orphan" } });
await face.save();
check("an unserved save stores the token", calls.set.length === setBefore + 1 && calls.set.at(-1)[1] === "pt-orphan",
  JSON.stringify(calls.set.slice(setBefore)));
check("an unserved save leaves the Config section alone", mutateOps.length === opsBefore, String(mutateOps.length));
check("an unserved save reports success", face.hooks.qoderCard.getSnapshot().saved === true);

// A knob edit the deployment cannot write must not answer "saved": the card used
// to claim success for a change that never left the browser.
// The degraded card renders no radios, so the controller action stages it.
face.setMode("catalog");
const strandedOps = mutateOps.length;
await face.save();
const stranded = face.hooks.qoderCard.getSnapshot();
check("a stranded knob edit is reported",
  stranded.failure?.kind === "problem" && stranded.failure.problem.kind === "notServed",
  JSON.stringify(stranded.failure));
check("a stranded knob edit claims no success", stranded.saved === false, JSON.stringify(stranded.saved));
check("a stranded knob edit writes nothing", mutateOps.length === strandedOps, String(mutateOps.length));

console.log(failures === 0 ? "client card: OK" : `client card: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
