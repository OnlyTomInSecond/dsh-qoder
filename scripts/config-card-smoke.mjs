// Offline check of the configuration card's form logic and of the model-list
// gate. No network, no DSH install: the card's rules are pure functions, and
// the adapter is driven with fake Host services.
import {
  MAX_OUTPUT_TOKENS_LIMIT, TOKEN_REFS, draftOps, numberAt, profileOps, tokenDrafts, windowModeOf,
} from "../lib/form.js";
import { apply } from "../index.js";

let failures = 0;
function check(label, condition, detail) {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
}

/** A draft with every field at its default, overridden per call. */
const draft = (overrides = {}) => ({
  mode: "catalog", windowText: "", outputText: "", idleText: "", deltaText: "",
  reasoning: "none", debug: false, ...overrides,
});

const opAt = (ops, path) => ops.find((op) => op.path[0] === path);

// ---- context window modes ------------------------------------------------
{
  const { ops } = draftOps(draft({ mode: "catalog" }));
  check("catalog unsets the explicit window", opAt(ops, "contextWindow")?.op === "unset");
  check("catalog clears the max flag", opAt(ops, "useMaxContext")?.value === false);
}
{
  const { ops } = draftOps(draft({ mode: "max" }));
  check("max unsets the explicit window", opAt(ops, "contextWindow")?.op === "unset");
  check("max sets the flag", opAt(ops, "useMaxContext")?.value === true);
}
{
  const { ops } = draftOps(draft({ mode: "custom", windowText: "400000" }));
  check("custom sets the window", opAt(ops, "contextWindow")?.value === 400000);
  check("custom clears the max flag", opAt(ops, "useMaxContext")?.value === false);
}
{
  const plan = draftOps(draft({ mode: "custom", windowText: "" }));
  check("custom without a number is refused", "problem" in plan, JSON.stringify(plan));
}
{
  const plan = draftOps(draft({ mode: "custom", windowText: "1.5" }));
  check("a fractional window is refused", "problem" in plan, JSON.stringify(plan));
}

// ---- other knobs ---------------------------------------------------------
{
  const { ops } = draftOps(draft({ deltaText: "0" }));
  check("a zero delta interval is accepted", opAt(ops, "streamDeltaIntervalMs")?.value === 0);
}
{
  const plan = draftOps(draft({ outputText: String(MAX_OUTPUT_TOKENS_LIMIT + 1) }));
  check("an over-limit output cap is refused", "problem" in plan, JSON.stringify(plan));
}
{
  const { ops } = draftOps(draft({ reasoning: "last", debug: true }));
  check("replay policy is written", opAt(ops, "replayReasoning")?.value === "last");
  check("debug is written", opAt(ops, "debug")?.value === true);
}
{
  const { ops } = draftOps(draft({ outputText: "", idleText: "", deltaText: "" }));
  check("blank optional fields write nothing", !opAt(ops, "maxOutputTokens") && !opAt(ops, "streamIdleTimeoutMs"));
}

// ---- helpers -------------------------------------------------------------
check("blank parses to undefined", numberAt("  ") === undefined);
check("zero parses only with min 0", numberAt("0") === undefined && numberAt("0", 0) === 0);
check("stored window implies custom mode", windowModeOf({ contextWindow: 200000 }) === "custom");
check("useMaxContext implies max mode", windowModeOf({ useMaxContext: true }) === "max");
check("neither implies catalog mode", windowModeOf({}) === "catalog");

// ---- token drafts and profile edits --------------------------------------
{
  const stored = tokenDrafts({ QODER_API_KEY: " pt-a ", QODER_CN_API_KEY: "  " });
  check("only non-blank tokens are stored", stored.length === 1 && stored[0].value === "pt-a", JSON.stringify(stored));
  const ops = profileOps(stored, {});
  check("a stored token marks its profile", opAt(ops, "providers")?.path[1] === "qoder", JSON.stringify(ops));
  check("the profile names the token reference", opAt(ops, "providers")?.value.apiKeyEnv === "QODER_API_KEY");
  const again = profileOps(stored, { qoder: { apiKeyEnv: "QODER_API_KEY" } });
  check("an existing profile is not rewritten", again.length === 0, JSON.stringify(again));
}
check("both regions have a reference", TOKEN_REFS.length === 2);

// ---- the model list follows the token, not the profile -------------------
{
  const tokens = new Map();
  const credentials = {
    async describe(ref) { return { configured: tokens.has(ref), writable: true }; },
    async resolve(ref) { return tokens.has(ref) ? { value: tokens.get(ref) } : undefined; },
    async set(ref, value) { tokens.set(ref, value); },
    async unset(ref) { tokens.delete(ref); },
    async readRecord() { return undefined; },
    async modifyRecord() {},
  };
  const settings = { describe: () => [], mutate: async () => {} };
  let adapter;
  apply({
    llm: { registerAdapter(_providers, instance) { adapter = instance; return {}; } },
    get(name) {
      if (name === "credentials") return credentials;
      if (name === "settings") return settings;
      return undefined;
    },
    inject(_deps, callback) { callback({ effect() {} }); return {}; },
  }, { providers: { get: () => ({}) } });

  check("no token means no models", (await adapter.listModels("qoder")).length === 0);
  tokens.set("QODER_API_KEY", "jt-orphan");
  const models = await adapter.listModels("qoder");
  check("a token without a profile entry still lists models", models.length > 0, `${models.length} models`);
  tokens.delete("QODER_API_KEY");
  check("a cleared token lists nothing again", (await adapter.listModels("qoder")).length === 0);
}

console.log(failures === 0 ? "config card: OK" : `config card: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
