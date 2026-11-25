// Offline check of the card's pure form rules and of the model-list gate. No
// network, no DSH install: the rules are pure functions, and the adapter is
// driven with fake Host services.
import {
  MAX_OUTPUT_TOKENS_LIMIT, NUMBER_FIELDS, TOKEN_REFS, draftOps, numberAt, tokenDrafts, windowModeOf,
} from "../lib/form.js";

import { apply } from "../index.js";

let failures = 0;
function check(label, condition, detail) {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
}

/**
 * A draft with every field at its default, overridden per call. The shape is the
 * card's own snapshot slice, so a rename in either place fails here rather than
 * in the browser: `window` (not `windowText`) is what the controller hands over.
 */
const draft = (overrides = {}) => ({
  mode: "catalog", window: "", fields: { output: "", idle: "", delta: "" },
  reasoning: "none", debug: false, ...overrides,
});

const opAt = (ops, path) => ops.find((op) => op.path[0] === path);

// ---- context window modes ------------------------------------------------
{
  // Switching FROM a stored custom window TO the catalog default: the mode
  // writes what the switch needs, and nothing else.
  const before = { contextWindow: 400000 };
  const { ops } = draftOps(draft({ mode: "catalog" }), before);
  check("catalog unsets the explicit window", opAt(ops, "contextWindow")?.op === "unset");
  check("catalog clears the max flag", opAt(ops, "useMaxContext")?.value === false);
}
{
  const { ops } = draftOps(draft({ mode: "max" }), {});
  check("max unsets the explicit window", opAt(ops, "contextWindow")?.op === "unset");
  check("max sets the flag", opAt(ops, "useMaxContext")?.value === true);
}
{
  const { ops } = draftOps(draft({ mode: "custom", window: "400000" }), {});
  check("custom sets the window", opAt(ops, "contextWindow")?.value === 400000);
  check("custom clears the max flag", opAt(ops, "useMaxContext")?.value === false);
}
{
  const { ops } = draftOps(draft({ mode: "custom", window: "400000" }), { contextWindow: 200000 });
  check("an edited custom window rewrites only the window", opAt(ops, "contextWindow")?.value === 400000
    && opAt(ops, "useMaxContext") === undefined, JSON.stringify(ops));
}
{
  const plan = draftOps(draft({ mode: "catalog" }), {});
  check("an unchanged mode writes no mode field", !("problem" in plan)
    && !opAt(plan.ops, "contextWindow") && !opAt(plan.ops, "useMaxContext"), JSON.stringify(plan));
}
{
  const plan = draftOps(draft({ mode: "custom", window: "" }), {});
  check("custom without a number is refused",
    "problem" in plan && plan.problem.kind === "notInteger" && plan.problem.field === "field.window", JSON.stringify(plan));
  const fractional = draftOps(draft({ mode: "custom", window: "1.5" }), {});
  check("a fractional window is refused", "problem" in fractional, JSON.stringify(fractional));
  // A custom window stays validated even when the stored mode is already custom.
  const unchanged = draftOps(draft({ mode: "custom", window: "" }), { contextWindow: 200000 });
  check("an emptied custom window is still refused", "problem" in unchanged, JSON.stringify(unchanged));
}

// ---- other knobs ---------------------------------------------------------
{
  const { ops } = draftOps(draft({ fields: { output: "", idle: "", delta: "0" } }));
  check("a zero delta interval is accepted", opAt(ops, "streamDeltaIntervalMs")?.value === 0);
}
{
  const over = String(MAX_OUTPUT_TOKENS_LIMIT + 1);
  const tooBig = draftOps(draft({ fields: { output: over, idle: "", delta: "" } }));
  check("an over-limit output cap is refused",
    "problem" in tooBig && tooBig.problem.kind === "overMax" && tooBig.problem.max === MAX_OUTPUT_TOKENS_LIMIT, JSON.stringify(tooBig));
  const { ops } = draftOps(draft({ fields: { output: "8192", idle: "30000", delta: "" } }));
  check("an output cap is written", opAt(ops, "maxOutputTokens")?.value === 8192);
  check("an idle timeout is written", opAt(ops, "streamIdleTimeoutMs")?.value === 30000);
  check("a blank delta interval writes nothing", !opAt(ops, "streamDeltaIntervalMs"));
}
{
  // A save that stores only a token must not pin the other knobs.
  const current = { maxOutputTokens: 32768, replayReasoning: "none", debug: false };
  const { ops } = draftOps(draft({ fields: { output: "32768", idle: "", delta: "" } }), current);
  check("an unchanged cap is not rewritten", !opAt(ops, "maxOutputTokens"), JSON.stringify(ops));
  check("an unchanged replay policy is not rewritten", !opAt(ops, "replayReasoning"), JSON.stringify(ops));
  check("an unchanged debug flag is not rewritten", !opAt(ops, "debug"), JSON.stringify(ops));
}
{
  const { ops } = draftOps(draft({ reasoning: "last", debug: true }));
  check("replay policy is written", opAt(ops, "replayReasoning")?.value === "last");
  check("debug is written", opAt(ops, "debug")?.value === true);
}
{
  const { ops } = draftOps(draft());
  check("blank optional fields write nothing", !opAt(ops, "maxOutputTokens") && !opAt(ops, "streamIdleTimeoutMs"));
  check("every knob has a distinct Config field", new Set(NUMBER_FIELDS.map((spec) => spec.field)).size === NUMBER_FIELDS.length);
}

// ---- helpers -------------------------------------------------------------
check("blank parses to undefined", numberAt("  ") === undefined);
check("zero parses only with min 0", numberAt("0") === undefined && numberAt("0", 0) === 0);
check("stored window implies custom mode", windowModeOf({ contextWindow: 200000 }) === "custom");
check("useMaxContext implies max mode", windowModeOf({ useMaxContext: true }) === "max");
check("neither implies catalog mode", windowModeOf({}) === "catalog");

// ---- token drafts --------------------------------------------------------
{
  const stored = tokenDrafts({ QODER_API_KEY: " pt-a ", QODER_CN_API_KEY: "  " });
  check("only non-blank tokens are stored", stored.length === 1 && stored[0].value === "pt-a", JSON.stringify(stored));
  check("a stored token keeps its own reference", stored[0].ref === "QODER_API_KEY", JSON.stringify(stored));
  check("the CN token keeps the CN reference", tokenDrafts({ QODER_CN_API_KEY: "jt-a" })[0]?.ref === "QODER_CN_API_KEY");
}
check("both regions have a reference", TOKEN_REFS.length === 2);
check("each region writes only its own reference", TOKEN_REFS.every((entry) => entry.aliases.includes(entry.ref)));
check("the two regions do not share a reference",
  TOKEN_REFS[0].aliases.every((ref) => !TOKEN_REFS[1].aliases.includes(ref)));

// ---- the model list follows the token ------------------------------------
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
  }, {});

  check("no token means no models", (await adapter.listModels("qoder")).length === 0);
  tokens.set("QODER_API_KEY", "jt-orphan");
  const models = await adapter.listModels("qoder");
  check("a token with no profile entry still lists models", models.length > 0, `${models.length} models`);
  tokens.delete("QODER_API_KEY");
  check("a cleared token lists nothing again", (await adapter.listModels("qoder")).length === 0);
}

console.log(failures === 0 ? "config card: OK" : `config card: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
