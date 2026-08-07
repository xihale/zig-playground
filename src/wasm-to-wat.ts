/**
 * Convert a WebAssembly binary to readable WAT text via wabt.js.
 * Lazy-loads the ~675KB wabt runtime on first use so cold page load
 * stays free of the dependency.
 */

import { prettyWat } from "./ir-pretty";

type WabtModule = {
  readWasm: (
    buffer: Uint8Array,
    options: Record<string, boolean>,
  ) => {
    generateNames: () => void;
    applyNames: () => void;
    toText: (opts: { foldExprs: boolean; inlineExport: boolean }) => string;
    destroy: () => void;
  };
};

let wabtPromise: Promise<WabtModule> | null = null;

/** Features Zig's wasm backend may emit — enable liberally so read never fails. */
const READ_FEATURES: Record<string, boolean> = {
  readDebugNames: true,
  check: true,
  exceptions: true,
  mutable_globals: true,
  sat_float_to_int: true,
  sign_extension: true,
  simd: true,
  threads: true,
  multi_value: true,
  tail_call: true,
  bulk_memory: true,
  reference_types: true,
  function_references: true,
  gc: true,
  memory64: true,
  extended_const: true,
  relaxed_simd: true,
  annotations: true,
  code_metadata: true,
};

function loadWabt(): Promise<WabtModule> {
  if (!wabtPromise) {
    wabtPromise = import("wabt").then(async (mod) => {
      // CJS default export is the async factory.
      const factory = (mod as { default?: () => Promise<WabtModule> }).default
        ?? (mod as unknown as () => Promise<WabtModule>);
      return factory();
    });
  }
  return wabtPromise;
}

/** Soft cap so multi-MB debug std modules don't freeze the DOM. */
export const WAT_DISPLAY_LIMIT = 1_500_000;

export type WasmToWatResult = {
  text: string;
  truncated: boolean;
  fullLength: number;
  shown?: number;
  hidden?: number;
};

/**
 * Disassemble `wasm` into WAT. Yields to the event loop after loading wabt
 * so the UI can paint a "converting…" state first.
 */
export async function wasmToWat(wasm: ArrayBuffer): Promise<WasmToWatResult> {
  const wabt = await loadWabt();
  // Let the "converting" paint land before the sync CPU work.
  await new Promise<void>((r) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => r());
    } else {
      setTimeout(r, 0);
    }
  });

  const bytes = new Uint8Array(wasm);
  const module = wabt.readWasm(bytes, READ_FEATURES);
  try {
    try {
      module.generateNames();
      module.applyNames();
    } catch {
      // Name section optional / apply may fail on some modules — still emit WAT.
    }
    // foldExprs: denser, easier to scan than one-opcode-per-line.
    const raw = module.toText({ foldExprs: true, inlineExport: true });
    // Default: only $main.* (user source). Full module still huge with std.
    const pretty = prettyWat(raw);
    const full = pretty.text;
    const fullLength = full.length;
    const meta = { shown: pretty.shown, hidden: pretty.hidden };
    if (fullLength <= WAT_DISPLAY_LIMIT) {
      return { text: full, truncated: false, fullLength, ...meta };
    }
    return {
      text:
        full.slice(0, WAT_DISPLAY_LIMIT) +
        `\n\n;; … truncated: showing ${WAT_DISPLAY_LIMIT.toLocaleString()} of ` +
        `${fullLength.toLocaleString()} characters\n`,
      truncated: true,
      fullLength,
      ...meta,
    };
  } finally {
    module.destroy();
  }
}
