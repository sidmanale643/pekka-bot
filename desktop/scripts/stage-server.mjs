// Builds desktop/server, the copy of Pekka's server that the Mac app runs and ships:
// - src/ compiled to JavaScript, so Electron's Node.js runs it without a TypeScript loader,
// - every other file under src/ (the web UI, base skills) as it is,
// - production dependencies only, installed flat so the app bundle has no symlinks.
// Usage: node scripts/stage-server.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const desktop = join(import.meta.dirname, "..");
const root = join(desktop, "..");
const stage = join(desktop, "server");
const tsc = join(root, "node_modules/typescript/bin/tsc");

if (!existsSync(tsc)) {
  console.error("Run pnpm install in the repository root first: staging compiles the server with its TypeScript.");
  process.exit(1);
}

mkdirSync(stage, { recursive: true });
rmSync(join(stage, "src"), { recursive: true, force: true });

console.log("Compiling src/ to JavaScript…");
writeFileSync(join(stage, "tsconfig.build.json"), JSON.stringify({
  extends: "../../tsconfig.json",
  compilerOptions: { noEmit: false, rootDir: "../../src", outDir: "./src", rewriteRelativeImportExtensions: true },
  include: ["../../src"],
  exclude: ["../../src/**/*.test.ts"],
}, null, 2));
// tsc still writes the files when the code has type errors (exit code 2). They're reported, not fatal:
// the app runs what `pnpm api` would run. `pnpm typecheck` is where they get fixed.
const compiled = spawnSync(process.execPath, [tsc, "-p", join(stage, "tsconfig.build.json")], { stdio: "inherit" });
if (compiled.status !== 0 && compiled.status !== 2) process.exit(compiled.status ?? 1);
if (compiled.status === 2) console.warn("Warning: src/ has type errors (above). Staged anyway.");

for (const file of filesUnder(join(root, "src"))) {
  if (file.endsWith(".ts")) continue;
  cpSync(file, join(stage, "src", relative(join(root, "src"), file)));
}
cpSync(join(desktop, "launcher.mjs"), join(stage, "launcher.mjs"));

// Dependencies change rarely, so they're reinstalled only when the manifest or lockfile does.
const manifests = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
const hash = createHash("sha256");
for (const name of manifests) hash.update(readFileSync(join(root, name)));
const digest = hash.digest("hex");
const stamp = join(stage, ".deps-hash");
if (existsSync(join(stage, "node_modules")) && existsSync(stamp) && readFileSync(stamp, "utf8") === digest) {
  console.log("Production dependencies are up to date.");
} else {
  console.log("Installing production dependencies…");
  for (const name of manifests) cpSync(join(root, name), join(stage, name));
  rmSync(join(stage, "node_modules"), { recursive: true, force: true });
  execFileSync("pnpm", ["install", "--prod", "--frozen-lockfile", "--config.node-linker=hoisted"], { cwd: stage, stdio: "inherit" });
  // Command shims are symlinks the server never uses.
  rmSync(join(stage, "node_modules/.bin"), { recursive: true, force: true });
  // Nor does it load type declarations, source maps, TypeScript sources or docs: about a third of the bytes.
  // License files stay, whatever their extension.
  for (const file of filesUnder(join(stage, "node_modules"))) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (/^licen[cs]e/i.test(name)) continue;
    if (/\.(d\.[cm]?ts|map|md|[cm]?ts)$/i.test(name)) rmSync(file);
  }
  writeFileSync(stamp, digest);
}
console.log(`Staged Pekka's server in ${relative(process.cwd(), stage) || "."}`);

function filesUnder(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}
