/**
 * Build both faces of the package.
 *
 * `index.js` is the Host half: an ESM bundle esbuild produces. `lib/client.js`
 * is the browser half, which DSH's client module system serves from the
 * package's `./client` export. That artifact must be a single classic script
 * that registers a lazy CommonJS factory under the package name, so it is
 * bundled to CJS first and then wrapped in the `window.__ModuleLoader__.load`
 * envelope the loader expects.
 *
 * Only `react` and `react/jsx-runtime` stay external: they are in the shell's
 * platform module table. Everything else — including the form logic shared with
 * the Host — is inlined, because a `require()` the table cannot answer throws at
 * first materialization.
 */
import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const PACKAGE = "@local/dsh-llm-qoder";
const CLIENT_OUT = "lib/client.js";

/** Module-table specifiers the browser half may require. */
const CLIENT_EXTERNALS = ["react", "react/jsx-runtime"];

await build({
  entryPoints: ["src/index.ts"],
  outfile: "index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  logLevel: "info",
});

await build({
  entryPoints: ["src/client/index.ts"],
  outfile: CLIENT_OUT,
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: CLIENT_EXTERNALS,
  sourcemap: false,
  logLevel: "info",
});

// The card's form logic, emitted as plain ESM so a Node smoke test can drive
// the same rules the browser runs. Not exported; it exists for the tests.
await build({
  entryPoints: ["src/client/form.ts"],
  outfile: "lib/form.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "error",
});

const body = await readFile(CLIENT_OUT, "utf8");
await writeFile(
  CLIENT_OUT,
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE)}, `
  + `factory: (require) => { var module = { exports: {} }; var exports = module.exports; ${body}\n`
  + "return module.exports; } });\n",
  "utf8",
);
