import { WASI, PreopenDirectory, Fd, File, OpenFile, Inode, Directory } from "@bjorn3/browser_wasi_shim";
import { compileWasmAsset, fetchAssetBuffer, getLatestZigArchive, stderrOutput } from "../utils";
import {
    type FlatEntry,
    loadZirCacheEntries,
    saveZirCacheEntries,
    ZIR_CACHE_ZIG_VERSION,
} from "../zir-cache";

type Ready = {
    libDirectory: Directory;
    compilerRt: ArrayBuffer;
    zigModule: WebAssembly.Module;
    zirCache: { files: number; bytes: number } | null;
};

/** Shared across compiles: Zig's global cache (/cache) for ZIR of std, etc. */
const cacheContents = new Map<string, Inode>();

/** Last successfully persisted size — skip redundant IDB writes. */
let lastSavedBytes = 0;
/** Serialize IDB writes; never block compile on disk. */
let persistChain: Promise<void> = Promise.resolve();

/** Duck-type walk — avoids fragile instanceof across bundler copies. */
function flattenCache(map: Map<string, Inode>, prefix = ""): FlatEntry[] {
    const out: FlatEntry[] = [];
    for (const [name, node] of map.entries()) {
        const p = prefix ? `${prefix}/${name}` : name;
        const any = node as File | Directory;
        if (any instanceof File || (any && "data" in any && (any as File).data != null && !("contents" in any))) {
            const d = (any as File).data;
            out.push({
                path: p,
                data: d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer),
            });
        } else if (any instanceof Directory || (any && (any as Directory).contents instanceof Map)) {
            out.push(...flattenCache((any as Directory).contents, p));
        }
    }
    return out;
}

/** Build tree with THIS module's File/Directory (same as PreopenDirectory). */
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

function schedulePersistCache() {
    persistChain = persistChain
        .then(async () => {
            const entries = flattenCache(cacheContents);
            const bytes = entries.reduce((s, e) => s + e.data.byteLength, 0);
            if (bytes === 0 || bytes === lastSavedBytes) return;
            const saved = await saveZirCacheEntries(entries, ZIR_CACHE_ZIG_VERSION);
            if (saved) lastSavedBytes = saved.bytes;
        })
        .catch(() => {
            /* ignore — memory cache still works this session */
        });
}

let readyPromise: Promise<Ready> | null = null;

function ensureReady(): Promise<Ready> {
    if (!readyPromise) {
        readyPromise = (async (): Promise<Ready> => {
            // Load ZIR cache in parallel with compiler assets (wall time ≈ max of both).
            const [zirHit, libDirectory, compilerRt, zigModule] = await Promise.all([
                loadZirCacheEntries(ZIR_CACHE_ZIG_VERSION),
                getLatestZigArchive(),
                fetchAssetBuffer(new URL("../../zig-out/libcompiler_rt.a", import.meta.url)),
                compileWasmAsset(new URL("../../zig-out/bin/zig.wasm", import.meta.url)),
            ]);

            let zirCache: Ready["zirCache"] = null;
            if (zirHit) {
                hydrateCache(cacheContents, zirHit.entries);
                lastSavedBytes = zirHit.bytes;
                zirCache = { files: zirHit.files, bytes: zirHit.bytes };
            }

            return { libDirectory, compilerRt, zigModule, zirCache };
        })();
    }
    return readyPromise;
}

// Warm std + compiler_rt + zig.wasm (+ optional ZIR restore) as soon as the worker starts.
// UI shows "loading" until this resolves; compile messages are only posted after.
ensureReady()
    .then((r) => postMessage({ ready: true, zirCache: r.zirCache }))
    .catch((err) => postMessage({ ready: false, error: `${err}` }));

let currentlyRunning = false;

async function run(source: string) {
    if (currentlyRunning) return;

    currentlyRunning = true;

    try {
        // Caller should wait for { ready: true }; ensureReady is still the gate.
        const { libDirectory, compilerRt, zigModule } = await ensureReady();

        const args = [
            "zig.wasm",
            "build-exe",
            "main.zig",
            "libcompiler_rt.a",
            "-fno-compiler-rt", // manually linked because the self hosted webassembly backend cannot compile it by itself
            "-fno-entry", // prevent the native webassembly backend from adding a start function to the module
        ];
        const env: string[] = [];
        const fds = [
            new OpenFile(new File([])), // stdin
            stderrOutput(), // stdout
            stderrOutput(), // stderr
            new PreopenDirectory(".", new Map<string, Inode>([
                ["main.zig", new File(new TextEncoder().encode(source))],
                // Fresh File each run; buffer is shared read-only.
                ["libcompiler_rt.a", new File(new Uint8Array(compilerRt))],
            ])),
            new PreopenDirectory("/lib", libDirectory.contents),
            new PreopenDirectory("/cache", cacheContents),
        ] satisfies Fd[];
        const wasi = new WASI(args, env, fds, { debug: false });

        const instance = await WebAssembly.instantiate(zigModule, {
            "wasi_snapshot_preview1": wasi.wasiImport,
        });

        postMessage({
            stderr: "Compiling...\n",
        });

        // @ts-ignore
        const exitCode = wasi.start(instance);

        if (exitCode == 0) {
            const cwd = wasi.fds[3] as PreopenDirectory;
            const mainWasm = cwd.dir.contents.get("main.wasm") as File | undefined;
            if (mainWasm) {
                postMessage({ compiled: mainWasm.data });
                // First cold compile (or grown cache) → async IDB write.
                schedulePersistCache();
            } else {
                postMessage({ failed: true });
            }
        } else {
            postMessage({ failed: true });
        }
    } catch (err) {
        postMessage({
            stderr: `${err}`,
        });
        postMessage({ failed: true });
    } finally {
        currentlyRunning = false;
    }
}

onmessage = (event) => {
    if (event.data.run) {
        run(event.data.run);
    }
}
