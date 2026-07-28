# P1: Repository Fork + Content Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork zig-playground into a new `ziglings-web` repo and build the content pipeline that vendors Ziglings exercises + patches + a parsed `catalog.json`, with an idempotent sync script and a catalog-integrity CI check.

**Architecture:** New repo created as a sibling of `zig-playground` (carrying the compiler/worker/editor code, to be trimmed in later plans). Ziglings source enters as a git submodule (`vendor/ziglings-src/`). A Node script `scripts/sync-ziglings.mjs` copies exercises + patches verbatim and invokes `scripts/gen-catalog.zig` (a Zig program that imports elrond's exercise array and emits JSON). A `check-catalog.mjs` script validates integrity. All artifacts commit to the repo.

**Tech Stack:** Node ESM (.mjs), Zig (for catalog generation), git submodules. No frontend changes in P1 — this is pure content/tooling.

**Spec reference:** `docs/superpowers/specs/2026-07-28-ziglings-web-fork-design.md` §2 (Content Pipeline), §6.4 Check 1 (catalog integrity), §6.3 (compiler asset strategy note).

---

## File Structure (what P1 creates/touches in the NEW repo)

```
ziglings-web/                       # new repo (forked from playground)
├── scripts/
│   ├── sync-ziglings.mjs           # NEW: orchestrates vendor + catalog regen
│   ├── gen-catalog.zig             # NEW: imports elrond, emits catalog JSON
│   └── check-catalog.mjs           # NEW: CI integrity check
├── vendor/
│   ├── ziglings-src/               # NEW: git submodule → codeberg ziglings/exercises
│   └── ziglings/                   # NEW: sync output (committed)
│       ├── exercises/*.zig
│       ├── patches/*.patch
│       └── catalog.json
├── test/
│   └── check-catalog.test.mjs      # NEW: unit tests for check-catalog logic
└── .github/workflows/ci.yml        # NEW (or extended): runs check-catalog
```

**Responsibilities:**
- `sync-ziglings.mjs` — one-command reproducible regen; reads submodule, writes `vendor/ziglings/`. Idempotent.
- `gen-catalog.zig` — the only thing that understands elrond's Zig struct; emits structured JSON. Compiled/run by host `zig`.
- `check-catalog.mjs` — pure logic: validates a catalog against the vendored files. Importable by both CLI and tests.
- `check-catalog.test.mjs` — unit tests for the validator (not for the catalog itself).

---

## Task 1: Fork playground into a new repo

**Files:**
- Create: sibling directory `../ziglings-web` (relative to current playground)
- The new repo inherits all of playground's history via fork

- [ ] **Step 1: Create the new repo as a clone of the current playground**

Run from the playground root:
```bash
cd /home/xihale/Desktop/learning/zig
git clone /home/xihale/Desktop/learning/zig/zig-playground ziglings-web
cd ziglings-web
```

Expected: a new directory `ziglings-web/` that is a full clone (with history) of the playground, on branch `master`.

- [ ] **Step 2: Point the new repo at a fresh remote**

The clone's `origin` currently points at the playground's local path. We do NOT want to accidentally push back to the playground. Remove the inherited origin for now; a real remote gets added when you create the GitHub/Codeberg repo.

```bash
cd /home/xihale/Desktop/learning/zig/ziglings-web
git remote remove origin
git remote -v    # should print nothing
```

Expected: `origin` is gone (or shows nothing). We'll add the real remote later.

- [ ] **Step 3: Rename the default branch to `main`**

The playground uses `master`; the new project uses `main` (matches Ziglings/codeberg convention).

```bash
git branch -m master main
git branch --show-current    # should print: main
```

Expected: current branch is `main`.

- [ ] **Step 4: Update package.json name and add a content-pipeline script**

Edit `package.json`:
- Change `"name": "playground"` → `"name": "ziglings-web"`.
- In `"scripts"`, add `"sync-ziglings": "node scripts/sync-ziglings.mjs"` and `"check-catalog": "node scripts/check-catalog.mjs"`.

The scripts block should become:
```json
"scripts": {
  "dev": "vite",
  "build": "vite build && node scripts/assemble-dist.mjs",
  "sync-ziglings": "node scripts/sync-ziglings.mjs",
  "check-catalog": "node scripts/check-catalog.mjs",
  "preview": "vite preview"
}
```

(The `compilers:*` and `package:compiler` scripts from the playground stay for now — they'll be evaluated in a later plan per spec §6.3; do not delete in P1.)

- [ ] **Step 5: Commit the repo scaffolding**

```bash
git add package.json
git commit -m "Rename project to ziglings-web; add content-pipeline scripts"
```

Expected: one commit on `main`.

---

## Task 2: Add Ziglings as a git submodule

**Files:**
- Create: `.gitmodules`
- Create: `vendor/ziglings-src/` (submodule worktree)

- [ ] **Step 1: Add the submodule**

Run from the new repo root:
```bash
cd /home/xihale/Desktop/learning/zig/ziglings-web
git submodule add https://codeberg.org/ziglings/exercises.git vendor/ziglings-src
```

Expected: `.gitmodules` created, `vendor/ziglings-src/` populated with the Ziglings repo (default branch `main`, HEAD `f39b462…` or newer).

- [ ] **Step 2: Verify the submodule tracks main and is initialized**

```bash
git submodule status
```

Expected: one line like `<sha> vendor/ziglings-src (main)` showing a populated commit.

- [ ] **Step 3: Verify the expected Ziglings layout is present**

```bash
ls vendor/ziglings-src/
```

Expected to see at least: `exercises/`, `patches/`, `rivendell/elrond.zig`, `build.zig`, `README.md`, `LICENSE`.

If `rivendell/elrond.zig` is missing, STOP — the upstream layout changed; consult the spec (§2.1) and adjust the catalog-generation approach before proceeding.

- [ ] **Step 4: Commit the submodule**

```bash
git add .gitmodules vendor/ziglings-src
git commit -m "Add Ziglings as git submodule at vendor/ziglings-src"
```

Expected: one commit registering the submodule.

---

## Task 3: Inspect elrond.zig and capture the Exercise struct shape

This task is reconnaissance — it produces no committed code, but its findings drive Task 4 (the catalog generator). Do not skip it; the generator must match the actual struct.

**Files:** read-only inspection of `vendor/ziglings-src/rivendell/elrond.zig`

- [ ] **Step 1: Locate and read the Exercise struct definition**

```bash
grep -n "const Exercise" vendor/ziglings-src/rivendell/elrond.zig
```

Read ~40 lines starting at that line. Record the exact field names and types. As of the spec's research (elrond ~line 76-110) the fields were:
`main_file`, `output`, `hint`, `check_stdout`, `link_libc`, `kind`, `skip`, `skip_hint`, `timestamp`.

**If the actual struct differs (renamed/added/removed fields), update Task 4's generator to match the real struct.** The spec lists the expected fields; reality wins.

- [ ] **Step 2: Locate the exercises array**

```bash
grep -n "const exercises" vendor/ziglings-src/rivendell/elrond.zig
```

Confirm it's a `[_]Exercise{ ... }` literal. Note its start line (research found ~line 563). Count entries:
```bash
awk '/const exercises/,/^};/' vendor/ziglings-src/rivendell/elrond.zig | grep -c '\.main_file'
```

Expected: ~116.

- [ ] **Step 3: Note the build.zig Zig version floor**

```bash
grep -n "0\.\(1[0-9]\|[0-9]\)\." vendor/ziglings-src/build.zig | head
```

Find the comptime version check (e.g. `0.17.0-dev.607`). Record this value — it becomes `catalog.zigFloor`. This is the spec §6.2 invariant source.

- [ ] **Step 4: Verify host zig is available and recent enough**

```bash
zig version
```

The catalog generator (Task 4) needs a host `zig` that can compile elrond's imports. If `zig` is not on PATH, install it or alias before Task 4. Record the version.

(No commit in this task — it's reconnaissance.)

---

## Task 4: Write the catalog generator (gen-catalog.zig)

**Files:**
- Create: `scripts/gen-catalog.zig`

This program imports elrond's data and emits catalog JSON to stdout. It is the single source of truth for translating Zig metadata → JSON.

- [ ] **Step 1: Write a minimal generator that imports elrond and prints the count**

Create `scripts/gen-catalog.zig`:
```zig
const std = @import("std");

// Import elrond to reuse its Exercise struct + exercises array.
// Path is relative to this file's location in the new repo.
const elrond = @import("../vendor/ziglings-src/rivendell/elrond.zig");

pub fn main() !void {
    // Sanity: prove we can see the array. Adjust the symbol name if elrond
    // exposes it differently (Task 3 Step 2 recorded the exact name).
    std.debug.print("count={d}\n", .{elrond.exercises.len});
}
```

- [ ] **Step 2: Run it to confirm the import resolves**

```bash
cd /home/xihale/Desktop/learning/zig/ziglings-web
zig run scripts/gen-catalog.zig
```

Expected: prints `count=116` (or whatever Task 3 Step 2 counted).

If it fails to compile (e.g. elrond expects a build context, or has other top-level deps), the simplest robust fallback is to **copy the Exercise struct definition + the exercises array literal into a standalone `scripts/gen-catalog.zig`** that doesn't `@import` elrond at all — just defines the struct, pastes the array, and emits JSON. This is more brittle to upstream struct changes but compiles unconditionally. Only fall back if the import path genuinely fails; prefer the import.

- [ ] **Step 3: Extend the generator to emit full catalog JSON**

Replace `scripts/gen-catalog.zig` with the full emitter. It reads `elrond.exercises`, derives `number`/`slug`/`name`/`runnable`/`notRunnableReason`, and writes JSON to stdout.

```zig
const std = @import("std");
const elrond = @import("../vendor/ziglings-src/rivendell/elrond.zig");

pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const a = arena.allocator();

    var bw = std.io.bufferedWriter(std.io.getStdOut().writer());
    const w = bw.writer();

    // Top-level object. zigFloor is read from a build-time constant if
    // available, else hard-coded from Task 3 Step 3.
    try w.writeAll("{\n");
    try w.writeAll("  \"version\": \"PLACEHOLDER_COMMIT\",\n");
    try w.writeAll("  \"zigFloor\": \"0.17.0-dev.607\",\n");
    try w.writeAll("  \"exercises\": [\n");

    for (elrond.exercises, 0..) |ex, i| {
        // Derive fields from main_file like "001_hello.zig".
        const stem = stemOf(ex.main_file);          // "001_hello"
        const number = numberFromStem(stem);          // 1
        const name = nameFromStem(stem);              // "hello"

        const runnable = !ex.link_libc and !ex.skip and !ex.timestamp; // file-IO heuristic added in JS
        const reason: ?[]const u8 = if (ex.link_libc) "link_libc"
            else if (ex.skip) "skipped"
            else if (ex.timestamp) "timestamp_exercise"
            else null;

        try w.writeAll("    {\n");
        try w.print("      \"number\": {d},\n", .{number});
        try w.print("      \"slug\": \"{s}\",\n", .{stem});
        try w.print("      \"name\": \"{s}\",\n", .{name});
        try w.print("      \"sourcePath\": \"exercises/{s}\",\n", .{ex.main_file});
        try w.print("      \"patchPath\": \"patches/{s}.patch\",\n", .{stem});
        try w.writeAll("      \"output\": ");
        try writeJsonString(w, ex.output);
        try w.writeAll(",\n");
        try w.print("      \"checkStdout\": {s},\n", .{if (ex.check_stdout) "true" else "false"});
        try w.print("      \"kind\": \"{s}\",\n", .{if (ex.kind == .@"test") "test" else "exe"});
        try w.print("      \"linkLibc\": {s},\n", .{if (ex.link_libc) "true" else "false"});
        try w.writeAll("      \"hint\": ");
        if (ex.hint) |h| try writeJsonString(w, h) else try w.writeAll("null");
        try w.writeAll(",\n");
        try w.print("      \"skip\": {s},\n", .{if (ex.skip) "true" else "false"});
        try w.print("      \"timestamp\": {s},\n", .{if (ex.timestamp) "true" else "false"});
        try w.print("      \"runnable\": {s},\n", .{if (runnable) "true" else "false"});
        try w.writeAll("      \"notRunnableReason\": ");
        if (reason) |r| { try w.writeAll("\""); try w.writeAll(r); try w.writeAll("\""); } else try w.writeAll("null");
        try w.writeAll("\n");
        try w.writeAll(if (i + 1 < elrond.exercises.len) "    },\n" else "    }\n");
    }

    try w.writeAll("  ]\n}\n");
    try bw.flush();
    _ = a;
}

/// "001_hello.zig" -> "001_hello"
fn stemOf(main_file: []const u8) []const u8 {
    if (std.mem.lastIndexOfScalar(u8, main_file, '.')) |dot| {
        return main_file[0..dot];
    }
    return main_file;
}

/// "001_hello" -> 1  (parse leading digits, ignore zeros)
fn numberFromStem(stem: []const u8) usize {
    var n: usize = 0;
    for (stem) |c| {
        if (c >= '0' and c <= '9') {
            n = n * 10 + (c - '0');
        } else break;
    }
    return n;
}

/// "001_hello" -> "hello" (skip leading digits and the underscore)
fn nameFromStem(stem: []const u8) []const u8 {
    var i: usize = 0;
    while (i < stem.len and stem[i] >= '0' and stem[i] <= '9') : (i += 1) {}
    if (i < stem.len and stem[i] == '_') i += 1;
    return stem[i..];
}

/// Minimal JSON string escaping.
fn writeJsonString(w: anytype, s: []const u8) !void {
    try w.writeAll("\"");
    for (s) |c| {
        switch (c) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            else => if (c < 0x20) {
                try w.print("\\u{x:0>4}", .{c});
            } else {
                try w.writeByte(c);
            },
        }
    }
    try w.writeAll("\"");
}
```

**Note on the `version`/`zigFloor` placeholders:** the Zig generator can't easily read the submodule SHA. `sync-ziglings.mjs` (Task 5) will rewrite the `"version"` field with the real commit SHA after the Zig program emits JSON. The `zigFloor` is hard-coded from Task 3 Step 3; if you found a different value, update it here.

- [ ] **Step 4: Run the generator and eyeball the output**

```bash
zig run scripts/gen-catalog.zig | head -40
```

Expected: valid-looking JSON with 116 entries (or the count from Task 3 Step 2). Spot-check `001_hello`: number=1, slug=`001_hello`, output=`Hello world!`.

- [ ] **Step 5: Validate the JSON parses**

```bash
zig run scripts/gen-catalog.zig > /tmp/catalog-probe.json
node -e "JSON.parse(require('fs').readFileSync('/tmp/catalog-probe.json','utf8')); console.log('valid JSON')"
```

Expected: prints `valid JSON`. If it errors, fix the escaping in `writeJsonString`.

- [ ] **Step 6: Commit the generator**

```bash
git add scripts/gen-catalog.zig
git commit -m "Add gen-catalog.zig: parse elrond exercises into JSON"
```

---

## Task 5: Write the sync script (sync-ziglings.mjs)

**Files:**
- Create: `scripts/sync-ziglings.mjs`

One-command reproducible regen of `vendor/ziglings/`. Reads the submodule, copies files verbatim, runs the Zig generator, stamps the real commit SHA, writes stable JSON.

- [ ] **Step 1: Write the sync script**

Create `scripts/sync-ziglings.mjs`:
```js
// One-command, idempotent regen of vendor/ziglings/.
// Run after `git submodule update --remote vendor/ziglings-src`.
//
// Steps:
//   1. Copy exercises/*.zig and patches/patches/*.patch verbatim into vendor/ziglings/.
//   2. Run `zig run scripts/gen-catalog.zig` and capture its JSON.
//   3. Stamp the real submodule commit SHA into catalog.version.
//   4. Apply the file-IO heuristic to derive final `runnable` per exercise.
//   5. Serialize with stable formatting and write vendor/ziglings/catalog.json.
//
// Idempotency: identical submodule input → byte-identical catalog.json.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "vendor/ziglings-src");
const out = resolve(root, "vendor/ziglings");

// --- 0. sanity: submodule present ---
if (!existsSync(resolve(src, "rivendell/elrond.zig"))) {
  console.error("vendor/ziglings-src not populated. Run: git submodule update --init");
  process.exit(1);
}

// --- 1. clean + copy verbatim ---
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, "exercises"), { recursive: true });
mkdirSync(resolve(out, "patches"), { recursive: true });

for (const f of readdirSync(resolve(src, "exercises"))) {
  if (f.endsWith(".zig")) cpSync(resolve(src, "exercises", f), resolve(out, "exercises", f));
}
// Ziglings stores patches at patches/patches/*.patch
const patchDir = resolve(src, "patches/patches");
for (const f of readdirSync(patchDir)) {
  if (f.endsWith(".patch")) cpSync(resolve(patchDir, f), resolve(out, "patches", f));
}
// Carry the LICENSE for attribution.
cpSync(resolve(src, "LICENSE"), resolve(out, "LICENSE"));

// --- 2. run the Zig generator ---
const raw = execFileSync("zig", ["run", resolve(root, "scripts/gen-catalog.zig")], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
const catalog = JSON.parse(raw);

// --- 3. stamp the real submodule commit SHA ---
const sha = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
catalog.version = sha;

// --- 4. file-IO heuristic: refine `runnable` ---
// gen-catalog.zig already cleared runnable for link_libc/skip/timestamp.
// Add a source scan for file-IO / @cImport on top.
for (const ex of catalog.exercises) {
  if (!ex.runnable) continue;
  const code = readFileSync(resolve(out, ex.sourcePath), "utf8");
  if (/\bstd\.fs\b|\bstd\.os\.open\b|@cImport/.test(code)) {
    ex.runnable = false;
    ex.notRunnableReason = "file_io";
  }
}

// --- 5. stable serialization ---
// Sort exercises by number (gen-catalog already emits in array order, but enforce).
catalog.exercises.sort((a, b) => a.number - b.number);
writeFileSync(resolve(out, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n", "utf8");

console.log(`synced ${catalog.exercises.length} exercises from ${sha.slice(0, 10)}`);
console.log(`  runnable: ${catalog.exercises.filter((e) => e.runnable).length}`);
console.log(`  not runnable: ${catalog.exercises.filter((e) => !e.runnable).length}`);
```

- [ ] **Step 2: Run the sync script**

```bash
cd /home/xihale/Desktop/learning/zig/ziglings-web
node scripts/sync-ziglings.mjs
```

Expected: prints something like:
```
synced 116 exercises from f39b462659
  runnable: 113
  not runnable: 3
```

(Exact runnable count may vary by Ziglings version; spec expects ~113.)

- [ ] **Step 3: Verify the vendored output exists and looks right**

```bash
ls vendor/ziglings/exercises/ | head
ls vendor/ziglings/patches/ | head
head -20 vendor/ziglings/catalog.json
```

Expected: exercise `.zig` files, `.patch` files, and a `catalog.json` whose top looks like:
```json
{
  "version": "f39b462659...",
  "zigFloor": "0.17.0-dev.607",
  "exercises": [
    {
      "number": 1,
      "slug": "001_hello",
      ...
```

- [ ] **Step 4: Verify idempotency — run twice, expect no diff**

```bash
node scripts/sync-ziglings.mjs
cp vendor/ziglings/catalog.json /tmp/catalog-run1.json
node scripts/sync-ziglings.mjs
diff /tmp/catalog-run1.json vendor/ziglings/catalog.json && echo "IDEMPOTENT"
```

Expected: prints `IDEMPOTENT` (empty diff). If the diff is non-empty, the generator or serializer is non-deterministic — fix before committing (spec §2.7).

- [ ] **Step 5: Commit the sync script and the vendored output**

```bash
git add scripts/sync-ziglings.mjs vendor/ziglings/
git commit -m "Add sync-ziglings.mjs; vendor exercises + patches + catalog.json"
```

---

## Task 6: Write the catalog-integrity checker (check-catalog.mjs) — TDD

**Files:**
- Create: `scripts/check-catalog.mjs`
- Create: `test/check-catalog.test.mjs`

Pure-logic validator: given a catalog object and a root path, returns a list of problems. Importable so tests can call it with synthetic catalogs. Exits nonzero if any problem is found.

- [ ] **Step 1: Set up a tiny test runner (no test framework dep — keep it minimal)**

Create `test/check-catalog.test.mjs`:
```js
// Minimal test runner: each test throws on failure. No framework dep.
import { checkCatalog } from "../scripts/check-catalog.mjs";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? "assertion failed"); }

// A tiny in-memory fake filesystem so tests don't touch the real vendor tree.
function fakeFs(files) {
  return (p) => files.has(p);
}

test("empty problems for a well-formed catalog", () => {
  const cat = {
    version: "abc", zigFloor: "0.17.0-dev.607",
    exercises: [{
      number: 1, slug: "001_hello", name: "hello",
      sourcePath: "exercises/001_hello.zig", patchPath: "patches/001_hello.patch",
      output: "Hello world!", checkStdout: false, kind: "exe", linkLibc: false,
      hint: null, skip: false, timestamp: false, runnable: true, notRunnableReason: null,
    }],
  };
  const exists = fakeFs(new Set(["exercises/001_hello.zig", "patches/001_hello.patch"]));
  const problems = checkCatalog(cat, { exists });
  assert(problems.length === 0, `expected no problems, got: ${JSON.stringify(problems)}`);
});

test("flags missing source file", () => {
  const cat = { version: "x", zigFloor: "x", exercises: [{
    number: 1, slug: "001_hello", sourcePath: "exercises/missing.zig", patchPath: "patches/x.patch",
    runnable: true,
  }] };
  const exists = fakeFs(new Set(["patches/x.patch"]));
  const problems = checkCatalog(cat, { exists });
  assert(problems.some((p) => /sourcePath/.test(p)), "expected a sourcePath problem");
});

test("flags duplicate number", () => {
  const cat = { version: "x", zigFloor: "x", exercises: [
    { number: 1, slug: "a", sourcePath: "a.zig", patchPath: "a.patch", runnable: true },
    { number: 1, slug: "b", sourcePath: "b.zig", patchPath: "b.patch", runnable: true },
  ] };
  const exists = fakeFs(new Set(["a.zig","a.patch","b.zig","b.patch"]));
  const problems = checkCatalog(cat, { exists });
  assert(problems.some((p) => /duplicate number/.test(p)), "expected duplicate-number problem");
});

test("flags missing zigFloor", () => {
  const cat = { version: "x", exercises: [] };
  const problems = checkCatalog(cat, { exists: () => true });
  assert(problems.some((p) => /zigFloor/.test(p)), "expected zigFloor problem");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run the test to confirm it fails (check-catalog.mjs doesn't exist yet)**

```bash
node test/check-catalog.test.mjs
```

Expected: FAIL with a module-not-found error for `../scripts/check-catalog.mjs`.

- [ ] **Step 3: Write the minimal checker to make tests pass**

Create `scripts/check-catalog.mjs`:
```js
// Pure-logic catalog integrity validator.
// Returns an array of human-readable problem strings (empty = valid).
//
// `opts.exists(path)` is injected so tests can supply a fake filesystem;
// the CLI wrapper below uses the real fs.

export function checkCatalog(catalog, opts) {
  const problems = [];
  const exists = opts.exists;

  if (!catalog.zigFloor) problems.push("missing top-level zigFloor");

  const seenNumbers = new Set();
  for (const ex of catalog.exercises ?? []) {
    if (!ex.sourcePath) {
      problems.push(`exercise ${ex.slug ?? ex.number}: missing sourcePath`);
    } else if (!exists(ex.sourcePath)) {
      problems.push(`exercise ${ex.slug}: sourcePath file missing: ${ex.sourcePath}`);
    }
    if (!ex.patchPath) {
      problems.push(`exercise ${ex.slug ?? ex.number}: missing patchPath`);
    } else if (!exists(ex.patchPath)) {
      problems.push(`exercise ${ex.slug}: patchPath file missing: ${ex.patchPath}`);
    }
    if (ex.number != null) {
      if (seenNumbers.has(ex.number)) {
        problems.push(`duplicate number: ${ex.number} (slug ${ex.slug})`);
      }
      seenNumbers.add(ex.number);
    }
  }
  return problems;
}

// --- CLI wrapper ---
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Run as CLI only when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const catalogPath = resolve(root, "vendor/ziglings/catalog.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const problems = checkCatalog(catalog, { exists: (p) => existsSync(resolve(root, "vendor/ziglings", p)) });
  if (problems.length > 0) {
    console.error(`catalog integrity: ${problems.length} problem(s):`);
    for (const p of problems) console.error("  " + p);
    process.exit(1);
  }
  console.log(`catalog integrity: OK (${catalog.exercises.length} exercises)`);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
node test/check-catalog.test.mjs
```

Expected: `4 passed, 0 failed`.

- [ ] **Step 5: Run the checker against the real vendored catalog**

```bash
node scripts/check-catalog.mjs
```

Expected: `catalog integrity: OK (116 exercises)` (or the synced count). If it reports problems, the sync script has a bug — fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-catalog.mjs test/check-catalog.test.mjs
git commit -m "Add check-catalog.mjs validator with unit tests"
```

---

## Task 7: Add CI workflow (catalog integrity check)

**Files:**
- Create: `.github/workflows/ci.yml`

This is spec §6.4 Check 1. Later plans add Checks 2 (smoke-verify) and 3 (version alignment); P1 only wires the catalog check.

- [ ] **Step 1: Check whether a CI workflow already exists (inherited from playground)**

```bash
ls .github/workflows/ 2>/dev/null
```

If a workflow exists, read it to understand the playground's CI conventions (node version, caching) and extend it rather than create a parallel one. If nothing exists, create fresh.

- [ ] **Step 2: Write (or extend) the CI workflow to run check-catalog**

Create/overwrite `.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  catalog-integrity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: true    # Ziglings source is needed for check-catalog's file-existence checks
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Restore vendored content
        run: |
          # vendor/ziglings/ is committed, but its file-existence checks reference
          # paths relative to vendor/ziglings — committed files suffice; no sync needed in CI.
          ls vendor/ziglings/catalog.json
      - name: Catalog integrity
        run: node scripts/check-catalog.mjs
```

Note: `actions/checkout` with `submodules: true` ensures `vendor/ziglings-src` is present, but `check-catalog.mjs` only reads the committed `vendor/ziglings/` artifacts — so the submodule isn't strictly required at CI time. It's included for parity and future checks.

- [ ] **Step 3: Commit the CI workflow**

```bash
git add .github/workflows/ci.yml
git commit -m "CI: add catalog-integrity check"
```

---

## Task 8: Document the bump flow + attribution

**Files:**
- Modify: `README.md` (inherited from playground — needs replacing for the new project)

- [ ] **Step 1: Read the inherited README to know what's being replaced**

```bash
head -40 README.md
```

The playground README is operator-facing (compiler build, deploy). It does not fit a learning platform. We replace it wholesale in P1.

- [ ] **Step 2: Write a new README**

Overwrite `README.md`:
```markdown
# Ziglings Web

A browser-based Zig learning platform that hosts the [Ziglings](https://codeberg.org/ziglings/exercises)
exercise set with zero-install editing, automatic verification, and progress tracking.

> **Status:** early development. Content pipeline (this repo's first milestone) is in place;
> the in-browser editor/verifier is forthcoming.

## What this is (and isn't)

- A third-party web rendering of Ziglings content — **not** the official Ziglings project.
- Faithful to Ziglings' exercises; this project's job is making them *easier to learn* in a browser.
- No backend, no accounts — progress lives in your browser's localStorage.

## Content attribution

All exercise content is © Ziglings contributors, sourced from
[Codeberg `ziglings/exercises`](https://codeberg.org/ziglings/exercises), vendored under
`vendor/ziglings/`. See `vendor/ziglings/LICENSE`.

## Updating the content (bump flow)

When Ziglings publishes new exercises:

```bash
# 1. Pull the latest Ziglings into the submodule
git submodule update --remote vendor/ziglings-src

# 2. Regenerate the vendored artifacts (idempotent)
npm run sync-ziglings

# 3. Review what changed
git diff vendor/ziglings/catalog.json
git diff vendor/ziglings/exercises/

# 4. If zigFloor changed and exceeds the compiler we ship, STOP and resolve that first.

# 5. Commit
git add vendor/ziglings-src vendor/ziglings/
git commit -m "bump ziglings"
```

The sync is idempotent — identical submodule input produces byte-identical `catalog.json`, so `git diff`
shows only real content changes.

## Repo layout

```
scripts/
  sync-ziglings.mjs   one-command content regen
  gen-catalog.zig     parses Ziglings' elrond into catalog.json
  check-catalog.mjs   catalog integrity validator
vendor/
  ziglings-src/       git submodule → Ziglings
  ziglings/           committed artifacts (exercises, patches, catalog.json)
test/                 unit tests (node, no framework)
```
```

- [ ] **Step 3: Commit the README**

```bash
git add README.md
git commit -m "Replace README with ziglings-web project docs"
```

---

## Task 9: P1 acceptance verification

No new files — a final gate confirming P1 meets its success criteria before handing off to P2.

- [ ] **Step 1: Re-run the full content pipeline from a clean state**

```bash
cd /home/xihale/Desktop/learning/zig/ziglings-web
rm -rf vendor/ziglings
git submodule update --init --remote vendor/ziglings-src
node scripts/sync-ziglings.mjs
```

Expected: regenerates `vendor/ziglings/` cleanly; prints the synced count.

- [ ] **Step 2: Confirm catalog integrity passes**

```bash
node scripts/check-catalog.mjs
```

Expected: `catalog integrity: OK (...)`.

- [ ] **Step 3: Confirm unit tests pass**

```bash
node test/check-catalog.test.mjs
```

Expected: `4 passed, 0 failed`.

- [ ] **Step 4: Confirm idempotency one more time**

```bash
node scripts/sync-ziglings.mjs && git diff --quiet vendor/ziglings/ && echo "CLEAN" || echo "DIRTY"
```

Expected: `CLEAN` (running sync produced no changes vs the committed state).

- [ ] **Step 5: Record the derived runnable count and the zigFloor**

```bash
node -e "const c=require('./vendor/ziglings/catalog.json'); console.log('exercises:',c.exercises.length,'runnable:',c.exercises.filter(e=>e.runnable).length,'floor:',c.zigFloor)"
```

Record these numbers. They feed P2 (the verifier needs to know how many exercises to support, and the floor version drives compiler-alignment decisions).

- [ ] **Step 6: Final commit if anything was regenerated**

```bash
git status
```

If clean, P1 is done. If the regeneration changed anything (it shouldn't), investigate why before committing.

---

## P1 Success Criteria (recap)

1. New `ziglings-web` repo exists, forked from playground, on branch `main`, no inherited origin.
2. Ziglings vendored as a git submodule; exercises + patches + catalog.json committed.
3. `npm run sync-ziglings` regenerates `vendor/ziglings/` idempotently.
4. `npm run check-catalog` validates integrity; unit tests cover the validator logic.
5. CI workflow runs the catalog-integrity check.
6. README documents attribution + the bump flow.
7. The two spec-flagged technical risks are resolved: **catalog generation works against the real elrond struct** (Task 3/4), and **the file-IO / libc / timestamp exercises are correctly flagged not-runnable** (Task 5 Step 4).

**Hand-off to P2:** P2 (verification pipeline) consumes `vendor/ziglings/catalog.json` and the committed exercise sources. The two remaining technical risks for P2 (`--test-no-exec` behavior, `zig test` output filename) are verified at the start of P2, not P1.

---

## Notes for the executor

- **Default repo path:** `../ziglings-web` (sibling of playground). If you prefer a different location/name, adjust Task 1's paths — everything else is relative to the new repo root.
- **The `compilers:*` scripts stay in P1.** They're playground machinery; spec §6.3 defers the compiler-asset decision. Do not delete; do not modify.
- **`gen-catalog.zig` `@import` is the preferred path.** If elrond won't compile as an import (other top-level deps), fall back to pasting the struct + array into the generator. Document which path you took in the commit message.
- **No frontend changes in P1.** The editor, workers, examples — all untouched. P1 is content/tooling only.
