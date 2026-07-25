import { untar } from "@andrewbranch/untar.js";
import { Directory, File, ConsoleStdout, wasi as wasi_defs } from "@bjorn3/browser_wasi_shim";

/** Bump when the on-disk layout of cached assets changes. */
const ASSET_CACHE_NAME = "zig-playground-assets-v1";
/**
 * Soft TTL for Cache Storage entries. Production URLs are content-hashed so
 * they naturally invalidate on deploy; this mainly bounds unhashed / rare paths.
 * 30 days is long enough that a multi-MB ReleaseFast download is a rare cost.
 */
const ASSET_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Fetch a playground asset with a long-lived Cache Storage layer.
 * Skips disk cache in Vite dev so local `zig build` rebuilds are picked up.
 */
export async function fetchAsset(url: URL | string): Promise<Response> {
    const href = typeof url === "string" ? url : url.href;

    // Dedicated workers support `caches`; fall back if missing or in dev.
    if (import.meta.env.DEV || typeof caches === "undefined") {
        return fetch(href);
    }

    try {
        const cache = await caches.open(ASSET_CACHE_NAME);
        const hit = await cache.match(href);
        if (hit) {
            const cachedAt = hit.headers.get("x-zig-playground-cached-at");
            if (cachedAt) {
                const age = Date.now() - Number(cachedAt);
                if (Number.isFinite(age) && age >= 0 && age < ASSET_CACHE_MAX_AGE_MS) {
                    return hit;
                }
            } else {
                // Legacy entry without timestamp — treat as usable once.
                return hit;
            }
        }

        const res = await fetch(href);
        if (res.ok) {
            const headers = new Headers(res.headers);
            headers.set("x-zig-playground-cached-at", String(Date.now()));
            // Opaque to browser HTTP cache rules; we own eviction via TTL + name bump.
            headers.set("Cache-Control", "max-age=2592000");
            await cache.put(href, new Response(await res.clone().arrayBuffer(), {
                status: res.status,
                statusText: res.statusText,
                headers,
            }));
        }
        return res;
    } catch {
        return fetch(href);
    }
}

export async function fetchAssetBuffer(url: URL | string): Promise<ArrayBuffer> {
    return (await fetchAsset(url)).arrayBuffer();
}

export async function compileWasmAsset(url: URL | string): Promise<WebAssembly.Module> {
    const href = typeof url === "string" ? url : url.href;
    if (import.meta.env.DEV || typeof caches === "undefined") {
        return WebAssembly.compileStreaming(fetch(href));
    }
    const res = await fetchAsset(href);
    // Body may already be buffered from Cache Storage — compile() not streaming.
    if (res.headers.has("x-zig-playground-cached-at")) {
        return WebAssembly.compile(await res.arrayBuffer());
    }
    return WebAssembly.compileStreaming(res);
}

/** Memoized so each worker only fetch/gunzip/untar std once. */
let archivePromise: Promise<Directory> | null = null;

export function getLatestZigArchive(): Promise<Directory> {
    if (!archivePromise) {
        archivePromise = loadZigArchive();
    }
    return archivePromise;
}

async function loadZigArchive(): Promise<Directory> {
    const response = await fetchAsset(new URL("../zig-out/zig.tar.gz", import.meta.url));
    let arrayBuffer = await response.arrayBuffer();
    const magicNumber = new Uint8Array(arrayBuffer).slice(0, 2);
    if (magicNumber[0] == 0x1F && magicNumber[1] == 0x8B) {
        const ds = new DecompressionStream("gzip");
        const response = new Response(new Response(arrayBuffer).body!.pipeThrough(ds));
        arrayBuffer = await response.arrayBuffer();
    } else {
        // already decompressed
    }
    const entries = untar(arrayBuffer);

    let root: TreeNode = new Map();

    for (const e of entries) {
        if (!e.filename.startsWith("lib/")) continue;
        const path = e.filename.slice("lib/".length);
        const splitPath = path.split("/");

        let c = root;
        for (const segment of splitPath.slice(0, -1)) {
            if (!c.has(segment)) {
                c.set(segment, new Map());
            }
            c = c.get(segment) as TreeNode;
        }


        c.set(splitPath[splitPath.length - 1], e.fileData);
    }

    return convert(root);
}

type TreeNode = Map<string, TreeNode | Uint8Array>;

function convert(node: TreeNode): Directory {
    return new Directory(
        [...node.entries()].map(([key, value]) => {
            if (value instanceof Uint8Array) {
                return [key, new File(value)];
            } else {
                return [key, convert(value)];
            }
        })
    )
}

export function stderrOutput(): ConsoleStdout {
    const dec = new TextDecoder("utf-8", { fatal: false });
    const stderr = new ConsoleStdout((buffer) => {
        postMessage({ stderr: dec.decode(buffer, { stream: true }) });
    });
    stderr.fd_pwrite = (data, offset) => {
        return { ret: wasi_defs.ERRNO_SPIPE, nwritten: 0 };
    }
    return stderr;
}
