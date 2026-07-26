// Zig 0.16.0 examples: shared core + version-specific std demos.
import type { Example } from "./types.ts";
import { sharedExamples } from "./shared.ts";

/** 0.16 renamed GeneralPurposeAllocator → DebugAllocator (GPA alias removed). */
const debug_allocator = `const std = @import("std");

pub fn main() !void {
    // On 0.16+, use DebugAllocator (GeneralPurposeAllocator was removed as a name).
    var da = std.heap.DebugAllocator(.{}){};
    defer {
        const status = da.deinit();
        std.debug.print("debug allocator deinit: {s}\\n", .{@tagName(status)});
    }
    const gpa = da.allocator();

    const n = try gpa.create(i32);
    defer gpa.destroy(n);
    n.* = 42;
    std.debug.print("allocated i32 = {d}\\n", .{n.*});

    const bytes = try gpa.alloc(u8, 8);
    defer gpa.free(bytes);
    @memcpy(bytes, "zig-0.16");
    std.debug.print("bytes = {s}\\n", .{bytes});
}
`;

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

export const examples_0_16_0: Example[] = [
    ...sharedExamples,
    { name: "DebugAllocator", code: debug_allocator },
    { name: "inline for", code: inline_for },
];
