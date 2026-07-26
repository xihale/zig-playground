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
import { lspClient } from "./lsp.ts";
import { examples } from "./examples.ts";
import {
  parseEmbedConfig,
  buildShareUrl,
  buildIframeSnippet,
} from "./embed.ts";
import { bindCuts, resolveCompileSource, type CutBinding } from "./cut.ts";
// @ts-ignore
import ZigWorker from './workers/zig.ts?worker';
// @ts-ignore
import RunnerWorker from './workers/runner.ts?worker';

/** Auto-compile debounce after edits (ms). Matches serverDiagnostics sync lag. */
const AUTO_RUN_DEBOUNCE_MS = 500;

// Embed mode: blog/doc iframes pass source via ?code= / ?b64= and hide chrome.
const embedConfig = parseEmbedConfig();
if (embedConfig.embed) {
  document.body.classList.add("embed");
  document.documentElement.classList.add("embed");
}

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
 * active-line, semantic tokens, and occasionally docView).
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
          key: "Mod-s",
          run: formatDocument,
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
      // Auto-run on any edit once LSP reports no errors (debounce + recheck
      // when publishDiagnostics lands). Draft save is independent of that.
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleSave();
          autoRunWanted = true;
          scheduleAutoRun();
          // Don't react to diagnostics in the same update — they lag the
          // new buffer; the debounce timer + later publishes handle it.
          return;
        }
        // Fresh diagnostics: retry if an earlier attempt was blocked by errors.
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
// Keep the previous run's output + exit code visible while a new
// compile is in flight. Swap both only when a concrete result is ready
// (compile failure, first run chunk, or exit). No intermediate
// "compiling" / "running" status flash.

const outputContainer = document.getElementById("output-container")!;
const runStatus = document.getElementById("run-status")!;
const statusText = document.getElementById("status-text")!;

/** Currently displayed blocks (null after a swap until recreated). */
let compileBlock: HTMLElement | null = null;
let runBlock: HTMLElement | null = null;
/** Buffered text for the in-flight generation (not yet on screen). */
let bufCompile = "";
let bufRun = "";
/** True once this generation has replaced the previous output. */
let outputCommitted = false;

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "exit"; code: number; crashed?: boolean };

function setStatus(status: Status) {
  runStatus.classList.remove("idle", "busy", "ok", "err");
  if (status.kind === "idle") {
    runStatus.classList.add("idle");
    statusText.textContent = "idle";
  } else if (status.kind === "loading") {
    runStatus.classList.add("busy");
    statusText.textContent = "loading";
  } else {
    const bad = status.code !== 0 || !!status.crashed;
    runStatus.classList.add(bad ? "err" : "ok");
    statusText.textContent = String(status.code);
  }
}

/** Remove displayed output blocks (keeps embed floating status). */
function wipeDisplayedOutput() {
  for (const child of [...outputContainer.children]) {
    if (child === runStatus) continue;
    child.remove();
  }
  compileBlock = null;
  runBlock = null;
}

function scrollOutput() {
  outputContainer.scrollTop = outputContainer.scrollHeight;
}

/**
 * First result for this generation: drop the previous run's DOM and
 * paint the buffered content. Later chunks append to the live blocks.
 */
function commitOutput(mode: "compile" | "run") {
  if (outputCommitted) return;
  wipeDisplayedOutput();
  outputCommitted = true;

  if (mode === "compile") {
    if (bufCompile) {
      compileBlock = document.createElement("div");
      compileBlock.className = "zig-output";
      compileBlock.textContent = bufCompile;
      outputContainer.appendChild(compileBlock);
    }
  } else if (bufRun) {
    runBlock = document.createElement("div");
    runBlock.className = "runner-output";
    runBlock.textContent = bufRun;
    outputContainer.appendChild(runBlock);
  }
  scrollOutput();
}

/** Buffer compile diagnostics; paint only after a failed compile. */
function appendCompile(text: string) {
  bufCompile += text;
  if (outputCommitted) {
    if (!compileBlock) {
      compileBlock = document.createElement("div");
      compileBlock.className = "zig-output";
      outputContainer.appendChild(compileBlock);
    }
    compileBlock.textContent += text;
    scrollOutput();
  }
}

/** Buffer program output; swap previous result on the first chunk. */
function appendRun(text: string) {
  bufRun += text;
  if (!outputCommitted) {
    commitOutput("run");
    return;
  }
  if (!runBlock) {
    runBlock = document.createElement("div");
    runBlock.className = "runner-output";
    outputContainer.appendChild(runBlock);
  }
  runBlock.textContent += text;
  scrollOutput();
}

/** Compile failed — show diagnostics (or empty if none). */
function commitCompileFailure() {
  commitOutput("compile");
}

/**
 * Run finished with no stdout yet — clear previous output so a silent
 * program doesn't leave the last run's print lines on screen.
 */
function commitEmptyRunIfNeeded() {
  if (!outputCommitted) {
    wipeDisplayedOutput();
    outputCommitted = true;
  }
}

// ─── zig worker / run queue ─────────────────────────────────────
// 1) Worker loads std + zig.wasm async → UI shows "loading".
// 2) Only after { ready: true } does the compile queue run.
// At most one compile+run in flight. Further requests keep a single
// pending snapshot (latest source wins) and never double-post the worker.

/** True once zig worker has finished fetching/compiling compiler assets. */
let compilerReady = false;

let zigWorker = new ZigWorker();
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
 * True after a doc edit until we successfully queue an auto-run (or force
 * run). Stays true while LSP still reports errors so a later clean
 * publishDiagnostics can unstick the queue.
 */
let autoRunWanted = false;
let activeRunner: Worker | null = null;

function startRun(source: string) {
  runGen += 1;
  runBusy = true;
  pendingSource = null;
  lastStartedSource = source;

  if (activeRunner) {
    activeRunner.terminate();
    activeRunner = null;
  }

  // Keep previous output + exit code until this gen has a result.
  bufCompile = "";
  bufRun = "";
  outputCommitted = false;
  zigWorker.postMessage({ run: source });
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
 *   double-run when auto-run races the initial job).
 * - When idle: start immediately (auto skips unchanged source).
 */
function requestRun(opts: { force?: boolean } = {}) {
  const source = compileSource();

  if (!compilerReady) {
    // Asset load in flight — queue only; status stays "loading".
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
/** Button / first load / example switch — always run. */
function runCode() {
  autoRunWanted = false;
  if (autoRunTimer !== null) {
    clearTimeout(autoRunTimer);
    autoRunTimer = null;
  }
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
 * Auto-compile only when LSP shows no errors. Keeps `autoRunWanted` set
 * while blocked so a later clean diagnostic publish can proceed.
 */
function tryAutoRun() {
  if (!autoRunWanted) return;
  if (hasLspErrors()) return;
  autoRunWanted = false;
  requestRun({ force: false });
}

/** Debounced auto-run after any edit — skip if idle and source unchanged. */
function scheduleAutoRun() {
  if (autoRunTimer !== null) clearTimeout(autoRunTimer);
  autoRunTimer = setTimeout(() => {
    autoRunTimer = null;
    // Push the latest buffer to ZLS so diagnostics match what we may run.
    const plugin = LSPPlugin.get(editor);
    if (plugin) plugin.client.sync();
    tryAutoRun();
  }, AUTO_RUN_DEBOUNCE_MS);
}

zigWorker.onmessage = (ev: MessageEvent) => {
  // Compiler assets ready (or failed) — open the compile queue.
  if (ev.data.ready === true) {
    compilerReady = true;
    if (pendingSource !== null) {
      const next = pendingSource;
      pendingSource = null;
      startRun(next);
    }
    return;
  }
  if (ev.data.ready === false) {
    compilerReady = false;
    bufCompile = "";
    bufRun = "";
    outputCommitted = false;
    appendCompile(ev.data.error ? `${ev.data.error}\n` : "failed to load compiler\n");
    commitCompileFailure();
    setStatus({ kind: "exit", code: 1, crashed: true });
    return;
  }

  const gen = runGen;

  // Compile-time stderr (diagnostics). Buffered until failed/success;
  // skip the redundant "Compiling..." progress marker.
  if (ev.data.stderr) {
    if (gen !== runGen) return;
    const text: string = ev.data.stderr;
    if (/^\s*Compiling\.\.\.\s*$/.test(text)) return;
    appendCompile(text);
    return;
  }

  // A failed compile: paint buffered diagnostics + exit code together.
  if (ev.data.failed) {
    if (gen !== runGen) return;
    commitCompileFailure();
    setStatus({ kind: "exit", code: 1, crashed: true });
    completeRun(gen);
    return;
  }

  // Successful compile. If a newer request is already pending, drop this
  // artifact and start the latest source instead of running stale wasm.
  if (ev.data.compiled) {
    if (gen !== runGen) return;

    if (pendingSource !== null) {
      const next = pendingSource;
      pendingSource = null;
      startRun(next);
      return;
    }

    // Compile succeeded — discard any progress text; only program I/O
    // (or a silent empty panel) will replace the previous output.
    bufCompile = "";

    if (activeRunner) {
      activeRunner.terminate();
      activeRunner = null;
    }
    const runnerWorker = new RunnerWorker();
    activeRunner = runnerWorker;
    runnerWorker.postMessage({ run: ev.data.compiled });

    runnerWorker.onmessage = (rev: MessageEvent) => {
      if (gen !== runGen) return;
      if (rev.data.stderr) {
        appendRun(rev.data.stderr);
      } else if (rev.data.exitCode !== undefined) {
        // No stdout: still swap so a previous print doesn't linger.
        commitEmptyRunIfNeeded();
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

// Embed: float status over the output pane (toolbars are hidden).
if (embedConfig.embed) {
  outputContainer.appendChild(runStatus);
  runStatus.classList.add("embed-status");
}

// First paint: show loading while the worker fetches zig.wasm / std;
// the initial example is queued and only compiles after { ready: true }.
// Embed can opt out with autorun=0 (still shows the editor).
setStatus({ kind: "loading" });
if (embedConfig.autorun) {
  runCode();
} else {
  setStatus({ kind: "idle" });
}

// ─── Resize bar ─────────────────────────────────────────────────
// Horizontal split on wide screens (drag X), vertical on narrow ones
// (drag Y). We detect orientation from the live computed flex-direction
// so the same logic handles the CSS media-query switch.

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
  splitPane.style.setProperty("--editor-width-percent", `${percent}%`);
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
