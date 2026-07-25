import { EditorState } from "@codemirror/state";
import {
  keymap,
  EditorView,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
} from "@codemirror/view";
import { formatDocument } from "@codemirror/lsp-client";
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
import { lintKeymap } from "@codemirror/lint";
import { zigLanguage } from "@ndim/codemirror-lang-zig";
import { editorTheme, highlightStyle } from "./theme.ts";
import { lspClient } from "./lsp.ts";
import { examples } from "./examples.ts";
// @ts-ignore
import ZigWorker from './workers/zig.ts?worker';
// @ts-ignore
import RunnerWorker from './workers/runner.ts?worker';

// basicSetup clone with custom fold markers (open ⌄ vs closed › need
// different optical Y offsets — a single translate can't fix both).
const playgroundSetup = [
  lineNumbers(),
  highlightActiveLineGutter(),
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
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
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

// ─── CodeMirror ──────────────────────────────────────────────────

const editor = new EditorView({
  extensions: [],
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc: examples[0].code,
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
      ]),
      zigLanguage,
      syntaxHighlighting(highlightStyle),
      lspClient.plugin("file:///main.zig"),
      // Auto-run when the user types (or pastes) a semicolon — common end
      // of statement in Zig. Debounced so multi-edit transactions settle.
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        let typedSemi = false;
        update.changes.iterChanges((_fa, _ta, _fb, _tb, inserted) => {
          if (inserted.toString().includes(";")) typedSemi = true;
        });
        if (typedSemi) scheduleAutoRun();
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

const blankTemplate = `const std = @import("std");

pub fn main() !void {
}
`;

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
// Default selection: first real example (Hello World), not Blank.
exampleSelect.selectedIndex = 1;
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
// Single output area that shows only the current run. Each run clears
// the previous content. Status (idle / compiling / exit code) lives in
// the preview toolbar — not in the text stream.

const outputContainer = document.getElementById("output-container")!;
const runStatus = document.getElementById("run-status")!;
const statusText = document.getElementById("status-text")!;

let compileBlock: HTMLElement | null = null;
let runBlock: HTMLElement | null = null;

type Status =
  | { kind: "idle" }
  | { kind: "compiling" }
  | { kind: "running" }
  | { kind: "exit"; code: number; crashed?: boolean };

function setStatus(status: Status) {
  runStatus.classList.remove("idle", "busy", "ok", "err");
  if (status.kind === "idle") {
    runStatus.classList.add("idle");
    statusText.textContent = "idle";
  } else if (status.kind === "compiling") {
    runStatus.classList.add("busy");
    statusText.textContent = "compiling";
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
  outputContainer.replaceChildren();
  compileBlock = null;
  runBlock = null;
}

function scrollOutput() {
  outputContainer.scrollTop = outputContainer.scrollHeight;
}

function appendCompile(text: string) {
  if (!compileBlock) {
    compileBlock = document.createElement("div");
    compileBlock.className = "zig-output";
    outputContainer.appendChild(compileBlock);
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
    outputContainer.appendChild(runBlock);
  }
  runBlock.textContent += text;
  scrollOutput();
}

// ─── zig worker / run queue ─────────────────────────────────────
// At most one compile+run in flight. Further requests keep a single
// pending snapshot (latest source wins) and never double-post the worker.

let zigWorker = new ZigWorker();
/** Monotonic id for the in-flight job; stale worker/runner msgs ignored. */
let runGen = 0;
/** True while compile or run is in flight. */
let runBusy = false;
/** Single pending source; overwritten on each request while busy. */
let pendingSource: string | null = null;
/** Source of the last started job — skip no-op auto-runs when idle. */
let lastStartedSource: string | null = null;
let autoRunTimer: ReturnType<typeof setTimeout> | null = null;
let activeRunner: Worker | null = null;
/** Delay before flipping status to "running" — skips flash on fast exits. */
let runningStatusTimer: ReturnType<typeof setTimeout> | null = null;

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
  setStatus({ kind: "compiling" });
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
 * - While busy: one pending slot only, always overwritten (latest wins).
 *   Auto-run with unchanged source does not queue (avoids first-load
 *   double-run when `;` logic races the initial job).
 * - When idle: start immediately (auto skips unchanged source).
 */
function requestRun(opts: { force?: boolean } = {}) {
  const source = editor.state.doc.toString();
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
  requestRun({ force: true });
}

/** Debounced auto-run after `;` — skip if idle and source unchanged. */
function scheduleAutoRun() {
  if (autoRunTimer !== null) clearTimeout(autoRunTimer);
  autoRunTimer = setTimeout(() => {
    autoRunTimer = null;
    requestRun({ force: false });
  }, 350);
}

zigWorker.onmessage = (ev: MessageEvent) => {
  const gen = runGen;

  // Compile-time stderr (diagnostics). The UI already shows "compiling"
  // in the status area — skip the redundant "Compiling..." marker.
  if (ev.data.stderr) {
    if (gen !== runGen) return;
    const text: string = ev.data.stderr;
    if (/^\s*Compiling\.\.\.\s*$/.test(text)) return;
    appendCompile(text);
    return;
  }

  // A failed compile: the diagnostics are this run's result.
  if (ev.data.failed) {
    if (gen !== runGen) return;
    clearRunningStatusTimer();
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

    clearCompile();
    // Only show "running" if still in flight after 350ms — fast programs
    // go compiling → exit code with no intermediate flicker.
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
    runnerWorker.postMessage({ run: ev.data.compiled });

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

// ─── Run / Reset / auto-run ─────────────────────────────────────

const runButton = document.getElementById("run")! as HTMLButtonElement;
runButton.addEventListener("click", runCode);

function resetCode() {
  exampleSelect.value = "";
  replaceDoc(blankTemplate);
  runCode();
}

const resetButton = document.getElementById("reset")! as HTMLButtonElement;
resetButton.addEventListener("click", resetCode);

// Ctrl/Cmd+R → blank template (override browser reload).
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") {
    e.preventDefault();
    resetCode();
  }
});

// First paint: compile & run the default example.
runCode();

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
