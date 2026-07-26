import { untar } from "@andrewbranch/untar.js";
import { Directory, File, ConsoleStdout, wasi as wasi_defs } from "@bjorn3/browser_wasi_shim";

export async function fetchAssetBuffer(url: URL | string): Promise<ArrayBuffer> {
    const href = typeof url === "string" ? url : url.href;
    return (await fetch(href)).arrayBuffer();
}

export async function compileWasmAsset(url: URL | string): Promise<WebAssembly.Module> {
    const href = typeof url === "string" ? url : url.href;
    // Content-hashed build assets + Cache-Control handle caching; no Cache Storage layer.
    return WebAssembly.compileStreaming(fetch(href));
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
    const response = await fetch(new URL("../zig-out/zig.tar.gz", import.meta.url));
    let arrayBuffer = await response.arrayBuffer();
    const magicNumber = new Uint8Array(arrayBuffer).slice(0, 2);
    if (magicNumber[0] == 0x1F && magicNumber[1] == 0x8B) {
        const ds = new DecompressionStream("gzip");
        const response = new Response(new Response(arrayBuffer).body!.pipeThrough(ds));
        arrayBuffer = await response.arrayBuffer();
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
