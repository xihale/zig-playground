#!/usr/bin/env node
/**
 * Read versions.json and build + package each selected compiler id.
 *
 * Usage:
 *   node scripts/build-compilers.mjs --select stable
 *   node scripts/build-compilers.mjs --select scheduled
 *   node scripts/build-compilers.mjs --select all
 *   node scripts/build-compilers.mjs --only 0.15.2
 *   node scripts/build-compilers.mjs --only master
 *   node scripts/build-compilers.mjs --select stable --no-wasm-opt
 *   node scripts/build-compilers.mjs --select stable --skip-existing
 *   node scripts/build-compilers.mjs --dry-run
 *
 * Build modes (versions.json `build` field):
 *   "playground" (default) — host zig builds this repo (build.zig) with zig+zls deps
 *   "in-tree" — host zig builds the zig source tree directly for wasm32-wasi
 *               (required for official Codeberg master; playground dep graph is 0.15-era)
 *
 * ZLS on master: ZLS does not yet support post-build-split Zig nightlies
 * (https://github.com/zigtools/zls/issues/3208). Use `zlsFallbackId` to copy
 * an older packaged zls.wasm, or omit zls (package with --optional-zls).
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
import { homedir as osHomedir } from "node:os";
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
  --no-wasm-opt                   Skip wasm-opt post-process
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

function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    shell: false,
  });
  return { status: r.status ?? 1, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
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
    // Local trees may still need the playground patch.
    applyZigPatch(entry, local);
    return local;
  }
  if (entry.zig.git?.repo) {
    return ensureGitZig(entry, cacheRoot);
  }
  throw new Error(`[${entry.id}] no zig.path on disk and no zig.git configured`);
}

function hostZigBinary(entry) {
  const safe = String(entry.id).replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  if (process.env[`ZIG_BIN_${safe}`]) return process.env[`ZIG_BIN_${safe}`];
  if (process.env.ZIG) return process.env.ZIG;

  const home = osHomedir();
  const host = entry.hostZig;
  if (host) {
    const candidates = [
      join(home, ".local/share/zvm", host, "zig"),
      join(home, ".zvm", host, "zig"),
      // exact nightly path e.g. 0.17.0-dev.1464+…
      join(home, ".local/share/zvm", host.replace(/\+.*/, ""), "zig"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  return "zig";
}

function computeVersionString(entry, zigTree) {
  if (entry.zigVersionString) return entry.zigVersionString;
  const sha = runCapture("git", ["-C", zigTree, "rev-parse", "--short=9", "HEAD"]);
  if (sha.status === 0 && sha.stdout) {
    return `0.17.0-dev+${sha.stdout}`;
  }
  return "0.17.0-dev";
}

function maybeWasmOpt(wasmPath, wasmOpt) {
  if (!wasmOpt) return;
  const which = runCapture("which", ["wasm-opt"]);
  if (which.status !== 0) {
    console.warn("wasm-opt not found — skipping (install binaryen for smaller wasm)");
    return;
  }
  const tmp = wasmPath + ".opt";
  run("wasm-opt", [
    "-Oz",
    "--enable-bulk-memory",
    "--enable-mutable-globals",
    "--enable-nontrapping-float-to-int",
    "--enable-sign-ext",
    wasmPath,
    "-o",
    tmp,
  ]);
  cpSync(tmp, wasmPath);
  rmSync(tmp, { force: true });
  console.log(`wasm-opt → ${wasmPath}`);
}

function writeBuildZon(entry, zigAbsPath) {
  const zigRel = relative(root, zigAbsPath).split("\\").join("/");
  const minZig =
    entry.hostZig && entry.hostZig !== "master"
      ? entry.hostZig
      : entry.hostZig === "master"
        ? "0.17.0-dev"
        : "0.15.2";
  if (!entry.zls?.url || !entry.zls?.hash) {
    throw new Error(`[${entry.id}] playground build needs zls.url / zls.hash`);
  }
  const zon = `.{
    .name = .playground,
    .version = "0.0.0",
    .fingerprint = 0xdc188848360fd988,
    .minimum_zig_version = "${minZig}",
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
  console.log(`[${entry.id}] wrote build.zig.zon (zig=${zigRel}, min=${minZig})`);
}

/**
 * Build playground src/zls.zig → zls.wasm using host Zig + versions.json zls package.
 * Used by in-tree Zig builds where the compiler is not a package dependency.
 */
function buildZlsWasm(entry, zigBin, zlsDest, { wasmOpt }) {
  if (!entry.zls?.url || !entry.zls?.hash) {
    throw new Error(`[${entry.id}] buildZlsWasm needs zls.url / zls.hash`);
  }
  const zlsDir = join(root, ".zig-version-cache", entry.id, "zls-build");
  if (existsSync(zlsDir)) rmSync(zlsDir, { recursive: true, force: true });
  ensureDir(zlsDir);

  // 0.15 playground uses src/zls.zig; 0.16+ in-tree uses src/zls-0.16.zig
  const zlsEntry = entry.zlsEntrypoint || "src/zls-0.16.zig";
  const zlsSrcAbs = join(root, zlsEntry);
  if (!existsSync(zlsSrcAbs)) {
    throw new Error(`[${entry.id}] zls entrypoint missing: ${zlsEntry}`);
  }
  const zlsSrcRel = relative(zlsDir, zlsSrcAbs).split("\\").join("/");
  writeFileSync(
    join(zlsDir, "build.zig"),
    `const std = @import("std");
pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const optimize: std.builtin.OptimizeMode = .ReleaseSmall;
    const zls_dep = b.dependency("zls", .{
        .target = target,
        .optimize = optimize,
    });
    const zls_exe = b.addExecutable(.{
        .name = "zls",
        .root_module = b.createModule(.{
            .root_source_file = b.path("${zlsSrcRel}"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "zls", .module = zls_dep.module("zls") },
            },
        }),
    });
    zls_exe.entry = .disabled;
    zls_exe.rdynamic = true;
    b.installArtifact(zls_exe);
}
`,
  );
  writeFileSync(
    join(zlsDir, "build.zig.zon"),
    `.{
    .name = .zls_stage,
    .version = "0.0.0",
    .fingerprint = 0xffb1023a664b35b2,
    .dependencies = .{
        .zls = .{
            .url = "${entry.zls.url}",
            .hash = "${entry.zls.hash}",
        },
    },
    .paths = .{""},
}
`,
  );

  let zlsBuild = spawnSync(zigBin, ["build", "--release=small"], {
    cwd: zlsDir,
    encoding: "utf8",
    env: process.env,
  });
  if (zlsBuild.status !== 0 && /invalid fingerprint.*use this value: (0x[0-9a-fA-F]+)/.test(zlsBuild.stderr || "")) {
    const fp = (zlsBuild.stderr || "").match(/use this value: (0x[0-9a-fA-F]+)/)[1];
    writeFileSync(
      join(zlsDir, "build.zig.zon"),
      `.{
    .name = .zls_stage,
    .version = "0.0.0",
    .fingerprint = ${fp},
    .dependencies = .{
        .zls = .{
            .url = "${entry.zls.url}",
            .hash = "${entry.zls.hash}",
        },
    },
    .paths = .{""},
}
`,
    );
    run(zigBin, ["build", "--release=small"], { cwd: zlsDir });
  } else if (zlsBuild.status !== 0) {
    console.error(zlsBuild.stderr || zlsBuild.stdout);
    throw new Error(`[${entry.id}] zls.wasm build failed`);
  }

  const built =
    [
      join(zlsDir, "zig-out", "bin", "zls.wasm"),
      join(zlsDir, "zig-out", "bin", "zls"),
    ].find((p) => existsSync(p)) || null;
  if (!built) throw new Error(`[${entry.id}] zls.wasm not found after build`);
  ensureDir(join(zlsDest, ".."));
  cpSync(built, zlsDest);
  maybeWasmOpt(zlsDest, wasmOpt);
  console.log(`[${entry.id}] zls.wasm → ${zlsDest}`);
}

/**
 * Official 0.16+ / master: build zig.wasm inside the compiler source tree.
 * Playground build.zig cannot host these as a package dependency (Zig is not
 * a package from 0.16 onward). ZLS is built separately via buildZlsWasm, or
 * copied via zlsFallbackId when ZLS lags master (zls#3208).
 */
function buildInTree(entry, { wasmOpt, dryRun, cacheRoot }) {
  const zigTree = dryRun
    ? entry.zig.path || `(git ${entry.zig.git?.repo}@${entry.zig.git?.ref})`
    : resolveZigTree(entry, cacheRoot);

  const zigBin = hostZigBinary(entry);
  const versionString = dryRun
    ? entry.zigVersionString || "(git short sha)"
    : computeVersionString(entry, zigTree);

  console.log(`\n═══ building compiler "${entry.id}" [in-tree] ═══`);
  console.log(`    zigVersionString=${versionString}`);
  console.log(`    hostZig=${entry.hostZig || "(runner default)"} via ${zigBin}`);
  console.log(`    schedule=${entry.schedule || "(none)"}`);
  console.log(
    `    sources=${entry.zig.git ? `${entry.zig.git.repo}@${entry.zig.git.ref}` : entry.zig.path}`,
  );

  if (dryRun) {
    console.log(`    zig sources → ${zigTree}`);
    console.log(
      `    would run: ${zigBin} build -Dtarget=wasm32-wasi -Ddev=wasm -Dno-lib -Dversion-string=… --release=small`,
    );
    console.log(`    would package → public/compilers/${entry.id}/`);
    return;
  }

  // 1) zig.wasm inside official tree
  const zigOutTree = join(zigTree, "zig-out");
  if (existsSync(zigOutTree)) rmSync(zigOutTree, { recursive: true, force: true });

  run(
    zigBin,
    [
      "build",
      "-Dtarget=wasm32-wasi",
      "-Ddev=wasm",
      "-Dno-lib",
      `-Dversion-string=${versionString}`,
      "--release=small",
    ],
    { cwd: zigTree },
  );

  const zigWasm = join(zigOutTree, "bin", "zig.wasm");
  if (!existsSync(zigWasm)) {
    throw new Error(`[${entry.id}] missing ${zigWasm} after in-tree build`);
  }
  maybeWasmOpt(zigWasm, wasmOpt);

  // 2) Stage package layout under playground zig-out
  const stage = join(root, "zig-out");
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  ensureDir(join(stage, "bin"));
  cpSync(zigWasm, join(stage, "bin", "zig.wasm"));

  // 3) libcompiler_rt.a
  const crtDir = join(cacheRoot, entry.id, "crt-build");
  if (existsSync(crtDir)) rmSync(crtDir, { recursive: true, force: true });
  ensureDir(crtDir);
  // relative path to lib from crtDir
  const libRel = relative(crtDir, join(zigTree, "lib")).split("\\").join("/");
  writeFileSync(
    join(crtDir, "build.zig"),
    `const std = @import("std");
pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const optimize: std.builtin.OptimizeMode = .ReleaseSmall;
    const lib = b.addLibrary(.{
        .linkage = .static,
        .name = "compiler_rt",
        .root_module = b.createModule(.{
            .root_source_file = b.path("${libRel}/compiler_rt.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(lib);
}
`,
  );
  // fingerprint: let zig tell us if wrong
  writeFileSync(
    join(crtDir, "build.zig.zon"),
    `.{
    .name = .crt_stage,
    .version = "0.0.0",
    .fingerprint = 0xffb1023a664b35b2,
    .paths = .{""},
}
`,
  );
  let crtBuild = spawnSync(zigBin, ["build", "--release=small"], {
    cwd: crtDir,
    encoding: "utf8",
    env: process.env,
  });
  if (crtBuild.status !== 0 && /invalid fingerprint.*use this value: (0x[0-9a-fA-F]+)/.test(crtBuild.stderr || "")) {
    const fp = (crtBuild.stderr || "").match(/use this value: (0x[0-9a-fA-F]+)/)[1];
    writeFileSync(
      join(crtDir, "build.zig.zon"),
      `.{
    .name = .crt_stage,
    .version = "0.0.0",
    .fingerprint = ${fp},
    .paths = .{""},
}
`,
    );
    run(zigBin, ["build", "--release=small"], { cwd: crtDir });
  } else if (crtBuild.status !== 0) {
    console.error(crtBuild.stderr || crtBuild.stdout);
    throw new Error("compiler_rt build failed");
  }
  const crtA =
    [
      join(crtDir, "zig-out", "lib", "libcompiler_rt.a"),
      join(crtDir, "zig-out", "lib", "compiler_rt.a"),
      join(crtDir, "zig-out", "libcompiler_rt.a"),
    ].find((p) => existsSync(p)) || null;
  if (!crtA) throw new Error(`[${entry.id}] compiler_rt.a not found after build`);
  cpSync(crtA, join(stage, "libcompiler_rt.a"));

  // 4) zig.tar.gz = lib/std
  run("tar", ["-czf", join(stage, "zig.tar.gz"), "-C", zigTree, "lib/std"]);

  // 5) zls.wasm — build paired ZLS when coords given; else fallback; else omit
  let zlsNote = null;
  const zlsDest = join(stage, "bin", "zls.wasm");
  ensureDir(join(stage, "bin"));
  if (entry.zls?.url && entry.zls?.hash && !entry.zlsFallbackId) {
    try {
      buildZlsWasm(entry, zigBin, zlsDest, { wasmOpt });
      zlsNote = `built from ${entry.zls.url}`;
    } catch (e) {
      console.warn(`[${entry.id}] zls build failed:`, e.message || e);
      zlsNote = `build failed: ${e.message || e}`;
    }
  } else if (entry.zlsFallbackId) {
    const fb = join(root, "public", "compilers", entry.zlsFallbackId, "zls.wasm");
    if (existsSync(fb)) {
      cpSync(fb, zlsDest);
      zlsNote = `fallback from ${entry.zlsFallbackId} (ZLS does not support this Zig yet; see zls#3208)`;
      console.warn(`[${entry.id}] zls.wasm ${zlsNote}`);
    } else {
      console.warn(
        `[${entry.id}] zlsFallbackId=${entry.zlsFallbackId} not packaged — building without zls.wasm`,
      );
      zlsNote = "missing (no fallback package)";
    }
  } else if (entry.zls?.url) {
    zlsNote = "skipped for in-tree build (set zlsFallbackId or wait for ZLS master support)";
    console.warn(`[${entry.id}] ${zlsNote}`);
  }

  // 6) package
  const pkgArgs = [
    join(root, "scripts/package-compiler.mjs"),
    "--id",
    entry.id,
    "--from",
    "zig-out",
  ];
  if (!existsSync(zlsDest)) pkgArgs.push("--optional-zls");
  run("node", pkgArgs);

  enrichMeta(entry, versionString, { build: "in-tree", zlsNote });
}

function buildPlayground(entry, { wasmOpt, dryRun, cacheRoot }) {
  const zigTree = dryRun
    ? entry.zig.path || `(git ${entry.zig.git?.repo}@${entry.zig.git?.ref})`
    : resolveZigTree(entry, cacheRoot);

  const zigBin = hostZigBinary(entry);
  const versionString =
    entry.zigVersionString === undefined || entry.zigVersionString === null
      ? null
      : entry.zigVersionString;
  // 0.15 host: -Drelease; prefer that for playground path
  const zigArgs = ["build", "-Drelease"];
  if (versionString) zigArgs.push(`-Dzig-version-string=${versionString}`);
  if (wasmOpt) zigArgs.push("-Dwasm-opt");

  console.log(`\n═══ building compiler "${entry.id}" [playground] ═══`);
  console.log(`    zigVersionString=${versionString ?? "(from zig git)"}`);
  console.log(`    hostZig=${entry.hostZig || "(runner default)"} via ${zigBin}`);
  console.log(`    schedule=${entry.schedule || "(none)"}`);
  console.log(
    `    sources=${entry.zig.git ? `${entry.zig.git.repo}@${entry.zig.git.ref}` : entry.zig.path}`,
  );

  if (dryRun) {
    console.log(`    zig sources → ${zigTree}`);
    console.log(`    zls → ${entry.zls?.url}`);
    console.log(`    would run: ${zigBin} ${zigArgs.join(" ")}`);
    console.log(`    would package → public/compilers/${entry.id}/`);
    return;
  }

  writeBuildZon(entry, zigTree);

  const zigOut = join(root, "zig-out");
  if (existsSync(zigOut)) rmSync(zigOut, { recursive: true, force: true });

  run(zigBin, zigArgs);
  run("node", [
    join(root, "scripts/package-compiler.mjs"),
    "--id",
    entry.id,
    "--from",
    "zig-out",
  ]);

  enrichMeta(entry, versionString, { build: "playground" });
}

function enrichMeta(entry, versionString, extra = {}) {
  const metaPath = join(root, "public", "compilers", entry.id, "meta.json");
  if (!existsSync(metaPath)) return;
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.zigVersionString = versionString;
  meta.hostZig = entry.hostZig || null;
  meta.zigGit = entry.zig.git || null;
  meta.schedule = entry.schedule || null;
  meta.zlsUrl = entry.zls?.url || null;
  meta.zlsFallbackId = entry.zlsFallbackId || null;
  meta.label = entry.label || entry.id;
  Object.assign(meta, extra);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
}

function buildOne(entry, opts) {
  const mode = entry.build || "playground";
  if (mode === "in-tree") return buildInTree(entry, opts);
  if (mode === "playground") return buildPlayground(entry, opts);
  throw new Error(`[${entry.id}] unknown build mode: ${mode}`);
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
    selected
      .map(
        (v) =>
          v.id +
          (v.schedule ? ` (schedule=${v.schedule})` : "") +
          (v.build ? ` [${v.build}]` : ""),
      )
      .join(", "),
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

  console.log("\n── public/compilers ──");
  for (const v of manifest.versions) {
    const p = join(root, "public", "compilers", v.id, "zig.wasm");
    const z = join(root, "public", "compilers", v.id, "zls.wasm");
    console.log(
      `  ${v.id}: zig=${existsSync(p) ? "ok" : "MISSING"} zls=${existsSync(z) ? "ok" : "none"}`,
    );
  }
}

main();
