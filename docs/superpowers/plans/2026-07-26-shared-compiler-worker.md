# Shared Compiler Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Zig compiler assembly + compile pipeline into one origin-wide SharedWorker so that page reloads and multiple embed iframes reuse a single `WebAssembly.Module` instead of re-compiling `zig.wasm` each time.

**Architecture:** A new `zig.shared.ts` SharedWorker hosts lazily-loaded, refcount-evicted `Compiler` instances keyed by `versionId`. A thin `ZigSharedClient` (`src/zig-shared-client.ts`) hides SharedWorker-vs-dedicated-worker behind one `dispatch`/`onmessage` interface. `editor.ts` swaps `new ZigWorker()` for the client and adapts field names; `runner.ts`, `zls.ts`, `lsp.ts`, `compiler-cache.ts`, `zir-cache.ts` are untouched.

**Tech Stack:** TypeScript (Vite esbuild, no `tsc`), Vite `?sharedworker` import, existing `@bjorn3/browser_wasi_shim` + Cache Storage + IndexedDB layers.

**Spec:** `docs/superpowers/specs/2026-07-26-shared-compiler-worker-design.md`

**Verification model:** This repo has no test framework and no `tsconfig.json` (build is `vite build` via esbuild). Per the agreed pragmatic route, each task ends with `npm run build` passing **plus** a manual browser checkpoint — no new test dependencies are introduced. SharedWorker behavior (cross-page reuse, routing) is intrinsically browser-verified.

**Conventions used throughout:**
- `requestId` is a `string` (client-generated monotonic, stringified). Avoids any number-vs-string ambiguity at the SharedWorker boundary.
- The dedicated `ZigWorker` (`src/workers/zig.ts`) is kept **verbatim** as the fallback path — do not modify it in this plan.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/shared-protocol.ts` | **Create** | Type definitions for every client↔SharedWorker message. The single source of truth for the protocol; imported by both ends. |
| `src/workers/zig.shared.ts` | **Create** | SharedWorker entry. Compiler assembly, per-compiler serial compile queue, refcount, α-policy routing. |
| `src/zig-shared-client.ts` | **Create** | Thin client. Prefers `SharedWorker`, falls back to dedicated `ZigWorker`. Exposes `dispatch` + `onmessage`. |
| `src/editor.ts` | **Modify** | Swap `new ZigWorker()` → `new ZigSharedClient()`; adapt the two `postMessage` calls and the `onmessage` handler to the new protocol. Runner/ZLS code untouched. |
| `src/workers/zig.ts` | **Unchanged** | Kept verbatim as the dedicated-worker fallback. |
| `src/workers/runner.ts` | **Unchanged** | Still per-page dedicated worker. |
| `src/workers/zls.ts`, `src/lsp.ts` | **Unchanged** | Out of scope. |

---

## Task 1: Protocol type definitions

**Files:**
- Create: `src/shared-protocol.ts`

**Why first:** Every subsequent task imports from this file. Locking the contract first prevents type drift between the SharedWorker and client tasks.

- [ ] **Step 1: Create `src/shared-protocol.ts`**

```ts
/**
 * Wire protocol between ZigSharedClient and the compiler SharedWorker.
 *
 * Run-scoped messages carry `requestId` (client-generated monotonic string).
 * The SharedWorker applies the α policy: a new `run` from a port overwrites
 * that port's currentRequestId, after which any older-requestId reply is
 * dropped before being posted.
 *
 * See docs/superpowers/specs/2026-07-26-shared-compiler-worker-design.md.
 */

export type ZirCacheInfo = { files: number; bytes: number };

/** Client → SharedWorker. */
export type ClientMsg =
  | { kind: "init"; versionId: string }
  | { kind: "run"; requestId: string; versionId: string; source: string };

/** SharedWorker → Client. */
export type WorkerMsg =
  | { kind: "ready"; versionId: string; ok: true; zirCache: ZirCacheInfo | null }
  | { kind: "ready"; versionId: string; ok: false; error: string }
  | { kind: "stderr"; requestId: string; text: string }
  | { kind: "compiled"; requestId: string; wasm: ArrayBuffer }
  | { kind: "failed"; requestId: string };
```

- [ ] **Step 2: Verify the build picks it up**

Run: `npm run build`
Expected: Build succeeds. (No references yet; esbuild tree-shakes the unused types, but a syntax error would fail the build.)

- [ ] **Step 3: Commit**

```bash
git add src/shared-protocol.ts
git commit -m "Add SharedWorker wire protocol types."
```

---

## Task 2: SharedWorker skeleton — assembly + `ready`

**Files:**
- Create: `src/workers/zig.shared.ts`

**Scope of this task:** `onconnect`, `init`, lazy assembly, `ready` replies. **No compile logic yet** (that is Task 3). The assembly body is lifted verbatim from `src/workers/zig.ts:90-107`.

**Shared-state note:** `zig.ts` keeps `cacheContents`, `lastSavedBytes`, `persistChain`, `versionId` as module-level. In the SharedWorker these move **inside the `Compiler` object** so each version is isolated. The assembly code references them by closure, not by module global.

- [ ] **Step 1: Create `src/workers/zig.shared.ts`**

```ts
/**
 * SharedWorker hosting lazily-loaded Zig compiler instances.
 * See docs/superpowers/specs/2026-07-26-shared-compiler-worker-design.md.
 */

import {
    WASI,
    PreopenDirectory,
    Fd,
    File,
    OpenFile,
    Inode,
    Directory,
} from "@bjorn3/browser_wasi_shim";
import {
    compileWasmAsset,
    fetchAssetBuffer,
    getZigArchive,
    stderrOutput,
} from "../utils";
import {
    type FlatEntry,
    loadZirCacheEntries,
    saveZirCacheEntries,
} from "../zir-cache";
import { compilerAssetUrl } from "../version";
import type { ClientMsg, WorkerMsg, ZirCacheInfo } from "../shared-protocol";

type Ready = {
    libDirectory: Directory;
    compilerRt: ArrayBuffer;
    zigModule: WebAssembly.Module;
    zirCache: ZirCacheInfo | null;
    versionId: string;
};

type Compiler = {
    versionId: string;
    ready: Promise<Ready> | null;
    cacheContents: Map<string, Inode>;
    lastSavedBytes: number;
    persistChain: Promise<void>;
    compileChain: Promise<void>;
    refCount: number;
};

const compilers = new Map<string, Compiler>();

type PortState = {
    versionId: string | null;
    currentRequestId: string | null;
};
const ports = new Map<MessagePort, PortState>();

// ─── Cache (de)serialization helpers — lifted from zig.ts:30-64 ─────────

function flattenCache(map: Map<string, Inode>, prefix = ""): FlatEntry[] {
    const out: FlatEntry[] = [];
    for (const [name, node] of map.entries()) {
        const p = prefix ? `${prefix}/${name}` : name;
        const any = node as File | Directory;
        if (
            any instanceof File ||
            (any && "data" in any && (any as File).data != null && !("contents" in any))
        ) {
            const d = (any as File).data;
            out.push({
                path: p,
                data: d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer),
            });
        } else if (
            any instanceof Directory ||
            (any && (any as Directory).contents instanceof Map)
        ) {
            out.push(...flattenCache((any as Directory).contents, p));
        }
    }
    return out;
}

function hydrateCache(root: Map<string, Inode>, entries: FlatEntry[]): void {
    root.clear();
    for (const { path, data } of entries) {
        const parts = path.split("/");
        let cur = root;
        for (let i = 0; i < parts.length - 1; i++) {
            let next = cur.get(parts[i]);
            if (!(next instanceof Directory)) {
                next = new Directory(new Map());
                cur.set(parts[i], next);
            }
            cur = next.contents;
        }
        cur.set(parts[parts.length - 1], new File(data));
    }
}

// ─── Compiler lifecycle ────────────────────────────────────────────────

function newCompiler(versionId: string): Compiler {
    return {
        versionId,
        ready: null,
        cacheContents: new Map(),
        lastSavedBytes: 0,
        persistChain: Promise.resolve(),
        compileChain: Promise.resolve(),
        refCount: 0,
    };
}

function schedulePersistCache(c: Compiler) {
    c.persistChain = c.persistChain
        .then(async () => {
            const entries = flattenCache(c.cacheContents);
            const bytes = entries.reduce((s, e) => s + e.data.byteLength, 0);
            if (bytes === 0 || bytes === c.lastSavedBytes) return;
            const saved = await saveZirCacheEntries(entries, c.versionId);
            if (saved) c.lastSavedBytes = saved.bytes;
        })
        .catch(() => {
            /* ignore — memory cache still works this session */
        });
}

/**
 * Lazily assemble a version. Dedups concurrent inits via `c.ready`.
 * Body lifted from src/workers/zig.ts:90-107.
 */
function ensureCompiler(versionId: string): Promise<Ready> {
    let c = compilers.get(versionId);
    if (!c) {
        c = newCompiler(versionId);
        compilers.set(versionId, c);
    }
    if (!c.ready) {
        c.ready = (async (): Promise<Ready> => {
            const [zirHit, libDirectory, compilerRt, zigModule] = await Promise.all([
                loadZirCacheEntries(versionId),
                getZigArchive(versionId),
                fetchAssetBuffer(compilerAssetUrl(versionId, "libcompiler_rt.a")),
                compileWasmAsset(compilerAssetUrl(versionId, "zig.wasm")),
            ]);

            let zirCache: ZirCacheInfo | null = null;
            if (zirHit) {
                hydrateCache(c!.cacheContents, zirHit.entries);
                c!.lastSavedBytes = zirHit.bytes;
                zirCache = { files: zirHit.files, bytes: zirHit.bytes };
            }
            return { libDirectory, compilerRt, zigModule, zirCache, versionId };
        })();
    }
    return c.ready;
}

function postToPort(port: MessagePort, msg: WorkerMsg) {
    try {
        port.postMessage(msg);
    } catch {
        /* port closed mid-flight — swallow */
    }
}

// ─── Connection handling ───────────────────────────────────────────────

function handleInit(port: MessagePort, st: PortState, versionId: string) {
    // No-op if the port already holds this version (no double-count).
    if (st.versionId === versionId) {
        // Still (re)confirm readiness for this port.
        const c = compilers.get(versionId);
        if (c?.ready) {
            c.ready
                .then((r) =>
                    postToPort(port, {
                        kind: "ready",
                        versionId,
                        ok: true,
                        zirCache: r.zirCache,
                    }),
                )
                .catch((err) =>
                    postToPort(port, {
                        kind: "ready",
                        versionId,
                        ok: false,
                        error: `${err}`,
                    }),
                );
        }
        return;
    }
    // Release the previous version this port held.
    if (st.versionId !== null) releaseVersion(st.versionId);
    st.versionId = versionId;

    const c = ensureCompiler(versionId);
    compilers.get(versionId)!.refCount++;
    c.then((r) =>
        postToPort(port, {
            kind: "ready",
            versionId,
            ok: true,
            zirCache: r.zirCache,
        }),
    ).catch((err) =>
        postToPort(port, { kind: "ready", versionId, ok: false, error: `${err}` }),
    );
}

function releaseVersion(versionId: string) {
    const c = compilers.get(versionId);
    if (!c) return;
    c.refCount = Math.max(0, c.refCount - 1);
    if (c.refCount === 0) {
        compilers.delete(versionId);
    }
}

onconnect = (ev: MessageEvent) => {
    const port: MessagePort = ev.ports[0];
    const st: PortState = { versionId: null, currentRequestId: null };
    ports.set(port, st);

    port.onmessage = (e: MessageEvent) => {
        const msg = e.data as ClientMsg;
        if (!msg || typeof msg !== "object") return;
        if (msg.kind === "init") {
            handleInit(port, st, msg.versionId);
            return;
        }
        // `run` handled in Task 3.
    };

    port.onmessageerror = () => {
        cleanupPort(port);
    };
    // Note: SharedWorker ports do not emit a close event; cleanup is best-effort
    // on disconnect signals. Refcount leak risk is bounded — a stale compiler
    // entry is memory only, never re-fetched (Cache Storage still backs it).
    port.start();
};

function cleanupPort(port: MessagePort) {
    const st = ports.get(port);
    if (!st) return;
    if (st.versionId !== null) releaseVersion(st.versionId);
    ports.delete(port);
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds. The new file is not referenced yet (Vite bundles it only when imported), but a syntax/type error fails esbuild.

- [ ] **Step 3: Manual checkpoint — assembly fires through SharedWorker**

Temporarily add this snippet at the end of `index.html` inside `<body>`, before the existing `<script>` tag, then run `npm run dev`:

```html
<script type="module">
  import SW from "/src/workers/zig.shared.ts?sharedworker";
  const sw = new SW();
  sw.port.onmessage = (e) => console.log("[probe]", e.data);
  sw.port.postMessage({ kind: "init", versionId: "0.16.0" });
</script>
```

Expected in devtools console: a single `[probe] { kind: "ready", versionId: "0.16.0", ok: true, zirCache: { files: ..., bytes: ... } }` after the assembly (may take a few seconds on a cold Cache Storage).

If you see `ok: false`, check the `error` string — most likely a `fetchCompilerResponse` failure (verify `public/compilers/0.16.0/` exists and the dev server serves it).

- [ ] **Step 4: Remove the probe**

Delete the `<script type="module">` probe from `index.html`. Leave `index.html` exactly as it was.

- [ ] **Step 5: Commit**

```bash
git add src/workers/zig.shared.ts
git commit -m "Add SharedWorker skeleton: assembly + ready + refcount."
```

---

## Task 3: Compile pipeline + α-policy routing

**Files:**
- Modify: `src/workers/zig.shared.ts`

**Scope:** Add `run` handling, per-compiler serial queue, α-policy requestId overwrite, and the `stderr`/`compiled`/`failed` replies. The compile body is lifted from `src/workers/zig.ts:120-180`.

- [ ] **Step 1: Add the compile body above `onconnect`**

Insert this function into `src/workers/zig.shared.ts`, just before the `onconnect` definition (it needs `Compiler`, `postToPort`, `ports`, and `schedulePersistCache` already defined above):

```ts
let currentlyRunning = false; // defensive; the per-compiler chain already serializes.

/**
 * Compile one source against an assembled compiler. Body lifted from
 * src/workers/zig.ts:120-180; postMessage → port.postMessage with protocol.
 *
 * α policy: before every reply, re-check that this port's currentRequestId
 * still equals `requestId`. If a newer run superseded it, stop emitting.
 */
async function doOneCompile(
    port: MessagePort,
    st: PortState,
    requestId: string,
    versionId: string,
    source: string,
) {
    if (currentlyRunning) return; // belt-and-suspenders; queue guarantees serial.
    currentlyRunning = true;
    try {
        const c = compilers.get(versionId);
        if (!c || !c.ready) return; // version evicted before this run started.
        const { libDirectory, compilerRt, zigModule } = await c.ready;

        // If superseded while waiting on assembly, drop silently.
        if (st.currentRequestId !== requestId) return;

        const args = [
            "zig.wasm",
            "build-exe",
            "main.zig",
            "libcompiler_rt.a",
            "-fno-compiler-rt",
            "-fno-entry",
        ];
        const env: string[] = [];
        const fds = [
            new OpenFile(new File([])),
            stderrOutput(),
            stderrOutput(),
            new PreopenDirectory(".", new Map<string, Inode>([
                ["main.zig", new File(new TextEncoder().encode(source))],
                ["libcompiler_rt.a", new File(new Uint8Array(compilerRt))],
            ])),
            new PreopenDirectory("/lib", libDirectory.contents),
            new PreopenDirectory("/cache", c.cacheContents),
        ] satisfies Fd[];
        const wasi = new WASI(args, env, fds, { debug: false });

        const instance = await WebAssembly.instantiate(zigModule, {
            wasi_snapshot_preview1: wasi.wasiImport,
        });

        // Capture stderrOutput via the shim's callback into our protocol.
        // stderrOutput() in utils.ts returns a Fd whose writes we want as
        // { kind: "stderr", requestId, text }. The existing shim posts directly
        // via postMessage — we instead route through a per-port emitter.
        // See "stderr plumbing" note below; the simplest correct approach is to
        // install a temporary stderr sink around wasi.start().
        //
        // NOTE: utils.ts `stderrOutput()` is shared with the dedicated zig.ts
        // worker and posts via top-level postMessage. For the SharedWorker we
        // need per-port routing, so we wrap: redirect stderr writes here.

        // @ts-ignore
        const exitCode = wasi.start(instance);

        if (st.currentRequestId !== requestId) return; // superseded mid-run

        if (exitCode == 0) {
            const cwd = wasi.fds[3] as PreopenDirectory;
            const mainWasm = cwd.dir.contents.get("main.wasm") as File | undefined;
            if (mainWasm) {
                postToPort(port, {
                    kind: "compiled",
                    requestId,
                    wasm: mainWasm.data.buffer as ArrayBuffer,
                });
                schedulePersistCache(c);
            } else {
                postToPort(port, { kind: "failed", requestId });
            }
        } else {
            postToPort(port, { kind: "failed", requestId });
        }
    } catch (err) {
        if (st.currentRequestId === requestId) {
            postToPort(port, {
                kind: "stderr",
                requestId,
                text: `${err}\n`,
            });
            postToPort(port, { kind: "failed", requestId });
        }
    } finally {
        currentlyRunning = false;
    }
}
```

- [ ] **Step 2: Resolve the stderr plumbing**

The block above intentionally flags a real problem: `stderrOutput()` in `src/utils.ts` posts via the worker's global `postMessage`, which in a SharedWorker does **not** go to any specific port. We must route compile-time stderr per-port.

**The real shape** (verified in `src/utils.ts:81-89`): `stderrOutput()` returns a `ConsoleStdout` constructed with a write callback `new ConsoleStdout((buffer) => { postMessage({ stderr: dec.decode(buffer, { stream: true }) }) })`, plus a stubbed `fd_pwrite` returning `ERRNO_SPIPE`. The `{ stream: true }` decode is load-bearing — multiple writes must concatenate correctly.

Add a per-port variant that mirrors this exactly but calls `emit` instead of `postMessage`. At the top of `src/workers/zig.shared.ts`, update the import from `@bjorn3/browser_wasi_shim` to also pull `ConsoleStdout` and `wasi as wasi_defs`:

```ts
import {
    WASI,
    PreopenDirectory,
    Fd,
    File,
    OpenFile,
    Inode,
    Directory,
    ConsoleStdout,
} from "@bjorn3/browser_wasi_shim";
import { wasi as wasi_defs } from "@bjorn3/browser_wasi_shim";
```

And add the helper below the imports:

```ts
/**
 * Per-compile stderr sink that routes writes to the owning port.
 * Mirrors utils.ts stderrOutput() shape but with a custom emit target,
 * preserving the { stream: true } decode so multi-write concatenation works.
 */
function portStdout(emit: (text: string) => void): ConsoleStdout {
    const dec = new TextDecoder("utf-8", { fatal: false });
    const out = new ConsoleStdout((buffer) => {
        emit(dec.decode(buffer, { stream: true }));
    });
    // @ts-ignore — match utils.ts: stub pwrite on a console-type fd.
    out.fd_pwrite = (_data, _offset) => {
        return { ret: wasi_defs.ERRNO_SPIPE, nwritten: 0 };
    };
    return out;
}
```

Then replace the two `stderrOutput(),` lines in `doOneCompile`'s `fds` array with:

```ts
            portStdout((text) => {
                if (st.currentRequestId === requestId) {
                    postToPort(port, { kind: "stderr", requestId, text });
                }
            }),
            portStdout((text) => {
                if (st.currentRequestId === requestId) {
                    postToPort(port, { kind: "stderr", requestId, text });
                }
            }),
```

- [ ] **Step 3: Add `run` handling in `onmessage`**

In the `port.onmessage` handler inside `onconnect`, replace the comment `// \`run\` handled in Task 3.` with:

```ts
        if (msg.kind === "run") {
            const { requestId, versionId, source } = msg;
            st.currentRequestId = requestId; // α: supersede any prior run.
            const c = compilers.get(versionId);
            if (!c) {
                // Version never init'd on this port; cannot compile.
                postToPort(port, {
                    kind: "stderr",
                    requestId,
                    text: `version ${versionId} not initialized\n`,
                });
                postToPort(port, { kind: "failed", requestId });
                return;
            }
            c.compileChain = c.compileChain.then(() =>
                doOneCompile(port, st, requestId, versionId, source),
            );
            return;
        }
```

- [ ] **Step 4: Remove the now-unused `stderrOutput` import**

In the imports at the top of `src/workers/zig.shared.ts`, delete `stderrOutput,` from the `../utils` import block (it is no longer used — `PortStderrFd` replaces it). Leaving it would cause an esbuild warning but not a failure; remove for cleanliness.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 6: Manual checkpoint — single-page Run through SharedWorker**

Repeat the `index.html` probe from Task 2 Step 3 but extend it to also drive a compile:

```html
<script type="module">
  import SW from "/src/workers/zig.shared.ts?sharedworker";
  const sw = new SW();
  sw.port.onmessage = (e) => console.log("[probe]", e.data);
  sw.port.postMessage({ kind: "init", versionId: "0.16.0" });
  // After you see `ready ok:true` in the console, run this:
  window.probeRun = () =>
    sw.port.postMessage({
      kind: "run",
      requestId: "1",
      versionId: "0.16.0",
      source: 'const std = @import("std");\npub fn main() !void {\n    std.debug.print("hi\\n", .{});\n}\n',
    });
</script>
```

Run `npm run dev`, open the page, in console: wait for `ready`, then call `window.probeRun()`.
Expected: `[probe] { kind: "compiled", requestId: "1", wasm: ArrayBuffer }`. (No `stderr` for a clean program; a syntax error in `source` should produce `stderr` then `failed`.)

- [ ] **Step 7: Remove probe and commit**

Delete the probe from `index.html`. Then:

```bash
git add src/workers/zig.shared.ts
git commit -m "Add compile pipeline + α-policy routing to SharedWorker."
```

---

## Task 4: refcount edge cases — disconnect + double-init hardening

**Files:**
- Modify: `src/workers/zig.shared.ts`

**Why separate:** Tasks 2–3 implemented the happy-path refcount. This task hardens the edges without mixing concerns into the compile work.

- [ ] **Step 1: Verify the existing guards already cover the spec**

The Task 2 implementation already includes:
- `handleInit` no-op when `st.versionId === versionId` (no double-count).
- `handleInit` releases previous version before adopting new.
- `releaseVersion` deletes the compiler at `refCount === 0`.
- `cleanupPort` releases the port's version on messageerror.

The spec calls out one remaining gap: **SharedWorker ports do not emit a reliable `close` event**, so a tab closing without `onmessageerror` could leak a refcount. The accepted mitigation (per spec §"Lifecycle"): bounded memory-only leak; Cache Storage still backs re-assembly, so functional impact is nil.

**Action:** add a short comment block above `cleanupPort` documenting this accepted limitation, so future readers don't mistake it for a bug.

Insert above the `cleanupPort` function:

```ts
/**
 * Best-effort port cleanup. SharedWorker MessagePorts do not reliably emit a
 * close event when a tab unloads, so refcount may undercount on abrupt
 * disconnects. Impact is bounded: a stale Compiler entry holds memory only;
 * re-assembly is still Cache-Storage-backed. `onmessageerror` covers the
 * detectable cases.
 */
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds (comment-only change).

- [ ] **Step 3: Manual checkpoint — version eviction on switch**

Using the Task 3 probe (re-add it), drive two inits:

```js
sw.port.postMessage({ kind: "init", versionId: "0.16.0" });
// after ready:
sw.port.postMessage({ kind: "init", versionId: "0.15.2" });
// after second ready:
sw.port.postMessage({ kind: "init", versionId: "0.16.0" });
```

Expected: each `init` of a version not currently held by this port takes the assembly hit (visible as the delay before `ready`); switching back to a still-held version is fast (Cache Storage hit → near-instant `ready`). The exact memory eviction is not directly observable in devtools without taking a heap snapshot; the **timing** difference is the proxy signal.

- [ ] **Step 4: Remove probe and commit**

```bash
git add src/workers/zig.shared.ts
git commit -m "Document refcount cleanup limitation for SharedWorker ports."
```

---

## Task 5: Client shell — `ZigSharedClient`

**Files:**
- Create: `src/zig-shared-client.ts`

**Responsibility:** expose `dispatch(msg: ClientMsg)` and `onmessage` so `editor.ts` is unaware whether a SharedWorker or a dedicated `ZigWorker` is behind it.

- [ ] **Step 1: Create `src/zig-shared-client.ts`**

```ts
/**
 * Thin client for the compiler SharedWorker, with a dedicated-worker fallback.
 *
 * Exposes `dispatch` + `onmessage` so editor.ts sees a uniform surface
 * regardless of transport. Prefers SharedWorker (origin-wide reuse of the
 * assembled zig.wasm Module); falls back to the original ZigWorker when
 * SharedWorker is unavailable (older Safari, some in-app browsers).
 *
 * See docs/superpowers/specs/2026-07-26-shared-compiler-worker-design.md.
 */

// @ts-ignore — Vite sharedworker import (symmetric with existing ?worker).
import ZigSharedWorker from "./workers/zig.shared.ts?sharedworker";
// @ts-ignore — Vite worker import; verbatim fallback path.
import ZigWorker from "./workers/zig.ts?worker";
import type { ClientMsg, WorkerMsg } from "./shared-protocol";

export type { ClientMsg, WorkerMsg } from "./shared-protocol";

const sharedAvailable = typeof SharedWorker !== "undefined";

/**
 * Wire an old-style `ZigWorker` (whose onmessage posts legacy-shape objects
 * like { ready, stderr, compiled, failed, error }) into the new protocol.
 *
 * The dedicated fallback keeps its on-wire shape unchanged (zig.ts is frozen
 * as the fallback); this adapter translates at the boundary.
 */
function attachLegacyAdapter(
    worker: Worker,
    onMsg: (m: WorkerMsg) => void,
    versionIdRef: { current: string | null },
) {
    worker.onmessage = (ev: MessageEvent) => {
        const d = ev.data;
        if (d?.ready === true) {
            onMsg({
                kind: "ready",
                versionId: versionIdRef.current ?? "",
                ok: true,
                zirCache: d.zirCache ?? null,
            });
            return;
        }
        if (d?.ready === false) {
            onMsg({
                kind: "ready",
                versionId: versionIdRef.current ?? "",
                ok: false,
                error: d.error ?? "failed to load compiler",
            });
            return;
        }
        if (d?.stderr) {
            // Legacy worker doesn't carry requestId; route through the pending
            // request id tracked by the caller (see dispatch()).
            onMsg({ kind: "stderr", requestId: pendingReqId.current ?? "", text: d.stderr });
            return;
        }
        if (d?.failed) {
            onMsg({ kind: "failed", requestId: pendingReqId.current ?? "" });
            return;
        }
        if (d?.compiled) {
            onMsg({
                kind: "compiled",
                requestId: pendingReqId.current ?? "",
                wasm: d.compiled as ArrayBuffer,
            });
            return;
        }
    };
}

const pendingReqId = { current: null as string | null };

export class ZigSharedClient {
    private sw: SharedWorker | null = null;
    private dw: Worker | null = null;
    private versionIdRef = { current: null as string | null };
    /** User-supplied handler; receives normalized WorkerMsg. */
    public onmessage: ((m: WorkerMsg) => void) | null = null;

    constructor() {
        if (sharedAvailable) {
            this.sw = new ZigSharedWorker();
            this.sw.port.onmessage = (ev: MessageEvent) => {
                if (this.onmessage) this.onmessage(ev.data as WorkerMsg);
            };
            this.sw.port.onmessageerror = () => {
                /* swallow; α/timeout logic in editor.ts handles liveness */
            };
            this.sw.port.start();
        } else {
            this.dw = new ZigWorker();
            attachLegacyAdapter(this.dw, (m) => {
                if (this.onmessage) this.onmessage(m);
            }, this.versionIdRef);
        }
    }

    dispatch(msg: ClientMsg) {
        if (msg.kind === "init") {
            this.versionIdRef.current = msg.versionId;
            if (this.sw) this.sw.port.postMessage(msg);
            else this.dw!.postMessage({ init: { versionId: msg.versionId } });
            return;
        }
        // run
        pendingReqId.current = msg.requestId;
        if (this.sw) {
            this.sw.port.postMessage(msg);
        } else {
            // Legacy worker takes { run: source } (no requestId).
            this.dw!.postMessage({ run: msg.source });
        }
    }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/zig-shared-client.ts
git commit -m "Add ZigSharedClient with SharedWorker + dedicated fallback."
```

---

## Task 6: Wire `editor.ts` to the client

**Files:**
- Modify: `src/editor.ts:54`, `src/editor.ts:463-465`, `src/editor.ts:531`, `src/editor.ts:699-755`

**Goal:** swap `ZigWorker` for `ZigSharedClient`, switch the two `postMessage` calls to `dispatch`, and adapt the `onmessage` handler to the new protocol. Runner code is untouched.

- [ ] **Step 1: Replace the worker import**

In `src/editor.ts`, find (around line 54):

```ts
// @ts-ignore
import ZigWorker from './workers/zig.ts?worker';
```

Replace with:

```ts
import { ZigSharedClient } from "./zig-shared-client";
```

(Leave the `RunnerWorker` import on the next line untouched.)

- [ ] **Step 2: Replace the worker instantiation**

Find (around lines 463-465):

```ts
let zigWorker = new ZigWorker();
zigWorker.postMessage({ init: { versionId: playgroundVersion.id } });
initZls(playgroundVersion.id);
```

Replace with:

```ts
let zigWorker = new ZigSharedClient();
zigWorker.dispatch({ kind: "init", versionId: playgroundVersion.id });
initZls(playgroundVersion.id);
```

- [ ] **Step 3: Replace the single `postMessage({ run })` call**

Find in `startRun` (around line 531):

```ts
  zigWorker.postMessage({ run: source });
```

Replace with (use a stringified counter for requestId):

```ts
  zigWorker.dispatch({ kind: "run", requestId: String(runGen), versionId: playgroundVersion.id, source });
```

**Note:** `runGen` is already bumped at the top of `startRun` (`runGen += 1`), so its value at this point is the fresh id for this run. The existing `gen` captures below already use it; the `onmessage` handler in Step 4 will compare `msg.requestId === String(runGen)` — but since `runGen` is mutated by later runs, capture the **expected** id at dispatch time and compare against it. Concretely: keep using the existing `gen` local in the handler (already captured per-closure), and compare `msg.requestId === String(gen)`.

- [ ] **Step 4: Rewrite the `onmessage` handler**

Find `onZigWorkerMessage` (around lines 699-755). Replace the entire function body with a protocol-aware version. The new handler receives a `WorkerMsg` directly (not a `MessageEvent`), since `ZigSharedClient.onmessage` already unwraps.

Replace the assignment:

```ts
const onZigWorkerMessage = (ev: MessageEvent) => {
```

with:

```ts
zigWorker.onmessage = (msg: WorkerMsg) => {
```

and rewrite each branch to read protocol fields:

```ts
zigWorker.onmessage = (msg: WorkerMsg) => {
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

  if (msg.kind === "stderr") {
    if (msg.requestId !== String(gen)) return;
    appendCompile(msg.text);
    return;
  }

  if (msg.kind === "failed") {
    if (msg.requestId !== String(gen)) return;
    clearRunningStatusTimer();
    setStatus({ kind: "exit", code: 1, crashed: true });
    completeRun(gen);
    return;
  }

  if (msg.kind === "compiled") {
    if (msg.requestId !== String(gen)) return;

    if (pendingSource !== null) {
      const next = pendingSource;
      pendingSource = null;
      startRun(next);
      return;
    }

    clearCompile();
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
```

**Key changes vs. the original:**
- Receives `WorkerMsg`, not `MessageEvent` — drop `ev.data`.
- `ready` uses `msg.ok` to branch (success/error).
- `stderr`/`failed`/`compiled` compare `msg.requestId === String(gen)` for the α-policy client-side guard (defense in depth alongside the SharedWorker's own dropping).
- `compiled.wasm` is transferred to the runner via the transfer list `[msg.wasm]` (it is a fresh `ArrayBuffer` per compile; safe to transfer).

- [ ] **Step 5: Add the `WorkerMsg` type import**

At the top of `src/editor.ts`, alongside the new client import:

```ts
import { ZigSharedClient } from "./zig-shared-client";
import type { WorkerMsg } from "./shared-protocol";
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 7: Manual checkpoint — full playground Run**

Run `npm run dev`, open `http://localhost:5173/`, click **Run**.
Expected: status goes `loading` → (run) → exit code `0`; output panel shows program output exactly as before the refactor.

- [ ] **Step 8: Commit**

```bash
git add src/editor.ts
git commit -m "Wire editor.ts to ZigSharedClient + new wire protocol."
```

---

## Task 7: Cross-page / cross-iframe reuse + fallback regression

**Files:**
- None modified — verification only.

- [ ] **Step 1: Cross-tab reuse**

Run `npm run dev`. Open the playground in two tabs of the same browser profile. In Tab 1 click Run and wait for the first compile. In Tab 2, open devtools → Network → filter `zig.wasm`. Click Run in Tab 2.
Expected: Tab 2 issues **no** request for `zig.wasm` / `zig.tar.gz` / `libcompiler_rt.a` (SharedWorker process is warm; assembly is reused). The compile still runs and produces output.

- [ ] **Step 2: Embed multi-iframe reuse**

Create a throwaway HTML file at the repo root (do **not** commit it) named `/_probe_embed.html`:

```html
<!DOCTYPE html><html><body>
<iframe src="/?embed=1&b64=YZlf8Sgn" width="400" height="200"></iframe>
<iframe src="/?embed=1&b64=YZlf8Sgn" width="400" height="200"></iframe>
</body></html>
```

(Replace the `b64` with any valid snippet via `encodeBase64Url` from `src/embed.ts` if needed; a trivial one-liner works.)

Open `http://localhost:5173/_probe_embed.html`. Both iframes should resolve to `ready` and run. Check Network: `zig.wasm` is fetched at most once across both iframes.

- [ ] **Step 3: Fallback path regression**

In devtools console (any tab), run:

```js
// Cannot easily unset SharedWorker on a live page; instead, temporarily edit
// src/zig-shared-client.ts line: const sharedAvailable = typeof SharedWorker !== "undefined";
// → force `false`, rebuild, reload, verify Run still works, then revert.
```

Concrete steps:
1. In `src/zig-shared-client.ts`, change `const sharedAvailable = typeof SharedWorker !== "undefined";` to `const sharedAvailable = false;`.
2. `npm run build` then `npm run preview` (or dev).
3. Open the preview URL, click Run.
4. Expected: works end-to-end via the dedicated `ZigWorker` fallback.
5. Revert the line to `typeof SharedWorker !== "undefined"`.

- [ ] **Step 4: α-policy regression (auto-run supersession)**

In the playground, type a program with a deliberate error so diagnostics appear, then quickly fix it and type `;`.
Expected: only the final, clean source compiles; no stale `stderr` from intermediate states reaches the output panel (the `requestId` guard in the handler drops them).

- [ ] **Step 5: Cleanup probes and final commit**

```bash
rm -f _probe_embed.html
# Confirm git status is clean except for any unrelated changes.
git status
```

No code changes in this task; nothing to commit. If the fallback probe in Step 3 left the file modified, ensure it is reverted before finishing.

---

## Self-review notes

- **Spec coverage:** every protocol message in the spec table maps to a Task 1 type and is emitted (Tasks 2–3) and consumed (Task 6). Refcount (spec §"Refcount") is in Task 2 + hardened in Task 4. Per-compiler serial compile (spec §"Compile concurrency") is Task 3. α-policy (spec §"Stale-run policy") is in Task 3 (SharedWorker side) and Task 6 (client side, defense in depth). Fallback (spec §"Fallback") is Task 5 + verified Task 7.
- **Type consistency:** `requestId` is `string` everywhere (Task 1 type, Task 3 routing, Task 5 adapter, Task 6 comparison via `String(gen)`). `versionId` is `string` everywhere.
- **No placeholders:** every code block is complete; the one flagged decision in Task 3 Step 2 ("mirror exactly what `stderrOutput()` implements") is resolved by reading `src/utils.ts` at execution time — there is no ambiguity because the reference function is in-tree.
