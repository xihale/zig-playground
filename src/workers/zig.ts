import { WASI, PreopenDirectory, Fd, File, OpenFile, Inode, Directory } from "@bjorn3/browser_wasi_shim";
import { getLatestZigArchive, stderrOutput } from "../utils";

type Ready = {
    libDirectory: Directory;
    compilerRt: ArrayBuffer;
    zigModule: WebAssembly.Module;
};

/** Shared across compiles: Zig's global cache (/cache) for ZIR of std, etc. */
const cacheContents = new Map<string, Inode>();

let readyPromise: Promise<Ready> | null = null;

function ensureReady(): Promise<Ready> {
    if (!readyPromise) {
        readyPromise = (async (): Promise<Ready> => {
            const [libDirectory, compilerRt, zigModule] = await Promise.all([
                getLatestZigArchive(),
                fetch(new URL("../../zig-out/libcompiler_rt.a", import.meta.url)).then((r) =>
                    r.arrayBuffer(),
                ),
                WebAssembly.compileStreaming(
                    fetch(new URL("../../zig-out/bin/zig.wasm", import.meta.url)),
                ),
            ]);
            return { libDirectory, compilerRt, zigModule };
        })();
    }
    return readyPromise;
}

// Warm std + compiler_rt + zig.wasm as soon as the worker starts (like ZLS).
ensureReady();

let currentlyRunning = false;

async function run(source: string) {
    if (currentlyRunning) return;

    currentlyRunning = true;

    try {
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
