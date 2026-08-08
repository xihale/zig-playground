import { untar } from "@andrewbranch/untar.js";
import { Directory, File, ConsoleStdout, wasi as wasi_defs } from "@bjorn3/browser_wasi_shim";
import { fetchCompilerResponse } from "./compiler-cache";
import { compilerAssetUrlHashed } from "./version";

export async function fetchAssetBuffer(url: URL | string): Promise<ArrayBuffer> {
    const href = typeof url === "string" ? url : url.href;
    const response = await fetchCompilerResponse(href);
    if (!response.ok) {
        throw new Error(`fetch ${href}: HTTP ${response.status}`);
    }
    return response.arrayBuffer();
}

export async function compileWasmAsset(url: URL | string): Promise<WebAssembly.Module> {
    const href = typeof url === "string" ? url : url.href;
    // Compiler trees: Cache Storage (GHP ignores long Cache-Control). Hashed UI chunks
    // still rely on the normal HTTP cache.
    const response = await fetchCompilerResponse(href);
    if (!response.ok) {
        throw new Error(`fetch ${href}: HTTP ${response.status}`);
    }
    // compileStreaming needs a body stream; Response from Cache Storage works.
    return WebAssembly.compileStreaming(response);
}

/** Load std lib tarball for a specific compiler version id. */
export async function getZigArchive(versionId: string): Promise<Directory> {
    const url = await compilerAssetUrlHashed(versionId, "zig.tar.gz");
    return loadZigArchive(url);
}

async function loadZigArchive(tarUrl: string): Promise<Directory> {
    const response = await fetchCompilerResponse(tarUrl);
    if (!response.ok) {
        throw new Error(`fetch ${tarUrl}: HTTP ${response.status}`);
    }
    let arrayBuffer = await response.arrayBuffer();
    const magicNumber = new Uint8Array(arrayBuffer).slice(0, 2);
    if (magicNumber[0] == 0x1F && magicNumber[1] == 0x8B) {
        const ds = new DecompressionStream("gzip");
        const gunzipped = new Response(new Response(arrayBuffer).body!.pipeThrough(ds));
        arrayBuffer = await gunzipped.arrayBuffer();
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
