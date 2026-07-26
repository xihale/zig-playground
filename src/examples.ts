// Bundled playground examples, resolved per compiler version.
//
// Shared language/std demos live in examples/shared.ts and run under the
// WASI wasm runner (std.debug.print only; no libc / real FS / networking).
// Version-specific entries cover std renames (e.g. GPA → DebugAllocator).

export type { Example } from "./examples/types.ts";
export { sharedExamples } from "./examples/shared.ts";

import type { Example } from "./examples/types.ts";
import { examples_0_15_2 } from "./examples/v0_15_2.ts";
import { examples_0_16_0 } from "./examples/v0_16_0.ts";

/** Examples for a compiler version id (`0.15.2`, `0.16.0`, `master`, …). */
export function examplesFor(versionId: string): Example[] {
    switch (versionId) {
        case "0.15.2":
            return examples_0_15_2;
        case "0.16.0":
            return examples_0_16_0;
        case "master":
            // Track 0.16 until master needs its own fork.
            return examples_0_16_0;
        default:
            return examples_0_16_0;
    }
}
