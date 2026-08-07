/**
 * Run WABT's wasm-decompile (C-like pseudo-code) in a one-shot classic Worker.
 *
 * wabt.js only exposes wasm2wat. Decompile ships as a Node-oriented Emscripten
 * CLI under wabt/bin (NODERAWFS). We fetch that script, strip the Node-only FS
 * overlay, and run it against MEMFS in a Worker so the playground stays fully
 * client-side.
 */

// Vite emits a same-origin URL for the emscripten script (embedded wasm binary).
// @ts-expect-error Vite ?url query
import decompileScriptUrl from "wabt/bin/wasm-decompile?url";

import { prettyDecompile } from "./ir-pretty";

export const DECOMPILE_DISPLAY_LIMIT = 1_500_000;

export type WasmDecompileResult = {
  text: string;
  truncated: boolean;
  fullLength: number;
  /** How many main.zig functions were kept (0 if full dump). */
  shown?: number;
  hidden?: number;
};

/** Cached patched script blob URL (shared across decompile calls). */
let patchedScriptUrlPromise: Promise<string> | null = null;

function patchDecompileSource(src: string): string {
  // Drop shebang if present.
  let s = src.replace(/^#![^\n]*\n/, "");
  // CLI is linked with NODERAWFS; force MEMFS for the browser.
  s = s.replace(
    /if\s*\(\s*!ENVIRONMENT_IS_NODE\s*\)\s*\{\s*throw new Error\("NODERAWFS is currently only supported on Node\.js environment\."\)\s*\}/,
    "/* NODERAWFS guard removed for browser MEMFS */",
  );
  s = s.replace(
    /for\s*\(\s*var _key in NODERAWFS\s*\)\s*\{\s*FS\[_key\]\s*=\s*_wrapNodeError\s*\(\s*NODERAWFS\[_key\]\s*\)\s*\}/,
    "/* NODERAWFS overlay disabled — keep default MEMFS */",
  );
  return s;
}

function loadPatchedDecompileScript(): Promise<string> {
  if (!patchedScriptUrlPromise) {
    const abs = new URL(decompileScriptUrl, window.location.href).href;
    patchedScriptUrlPromise = fetch(abs)
      .then((r) => {
        if (!r.ok) throw new Error(`failed to fetch wasm-decompile (${r.status})`);
        return r.text();
      })
      .then((text) => {
        const patched = patchDecompileSource(text);
        const blob = new Blob([patched], { type: "application/javascript" });
        return URL.createObjectURL(blob);
      });
  }
  return patchedScriptUrlPromise;
}

/**
 * Decompile `wasm` to wasm-decompile's C-like text. Spawns a fresh worker
 * each call (the Emscripten binary is single-shot / not re-entrant).
 *
 * `wasm` may be transferred into the worker — pass a copy if you still need it.
 */
export async function wasmDecompile(wasm: ArrayBuffer): Promise<WasmDecompileResult> {
  const scriptUrl = await loadPatchedDecompileScript();

  return new Promise((resolve, reject) => {
    // wabt CLI glue unconditionally calls require("path") even in workers.
    const bootstrap = `
      var stdout = [];
      var stderr = [];
      var finished = false;

      function finish(status) {
        if (finished) return;
        finished = true;
        self.postMessage({
          type: "done",
          status: status | 0,
          text: stdout.join("\\n"),
          err: stderr.join("\\n"),
        });
      }

      self.require = function (name) {
        if (name === "path") {
          // Enough of Node's path for emscripten MEMFS (PATH / PATH_FS).
          var pathApi = {
            isAbsolute: function (p) { return typeof p === "string" && p.charAt(0) === "/"; },
            normalize: function (p) {
              var parts = String(p).split("/"), out = [], i, part, abs = String(p).charAt(0) === "/";
              for (i = 0; i < parts.length; i++) {
                part = parts[i];
                if (!part || part === ".") continue;
                if (part === "..") { if (out.length) out.pop(); }
                else out.push(part);
              }
              return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
            },
            dirname: function (p) {
              var n = pathApi.normalize(p);
              var i = n.lastIndexOf("/");
              if (i <= 0) return n.charAt(0) === "/" ? "/" : ".";
              return n.slice(0, i) || "/";
            },
            basename: function (p) {
              var n = pathApi.normalize(p);
              var i = n.lastIndexOf("/");
              return i >= 0 ? n.slice(i + 1) : n;
            },
            join: function () {
              return pathApi.normalize(Array.prototype.slice.call(arguments).join("/"));
            },
            resolve: function () {
              var args = Array.prototype.slice.call(arguments);
              var resolved = "";
              for (var i = args.length - 1; i >= 0; i--) {
                var seg = args[i];
                if (!seg) continue;
                resolved = seg + "/" + resolved;
                if (pathApi.isAbsolute(seg)) break;
              }
              return pathApi.normalize("/" + resolved);
            },
            relative: function (from, to) {
              from = pathApi.resolve(from).split("/").filter(Boolean);
              to = pathApi.resolve(to).split("/").filter(Boolean);
              var i = 0;
              while (i < from.length && i < to.length && from[i] === to[i]) i++;
              var up = from.slice(i).map(function () { return ".."; });
              return up.concat(to.slice(i)).join("/") || ".";
            },
          };
          pathApi.posix = pathApi;
          return pathApi;
        }
        if (name === "crypto") {
          return {
            randomFillSync: function (view) {
              crypto.getRandomValues(view);
              return view;
            },
          };
        }
        throw new Error("cannot require('" + name + "') in browser worker");
      };

      self.onmessage = function (ev) {
        var msg = ev.data;
        if (!msg || msg.type !== "run") return;
        var input = new Uint8Array(msg.bytes);

        // createWasm() is async; callMain runs after importScripts returns.
        // Collect output via print hooks, then finish from postRun/onExit.
        self.Module = {
          arguments: ["--enable-all", "in.wasm"],
          preRun: [function () {
            FS.writeFile("in.wasm", input);
          }],
          print: function (t) { stdout.push(String(t)); },
          printErr: function (t) { stderr.push(String(t)); },
          onExit: function (code) { finish(code); },
          postRun: [function () {
            // EXITSTATUS is a top-level var from the emscripten glue (worker global).
            finish(typeof EXITSTATUS === "number" ? EXITSTATUS : 0);
          }],
        };

        try {
          importScripts(${JSON.stringify(scriptUrl)});
          // Do not finish() here — wasm instantiate + main are async.
        } catch (e) {
          if (!finished) {
            var st = (e && typeof e.status === "number") ? e.status : 1;
            if (stdout.length > 0) finish(st);
            else {
              finished = true;
              self.postMessage({
                type: "done",
                status: 1,
                text: "",
                err: stderr.join("\\n") || String(e && e.message || e),
              });
            }
          }
        }
      };
    `;

    const blob = new Blob([bootstrap], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("wasm-decompile timed out"));
    }, 60_000);

    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (!msg || msg.type !== "done") return;
      clearTimeout(timer);
      cleanup();

      if (msg.status !== 0 && !msg.text) {
        reject(new Error(msg.err || `wasm-decompile exited ${msg.status}`));
        return;
      }

      const raw: string = msg.text || "";
      // Prefer main.zig functions only — full dump is ~30k+ lines of std.
      const pretty = prettyDecompile(raw);
      const full = pretty.text;
      const fullLength = full.length;
      const meta = {
        shown: pretty.shown,
        hidden: pretty.hidden,
      };
      if (fullLength <= DECOMPILE_DISPLAY_LIMIT) {
        resolve({ text: full, truncated: false, fullLength, ...meta });
        return;
      }
      resolve({
        text:
          full.slice(0, DECOMPILE_DISPLAY_LIMIT) +
          `\n\n// … truncated: showing ${DECOMPILE_DISPLAY_LIMIT.toLocaleString()} of ` +
          `${fullLength.toLocaleString()} characters\n`,
        truncated: true,
        fullLength,
        ...meta,
      });
    };

    worker.onerror = (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err.error ?? new Error(err.message || "wasm-decompile worker failed"));
    };

    worker.postMessage({ type: "run", bytes: wasm }, [wasm]);
  });
}
