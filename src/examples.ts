// Bundled examples for the Zig playground.
// Each one targets Zig 0.15.2 and the self-hosted wasm32 backend
// (no libc, no std.os / std.fs networking). They use only std.debug.print
// so they run under WASI without filesystem side effects.

export interface Example {
    name: string;
    code: string;
}

const hello = `const std = @import("std");

pub fn main() !void {
    std.debug.print("Hello, {s}!\\n", .{"world"});
}
`;

const fibonacci = `const std = @import("std");

fn fib(n: u64) u64 {
    if (n < 2) return n;
    var a: u64 = 0;
    var b: u64 = 1;
    var i: u64 = 0;
    while (i < n) : (i += 1) {
        const next = a + b;
        a = b;
        b = next;
    }
    return a;
}

pub fn main() !void {
    var i: u64 = 0;
    while (i <= 10) : (i += 1) {
        std.debug.print("fib({d}) = {d}\\n", .{ i, fib(i) });
    }
}
`;

const errors = `const std = @import("std");

const ParseError = error{
    Empty,
    OutOfRange,
};

fn parseSmall(buf: []const u8) ParseError!u8 {
    if (buf.len == 0) return error.Empty;
    var value: u8 = 0;
    for (buf) |c| {
        if (c < '0' or c > '9') return error.OutOfRange;
        value = value * 10 + (c - '0');
        if (value > 200) return error.OutOfRange;
    }
    return value;
}

pub fn main() !void {
    const inputs = [_][]const u8{ "42", "", "12", "999", "7" };
    for (inputs) |s| {
        const result = parseSmall(s);
        if (result) |v| {
            std.debug.print("{s} -> {d}\\n", .{ s, v });
        } else |err| {
            std.debug.print("{s} -> error: {s}\\n", .{ s, @errorName(err) });
        }
    }
}
`;

const structs = `const std = @import("std");

const Point = struct {
    x: i32,
    y: i32,

    fn distance(self: Point, other: Point) i32 {
        const dx = self.x - other.x;
        const dy = self.y - other.y;
        // Chebyshev distance keeps things to integer arithmetic.
        const ax = if (dx < 0) -dx else dx;
        const ay = if (dy < 0) -dy else dy;
        return if (ax > ay) ax else ay;
    }
};

pub fn main() !void {
    const a = Point{ .x = 1, .y = 2 };
    const b = Point{ .x = 4, .y = 6 };
    std.debug.print("a = ({d}, {d})\\n", .{ a.x, a.y });
    std.debug.print("b = ({d}, {d})\\n", .{ b.x, b.y });
    std.debug.print("distance = {d}\\n", .{a.distance(b)});
}
`;

export const examples: Example[] = [
    { name: "Hello World", code: hello },
    { name: "Fibonacci", code: fibonacci },
    { name: "Error Handling", code: errors },
    { name: "Structs", code: structs },
];
