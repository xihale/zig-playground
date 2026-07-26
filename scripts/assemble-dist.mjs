#!/usr/bin/env node
/**
 * After `vite build`, finish the multi-version Pages tree:
 * - copy versions.json to dist/
 * - ensure public/compilers was emitted (or copy from public/)
 * - write dist/<id>/index.html and dist/404.html (same SPA shell)
 *
 * Does not build wasm — binaries come from package-compiler.mjs (CI/local).
 */

import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const publicCompilers = join(root, "public", "compilers");

if (!existsSync(join(dist, "index.html"))) {
  console.error("dist/index.html missing — run vite build first");
  process.exit(1);
}

const versions = JSON.parse(readFileSync(join(root, "versions.json"), "utf8"));
writeFileSync(join(dist, "versions.json"), JSON.stringify(versions, null, 2) + "\n");

// Vite copies public/ into dist/; if compilers were packaged there, they land in dist/compilers.
// Also allow packaging straight into dist/compilers before assemble.
if (existsSync(publicCompilers) && !existsSync(join(dist, "compilers"))) {
  cpSync(publicCompilers, join(dist, "compilers"), { recursive: true });
}

const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
copyFileSync(join(dist, "index.html"), join(dist, "404.html"));

for (const v of versions.versions) {
  const dir = join(dist, v.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), indexHtml);
  const compilerDir = join(dist, "compilers", v.id);
  if (!existsSync(compilerDir)) {
    console.warn(`warning: dist/compilers/${v.id} missing — site will 404 those assets`);
  } else {
    const names = readdirSync(compilerDir);
    console.log(`  /${v.id}/  compilers: ${names.join(", ")}`);
  }
}

function dirSize(p) {
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const name of readdirSync(p)) {
    const fp = join(p, name);
    const st = statSync(fp);
    n += st.isDirectory() ? dirSize(fp) : st.size;
  }
  return n;
}

const csize = dirSize(join(dist, "compilers"));
console.log(`assemble-dist: default=${versions.default}, compilers≈${(csize / 1e6).toFixed(1)} MiB`);
console.log("(compilers are deploy artifacts only — never commit them)");
