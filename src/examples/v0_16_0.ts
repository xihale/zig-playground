// Zig 0.16.0 examples.
//
// Only a few demos use process.Init + std.Io — where they actually win:
// pre-wired gpa/arena/io/args, buffered Writer, passing *Io.Writer around.
// Language / pure-compute demos stay on std.debug.print (see shared.ts).
// master tracks this set until it needs its own fork.
import type { Example } from "./types.ts";
import { sharedExamples } from "./shared.ts";

// ── Where Init / Io earn their keep ───────────────────────────────

/** Official-style entry: runtime hands you Io; one streaming write. */
const hello = `const std = @import("std");
const Io = std.Io;

pub fn main(init: std.process.Init) !void {
    try Io.File.stdout().writeStreamingAll(init.io, "Hello, world!\\n");
}
`;

/**
 * process.Init is the package deal: gpa + arena + io + args + environ
 * without standing up allocators / Threaded Io yourself.
 */
const process_init = `const std = @import("std");
const Io = std.Io;

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();

    // Temporary heap — no DebugAllocator boilerplate.
    const n = try init.gpa.create(i32);
    defer init.gpa.destroy(n);
    n.* = 16;

    // Process-lifetime storage — free is automatic on exit.
    const note = try arena.dupe(u8, "lives until process exit");

    const args = try init.minimal.args.toSlice(arena);

    var buf: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(init.io, &buf);
    const w = &stdout_writer.interface;

    try w.print("gpa value = {d}\\n", .{n.*});
    try w.print("arena note = {s}\\n", .{note});
    try w.print("argc = {d}\\n", .{args.len});
    for (args, 0..) |arg, i| {
        try w.print("  argv[{d}] = {s}\\n", .{ i, arg });
    }
    try w.print("environ entries ≈ {d}\\n", .{init.environ_map.count()});
    try w.flush();
}
`;

/**
 * Minimal main: only argv + environ.
 * Upgrade to full Init when you need io / gpa / arena.
 */
const process_init_minimal = `const std = @import("std");

pub fn main(init: std.process.Init.Minimal) !void {
    const args = try init.args.toSlice(std.heap.page_allocator);
    defer std.heap.page_allocator.free(args);

    // No init.io here — debug.print is the practical choice for Minimal.
    std.debug.print("Init.Minimal argc={d}\\n", .{args.len});
    for (args, 0..) |arg, i| {
        std.debug.print("  [{d}] {s}\\n", .{ i, arg });
    }
}
`;

/**
 * Buffered Io.Writer: many small prints, one flush (fewer syscalls than
 * debug.print per line). Same Writer can be passed into helpers.
 */
const io_writer = `const std = @import("std");
const Io = std.Io;

fn greet(w: *Io.Writer, name: []const u8) !void {
    try w.print("hello, {s}\\n", .{name});
}

pub fn main(init: std.process.Init) !void {
    var buf: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(init.io, &buf);
    const w = &stdout_writer.interface;

    // Helpers take *Io.Writer — not hardcoded to stderr/debug.
    try greet(w, "zig");
    try greet(w, "playground");

    // Batch small writes; flush once.
    for (0..8) |i| {
        try w.print("{d} ", .{i});
    }
    try w.print("\\n", .{});
    try w.flush();
}
`;

/**
 * Arena + streaming: build a message with process arena, then one write.
 * No manual free; no growing a Writer buffer by hand.
 */
const io_arena_message = `const std = @import("std");
const Io = std.Io;

pub fn main(init: std.process.Init) !void {
    const arena = init.arena.allocator();

    // Compose in the process arena, then stream once.
    const msg = try std.fmt.allocPrint(
        arena,
        "built in arena: sum={d}, name={s}\\n",
        .{ 1 + 2 + 3, "zig" },
    );
    try Io.File.stdout().writeStreamingAll(init.io, msg);

    // More arena allocs — still no free calls.
    const tail = try arena.dupe(u8, "and another line\\n");
    try Io.File.stdout().writeStreamingAll(init.io, tail);
}
`;

/**
 * init.gpa as the default heap: containers without setting up DebugAllocator.
 */
const init_gpa_list = `const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;

    var list: std.ArrayList(i32) = .empty;
    defer list.deinit(gpa);

    try list.append(gpa, 10);
    try list.append(gpa, 20);
    try list.appendSlice(gpa, &[_]i32{ 30, 40 });

    // Language-style output is fine when Io is not the point.
    std.debug.print("len={d}\\n", .{list.items.len});
    for (list.items, 0..) |v, i| {
        std.debug.print("  [{d}] = {d}\\n", .{ i, v });
    }
}
`;

/** Shared demos except Hello World (we ship an Init/Io Hello above). */
const language = sharedExamples.filter((e) => e.name !== "Hello World");

export const examples_0_16_0: Example[] = [
    { name: "Hello World", code: hello },
    { name: "process.Init", code: process_init },
    { name: "process.Init.Minimal", code: process_init_minimal },
    { name: "Io Writer", code: io_writer },
    { name: "Io + arena message", code: io_arena_message },
    { name: "init.gpa ArrayList", code: init_gpa_list },
    ...language,
];
