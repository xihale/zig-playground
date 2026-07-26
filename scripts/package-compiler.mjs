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

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const id = arg("--id");
if (!id) {
  console.error("usage: package-compiler.mjs --id <versionId> [--from zig-out] [--to public/compilers/<id>]");
  process.exit(1);
}

const from = resolve(root, arg("--from", "zig-out"));
const to = resolve(root, arg("--to", join("public", "compilers", id)));

const files = [
  { src: join(from, "bin", "zig.wasm"), dest: "zig.wasm" },
  { src: join(from, "bin", "zls.wasm"), dest: "zls.wasm" },
  { src: join(from, "libcompiler_rt.a"), dest: "libcompiler_rt.a" },
  { src: join(from, "zig.tar.gz"), dest: "zig.tar.gz" },
];

for (const f of files) {
  if (!existsSync(f.src)) {
    console.error(`missing ${f.src} — run zig build first`);
    process.exit(1);
  }
}

mkdirSync(to, { recursive: true });
const metaFiles = {};
for (const f of files) {
  const dest = join(to, f.dest);
  cpSync(f.src, dest);
  metaFiles[f.dest] = statSync(dest).size;
  console.log(`  ${f.dest}  (${metaFiles[f.dest]} bytes)`);
}

const meta = {
  id,
  builtAt: new Date().toISOString(),
  files: metaFiles,
};
writeFileSync(join(to, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(`packaged compiler "${id}" → ${to}`);
