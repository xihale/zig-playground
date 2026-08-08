#!/usr/bin/env node
/**
 * Download all <id>.tar.gz from a GitHub Release and fill any missing
 * public/compilers/<id>/ trees listed in versions.json.
 *
 * Does not overwrite existing meta.json for an id (keeps freshly built trees).
 *
 *   node scripts/fill-compilers-from-release.mjs
 *   node scripts/fill-compilers-from-release.mjs --tag compilers
 *   node scripts/fill-compilers-from-release.mjs --require-all
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadVersionsManifest, root } from "./versions-lib.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const tag = arg("--tag", process.env.COMPILERS_RELEASE || "compilers");
const requireAll = process.argv.includes("--require-all");
const requireStable = process.argv.includes("--require-stable");

const manifest = loadVersionsManifest();
const missing = manifest.versions.filter(
  (v) => !existsSync(join(root, "public", "compilers", v.id, "meta.json")),
);

if (missing.length === 0) {
  console.log("fill: all versions.json ids already packaged");
  process.exit(0);
}

console.log(
  `fill: missing ${missing.map((v) => v.id).join(", ")} — download release ${tag}`,
);

const repo =
  process.env.GITHUB_REPOSITORY ||
  (() => {
    const r = spawnSync(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error("set GITHUB_REPOSITORY or run inside a gh repo");
    return r.stdout.trim();
  })();

const tmp = join(root, ".zig-version-cache", "release-download");
mkdirSync(tmp, { recursive: true });
// clean previous extract
for (const name of readdirSync(tmp)) {
  rmSync(join(tmp, name), { recursive: true, force: true });
}

const dl = spawnSync(
  "gh",
  ["release", "download", tag, "--repo", repo, "--dir", tmp, "--clobber", "--pattern", "*.tar.gz"],
  { stdio: "inherit", env: process.env },
);
if (dl.status !== 0) {
  console.error(`fill: failed to download release ${tag} from ${repo}`);
  failIfRequired(missing);
  process.exit(requireAll || requireStable ? 1 : 0);
}

// Extract each <id>.tar.gz into stage/compilers/<id>/ (flat — files at archive root).
const stage = join(tmp, "stage");
mkdirSync(join(stage, "compilers"), { recursive: true });
for (const name of readdirSync(tmp)) {
  if (!name.endsWith(".tar.gz") || name === "compilers.tar.gz") continue;
  const id = name.replace(/\.tar\.gz$/, "");
  const dest = join(stage, "compilers", id);
  mkdirSync(dest, { recursive: true });
  const x = spawnSync("tar", ["-xzf", join(tmp, name), "-C", dest], { stdio: "inherit" });
  if (x.status !== 0) {
    console.error(`fill: failed to extract ${name}`);
    process.exit(1);
  }
  console.log(`  extracted ${name} → ${id}`);
}

const publicCompilers = join(root, "public", "compilers");
mkdirSync(publicCompilers, { recursive: true });

for (const v of missing) {
  const src = join(stage, "compilers", v.id);
  const dest = join(publicCompilers, v.id);
  if (existsSync(join(src, "meta.json"))) {
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log(`  ${v.id}: filled from release`);
  } else {
    console.warn(`  ${v.id}: not in release`);
  }
}

const still = manifest.versions.filter(
  (v) => !existsSync(join(publicCompilers, v.id, "meta.json")),
);
for (const v of manifest.versions) {
  const ok = existsSync(join(publicCompilers, v.id, "meta.json"));
  console.log(`  matrix ${v.id}: ${ok ? "ok" : "MISSING"}`);
}

failIfRequired(still);
if (still.length && (requireAll || requireStable)) process.exit(1);
process.exit(0);

function failIfRequired(stillMissing) {
  if (!stillMissing.length) return;
  if (requireAll) {
    console.error("fill: --require-all and still missing:", stillMissing.map((v) => v.id).join(", "));
  }
  if (requireStable) {
    const stableMiss = stillMissing.filter((v) => !v.schedule);
    if (stableMiss.length) {
      console.error(
        "fill: --require-stable and still missing:",
        stableMiss.map((v) => v.id).join(", "),
      );
      process.exit(1);
    }
  }
}
