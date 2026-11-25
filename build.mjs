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
 *
 * Every artifact is written to a sibling temporary file and renamed into place.
 * A running Host watches this package: HMR reads a bundle's size and timestamps
 * to publish its revision, and a page load in the middle of a direct write sees
 * half a file. That happened while verifying this very feature — the index
 * briefly advertised a revision the route could not serve, so a reload during
 * the build window lost the card. A rename is atomic, so a reader sees either
 * the previous artifact or the next one.
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const PACKAGE = "@local/dsh-llm-qoder";
const CLIENT_OUT = "lib/client.js";

/** Module-table specifiers the browser half may require. */
const CLIENT_EXTERNALS = ["react", "react/jsx-runtime"];

let tempSeq = 0;

/**
 * Sibling path to build into before the rename.
 * @param outfile - the final artifact path.
 * @returns a unique temporary path in the same directory, so the rename cannot
 * cross a filesystem boundary.
 */
function siblingTemp(outfile) {
  tempSeq += 1;
  return `${outfile}.tmp-${String(process.pid)}-${String(tempSeq)}`;
}

/**
 * Read a file's bytes, treating a missing file as "no previous artifact".
 * @param path - file to read.
 * @returns the bytes, or undefined when it does not exist.
 */
async function previousBytes(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Move one finished temporary artifact into place, unless it is byte-identical
 * to what is already there.
 *
 * The running Host watches this package and republishes its client revision
 * from the artifact's size and timestamps, so an unchanged rewrite is not free:
 * it invalidates the page's module URL for a build that changed nothing. A
 * skipped rename keeps the artifact — and therefore the graph — untouched.
 * @param temp - the freshly built file.
 * @param outfile - the final artifact path.
 * @returns whether the artifact changed.
 */
async function publish(temp, outfile) {
  const [built, previous] = await Promise.all([readFile(temp), previousBytes(outfile)]);
  if (previous !== undefined && built.equals(previous)) {
    await rm(temp, { force: true });
    return false;
  }
  await rename(temp, outfile);
  return true;
}

/**
 * Run one esbuild invocation into a temporary path and publish it.
 * @param options - the esbuild options; `outfile` is the final artifact.
 */
async function buildAtomically(options) {
  const temp = siblingTemp(options.outfile);
  try {
    await build({ ...options, outfile: temp });
    await publish(temp, options.outfile);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

await buildAtomically({
  entryPoints: ["src/index.ts"],
  outfile: "index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  logLevel: "info",
});

const clientTemp = siblingTemp(CLIENT_OUT);
try {
  await build({
    entryPoints: ["src/client/index.ts"],
    outfile: clientTemp,
    bundle: true,
    platform: "browser",
    format: "cjs",
    target: "es2022",
    external: CLIENT_EXTERNALS,
    sourcemap: false,
    logLevel: "info",
  });
  // The envelope is added here, so the wrapped file is also written through a
  // temporary path: the reader must never see the bare CJS body either.
  const body = await readFile(clientTemp, "utf8");
  const wrapped = siblingTemp(CLIENT_OUT);
  await writeFile(
    wrapped,
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE)}, `
    + `factory: (require) => { var module = { exports: {} }; var exports = module.exports; ${body}\n`
    + "return module.exports; } });\n",
    "utf8",
  );
  await publish(wrapped, CLIENT_OUT);
} finally {
  await rm(clientTemp, { force: true });
}

// The card's form logic, emitted as plain ESM so a Node smoke test can drive
// the same rules the browser runs. Not exported; it exists for the tests.
await buildAtomically({
  entryPoints: ["src/client/form.ts"],
  outfile: "lib/form.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "error",
});
