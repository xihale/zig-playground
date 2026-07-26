// Zig 0.15.2 examples: shared core + version-specific std demos.
import type { Example } from "./types.ts";
import { sharedExamples } from "./shared.ts";

/** 0.15 still exports GeneralPurposeAllocator as an alias of DebugAllocator. */
const gpa = `const std = @import("std");

pub fn main() !void {
    // On 0.15, GeneralPurposeAllocator is the common name (alias of DebugAllocator).
    var gpa_state = std.heap.GeneralPurposeAllocator(.{}){};
    defer {
        const status = gpa_state.deinit();
        std.debug.print("gpa deinit: {s}\\n", .{@tagName(status)});
    }
    const gpa = gpa_state.allocator();

    const n = try gpa.create(i32);
    defer gpa.destroy(n);
    n.* = 42;
    std.debug.print("allocated i32 = {d}\\n", .{n.*});

    const bytes = try gpa.alloc(u8, 8);
    defer gpa.free(bytes);
    @memcpy(bytes, "zig-0.15");
    std.debug.print("bytes = {s}\\n", .{bytes});
}
`;

/** inline for + labeled blocks — pure language, works everywhere but sits with 0.15 set. */
const inline_for = `const std = @import("std");

const sizes = [_]usize{ 1, 2, 4, 8 };

pub fn main() !void {
    // inline for unrolls at comptime when the range is comptime-known.
    inline for (sizes) |s| {
        std.debug.print("size {d} => type u{d}\\n", .{ s, s * 8 });
    }

    const sum = blk: {
        var total: u32 = 0;
        for (sizes) |s| total += @intCast(s);
        break :blk total;
    };
    std.debug.print("sum of sizes = {d}\\n", .{sum});
}
`;

export const examples_0_15_2: Example[] = [
    ...sharedExamples,
    { name: "GeneralPurposeAllocator", code: gpa },
    { name: "inline for", code: inline_for },
];
