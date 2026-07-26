// Bundled playground examples, resolved per compiler version.
//
// - 0.15.2: shared language demos + GeneralPurposeAllocator (debug.print).
// - 0.16.0 / master: a few process.Init / std.Io showcases, then shared
//   language demos still on debug.print (no libc / real FS / networking).

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
