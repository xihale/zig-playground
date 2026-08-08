#!/usr/bin/env node
/**
 * Copy a local zig-out tree into public/compilers/<id>/ (or --to).
 * Large binaries stay out of git — only run this locally / in CI.
 *
 * Usage:
 *   node scripts/package-compiler.mjs --id 0.15.2
 *   node scripts/package-compiler.mjs --id 0.15.2 --from zig-out --to public/compilers/0.15.2
 */

import { cpSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function sha256OfFile(filePath, shortLen = 12) {
  const h = createHash("sha256").update(readFileSync(filePath));
  const full = h.digest("hex");
  return { full, short: full.slice(0, shortLen) };
}

/** logical base name → hashed physical filename */
function hashedName(logicalName, hash) {
  const dot = logicalName.indexOf(".");
  if (dot <= 0) return `${logicalName}.${hash}`;
  const base = logicalName.slice(0, dot);
  const rest = logicalName.slice(dot);  // includes the dot, e.g. ".tar.gz" or ".wasm"
  return `${base}.${hash}${rest}`;
}

const id = arg("--id");
if (!id) {
  console.error("usage: package-compiler.mjs --id <versionId> [--from zig-out] [--to public/compilers/<id>]");
  process.exit(1);
}

const from = resolve(root, arg("--from", "zig-out"));
const to = resolve(root, arg("--to", join("public", "compilers", id)));
const optionalZls = process.argv.includes("--optional-zls");

const logicalFiles = [
  { src: join(from, "bin", "zig.wasm"), logical: "zig.wasm", required: true },
  { src: join(from, "bin", "zls.wasm"), logical: "zls.wasm", required: !optionalZls },
  { src: join(from, "libcompiler_rt.a"), logical: "libcompiler_rt.a", required: true },
  { src: join(from, "zig.tar.gz"), logical: "zig.tar.gz", required: true },
];

for (const f of logicalFiles) {
  if (!existsSync(f.src)) {
    if (f.required) {
      console.error(`missing ${f.src} — run zig build first`);
      process.exit(1);
    }
    console.warn(`optional missing ${f.src} — skipping`);
  }
}

mkdirSync(to, { recursive: true });
const metaFiles = {};
for (const f of logicalFiles) {
  if (!existsSync(f.src)) continue;
  const { full, short } = sha256OfFile(f.src);
  const destName = hashedName(f.logical, short);
  const dest = join(to, destName);
  cpSync(f.src, dest);
  const size = statSync(dest).size;
  metaFiles[f.logical] = { size, sha256: full, name: destName };
  console.log(`  ${destName}  (${size} bytes)`);
}

const meta = {
  id,
  builtAt: new Date().toISOString(),
  files: metaFiles,
};
writeFileSync(join(to, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(`packaged compiler "${id}" → ${to}`);
