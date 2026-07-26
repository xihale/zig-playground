import { EditorState } from "@codemirror/state";
import {
  keymap,
  EditorView,
  lineNumbers,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  type ViewUpdate,
} from "@codemirror/view";
import { formatDocument, LSPPlugin } from "@codemirror/lsp-client";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  indentUnit,
  syntaxHighlighting,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  bracketMatching,
  foldKeymap,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  closeBrackets,
  autocompletion,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { forEachDiagnostic, lintKeymap, setDiagnosticsEffect } from "@codemirror/lint";
import { zigLanguage } from "@ndim/codemirror-lang-zig";
import { editorTheme, highlightStyle } from "./theme.ts";
import { fullLineSelection } from "./full-line-selection.ts";
import {
  highlightActiveLineEmptyOnly,
  highlightActiveLineGutterEmptyOnly,
} from "./active-line.ts";
import { lspClient, initZls } from "./lsp.ts";
import { examplesFor } from "./examples.ts";
import {
  parseEmbedConfig,
  buildShareUrl,
  buildIframeSnippet,
} from "./embed.ts";
import { bindCuts, resolveCompileSource, type CutBinding } from "./cut.ts";
import { setCutLspBridge } from "./cut-lsp.ts";
import {
  loadVersionsManifest,
  resolveVersion,
  pathForVersion,
} from "./version.ts";
import { ZigSharedClient } from "./zig-shared-client";
import type { WorkerMsg } from "./shared-protocol";
// @ts-ignore
import RunnerWorker from './workers/runner.ts?worker';

/**
 * Settle window after a structural trigger / Mod-S before syncing to ZLS
 * and waiting for publishDiagnostics (ms). Same order of magnitude as
 * `@codemirror/lsp-client` serverDiagnostics autoSync.
 */
const AUTO_RUN_DEBOUNCE_MS = 500;

/**
 * B: arm auto-run only on statement/block boundaries or multi-line paste —
 * not on every keystroke. Lone Enter (`\n`) is excluded.
 */
function isStructuralAutoRunTrigger(update: ViewUpdate): boolean {
  let hit = false;
  update.changes.iterChanges((_fa, _ta, _fb, _tb, inserted) => {
    if (hit) return;
    const text = inserted.toString();
    if (text.includes(";") || text.includes("}")) {
      hit = true;
      return;
    }
    // Multi-line paste (more than a single newline from Enter).
    if (text.length > 1 && text.includes("\n")) hit = true;
  });
  return hit;
}

// Embed mode: blog/doc iframes pass source via ?code= / ?b64= and hide chrome.
const embedConfig = parseEmbedConfig();
if (embedConfig.embed) {
  document.body.classList.add("embed");
  document.documentElement.classList.add("embed");
}

// Resolve compiler version from URL path before workers fetch wasm.
const versionsManifest = loadVersionsManifest();
const playgroundVersion = resolveVersion(versionsManifest);
/** Examples for the active compiler path (0.15.2 / 0.16.0 / master, …). */
const examples = examplesFor(playgroundVersion.id);
const versionSelect = document.getElementById("version-select") as HTMLSelectElement | null;
if (versionSelect) {
  for (const v of versionsManifest.versions) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.label;
    if (v.id === playgroundVersion.id) opt.selected = true;
    versionSelect.appendChild(opt);
  }
  if (embedConfig.embed) {
    versionSelect.hidden = true;
  } else {
    versionSelect.addEventListener("change", () => {
      const next = versionSelect.value;
      if (next === playgroundVersion.id) return;
      const path = pathForVersion(next, versionsManifest);
      const url = new URL(path, location.origin);
      url.search = location.search;
      url.hash = location.hash;
      location.assign(url.href);
    });
  }
}
document.title = `Zig Playground (${playgroundVersion.entry.label})`;

// basicSetup clone with custom fold markers (open ⌄ vs closed › need
// different optical Y offsets — a single translate can't fix both).
const playgroundSetup = [
  lineNumbers(),
  // Active line only for empty carets — non-empty selection stays uniform.
  highlightActiveLineGutterEmptyOnly(),
  highlightSpecialChars(),
  history(),
  foldGutter({
    markerDOM(open) {
      const span = document.createElement("span");
      span.className = open ? "cm-fold-open" : "cm-fold-closed";
      span.textContent = open ? "⌄" : "›";
      return span;
    },
  }),
  drawSelection(),
  // Paint selection as full line-box height (CM default uses text metrics only).
  fullLineSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLineEmptyOnly(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
];

// ─── Source persistence ─────────────────────────────────────────
// Survive reloads via localStorage. Debounced while typing; also
// flushed on page hide so a quick tab close still keeps the draft.
// Embed mode and URL-supplied source never touch the draft store.

const SOURCE_STORAGE_KEY = "zig-playground-source";
/** Full-app draft only — never pollute host tabs from an iframe demo. */
const persistDraft = !embedConfig.embed && embedConfig.code === null;

function loadSavedSource(): string | null {
  if (!persistDraft) return null;
  try {
    return localStorage.getItem(SOURCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveSource(source: string) {
  if (!persistDraft) return;
  try {
    localStorage.setItem(SOURCE_STORAGE_KEY, source);
  } catch {
    // Private mode / quota — ignore.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
  if (!persistDraft) return;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSource(editorSource());
  }, 300);
}

function flushSave() {
  if (!persistDraft) return;
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveSource(editorSource());
}

window.addEventListener("pagehide", flushSave);
window.addEventListener("beforeunload", flushSave);

// ─── CodeMirror ──────────────────────────────────────────────────

const blankTemplate = `const std = @import("std");

pub fn main() !void {
}
`;

const savedSource = loadSavedSource();
// Priority: URL code → local draft → first bundled example.
const rawInitial = embedConfig.code ?? savedSource ?? examples[0].code;

/**
 * Embed + Twoslash cuts: editor holds only the visible slice; compile
 * reassembles prefix/suffix. No block-replace decorations (those broke
 * active-line and docView).
 *
 * LSP dual-doc (`cut-lsp.ts`): ZLS is fed the full stitched program so
 * hover / diagnostics / complete stay correct on single-island cuts.
 */
let cutBinding: CutBinding | null = null;
let initialDoc = rawInitial;
if (embedConfig.embed) {
  const bound = bindCuts(rawInitial);
  initialDoc = bound.display;
  cutBinding = bound.binding;
}

/** Buffer shown in the editor (may be a cut slice in embed mode). */
function editorSource(): string {
  return editor.state.doc.toString();
}

/** Full program for zig worker / share (stitches cuts when bound). */
function compileSource(): string {
  const display = editorSource();
  return cutBinding ? resolveCompileSource(display, cutBinding) : display;
}

// Wire dual-doc before the LSP plugin opens the file on editor construct.
setCutLspBridge(cutBinding, () => {
  // Editor may not exist yet during the first didOpen; use initialDoc.
  try {
    return editor.state.doc.toString();
  } catch {
    return initialDoc;
  }
});

const editor = new EditorView({
  extensions: [],
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc: initialDoc,
    extensions: [
      playgroundSetup,
      editorTheme,
      indentUnit.of("    "),
      keymap.of([
        indentWithTab,
        {
          // Mod-S: format (when not dual-doc cut) + arm auto-run.
          // preventDefault avoids the browser "Save page" dialog.
          key: "Mod-s",
          preventDefault: true,
          run: (view) => {
            // Format rewrites the whole buffer — skip in cut dual-doc (would
            // only reformat the slice and break the stitch).
            if (!cutBinding?.visible) formatDocument(view);
            requestAutoRun();
            return true;
          },
        },
        {
          // Useful in embed mode (no Run button) and as a power-user shortcut.
          key: "Mod-Enter",
          run: () => {
            runCode();
            return true;
          },
        },
      ]),
      zigLanguage,
      syntaxHighlighting(highlightStyle),
      lspClient.plugin("file:///main.zig"),
      // Auto-run (full UI + embed): structural edit / Mod-S → debounce →
      // sync → wait for diagnostics → run only when LSP reports no errors.
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleSave();
          noteAutoRunDocChanged(update);
          return;
        }
        // D: gate only after a diagnostics publish for the settled buffer.
        for (const tr of update.transactions) {
          for (const e of tr.effects) {
            if (e.is(setDiagnosticsEffect)) {
              tryAutoRun();
              return;
            }
          }
        }
      }),
    ],
  }),
});

function replaceDoc(text: string) {
  editor.dispatch({
    changes: {
      from: 0,
      to: editor.state.doc.length,
      insert: text,
    },
  });
}

// ─── Examples dropdown ──────────────────────────────────────────

const exampleSelect = document.getElementById("example-select")! as HTMLSelectElement;
{
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Blank";
  exampleSelect.appendChild(blank);
}
for (const ex of examples) {
  const opt = document.createElement("option");
  opt.value = ex.name;
  opt.textContent = ex.name;
  exampleSelect.appendChild(opt);
}
// Restore matching example label when possible; otherwise Blank for
// custom drafts (or Hello World on a first visit with no save).
{
  const matched = examples.find((e) => e.code === initialDoc);
  if (matched) {
    exampleSelect.value = matched.name;
  } else if (initialDoc === blankTemplate || savedSource !== null) {
    exampleSelect.value = "";
  } else {
    exampleSelect.selectedIndex = 1;
  }
}
exampleSelect.addEventListener("change", () => {
  // Full-app example switch: clear any cut binding from a prior URL load.
  cutBinding = null;
  setCutLspBridge(null, editorSource);
  if (exampleSelect.value === "") {
    replaceDoc(blankTemplate);
    runCode();
    return;
  }
  const ex = examples.find(e => e.name === exampleSelect.value);
  if (ex) {
    replaceDoc(ex.code);
    runCode();
  }
});

// ─── Output routing ─────────────────────────────────────────────
// Single output area that shows only the current run. Each run clears
// the previous content. Status (idle / loading / running / exit code)
// lives in the preview toolbar — not in the text stream.

const outputContainer = document.getElementById("output-container")!;
const outputPad = document.getElementById("output-pad")!;
const runStatus = document.getElementById("run-status")!;
const statusText = document.getElementById("status-text")!;

let compileBlock: HTMLElement | null = null;
let runBlock: HTMLElement | null = null;

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "running" }
  | { kind: "exit"; code: number; crashed?: boolean };

function setStatus(status: Status) {
  runStatus.classList.remove("idle", "busy", "ok", "err");
  if (status.kind === "idle") {
    runStatus.classList.add("idle");
    statusText.textContent = "idle";
  } else if (status.kind === "loading") {
    runStatus.classList.add("busy");
    statusText.textContent = "loading";
  } else if (status.kind === "running") {
    runStatus.classList.add("busy");
    statusText.textContent = "running";
  } else {
    const bad = status.code !== 0 || !!status.crashed;
    runStatus.classList.add(bad ? "err" : "ok");
    statusText.textContent = String(status.code);
  }
}

/** Wipe the output area for a fresh run. */
function clearOutput() {
  outputPad.replaceChildren();
  compileBlock = null;
  runBlock = null;
  outputContainer.scrollLeft = 0;
}

function scrollOutput() {
  // Follow new output vertically; leave horizontal scroll alone so the
  // user can pan long lines without being yanked back to the start.
  outputContainer.scrollTop = outputContainer.scrollHeight;
}

function appendCompile(text: string) {
  if (!compileBlock) {
    compileBlock = document.createElement("div");
    compileBlock.className = "zig-output";
    outputPad.appendChild(compileBlock);
  }
  compileBlock.textContent += text;
  scrollOutput();
}

/** Drop the compile-stage block — used on success so progress lines
 *  vanish before the program output streams in. */
function clearCompile() {
  if (compileBlock) {
    compileBlock.remove();
    compileBlock = null;
  }
}

function appendRun(text: string) {
  if (!runBlock) {
    runBlock = document.createElement("div");
    runBlock.className = "runner-output";
    outputPad.appendChild(runBlock);
  }
  runBlock.textContent += text;
  scrollOutput();
}

// ─── zig worker / run queue ─────────────────────────────────────
// 1) Worker loads std + zig.wasm async → UI shows "loading".
// 2) Only after { ready: true } does the compile queue run.
// At most one compile+run in flight. Further requests keep a single
// pending snapshot (latest source wins) and never double-post the worker.

/** True once zig worker has finished fetching/compiling compiler assets. */
let compilerReady = false;
/**
 * True once the user (or an autorun URL) has triggered the first run.
 * Until then: workers stay un-booted (no asset fetches), the output pane
 * is hidden, and structural-edit auto-run is suppressed.
 */
let hasRunOnce = false;

// Lazy workers: do not fetch zig.wasm / zls.wasm until the first run is
// requested. Embed (default no autorun) and the full app on a path that
// does not auto-run stay asset-free until the user actually clicks Run.
let zigWorker: ZigSharedClient | null = null;
let workersBooted = false;
function bootWorkersOnce() {
  if (workersBooted) return;
  workersBooted = true;
  zigWorker = new ZigSharedClient();
  zigWorker.onmessage = onZigWorkerMessage;
  zigWorker.dispatch({ kind: "init", versionId: playgroundVersion.id });
  initZls(playgroundVersion.id);
}

/** Monotonic id for the in-flight job; stale worker/runner msgs ignored. */
let runGen = 0;
/** True while compile or run is in flight (not during asset loading). */
let runBusy = false;
/** Single pending source; overwritten on each request while busy/loading. */
let pendingSource: string | null = null;
/** Source of the last started job — skip no-op auto-runs when idle. */
let lastStartedSource: string | null = null;
let autoRunTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * True after a structural trigger / Mod-S until we queue an auto-run (or
 * force run). Stays true while LSP still reports errors so a later clean
 * publishDiagnostics can unstick the queue.
 */
let autoRunWanted = false;
/**
 * D: after debounce+sync, true until tryAutoRun consumes a diagnostics
 * publish (or the settle cycle is re-armed by further edits).
 */
let autoRunAwaitingDiags = false;
/** Bumped on every settle re-arm so in-flight timers/diag waits go stale. */
let autoRunEpoch = 0;
/**
 * After sync with didChange, wait this long for publishDiagnostics before
 * gating on whatever lint is present (ZLS hang safety).
 */
const AUTO_RUN_DIAGS_WAIT_MS = 2000;
/**
 * When sync was a no-op (e.g. lsp-client autoSync already flushed), diags
 * for this buffer are usually already applied or in flight — short fallback.
 */
const AUTO_RUN_DIAGS_FALLBACK_MS = 120;
let activeRunner: Worker | null = null;
/** Delay before flipping status to "running" — skips flash on fast exits. */
let runningStatusTimer: ReturnType<typeof setTimeout> | null = null;

function clearAutoRunTimer() {
  if (autoRunTimer !== null) {
    clearTimeout(autoRunTimer);
    autoRunTimer = null;
  }
}

function clearRunningStatusTimer() {
  if (runningStatusTimer !== null) {
    clearTimeout(runningStatusTimer);
    runningStatusTimer = null;
  }
}

function startRun(source: string) {
  runGen += 1;
  runBusy = true;
  pendingSource = null;
  lastStartedSource = source;
  clearRunningStatusTimer();

  if (activeRunner) {
    activeRunner.terminate();
    activeRunner = null;
  }

  clearOutput();
  // No "compiling" status — keep last status until exit or "running".
  zigWorker!.dispatch({ kind: "run", requestId: String(runGen), versionId: playgroundVersion.id, source });
}

/** End the current job if still current; drain at most one pending. */
function completeRun(gen: number) {
  if (gen !== runGen) return;
  runBusy = false;
  if (pendingSource === null) return;
  const next = pendingSource;
  pendingSource = null;
  startRun(next);
}

/**
 * Request a compile+run.
 * - Before compiler ready: queue only, status stays "loading".
 * - While busy: one pending slot only, always overwritten (latest wins).
 *   Auto-run with unchanged source does not queue (avoids first-load
 *   double-run when `;` logic races the initial job).
 * - When idle: start immediately (auto skips unchanged source).
 */
function requestRun(opts: { force?: boolean } = {}) {
  const source = compileSource();

  // First ever run: boot workers (fetches zig.wasm / zls.wasm). Subsequent
  // requests land in the !compilerReady / runBusy branches below while the
  // assets stream in.
  if (!workersBooted) bootWorkersOnce();

  if (!compilerReady) {
    // Asset load in flight — stay on "loading".
    if (!opts.force && pendingSource !== null && source === pendingSource) return;
    if (!opts.force && pendingSource === null && source === lastStartedSource) return;
    pendingSource = source;
    setStatus({ kind: "loading" });
    return;
  }

  if (runBusy) {
    if (!opts.force && source === lastStartedSource) return;
    pendingSource = source;
    // Already executing wasm: drop it and start the pending job now.
    // (Compile cannot be cancelled; pending is picked up when it finishes.)
    if (activeRunner) {
      const gen = runGen;
      activeRunner.terminate();
      activeRunner = null;
      completeRun(gen);
    }
    return;
  }
  if (!opts.force && source === lastStartedSource) return;
  startRun(source);
}
/** Button / first load / example switch — always run (ignores LSP errors). */
function runCode() {
  if (!hasRunOnce) {
    hasRunOnce = true;
    document.body.classList.add("has-run");
    const embedRunBtn = document.getElementById("embed-run");
    if (embedRunBtn) embedRunBtn.hidden = true;
  }
  autoRunWanted = false;
  autoRunAwaitingDiags = false;
  clearAutoRunTimer();
  requestRun({ force: true });
}

/** True if CodeMirror lint currently has any error-severity diagnostics. */
function hasLspErrors(): boolean {
  let found = false;
  forEachDiagnostic(editor.state, (d) => {
    if (d.severity === "error") found = true;
  });
  return found;
}

/**
 * Auto-compile only when LSP shows no errors for the settled buffer.
 * Keeps `autoRunWanted` + `autoRunAwaitingDiags` while blocked so a later
 * clean publishDiagnostics can proceed.
 */
function tryAutoRun() {
  if (!autoRunWanted || !autoRunAwaitingDiags) return;
  const plugin = LSPPlugin.get(editor);
  // Buffer moved since last sync — wait for the re-armed settle cycle.
  if (plugin && !plugin.unsyncedChanges.empty) return;
  if (hasLspErrors()) return;
  autoRunWanted = false;
  autoRunAwaitingDiags = false;
  clearAutoRunTimer();
  requestRun({ force: false });
}

/**
 * D: debounce → sync → wait for setDiagnosticsEffect (not stale pre-sync
 * lint). Fallback timer covers no-op sync when autoSync already flushed.
 */
function scheduleAutoRunSettle() {
  clearAutoRunTimer();
  autoRunAwaitingDiags = false;
  const epoch = ++autoRunEpoch;
  autoRunTimer = setTimeout(() => {
    autoRunTimer = null;
    if (!autoRunWanted || epoch !== autoRunEpoch) return;
    const plugin = LSPPlugin.get(editor);
    if (!plugin) {
      autoRunAwaitingDiags = true;
      tryAutoRun();
      return;
    }
    const hadUnsynced = !plugin.unsyncedChanges.empty;
    plugin.client.sync();
    if (!autoRunWanted || epoch !== autoRunEpoch) return;
    autoRunAwaitingDiags = true;
    // Prefer the next publishDiagnostics; fall back so we never hang if
    // ZLS does not re-publish (sync was a no-op / already applied).
    const waitMs = hadUnsynced ? AUTO_RUN_DIAGS_WAIT_MS : AUTO_RUN_DIAGS_FALLBACK_MS;
    autoRunTimer = setTimeout(() => {
      autoRunTimer = null;
      if (!autoRunWanted || epoch !== autoRunEpoch) return;
      tryAutoRun();
    }, waitMs);
  }, AUTO_RUN_DEBOUNCE_MS);
}

/** Arm auto-run from structural edit or Mod-S. */
function requestAutoRun() {
  // Suppress auto-run until the first explicit run — no point compiling
  // before the user has even looked at the code (and it would boot workers
  // + fetch assets we are trying to keep deferred).
  if (!hasRunOnce) return;
  autoRunWanted = true;
  scheduleAutoRunSettle();
}

/**
 * B: structural inserts / format arm auto-run. While already armed, any
 * further edit re-settles so we never compile against stale diagnostics.
 */
function noteAutoRunDocChanged(update: ViewUpdate) {
  if (isStructuralAutoRunTrigger(update)) {
    requestAutoRun();
    return;
  }
  for (const tr of update.transactions) {
    if (tr.isUserEvent("format")) {
      requestAutoRun();
      return;
    }
  }
  if (autoRunWanted) scheduleAutoRunSettle();
}

const onZigWorkerMessage = (msg: WorkerMsg) => {
  // Compiler assets ready (or failed) — open the compile queue.
  if (msg.kind === "ready") {
    if (msg.ok) {
      compilerReady = true;
      if (pendingSource !== null) {
        const next = pendingSource;
        pendingSource = null;
        startRun(next);
      }
    } else {
      compilerReady = false;
      clearOutput();
      appendCompile(msg.error ? `${msg.error}\n` : "failed to load compiler\n");
      setStatus({ kind: "exit", code: 1, crashed: true });
    }
    return;
  }

  const gen = runGen;

  // Compile-time stderr (diagnostics).
  if (msg.kind === "stderr") {
    if (msg.requestId !== String(gen)) return;
    appendCompile(msg.text);
    return;
  }

  // A failed compile: the diagnostics are this run's result.
  if (msg.kind === "failed") {
    if (msg.requestId !== String(gen)) return;
    clearRunningStatusTimer();
    setStatus({ kind: "exit", code: 1, crashed: true });
    completeRun(gen);
    return;
  }

  // Successful compile. If a newer request is already pending, drop this
  // artifact and start the latest source instead of running stale wasm.
  if (msg.kind === "compiled") {
    if (msg.requestId !== String(gen)) return;

    if (pendingSource !== null) {
      const next = pendingSource;
      pendingSource = null;
      startRun(next);
      return;
    }

    clearCompile();
    // Only show "running" if still in flight after 350ms — fast programs
    // go straight to exit code with no intermediate flicker.
    clearRunningStatusTimer();
    runningStatusTimer = setTimeout(() => {
      runningStatusTimer = null;
      if (gen !== runGen) return;
      setStatus({ kind: "running" });
    }, 350);

    if (activeRunner) {
      activeRunner.terminate();
      activeRunner = null;
    }
    const runnerWorker = new RunnerWorker();
    activeRunner = runnerWorker;
    // Transfer the compiled wasm bytes to the runner.
    runnerWorker.postMessage({ run: msg.wasm }, [msg.wasm]);

    runnerWorker.onmessage = (rev: MessageEvent) => {
      if (gen !== runGen) return;
      if (rev.data.stderr) {
        appendRun(rev.data.stderr);
      } else if (rev.data.exitCode !== undefined) {
        clearRunningStatusTimer();
        setStatus({
          kind: "exit",
          code: rev.data.exitCode,
          crashed: !!rev.data.crashed,
        });
        completeRun(gen);
      } else if (rev.data.done) {
        if (activeRunner === runnerWorker) activeRunner = null;
        runnerWorker.terminate();
      }
    };
  }
};

// ─── Run / Reset / Share / auto-run ─────────────────────────────

const runButton = document.getElementById("run")! as HTMLButtonElement;
runButton.addEventListener("click", runCode);

function resetCode() {
  cutBinding = null;
  setCutLspBridge(null, editorSource);
  exampleSelect.value = "";
  replaceDoc(blankTemplate);
  runCode();
}

const resetButton = document.getElementById("reset")! as HTMLButtonElement;
resetButton.addEventListener("click", resetCode);

// Share menu: copy link (full UI) or iframe snippet (embed UI).
const shareMenu = document.getElementById("share-menu")!;
const shareToggle = document.getElementById("share-toggle")! as HTMLButtonElement;
const shareDropdown = document.getElementById("share-dropdown")!;

function positionShareDropdown() {
  const r = shareToggle.getBoundingClientRect();
  // Fixed so ancestors with overflow:hidden (split panes) don't clip it.
  shareDropdown.style.top = `${r.bottom + 6}px`;
  shareDropdown.style.right = `${window.innerWidth - r.right}px`;
  shareDropdown.style.left = "auto";
}

function setShareOpen(open: boolean) {
  if (open) positionShareDropdown();
  shareDropdown.hidden = !open;
  shareToggle.setAttribute("aria-expanded", open ? "true" : "false");
  shareMenu.classList.toggle("open", open);
}

function flashShareLabel(text: string) {
  const prev = shareToggle.textContent;
  shareToggle.textContent = text;
  shareToggle.classList.add("share-flash");
  window.setTimeout(() => {
    shareToggle.textContent = prev;
    shareToggle.classList.remove("share-flash");
  }, 1200);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts / denied permission.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

shareToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  setShareOpen(shareDropdown.hidden);
});

shareDropdown.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-share]");
  if (!btn) return;
  e.stopPropagation();
  // Share the full program (with cut markers) so embeds stay self-contained.
  const source = compileSource();
  const kind = btn.dataset.share;
  const text =
    kind === "iframe"
      ? buildIframeSnippet(source)
      : buildShareUrl(source);
  const ok = await copyText(text);
  setShareOpen(false);
  flashShareLabel(ok ? "Copied!" : "Failed");
});

document.addEventListener("click", (e) => {
  if (!shareMenu.contains(e.target as Node)) setShareOpen(false);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setShareOpen(false);
});

// Ctrl/Cmd+R → blank template (override browser reload).
// Skip in embed: demos should not wipe the hosted snippet, and host
// pages often rely on normal reload inside the iframe.
if (!embedConfig.embed) {
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      resetCode();
    }
  });
}

// Embed: float status on the pane (outside the scrollport) so exit code
// stays top-right while long lines scroll underneath.
if (embedConfig.embed) {
  document.getElementById("preview-pane")!.appendChild(runStatus);
  runStatus.classList.add("embed-status");
  // Floating Run button lives on the editor pane (the output pane is
  // hidden until the first run). Hidden after first run via `has-run`.
  const embedRun = document.createElement("button");
  embedRun.type = "button";
  embedRun.id = "embed-run";
  embedRun.textContent = "▶";
  embedRun.title = "Run";
  embedRun.setAttribute("aria-label", "Run");
  embedRun.hidden = embedConfig.autorun;
  embedRun.addEventListener("click", runCode);
  document.getElementById("editor-pane")!.appendChild(embedRun);
}

// First paint: if autorun is on, kick the first run (boots workers,
// fetches assets, shows output). Otherwise stay idle — workers un-booted,
// output pane hidden — until the user clicks Run.
if (embedConfig.autorun) {
  setStatus({ kind: "loading" });
  runCode();
} else {
  setStatus({ kind: "idle" });
}

// ─── Resize bar ─────────────────────────────────────────────────
// Side-by-side on wide playgrounds (drag X); stacked on narrow ones
// (drag Y, output below). Orientation comes from the live computed
// flex-direction so the same logic follows the container query.

const splitPane = document.getElementById("split-pane")!;
const resizeBar = document.getElementById("resize-bar")!;

function isVerticalSplit() {
  return getComputedStyle(splitPane).flexDirection === "column";
}

function onResizeBarMove(event: MouseEvent) {
  const rect = splitPane.getBoundingClientRect();
  let percent: number;
  if (isVerticalSplit()) {
    percent = (event.clientY - rect.top) / rect.height * 100;
  } else {
    percent = (event.clientX - rect.left) / rect.width * 100;
  }
  percent = Math.min(Math.max(10, percent), 90);
  splitPane.style.setProperty("--editor-size-percent", `${percent}%`);
}

function onResizeBarMouseUp() {
  window.removeEventListener("mousemove", onResizeBarMove);
  window.removeEventListener("mouseup", onResizeBarMouseUp);
  document.body.style.removeProperty("user-select");
  document.body.style.removeProperty("cursor");
  resizeBar.classList.remove("dragging");
}

resizeBar.addEventListener("mousedown", event => {
  if (event.buttons & 1) {
    window.addEventListener("mousemove", onResizeBarMove);
    window.addEventListener("mouseup", onResizeBarMouseUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = isVerticalSplit() ? "row-resize" : "col-resize";
    resizeBar.classList.add("dragging");
  }
});

// Dragged split ratios are axis-specific. When the container flips
// between row and column, drop the inline percent so CSS defaults apply.
let lastVerticalSplit = isVerticalSplit();
new ResizeObserver(() => {
  const vertical = isVerticalSplit();
  if (vertical !== lastVerticalSplit) {
    lastVerticalSplit = vertical;
    splitPane.style.removeProperty("--editor-size-percent");
  }
}).observe(splitPane);
