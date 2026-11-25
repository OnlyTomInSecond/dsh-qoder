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
const React = { createElement: element };

/* ---- the bundle, loaded like the shell loads it ------------------------ */

const registrations = [];
const window = { __ModuleLoader__: { load: (registration) => { registrations.push(registration); } } };
const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
runInNewContext(source, { window, console });
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
