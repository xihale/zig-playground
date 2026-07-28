# Ziglings Web — Design Spec

**Date:** 2026-07-28
**Status:** Draft (pending implementation plan)
**Origin repo:** forked from `zig-playground` (master, commit 4d4c603)

---

## 0. TL;DR

Fork the zig-playground into a separate project — **Ziglings Web** — a browser-based Zig
learning platform that faithfully hosts the Ziglings exercise set, with zero-install editing,
automatic verification, and progress tracking. The playground's compiler/worker/ZLS/CodeMirror
assets are taken as a starting point; the two projects then diverge with **no code-sync obligation**.

This is the "enhanced-experience" tier: Ziglings content is the base, product differentiation is
making it *easier to learn* than local `zig build`. Not a content expansion, not a platform for
multiple curricula.

---

## 1. Concept & Boundaries

### 1.1 One-line positioning

A web-based Zig learning platform: faithfully carries Ziglings' exercises, uses a zero-install
in-browser editor + automatic verification + progress tracking, and makes the "read the error,
fix one hole, recompile" learning loop smoother than local `zig build`.

### 1.2 Identity

- Working name: **Ziglings Web**.
- Independent project, independent repo, independent domain (e.g. `ziglings.xihale.top`).
- English-first.
- Clear attribution: a third-party web rendering of Ziglings content, **not** the official
  Ziglings project. Content © Ziglings contributors, sourced from Codeberg
  `ziglings/exercises`. License retained alongside vendored content.

### 1.3 North-star user journey

```
land → exercise list (progress visible) → click an exercise →
read problem comments → edit code in editor → click Check →
auto compile+run+compare output → pass/fail panel →
(fail) see expected-vs-actual diff, optionally reveal hint → re-edit →
(pass) marked done, progress +1, guided to next exercise
```

This is the **single non-negotiable path**. All enhancement features serve it, none may obstruct it.

### 1.4 Do / Don't (scope guard)

**Do:**
- Faithfully host Ziglings exercise content (problem source + official hint + expected output).
- In-browser edit + compile + run + output-compare verification.
- Per-exercise draft persistence + solved-progress tracking (localStorage).
- Experience enhancements: progress visualization, expected-output diff, official-solution reveal.

**Don't (MVP):**
- No backend, no accounts, no cloud sync.
- No translation of exercise bodies (English-first).
- No self-authored course content (Ziglings is the sole content source).
- No social/leaderboard/share-my-solution.
- No "is this a syntactically canonical solution" judgement (output-compare is intentionally lenient).
- Not runnable in-browser: `link_libc`, `timestamp`, and file-IO exercises. (`test`-kind IS supported — see §3.4.)

### 1.5 Relationship to the playground

- **Start point:** fork current playground master. Carry `src/workers/`, `src/zig-shared-client.ts`,
  `src/shared-protocol.ts`, CodeMirror integration, `compiler-cache.ts`, `version.ts`'s asset mechanism.
- **Divergence:** no code-sync obligation after fork. The playground evolves its own concerns
  (share/embed/cut/twoslash); this project evolves its own (curriculum/verification/progress). Either
  side may modify forked code; neither waits for the other.
- **Shared knowledge only:** this project's design docs stay in its own repo, not mixed with the
  playground's `docs/`.

---

## 2. Content Pipeline

### 2.1 Problem

Ziglings content is scattered across three places with **no structured metadata file**:

| Content | Location | Form |
|---|---|---|
| Broken exercise source | `exercises/NNN_topic.zig` | 116 Zig files |
| Official answers | `patches/patches/NNN_topic.patch` | 117 unified diffs |
| Metadata (output/hint/flags) | `rivendell/elrond.zig` (Exercise array) | hand-maintained Zig literal |

We turn these into structured, version-tracked, reproducible browser content.

### 2.2 Vendor strategy

One Node script `scripts/sync-ziglings.mjs` produces three artifacts, all committed to the repo
(no runtime fetch — keeps the static site offline-capable and reproducible):

```
vendor/ziglings/
├── exercises/NNN_topic.zig    # copied verbatim
├── patches/NNN_topic.patch    # copied verbatim
└── catalog.json               # parsed from elrond.zig
```

Ziglings source enters as a **git submodule** (`vendor/ziglings-src/`) pinned to a specific commit —
traceable, and a bump is just a submodule SHA change.

### 2.3 catalog.json schema

```jsonc
{
  "version": "ziglings-commit-sha",
  "zigFloor": "0.17.0-dev.607",
  "exercises": [
    {
      "number": 1,                     // display/order number
      "slug": "001_hello",             // stable cross-version identity; also the progress key
      "name": "hello",
      "sourcePath": "exercises/001_hello.zig",
      "patchPath": "patches/001_hello.patch",
      "output": "Hello world!",        // expected output after trimLines
      "checkStdout": false,            // true=read stdout, false=read stderr
      "kind": "exe",                   // "exe"=zig run/build-exe | "test"=zig test
      "linkLibc": false,
      "hint": "DON'T PANIC! ...",      // optional, may be null
      "skip": false,                    // Ziglings marks skipped
      "timestamp": false,               // output contains a timestamp (tolerance)
      "runnable": true,                 // derived (see 2.5)
      "notRunnableReason": null         // derived reason when runnable=false
    }
  ]
}
```

**No `category` field in MVP.** Exercises render as a flat ordered list. Classification is deferred
until we import real content and see what grouping emerges naturally. (See §11 — open question.)

**slug is the stable cross-version identity** and the localStorage progress key. `number` is
display-only (current-version order). This choice eliminates the need for a migration history table.

### 2.4 Parsing elrond.zig

Write `scripts/gen-catalog.zig`: it `@import`s (or copies the struct def + array from) `elrond.zig`,
iterates the exercises array, and emits JSON via `std.debug.print`. The Node sync script runs
`zig run scripts/gen-catalog.zig`.

Why a Zig parser, not regex/Tree-sitter: elrond is legal Zig with nested literals, multi-line
strings, escapes — a regex will break. Letting the Zig compiler be the parser is robust, and if
Ziglings adds a field to the struct, our catalog picks it up automatically (just an extra JSON key).

### 2.5 Runnable derivation

The sync script derives `runnable` per exercise:

```
runnable = true iff:
  linkLibc == false       (browser WASI has no libc)
  AND skip == false
  AND timestamp == false  (the 1 timestamp exercise: skip in MVP)
  AND NOT file-IO heuristic matches  (scan source for std.fs / std.os.open / @cImport)
```

`notRunnableReason` ∈ { `"link_libc"`, `"skipped"`, `"timestamp_exercise"`, `"file_io"` }.

Note: **`kind == "test"` does NOT disqualify** — test mode is supported in MVP (see §3.4).

Expected: ~113/116 runnable; ~3 not runnable (libc + timestamp + any file-IO heuristic hits).

The file-IO heuristic may false-positive (marks runnable=false on something that could run). That's
a safe degradation — never affects correctness, only display.

### 2.6 Bump flow

```bash
# 1. Update content source
git submodule update --remote vendor/ziglings-src

# 2. Regenerate artifacts (one command, idempotent)
node scripts/sync-ziglings.mjs

# 3. Human review of diff (do not skip)
git diff vendor/ziglings/catalog.json     # did zigFloor change? output changes? new/removed slugs?
git diff vendor/ziglings/exercises/       # spot-check changed exercises

# 4. Version alignment (only if zigFloor changed) — see §6.2
#    if new floor > current master compiler version: BLOCK. Either bump the
#    playground's master compiler, or roll the submodule back to a compatible commit.

# 5. Commit
git add vendor/ziglings/
git commit -m "bump ziglings: <old> → <new>"
```

**Bump is not "pull and done." It is "pull → diff → judge → commit."** The sync script does mechanical
regeneration; a human always decides whether to proceed.

### 2.7 Idempotency requirement

Identical submodule input must produce byte-identical `catalog.json`:
- `exercises` array sorted by `number`.
- Stable JSON serialization (fixed indent, key order, no trailing whitespace).
- Identical string escaping.

Value: a clean `git diff` after bump — you see what actually changed, not a full-file regeneration diff.

### 2.8 Licensing & attribution

- Ziglings LICENSE retained at `vendor/ziglings-src/LICENSE`.
- README + page footer attribute content to Ziglings contributors, source Codeberg.
- Official answers (patches) hidden by default (Ziglings' "no peeking" culture); revealed only on
  explicit user action ("Show official solution").

---

## 3. Verification Pipeline

### 3.1 Problem

When the user clicks Check, decide "is this correct?" in the browser. Replicate Ziglings' logic
(compile → run → take output → trimLines → exact-compare against `output`) over the wasm pipeline,
supporting both `exe` and `test` kinds, and fix a pre-existing stdout/stderr conflation.

### 3.2 Current pipeline (what we fork)

```
editor.ts dispatch({kind:"run", source})
  → SharedWorker (zig.shared.ts doOneCompile): zig.wasm compiles → wasm bytes
  → {kind:"compiled", wasm}
  → RunnerWorker (runner.ts): WASI instantiate + _start → output stream
  → {stderr, exitCode, done}
  → editor.ts
```

**Pre-existing defect (must fix):** `runner.ts:10-12` wires both stdout (fd1) and stderr (fd2) to the
same `ConsoleStdout`, both posted as `{stderr: ...}`. stdout and stderr are conflated and mislabeled.
Ziglings verification depends on `check_stdout` to pick the stream — the current pipeline cannot.

### 3.3 Verification pipeline overview

A **Verifier** module (pure logic, main-thread side, in/around editor.ts) orchestrates the verdict:

```
user source + exercise metadata (kind, output, checkStdout, ...)
  → [1] dispatch compile (mode = kind=="exe" ? "run" : "test")
       → compiled wasm
  → [2] dispatch execute (RunnerWorker)
       → raw stdout + raw stderr + exitCode
  → [3] branch verdict by kind (see 3.4)
  → [4] Verdict { status, detail }
```

The Verifier holds only verdict logic. Compile/execute are the workers' job. Input is
(source + metadata + execution result); output is a verdict. This makes verdict logic independently
unit-testable.

### 3.4 Two-kind verdict branching

**kind = "exe" (most exercises):** replicate Ziglings `checkOutput`
```
1. exitCode != 0 → FAIL (failKind="run"), detail = raw stderr
2. exitCode == 0 → take stream:
     checkStdout == true  → stdout
     checkStdout == false → stderr    (std.debug.print writes stderr)
3. trimLines(taken)
4. exact compare (eql) against trimLines(catalog.output)
5. match → PASS; else → FAIL (failKind="output_mismatch"), detail = expected-vs-actual diff
```

**kind = "test" (e.g. 105_testing):** replicate Ziglings `checkTest`
```
1. exitCode != 0 → FAIL (failKind="run"), detail = test-runner output
2. exitCode == 0 → PASS (no output comparison — zig test passing means correct)
```

**Test mode is supported in MVP.** `zig test` and `build-exe` share codegen/link; the test binary is
just another WASI `_start` program. The existing `runner.ts` runs it unchanged. Compile-side changes
(§3.5) are small and additive.

### 3.5 Test-mode compile changes

`shared-protocol.ts` — add a mode field on the run request:
```ts
| { kind: "run"; requestId; versionId; source: string; mode: "run" | "test" }
```

`zig.shared.ts doOneCompile` (and its legacy twin `zig.ts`) — branch argv on mode:
```
run:  ["zig.wasm", "build-exe", "main.zig", "libcompiler_rt.a", "-fno-compiler-rt", "-fno-entry"]
test: ["zig.wasm", "test",      "main.zig", "libcompiler_rt.a", "-fno-compiler-rt", "--test-no-exec"]
```
- `--test-no-exec` is load-bearing: without it `zig test` runs tests in-process inside the compiler's
  own WASI instance, mixing compile I/O with test I/O. With it, the compiler step is pure-compile and
  emits a `test.wasm` for the runner.
- Drop `-fno-entry` in test mode (the synthesized test-runner `_start` is needed).
- Read `test.wasm` (not `main.wasm`) from the WASI cwd in test mode.

`runner.ts` — **no changes.** It already runs any WASI `_start` program.

**Two things to verify empirically before locking the design** (minutes each):
1. `--test-no-exec` on the bundled Zig versions emits the binary.
2. The exact default output filename of `zig test`.

### 3.6 trimLines — exact replication, unit-tested

Ziglings' `trimLines` is not `trim()`. It is:
```
split into lines
trimEnd each line (strip trailing spaces and \r)
drop trailing empty lines (consecutive newlines)
do NOT trim leading spaces; do NOT alter internal whitespace
```

Why it matters: cross-platform line endings (`\n` vs `\r\n`), trailing-newline presence, all make a
naive `===` fail on a correct solution. trimLines is Ziglings' tolerance boundary; we must replicate
it exactly or correct solutions get marked wrong — an experience killer.

Implement `trimLines(s)` as a utility with its **own unit tests** locking boundary cases (empty string,
newlines-only, mixed `\r\n`, trailing spaces). This is the single highest-leverage test in the project.

### 3.7 stdout/stderr separation (fix the defect)

Modify `runner.ts` to post the two streams separately:
```ts
const stdout = new ConsoleStdout("stdout", (s) => post({ stream: "stdout", text: s }));
const stderr = new ConsoleStdout("stderr", (s) => post({ stream: "stderr", text: s }));
// fd1 → stdout, fd2 → stderr (no longer both → stderr)
```

`shared-protocol.ts` RunnerWorker replies become `{stream: "stdout"|"stderr", text}` + `{exitCode}` + `{done}`,
replacing the current `{stderr}`. Forked project, no backward-compat debt — change it clean.

### 3.8 Verdict structure

```ts
interface Verdict {
  status: "pass" | "fail";
  failKind?: "compile" | "run" | "output_mismatch";
  expected?: string;   // trimLines'd expected (output_mismatch only)
  actual?: string;     // trimLines'd actual (output_mismatch only)
  rawOutput?: string;  // raw compile/run output (compile/run failures)
}
```

Three failKinds (test failure folds into "run" — its output sits in rawOutput).

### 3.9 Compile-failure vs run-failure vs output-mismatch

The verdict distinguishes failure cause, which drives the failure UI:

| Situation | failKind | UI shows |
|---|---|---|
| Compile error (syntax/type) | compile | raw compiler stderr — reading errors IS the Ziglings teaching point |
| Runtime panic / nonzero exit | run | runtime stderr + exitCode |
| exe output mismatch | output_mismatch | expected-vs-actual line-by-line diff |
| test nonzero exit | run | test-runner output |

### 3.10 Enhancements riding the verification flow

- **Expected-output diff:** on `output_mismatch`, side-by-side expected/actual, mismatched lines
  highlighted. Line-by-line, not char-by-char.
- **Hint button:** `hint` always available as a user-triggered "Show hint" button (no attempt-counting,
  no staged reveal). Respects Ziglings' "try yourself first" culture by being opt-in.
- **Official-solution reveal (post-pass):** after passing, a "Show official solution" button applies
  the patch and shows the healed source for comparison. Available only on runnable exercises that
  the user has passed; not-runnable exercises are banner-only (no reveal).

### 3.11 Edge cases

- **Long output:** cap at 1 MiB (Ziglings' value); UI truncates with "show all".
- **Single total timeout:** one wall-clock budget (e.g. 30s) covering compile+execute. Exceed →
  FAIL with detail "running too long, possible infinite loop". Simpler than per-stage thresholds.
- **Timestamp exercises:** none runnable in MVP (§2.5 marks them not-runnable); no tolerance logic built.

### 3.12 Don't (MVP)

- No partial-correct judgement (pass/fail only).
- No user-supplied test input.
- No execution-time scoring.
- No patch-identity strict judgement (patch is reveal-only, never a grade).

---

## 4. Content Presentation (UI)

### 4.1 Problem

The forked editor core + output panel exist, but the playground is "single editor + Run." We add a
**course shell**: exercise list, problem panel, verdict panel, progress. And we cut playground-specific UI.

### 4.2 Cut on fork (subtraction first)

| Cut | Location | Reason |
|---|---|---|
| Examples dropdown | `editor.ts:345-384` | replaced by exercise list |
| Multi-version dropdown | editor.ts version select | single-version policy |
| Share / Embed / Twoslash / cut | editor.ts share/embed UI, `cut.ts`, `cut-lsp.ts` | not a sharing platform |
| URL `?code=`/`?b64=` source encoding | `editor.ts:222` priority chain | replaced by exercise routing |
| Global base64 draft | localStorage draft | replaced by per-exercise drafts |

**Keep unchanged:** CodeMirror + ZLS integration, `zig-shared-client.ts`, `shared-protocol.ts`
(extended for test mode), `compiler-cache.ts`, `version.ts` asset mechanism (used internally, no UI).

editor.ts slims from ~1000 lines; its job becomes "editor + compile/execute orchestration." Course
logic lives in the shell.

### 4.3 Layout (three panes)

```
┌─────────────────────────────────────────────────────────────┐
│  Top: Logo · current exercise (001_hello) · progress 3/113 · export/import │
├──────────┬──────────────────────────────┬───────────────────┤
│ Exercise │                              │  Problem + Verdict │
│ list     │     Editor (CodeMirror)       │                    │
│ (flat,   │                              │  ─────────────     │
│  ordered)│                              │  Expected output   │
│          │                              │  Your output       │
│ ✓ 001    │                              │  (diff)            │
│ ✓ 002    │                              │                    │
│ ▶ 003    │                              │  ─────────────     │
│ · 004    │                              │  [Show hint]       │
│ ⊘ 096    │                              │                    │
│ ...      │                              │  [Check] [Next]    │
├──────────┴──────────────────────────────┴───────────────────┤
│  Output panel (compile/run raw output, collapsible)         │
└─────────────────────────────────────────────────────────────┘
```

- **Left (nav):** flat ordered exercise list, status markers, top progress number. Read-only.
- **Center (editor):** where you write code. Clean, uncluttered.
- **Right (context):** problem body, expected/actual diff, hint, verdict result.
- **Bottom (output):** raw compile/run output. Collapsed by default, auto-expands on failure.

### 4.4 Left pane: exercise list & status

**Flat list, ordered by number. No grouping/classification in MVP** (deferred per §11).

Per-exercise status marker:
- `✓` solved (green)
- `▶` current (highlighted)
- `·` not attempted (grey)
- `⊘` not runnable (grey + tooltip with `notRunnableReason`)

**Progress:** top bar shows `3/113` with a thin progress bar. No mini-grid, no category breakdown.

No dedicated search box (browser Ctrl+F suffices for ~116 items).

### 4.5 Routing (URL = current exercise)

Replace playground's version-segment routing with **exercise routing**:
```
/         → redirect to first unsolved (or /1/)
/1/       → exercise number 1
/105/     → exercise 105 (test-kind)
/96/      → exercise 96 (not runnable, banner shown)
```

URL determines current exercise (by number). In-exercise edit state and progress live in localStorage,
not the URL — keeps URLs clean and shareable (sharing `/4/` opens exercise 4's initial state, not your draft).

Vite's existing SPA fallback handles these paths.

### 4.6 Right pane: problem & verdict

**Upper (persistent): problem body**
- Extracted from the source file's leading comments (every Ziglings exercise opens with teaching
  comments). Rendered as Markdown.
- Below: exercise metadata (kind, expected-output preview).

**Lower (dynamic): verdict region**
- Initial: `[Check]` button + "edit then Check to verify".
- Checking: "Compiling..." / "Running..." (reuse playground's status mechanism).
- PASS: green "✓ Passed" + `[Next]` + `[Show official solution]`.
- FAIL (compile): red "✗ Compile error" + raw compiler stderr (monospace, scrollable).
- FAIL (output_mismatch): red "✗ Output mismatch" + side-by-side expected/actual diff.
- FAIL (run/test): red "✗ Run failed" / "✗ Tests failed" + runner output.

**Diff rendering:** line-by-line (expected left / actual right), mismatched lines highlighted. Not
char-level diff (too noisy).

### 4.7 Per-exercise draft persistence

```
localStorage key: "ziglings:drafts"
value: { "<slug>": "<user source string>", ... }   // only exercises the user has edited
```

- Enter exercise → load its draft (or initial broken source if none).
- Edit → debounce-save into that exercise's entry.
- Switch exercise → current draft already saved; new exercise loads its own.
- Pass → draft retained (user can revisit their solution); solved-flag set independently.

**Lazy storage:** only exercises actually edited get an entry. Keeps size bounded.

### 4.8 Check flow state machine

```
idle → checking (disable button, show stage) → verdict (pass/fail) → idle
```

- Checking disables Check + shows stage, preventing double-submit.
- **Auto-run is OFF by default** in the learning platform. Auto-run executes the user's broken code
  and floods the output with noise, interfering with learning. Explicit Check is primary. (The ZLS
  diagnostic-gated silent run can stay if it's low-noise; otherwise cut.)

### 4.9 Not-runnable exercises

For `runnable=false` (~3 exercises):
- Left list marks `⊘`, greyed.
- On open: problem body shows normally; **editor is read-only**; top banner:
  "This exercise needs a local Zig environment (reason: `link_libc` / `file_io` / `timestamp_exercise`).
  Complete it locally via `git clone` of Ziglings."
- No Check button.
- No official-solution reveal (cut in simplicity review).

All 116 exercises are present; the experience does not fracture.

### 4.10 Top bar & global elements

- Logo + project name (Ziglings Web).
- Current exercise indicator (`001_hello`, clickable).
- Global progress (`3/113` + thin bar).
- Export/Import buttons.
- Footer attribution: "Content © Ziglings contributors · Source: codeberg.org/ziglings/exercises".

### 4.11 Mobile

Inherit the playground's mobile-aware split. On narrow screens the three panes collapse to a single
pane with top tabs (list / editor / problem). MVP prioritizes desktop; mobile is "usable," not equal.

### 4.12 Don't (MVP)

- No learning-path / dependency graph (flat list suffices).
- No achievements / badges / streak.
- No notes / bookmarks.
- No exercise translation.
- No user-authored exercises.
- No theme switcher (single theme per DESIGN.md).

---

## 5. Progress System

### 5.1 Storage layout — two keys, not three

```
ziglings:progress    → which exercises are solved + when
ziglings:drafts      → per-exercise draft source
```

**No `meta` key.** `lastActiveKey` is expressed by the URL (routing is state). `stats` are derived
from progress in O(1). No streak.

### 5.2 progress schema

```ts
// ziglings:progress
{
  version: 1,                     // schema version, for future migration
  ziglingsCommit: "abc123",       // which Ziglings commit this progress is against
  solved: {
    "001_hello": "2026-07-28T10:30:00Z",   // slug → pass timestamp (ISO)
    "002_std":   "2026-07-28T11:00:00Z",
  }
}
```

- `solved` keyed by **slug** (stable cross-version), not number. Bump needs no migration table.
- No `attempts` field (cut in simplicity review — hint is a user-triggered button, no counting).

### 5.3 drafts schema

```ts
// ziglings:drafts
{
  version: 1,
  drafts: {
    "001_hello": "const std = @import(\"std\");\n..."   // slug → source string
  }
}
```

Pure string values (no `updatedAt` — import is full-replace, no per-field merge). Lazy: only edited
exercises appear.

### 5.4 Landing behavior

```
1. Read URL → current exercise (or redirect to /1/ if root and no progress).
2. Read progress.solved → render left-list status markers + top progress count.
3. Read drafts[currentSlug] → load draft (or initial broken source if none).
4. Compare progress.ziglingsCommit vs catalog.version:
     mismatch → orphan-handling (see 5.6); no migration table.
```

First visit: both keys empty → land on `/1/`, progress 0/113, list all grey. Zero config.

### 5.5 Export / Import (the manual-sync mechanism)

**Export:** top-bar button downloads `ziglings-progress-YYYYMMDD.json`:
```jsonc
{
  "format": "ziglings-progress",
  "formatVersion": 1,
  "exportedAt": "2026-07-28T11:20:00Z",
  "progress": { /* entire ziglings:progress */ },
  "drafts":   { /* entire ziglings:drafts */ }
}
```

**Import:** top-bar button → file picker → **full replace**. Before replacing, **automatically
download a backup of the current local data** so the replace is safe and recoverable.

No per-field merge, no timestamps on drafts, no CRDT. Simple and recoverable.

### 5.6 Version handling after bump (slug-keyed, no migration table)

Because progress is keyed by slug:
- **Unchanged slug (the vast majority):** key still resolves in the new catalog → progress carries
  over automatically, zero work.
- **Disappeared slug (rename/delete, rare):** key no longer resolves → becomes an orphan, retained
  in progress but not displayed; carried in exports.
- **New slug:** naturally has no progress.

No `catalog-history.json`. Renames with different slugs cannot be auto-migrated anyway (the new name
isn't inferable); orphan-retention + manual handling suffices.

### 5.7 Honest data-loss notice

localStorage is lossy (clear cache, private mode, browser switch). The UI is honest:
- One-time first-visit top banner: "Progress is stored in this browser. To move devices, use
  Export/Import." Dismissible.
- Export always reachable from the top bar — lowers loss anxiety.

No pretense of cloud. Users who know the boundary trust it.

### 5.8 Don't (MVP)

- No automatic cloud sync.
- No accounts/login.
- No "share my progress" link (would need server storage).
- No dedicated wrong-answer book (cut; no attempts counting).
- No streak / time tracking.

---

## 6. Version Management, CI, Deployment

### 6.1 Three coupled changes

```
Ziglings commit (content source)
  → determines catalog.version + zigFloor + content
  → determines required Zig compiler version (>= zigFloor)
  → determines whether the playground's master compiler is new enough
  → if not: this project blocks (wait for playground upgrade, or roll back Ziglings commit)
```

**Invariant to maintain:** `playground master compiler version >= catalog.zigFloor`. All flows serve this.

### 6.2 Full bump flow

```bash
# 1. Update source
git submodule update --remote vendor/ziglings-src

# 2. Regenerate (one command, idempotent)
node scripts/sync-ziglings.mjs

# 3. Human diff review (do not skip)
git diff vendor/ziglings/catalog.json    # zigFloor change? output changes? new/removed slugs?
git diff vendor/ziglings/exercises/      # spot-check

# 4. Version alignment (only if zigFloor changed)
#    if new floor > current master compiler version → BLOCK. Do not deploy.

# 5. Regression (CI checks, see 6.5)

# 6. Commit
git add vendor/ziglings/
git commit -m "bump ziglings: <old> → <new>"
```

**Bump = pull → diff → judge → commit.** Mechanical regen is the script; the human decides.

### 6.3 Compiler asset strategy

**Recommended for MVP: (a) reuse the playground's compiler URLs.**
`version.ts` points at `https://zp.xihale.top/compilers/master/...`. Zero build cost; the project
ships as a pure static site with no wasm-build step.

**Known cost:** runtime coupling to the playground being online. If the playground is down, this
project's compiler fetch fails too. Documented as a known coupling point; switching to (b) —
self-built compiler assets via the forked `build.zig` — is a future independence step, not an MVP need.

This is a **deferred decision**, recorded here; confirm during implementation.

### 6.4 CI — three invariants

#### Check 1: catalog integrity
```bash
node scripts/check-catalog.mjs
```
- Every exercise's `sourcePath` / `patchPath` files exist.
- `number` unique.
- `zigFloor` present.
(Trimmed from earlier draft — category/runnable self-checks are derived, surface naturally if wrong.)

#### Check 2: verification-pipeline smoke test
```bash
node scripts/smoke-verify.mjs
```
Not all 113 exercises. Sample:
- 2 of each `kind` (exe / test).
- Each `failKind` covered (compile error / output mismatch / pass).
- Pre-made source fixtures (correct + intentionally wrong) run through the verifier; assert Verdicts.

Guards the core: trimLines, stdout/stderr separation, two-kind branching. If these break, smoke goes red.

#### Check 3: version alignment
```bash
node scripts/check-version-alignment.mjs
```
Assert `catalog.zigFloor <= playground master compiler version` (pulled from playground's versions.json).
Fails → block deploy.

### 6.5 Deployment

Pure static, GitHub Pages, custom domain — same shape as the playground:
```
npm run build = vite build + node scripts/assemble-dist.mjs  → dist/ → gh-pages branch
domain: ziglings.xihale.top (or chosen)
```
With §6.3 (a): no wasm build; the site references the playground's deployed compiler assets.

### 6.6 Monitoring & degradation (honest)

- Compiler-asset load failure: top banner "compiler failed to load, check network and refresh."
- Single exercise unexpectedly fails to compile: that exercise degrades to "temporarily unavailable";
  others unaffected. One failure must not tank the site.
- localStorage quota: if export size grows large (>4MB), suggest "you have many drafts; consider
  exporting and clearing solved-exercise drafts."

### 6.7 Documentation

Root README records:
- What this is, relationship to Ziglings/playground (attribution).
- The bump operation manual (§6.2) so future-self/contributors can reproduce.
- The version-strategy tradeoff (why dev/master-only, what it costs).
- The progress slug-keying rationale (§5.6).

`docs/` holds this design spec.

### 6.8 Don't (MVP)

- No automated bump bot (bump needs human judgement).
- No staging/prod environments.
- No CDN / perf optimization (Pages suffices).
- No error reporting (Sentry etc.) — no-backend principle.

---

## 7. Summary of Key Decisions

| Dimension | Decision |
|---|---|
| Depth | Deep integration — independent Zig learning platform |
| Project relation | Fork playground, then diverge, no code-sync |
| Positioning | Enhanced-experience: Ziglings content + better UX |
| Version strategy | Track dev/master only, accept bump maintenance cost |
| Verification | Output-compare primary + patch for official-solution reveal |
| test-kind | **In MVP** — small additive compile-mode branch, runner unchanged |
| Not-runnable exercises | libc + timestamp + file-IO heuristic; banner + read-only |
| Progress persistence | localStorage, two keys (progress/drafts), full-replace import |
| Audience/deploy | English-first, independent domain |
| Architecture | Course shell wrapping editor core; three-pane layout |
| Progress key | **slug** (stable cross-version) — eliminates migration history table |
| Hint | User-triggered button, no counting/staging |
| Compiler assets | Reuse playground URLs (deferred decision; self-build later if needed) |

---

## 8. Success Criteria (MVP complete when)

1. ~113/116 runnable exercises can be selected, edited, Checked, and judged pass/fail.
2. Both `exe` and `test` kinds work through one pipeline.
3. Progress persists in localStorage across refreshes; export/import round-trips.
4. Core experience enhancements are landed: progress visualization (top bar + list markers),
   expected-output diff, and the hint button.
5. Not-runnable exercises show a clear "needs local environment" banner without breaking the list.
6. Deploys as a pure static site with no backend dependency.
7. Bump flow is reproducible from the README manual; CI's three checks pass.

---

## 9. Open Questions / Deferred Decisions

1. **Exercise classification (category field):** deferred. Decide after importing real content and
   observing natural groupings. catalog has no `category` field in MVP.
2. **Compiler asset strategy (§6.3):** recommend (a) reuse playground URLs for MVP. Confirm at
   implementation; the runtime coupling is acceptable to start.
3. **`--test-no-exec` empirical verification:** confirm it emits a binary on the bundled Zig versions,
   and confirm `zig test`'s default output filename. Minutes each; do at implementation start.
4. **Auto-run:** off by default; decide whether the diagnostic-gated silent run stays or is fully cut.
5. **Final project/domain name** ("Ziglings Web" is a working name).

---

## 10. Explicit Simplicity Wins (vs. earlier draft)

- **slug-keyed progress** → no `catalog-history.json`, no migration table.
- **Two localStorage keys** (cut `meta`) → `lastActiveKey` via URL, `stats` derived.
- **No `attempts` / staged hints** → single user-triggered hint button.
- **No streak / mini-grid / search box / not-runnable reveal** → flat list + top progress.
- **Single total timeout** (not per-stage).
- **Three failKinds** (test folds into run).
- **Full-replace import** (with auto-backup), not per-field merge; drafts are plain strings.
- **No `category` field in MVP** (deferred).
- **timestamp exercise not runnable** (no tolerance logic).

---

## 11. Relationship to Existing Playground Specs

This spec is self-contained and lives in the **new project's** repo after fork. It references the
playground's existing specs only to describe what is being carried over:
- `2026-07-26-multi-version-compilers-design.md` — the asset/version mechanism reused (internally).
- `2026-07-26-shared-compiler-worker-design.md` — the SharedWorker + wire protocol extended for test mode.

No content is copied; the fork carries the code, this spec describes the new project's own design.
