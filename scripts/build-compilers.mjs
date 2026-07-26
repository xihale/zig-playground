#!/usr/bin/env node
/**
 * Read versions.json and build + package each selected compiler id.
 *
 * Usage:
 *   node scripts/build-compilers.mjs --select stable
 *   node scripts/build-compilers.mjs --select scheduled
 *   node scripts/build-compilers.mjs --select all
 *   node scripts/build-compilers.mjs --only 0.15.2
 *   node scripts/build-compilers.mjs --only master --only 0.15.2
 *   node scripts/build-compilers.mjs --select stable --no-wasm-opt
 *   node scripts/build-compilers.mjs --select stable --skip-existing
 *   node scripts/build-compilers.mjs --dry-run
 *
 * Selection:
 *   stable     — entries without `schedule`
 *   scheduled  — entries with `schedule` (periodic / manual master job)
 *   all        — every entry
 *   --only id  — explicit ids (can repeat); overrides --select
 *   --skip-existing — skip ids that already have public/compilers/<id>/zig.wasm
 *
 * For each id:
 *   1) resolve Zig sources (local path preferred, else git clone cache)
 *   2) write build.zig.zon for that id's zls + zig path
 *   3) zig build -Drelease [-Dwasm-opt] -Dzig-version-string=…
 *   4) package into public/compilers/<id>/
 *
 * Large binaries never go to git. CI Deploy reuses Release assets; only build
 * when a packaged tree is missing (or you run this script on purpose).
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadVersionsManifest,
  selectVersions,
  resolveLocalZigPath,
  root,
} from "./versions-lib.mjs";

function parseArgs(argv) {
  const only = [];
  let select = "all";
  let wasmOpt = true;
  let dryRun = false;
  let releaseTag = process.env.COMPILERS_RELEASE || "compilers-latest";
  let fillMissing = false;
  let skipExisting = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--select") select = argv[++i];
    else if (a === "--only") only.push(argv[++i]);
    else if (a === "--no-wasm-opt") wasmOpt = false;
    else if (a === "--wasm-opt") wasmOpt = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--fill-missing") fillMissing = true;
    else if (a === "--skip-existing") skipExisting = true;
    else if (a === "--release-tag") releaseTag = argv[++i];
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return { only, select, wasmOpt, dryRun, releaseTag, fillMissing, skipExisting };
}

function printHelp() {
  console.log(`Usage: node scripts/build-compilers.mjs [options]

Options:
  --select stable|scheduled|all   Which versions.json entries to build (default: all)
  --only <id>                     Build only this id (repeatable; overrides --select)
  --skip-existing                 Skip ids that already have public/compilers/<id>/zig.wasm
  --no-wasm-opt                   Skip -Dwasm-opt
  --fill-missing                  After build, fetch missing ids from GitHub release
  --release-tag <tag>             Release tag for --fill-missing (default: compilers-latest)
  --dry-run                       Print plan only
`);
}

function isPackaged(id) {
  return existsSync(join(root, "public", "compilers", id, "zig.wasm"));
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
    shell: false,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed with exit ${r.status}`);
  }
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/** Apply optional repo-relative patch after a clean checkout of git.ref. */
function applyZigPatch(entry, dest) {
  const patchRel = entry.zig.patch;
  if (!patchRel) return;
  const patchAbs = join(root, patchRel);
  if (!existsSync(patchAbs)) {
    throw new Error(`[${entry.id}] zig.patch missing: ${patchRel}`);
  }
  // Clean tree for the pinned ref, then apply. Re-runs are idempotent via
  // git apply (already-applied patches fail check → skip).
  const check = spawnSync("git", ["-C", dest, "apply", "--check", patchAbs], {
    encoding: "utf8",
  });
  if (check.status === 0) {
    console.log(`[${entry.id}] applying ${patchRel}`);
    run("git", ["-C", dest, "apply", patchAbs]);
  } else {
    console.log(`[${entry.id}] patch already applied or not needed: ${patchRel}`);
  }
}

/** Clone or update a shallow checkout for this version id. */
function ensureGitZig(entry, cacheRoot) {
  const { repo, ref } = entry.zig.git;
  const dest = join(cacheRoot, entry.id, "zig");
  if (existsSync(join(dest, "build.zig"))) {
    console.log(`[${entry.id}] reusing git cache ${dest}`);
    // Reset to the pinned ref (tag/branch/sha) so patches re-apply cleanly.
    try {
      run("git", ["-C", dest, "fetch", "--depth", "1", "origin", ref]);
      run("git", ["-C", dest, "checkout", "-f", "FETCH_HEAD"]);
      run("git", ["-C", dest, "clean", "-fd"]);
    } catch {
      console.warn(`[${entry.id}] git update skipped (using existing tree)`);
    }
    applyZigPatch(entry, dest);
    return dest;
  }
  ensureDir(join(cacheRoot, entry.id));
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  console.log(`[${entry.id}] cloning ${repo} @ ${ref}`);
  // Try branch/tag shallow clone first; fall back to full fetch of ref.
  const clone = spawnSync(
    "git",
    ["clone", "--depth", "1", "--branch", ref, repo, dest],
    { stdio: "inherit" },
  );
  if (clone.status !== 0) {
    run("git", ["clone", "--filter=blob:none", "--no-checkout", repo, dest]);
    run("git", ["-C", dest, "fetch", "--depth", "1", "origin", ref]);
    run("git", ["-C", dest, "checkout", "FETCH_HEAD"]);
  }
  applyZigPatch(entry, dest);
  return dest;
}

function resolveZigTree(entry, cacheRoot) {
  const local = resolveLocalZigPath(entry);
  if (local) {
    console.log(`[${entry.id}] zig path ${local}`);
    return local;
  }
  if (entry.zig.git?.repo) {
    return ensureGitZig(entry, cacheRoot);
  }
  throw new Error(`[${entry.id}] no zig.path on disk and no zig.git configured`);
}

function writeBuildZon(entry, zigAbsPath) {
  const zigRel = relative(root, zigAbsPath).split("\\").join("/");
  const zon = `.{
    .name = .playground,
    .version = "0.0.0",
    .fingerprint = 0xdc188848360fd988,
    .minimum_zig_version = "0.15.2",
    .dependencies = .{
        .zls = .{
            .url = "${entry.zls.url}",
            .hash = "${entry.zls.hash}",
        },
        .zig = .{
            .path = "${zigRel}",
        },
    },
    .paths = .{""},
}
`;
  writeFileSync(join(root, "build.zig.zon"), zon);
  console.log(`[${entry.id}] wrote build.zig.zon (zig=${zigRel})`);
}

function buildOne(entry, { wasmOpt, dryRun, cacheRoot }) {
  const zigTree = dryRun
    ? entry.zig.path || `(git ${entry.zig.git?.repo}@${entry.zig.git?.ref})`
    : resolveZigTree(entry, cacheRoot);

  const versionString = entry.zigVersionString || entry.id;
  const zigArgs = [
    "build",
    "-Drelease",
    `-Dzig-version-string=${versionString}`,
  ];
  if (wasmOpt) zigArgs.push("-Dwasm-opt");

  console.log(`\n═══ building compiler "${entry.id}" ═══`);
  console.log(`    zigVersionString=${versionString}`);
  console.log(`    hostZig=${entry.hostZig || "(runner default)"}`);
  console.log(`    schedule=${entry.schedule || "(none)"}`);

  if (dryRun) {
    console.log(`    zig sources → ${zigTree}`);
    console.log(`    zls → ${entry.zls.url}`);
    console.log(`    would run: zig ${zigArgs.join(" ")}`);
    console.log(`    would package → public/compilers/${entry.id}/`);
    return;
  }

  writeBuildZon(entry, zigTree);

  // Clean install prefix so packages don't mix artifacts across ids.
  const zigOut = join(root, "zig-out");
  if (existsSync(zigOut)) {
    rmSync(zigOut, { recursive: true, force: true });
  }

  run("zig", zigArgs);
  run("node", [
    join(root, "scripts/package-compiler.mjs"),
    "--id",
    entry.id,
    "--from",
    "zig-out",
  ]);

  // Enrich meta.json with versions.json fields
  const metaPath = join(root, "public", "compilers", entry.id, "meta.json");
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.zigVersionString = versionString;
    meta.schedule = entry.schedule || null;
    meta.zlsUrl = entry.zls.url;
    meta.label = entry.label || entry.id;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = loadVersionsManifest();
  const selected = selectVersions(manifest, {
    select: opts.only.length ? "all" : opts.select,
    only: opts.only.length ? opts.only : undefined,
  });

  if (selected.length === 0) {
    console.error("no versions selected");
    process.exit(1);
  }

  console.log("versions.json default =", manifest.default);
  console.log(
    "selected:",
    selected.map((v) => v.id + (v.schedule ? ` (schedule=${v.schedule})` : "")).join(", "),
  );

  const toBuild = opts.skipExisting
    ? selected.filter((v) => {
        if (isPackaged(v.id)) {
          console.log(`[${v.id}] skip — already packaged`);
          return false;
        }
        return true;
      })
    : selected;

  if (toBuild.length === 0) {
    console.log("nothing to build (all selected ids already packaged or empty selection)");
  }

  const cacheRoot = join(root, ".zig-version-cache");
  ensureDir(cacheRoot);

  // Preserve original zon to restore after multi-build (local dev convenience).
  const zonPath = join(root, "build.zig.zon");
  const zonBackup = existsSync(zonPath) ? readFileSync(zonPath, "utf8") : null;

  let failed = null;
  try {
    for (const entry of toBuild) {
      try {
        buildOne(entry, {
          wasmOpt: opts.wasmOpt,
          dryRun: opts.dryRun,
          cacheRoot,
        });
      } catch (e) {
        failed = e;
        console.error(`[${entry.id}] FAILED:`, e.message || e);
        break;
      }
    }
  } finally {
    if (zonBackup && !opts.dryRun && toBuild.length > 0) {
      writeFileSync(zonPath, zonBackup);
      console.log("restored build.zig.zon");
    }
  }

  if (failed) {
    process.exit(1);
  }

  if (opts.fillMissing && !opts.dryRun) {
    run("node", [
      join(root, "scripts/fill-compilers-from-release.mjs"),
      "--tag",
      opts.releaseTag,
    ]);
  }

  // Summary
  console.log("\n── public/compilers ──");
  for (const v of manifest.versions) {
    const p = join(root, "public", "compilers", v.id, "zig.wasm");
    console.log(`  ${v.id}: ${existsSync(p) ? "ok" : "MISSING"}`);
  }
}

main();
