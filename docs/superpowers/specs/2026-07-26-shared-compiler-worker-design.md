# Shared compiler worker design

**Date:** 2026-07-26
**Status:** approved (all sections locked for implementation)

## Problem

Every iframe and every page load today spins up its own dedicated `ZigWorker`
and pays the same CPU-bound setup cost on top of the (already cached) network
bytes:

1. `WebAssembly.compile(zig.wasm)` — tens of MB, hundreds of ms to seconds.
2. `untar(zig.tar.gz)` — the std library tarball, re-extracted in memory each boot.
3. Worker cold start.

`src/compiler-cache.ts` (Cache Storage) and `src/zir-cache.ts` (IndexedDB) already
deduplicate the **bytes** across the origin. They cannot deduplicate steps 1–3:
a compiled `WebAssembly.Module` cannot be structured-cloned, stored in IDB, or
transferred across workers. The work therefore has to be shared by **keeping a
single live compiler process** on the page.

## Goal

One SharedWorker per origin hosts every Zig compiler instance. All pages
(playground main site) and all embed iframes on that origin reuse it:

- A second iframe on the same page no longer re-compiles `zig.wasm`.
- A page reload no longer re-compiles `zig.wasm` if the SharedWorker process is
  still alive.
- Different Zig versions coexist, lazily loaded, refcount-evicted.

## Non-goals

- Sharing the **runner** (executing the user's compiled `main.wasm`). The runner
  stays a per-page dedicated worker so `activeRunner.terminate()` cancellation
  semantics in `editor.ts` are untouched.
- Sharing **ZLS**. ZLS is tightly coupled to the editor lifecycle (semantic
  tokens, autocompletion, the cut dual-doc bridge). It is out of scope for this
  change and stays a dedicated worker.
- Cross-origin sharing. Storage partitioning (Chrome 113+/FF/Safari) already
  isolates embedded cross-origin iframes; this design shares within one origin
  only.
- Cancellation of an in-flight `WebAssembly.compile` or `wasi.start`. Neither is
  cancelable; stale results are dropped by `requestId` instead.

## Decisions (brainstorming)

1. **Scope:** origin-wide SharedWorker, shared by main site + embed iframes.
2. **Versions:** lazily loaded per `versionId`, coexisting; **refcount-evicted**
   (not LRU, not never-release). A version is loaded the first time a port
   `init`s it, and released when the last port holding it disconnects or
   switches away.
3. **Routing:** `requestId` on every run-scoped message.
4. **Stale-run policy (α):** when a port sends a new `run`, the SharedWorker
   overwrites that port's `currentRequestId`. Any further `stderr`/`compiled`/
   `failed` for the previous `requestId` on that port is dropped. This mirrors
   today's `runGen` behavior exactly.
5. **Compile concurrency:** **per-compiler** serial queue. Same version is
   serial (protects that version's `cacheContents` Map); different versions run
   in parallel (they share no mutable state).
6. **Runner:** unchanged, stays a per-page dedicated worker.
7. **ZLS:** unchanged, out of scope.
8. **Fallback:** when `typeof SharedWorker === "undefined"`, transparently fall
   back to the existing dedicated `ZigWorker` with identical behavior.
9. **Build:** Vite `?sharedworker` import; zero extra config.

## Architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  main page P │  │  iframe I1   │  │  iframe I2   │   (each has a thin client)
│ ZigSharedClient │ ZigSharedClient │ ZigSharedClient │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                  │                 │
       ▼                  ▼                 ▼
   ┌──────────────────────────────────────────┐
   │       SharedWorker (one per origin)      │
   │  compilers: Map<versionId, Compiler>     │  lazy, refcounted
   │    "0.16.0" → { module, libDir, ref }    │
   │    "master" → { module, libDir, ref }    │
   │  per-compiler serial compile queue       │
   │  per-port currentRequestId (α policy)    │
   └──────────────────────────────────────────┘
```

### SharedWorker responsibilities

- **Assemble** a compiler tree for a `versionId`: fetch+compile `zig.wasm`,
  `libcompiler_rt.a`, untar `zig.tar.gz`, hydrate ZIR cache. All byte fetches go
  through the existing `fetchCompilerResponse` (Cache Storage) and
  `loadZirCacheEntries` (IDB) — no new caching layer.
- **Compile** user source against an assembled tree, returning `main.wasm`
  bytes. Does **not** execute user wasm.
- **Route** run-scoped replies by `requestId`, with α stale-run dropping.

### Client responsibilities

- `ZigSharedClient` exposes the same surface `editor.ts` uses today
  (`dispatch`, `onmessage`), hiding whether a SharedWorker or a fallback
  dedicated worker is behind it.
- Runner lifecycle (`activeRunner.terminate()`, `runGen`) stays in `editor.ts`
  exactly as is.

## Message protocol

Every message is a plain JS object. Run-scoped messages carry `requestId`
(client-generated monotonic id).

### Client → SharedWorker

| Message | Fields | Notes |
|---|---|---|
| `init` | `{ kind: "init", versionId }` | No `requestId` (not a run). Triggers lazy assembly of that version and increments its refcount on this port. Sent on connect and on version switch. |
| `run` | `{ kind: "run", requestId, versionId, source }` | Compile request. `versionId` is redundant but lets the SharedWorker route to the right `Compiler` even right after a version switch. |

### SharedWorker → Client

| Message | Fields | Notes |
|---|---|---|
| `ready` | `{ kind: "ready", versionId, ok: true, zirCache }` | Assembly succeeded. `zirCache` is `{ files, bytes } \| null`, surfaced to UI as today. No `requestId` (async ack of `init`). |
| `ready` (error) | `{ kind: "ready", versionId, ok: false, error: string }` | Assembly failed (fetch/compile/untar). Same `kind` + an explicit `ok` flag so the client branches on one field; no `zirCache` field on failure. |
| `stderr` | `{ kind: "stderr", requestId, text }` | Compile diagnostics. May arrive multiple times per run, in send order. |
| `compiled` | `{ kind: "compiled", requestId, wasm: ArrayBuffer }` | Compile succeeded. `wasm` is transferable. |
| `failed` | `{ kind: "failed", requestId }` | Compile produced no artifact. All `stderr` for this `requestId` is flushed first. |

### Ordering guarantees

- The per-compiler compile queue is serial, so a single `requestId`'s `stderr`
  stream is contiguous and ordered; the port is FIFO; the client therefore does
  not need a sequence number.
- The client keeps its own `runGen` (unchanged from today) so it can ignore
  replies whose `requestId` is no longer current — defense in depth alongside
  the SharedWorker's α dropping.

### Transfer safety

`compiled.wasm` is a fresh `ArrayBuffer` per compile (each `run` re-instantiates
and produces its own `main.wasm`). Compile is serial per version, so no two
clients ever contend for the same buffer. Transfer is safe.

## SharedWorker internal structure

```ts
// src/workers/zig.shared.ts
type Compiler = {
  versionId: string;
  ready: Promise<Ready> | null;        // assembly dedup (today's readyPromise pattern)
  cacheContents: Map<string, Inode>;   // per-version ZIR /cache (was module-level in zig.ts)
  lastSavedBytes: number;              // IDB write dedup (was module-level)
  persistChain: Promise<void>;         // IDB write serialization (was module-level)
  compileChain: Promise<void>;         // per-compiler serial compile queue
  refCount: number;
};

const compilers = new Map<string, Compiler>();
const ports = new Map<MessagePort, { versionId: string | null; currentRequestId: string | null }>();
```

- **Assembly dedup:** `ensureCompiler(versionId)` returns the existing
  `ready` Promise if present; otherwise creates the `Compiler`, runs the
  `Promise.all` assembly (reused verbatim from `zig.ts:90-107`), and resolves
  with `{ libDirectory, compilerRt, zigModule, zirCache }`. Every port waiting
  on that version attaches `.then` to post `ready`.

- **Refcount:** port `init(versionId)` → if the port already holds the same
  `versionId`, no-op (no double count). Otherwise `refCount++` on the new
  version's compiler (creating it via `ensureCompiler` if absent) and
  `refCount--` on the port's previous version (removing it from `compilers` if
  it hits 0). Port disconnect → decrement whatever version that port currently
  holds.

- **Per-compiler serial compile:** each `run` is appended to
  `compiler.compileChain`. Inside, before emitting any reply, re-check
  `portState.currentRequestId === requestId`; if not, the run was superseded —
  emit nothing further for it. The `doOneCompile` body is `zig.ts:120-180`
  with `postMessage` swapped for `port.postMessage({ kind, requestId, ... })`
  and module-level state read from the `Compiler` object.

- **Lifecycle:**
  - `onconnect` → create a `PortState`, do not assemble (wait for `init`).
  - `port.onmessage` → route `init` / `run`.
  - `port.onmessageerror` / port closed → drop from `ports`, decrement refcount.
  - In-flight compile for a disconnected port completes; `port.postMessage`
    throws and is swallowed in try/catch.
  - `compilers` are released by refcount only; the SharedWorker process itself
    is reaped by the browser after the last port goes away.

## Changes

### New

- `src/workers/zig.shared.ts` — SharedWorker entry. Assembly (reuses
  `zig.ts`'s `Promise.all`), per-compiler serial compile queue, refcount,
  α-policy routing.
- `src/zig-shared-client.ts` — thin client. Prefers `SharedWorker`, falls back
  to dedicated `ZigWorker`. Exposes `dispatch(msg)` + `onmessage` so `editor.ts`
  changes minimally.

### Modified

- `src/editor.ts` — `new ZigWorker()` → `new ZigSharedClient()`; the two
  `postMessage({ init/run })` calls become `dispatch({ kind, ... })`; the
  `onmessage` handler adapts field names to the new protocol. `runGen` and the
  runner lifecycle are untouched.

### Unchanged

- `src/workers/zig.ts` — kept verbatim as the fallback path invoked by the
  client shell. No dual maintenance risk: it remains the dedicated-worker
  implementation.
- `src/workers/runner.ts` — untouched (still per-page dedicated worker).
- `src/workers/zls.ts`, `src/lsp.ts` — untouched (out of scope).
- `src/compiler-cache.ts`, `src/zir-cache.ts`, `src/version.ts` — reused as-is
  by the SharedWorker.

### Build

Vite `?sharedworker` import; no `vite.config.js` changes.

## Fallback

`ZigSharedClient` checks `typeof SharedWorker === "undefined"` (older Safari,
some in-app browsers). When unavailable it instantiates the existing dedicated
`ZigWorker` and adapts the **same** JSON protocol on top of it, so `editor.ts`
sees one uniform interface regardless of transport. The dedicated fallback path
reuses `zig.ts` unchanged.

## Testing notes

- Manual: load the main site, confirm first-run assembly + a Run.
- Open a second tab to the same origin; the second tab's `ready` should be
  near-instant (SharedWorker process already warm).
- Embed: a page with two embed iframes for the same version should compile the
  first asm only once; second iframe's first Run is fast.
- Version switch: navigate `/` → `/0.15.2/` → `/`; refcount should evict each
  version when no port holds it (verify via devtools Memory or by re-assembly
  timing on return).
- Fallback: force `SharedWorker = undefined` in devtools; confirm dedicated
  worker path still runs end to end.
- Concurrent runs: two iframes Run at once on the same version — replies must
  not cross (verify `requestId` routing via console logging).
