// Real-call smoke test: lists the live Qoder catalog and, with
// QODER_SMOKE_STREAM=1, streams one short answer through the adapter.
//
// A token is required even to list models, so this needs QODER_API_KEY (or a
// stored credential) exactly like the running plugin does.
import { apply } from "../index.js";

let adapter;
apply({ llm: { registerAdapter(_providers, value) { adapter = value; return {}; } }, get() { return undefined; } }, {});
const models = await adapter.listModels("qoder");
if (models.length === 0) {
  console.log("qoder: no models — set QODER_API_KEY (or the matching CN variable) to list them");
  process.exit(process.env.QODER_API_KEY || process.env.QODER_ACCESS_TOKEN ? 1 : 0);
}
console.log(`qoder: ${models.length} models, first: ${models.slice(0, 5).map((m) => m.id).join(", ")}`);
if (process.env.QODER_SMOKE_STREAM !== "1") process.exit(0);

let text = "";
for await (const chunk of adapter.stream({
  provider: "qoder",
  model: process.env.QODER_SMOKE_MODEL || "Qwen3.8-Flash",
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly QODER_DSH_OK" }] }],
  maxTokens: 64,
})) {
  if (chunk.type === "text-delta") text += chunk.text;
  if (chunk.type === "usage" || chunk.type === "finish") console.log(chunk.type, JSON.stringify(chunk));
}
console.log("text:", JSON.stringify(text));
