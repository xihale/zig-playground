// Runs compiled Zig code

import { WASI, PreopenDirectory, OpenFile, File } from "@bjorn3/browser_wasi_shim";
import { stderrOutput } from "../utils";

async function run(wasmData: BufferSource) {
    const args = ["main.wasm"];
    const env: string[] = [];
    const fds = [
        new OpenFile(new File([])), // stdin
        stderrOutput(), // stdout
        stderrOutput(), // stderr
        new PreopenDirectory(".", new Map([])),
    ];
    const wasi = new WASI(args, env, fds);

    const { instance } = await WebAssembly.instantiate(wasmData, {
        "wasi_snapshot_preview1": wasi.wasiImport,
    });;

    try {
        // @ts-ignore
        const exitCode = wasi.start(instance);
        // Exit code is surfaced as its own message so the UI can render it
        // as a badge above the tab bar instead of as a textual trailer in
        // the output stream.
        postMessage({ exitCode });
    } catch (err) {
        postMessage({ stderr: `${err}` });
        postMessage({ exitCode: 1, crashed: true });
    }

    postMessage({
        done: true,
    });
}

onmessage = (event) => {
    if (event.data.run) {
        run(event.data.run);
    }
}
