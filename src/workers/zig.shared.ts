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
