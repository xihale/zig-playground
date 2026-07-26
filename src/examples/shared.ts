// Language / pure-compute demos shared by 0.15.2 and 0.16.0.
// Prefer std.debug.print here; 0.16 only swaps in Init/Io for demos where
// that API's advantages matter (see v0_16_0.ts).

import type { Example } from "./types.ts";

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

const switch_ex = `const std = @import("std");

const Color = enum { red, green, blue, yellow };

fn describe(c: Color) []const u8 {
    return switch (c) {
        .red => "warm",
        .yellow => "warm",
        .green => "cool",
        .blue => "cool",
    };
}

fn fib_like(n: u8) u32 {
    return switch (n) {
        0 => 0,
        1, 2 => 1,
        else => fib_like(n - 1) + fib_like(n - 2),
    };
}

pub fn main() !void {
    inline for (.{ Color.red, .green, .blue, .yellow }) |c| {
        std.debug.print("{s} is {s}\\n", .{ @tagName(c), describe(c) });
    }
    std.debug.print("fib_like(8) = {d}\\n", .{fib_like(8)});
}
`;

const loops = `const std = @import("std");

pub fn main() !void {
    // while with continue expression
    var i: usize = 0;
    while (i < 5) : (i += 1) {
        std.debug.print("while {d}\\n", .{i});
    }

    // for over a slice
    const words = [_][]const u8{ "alpha", "beta", "gamma" };
    for (words, 0..) |w, idx| {
        std.debug.print("for [{d}] = {s}\\n", .{ idx, w });
    }

    // for over a range
    for (3..7) |n| {
        std.debug.print("range {d}\\n", .{n});
    }
}
`;

const defer_errdefer = `const std = @import("std");

fn mayFail(fail: bool) !void {
    std.debug.print("  enter mayFail\\n", .{});
    defer std.debug.print("  defer always runs\\n", .{});
    errdefer std.debug.print("  errdefer only on error\\n", .{});

    if (fail) return error.Boom;
    std.debug.print("  success path\\n", .{});
}

pub fn main() !void {
    std.debug.print("ok call:\\n", .{});
    try mayFail(false);

    std.debug.print("fail call:\\n", .{});
    mayFail(true) catch |err| {
        std.debug.print("caught {s}\\n", .{@errorName(err)});
    };
}
`;

const optionals = `const std = @import("std");

fn findEven(nums: []const i32) ?i32 {
    for (nums) |n| {
        if (@rem(n, 2) == 0) return n;
    }
    return null;
}

pub fn main() !void {
    const a = [_]i32{ 1, 3, 5, 8, 9 };
    const b = [_]i32{ 1, 3, 5 };

    if (findEven(&a)) |v| {
        std.debug.print("first even in a: {d}\\n", .{v});
    } else {
        std.debug.print("no even in a\\n", .{});
    }

    const maybe = findEven(&b);
    std.debug.print("b: {s}\\n", .{if (maybe == null) "none" else "found"});

    // orelse default
    const x = findEven(&b) orelse -1;
    std.debug.print("orelse => {d}\\n", .{x});
}
`;

const enums = `const std = @import("std");

const Direction = enum {
    north,
    south,
    east,
    west,

    fn opposite(self: Direction) Direction {
        return switch (self) {
            .north => .south,
            .south => .north,
            .east => .west,
            .west => .east,
        };
    }
};

// Non-exhaustive enum (extra integer tags allowed).
const Status = enum(u8) {
    ok = 0,
    warn = 1,
    err = 2,
    _,
};

pub fn main() !void {
    const d: Direction = .east;
    std.debug.print("{s} opposite {s}\\n", .{ @tagName(d), @tagName(d.opposite()) });

    const codes = [_]Status{ .ok, .warn, @enumFromInt(99) };
    for (codes) |s| {
        const label = switch (s) {
            .ok => "ok",
            .warn => "warn",
            .err => "err",
            _ => "unknown",
        };
        std.debug.print("status {d} => {s}\\n", .{ @intFromEnum(s), label });
    }
}
`;

const tagged_unions = `const std = @import("std");

const Token = union(enum) {
    number: i32,
    ident: []const u8,
    punct: u8,

    fn describe(self: Token) void {
        switch (self) {
            .number => |n| std.debug.print("number {d}\\n", .{n}),
            .ident => |s| std.debug.print("ident {s}\\n", .{s}),
            .punct => |c| std.debug.print("punct '{c}'\\n", .{c}),
        }
    }
};

pub fn main() !void {
    const tokens = [_]Token{
        .{ .number = 42 },
        .{ .ident = "main" },
        .{ .punct = '(' },
        .{ .punct = ')' },
    };
    for (tokens) |t| t.describe();
}
`;

const arrays_slices = `const std = @import("std");

pub fn main() !void {
    var arr = [_]i32{ 10, 20, 30, 40, 50 };
    const all: []i32 = arr[0..];
    const mid = arr[1..4];

    std.debug.print("len={d} mid=", .{all.len});
    for (mid) |v| std.debug.print("{d} ", .{v});
    std.debug.print("\\n", .{});

    // Multidimensional via array of arrays
    const grid = [_][3]u8{
        .{ 1, 2, 3 },
        .{ 4, 5, 6 },
    };
    for (grid, 0..) |row, r| {
        for (row, 0..) |cell, c| {
            std.debug.print("[{d},{d}]={d} ", .{ r, c, cell });
        }
        std.debug.print("\\n", .{});
    }

    // Sentinel-terminated slice
    const cstr: [:0]const u8 = "zig";
    std.debug.print("cstr={s} len={d}\\n", .{ cstr, cstr.len });
}
`;

const pointers = `const std = @import("std");

fn double(p: *i32) void {
    p.* *= 2;
}

fn sum(xs: []const i32) i32 {
    var total: i32 = 0;
    for (xs) |x| total += x;
    return total;
}

pub fn main() !void {
    var n: i32 = 21;
    double(&n);
    std.debug.print("n={d}\\n", .{n});

    const vals = [_]i32{ 1, 2, 3, 4 };
    std.debug.print("sum={d}\\n", .{sum(&vals)});

    // Optional pointer
    var maybe: ?*i32 = &n;
    if (maybe) |p| {
        p.* += 1;
        std.debug.print("via optional ptr: {d}\\n", .{p.*});
    }
    maybe = null;
    std.debug.print("maybe is null: {}\\n", .{maybe == null});
}
`;

const comptime_ex = `const std = @import("std");

fn fibComptime(comptime n: u32) u32 {
    if (n < 2) return n;
    return fibComptime(n - 1) + fibComptime(n - 2);
}

// Build a lookup table entirely at compile time.
fn makeSquares(comptime n: usize) [n]u32 {
    var out: [n]u32 = undefined;
    for (&out, 0..) |*slot, i| {
        slot.* = @intCast(i * i);
    }
    return out;
}

const squares = makeSquares(8);

pub fn main() !void {
    std.debug.print("fib(10) = {d}\\n", .{comptime fibComptime(10)});
    for (squares, 0..) |sq, i| {
        std.debug.print("{d}^2 = {d}\\n", .{ i, sq });
    }
}
`;

const generics = `const std = @import("std");

fn max(comptime T: type, a: T, b: T) T {
    return if (a > b) a else b;
}

fn Queue(comptime Child: type) type {
    return struct {
        const Self = @This();
        items: [8]Child = undefined,
        head: usize = 0,
        tail: usize = 0,
        len: usize = 0,

        fn push(self: *Self, value: Child) !void {
            if (self.len == self.items.len) return error.Full;
            self.items[self.tail] = value;
            self.tail = (self.tail + 1) % self.items.len;
            self.len += 1;
        }

        fn pop(self: *Self) ?Child {
            if (self.len == 0) return null;
            const v = self.items[self.head];
            self.head = (self.head + 1) % self.items.len;
            self.len -= 1;
            return v;
        }
    };
}

pub fn main() !void {
    std.debug.print("max(i32) = {d}\\n", .{max(i32, 3, 7)});
    std.debug.print("max(f32) = {d:.1}\\n", .{max(f32, 2.5, 1.25)});

    var q = Queue(i32){};
    try q.push(10);
    try q.push(20);
    try q.push(30);
    while (q.pop()) |v| {
        std.debug.print("pop {d}\\n", .{v});
    }
}
`;

const reflection = `const std = @import("std");

const Person = struct {
    name: []const u8,
    age: u8,
};

fn printFields(comptime T: type) void {
    const info = @typeInfo(T);
    inline for (info.@"struct".fields) |field| {
        std.debug.print("  field {s}: {s}\\n", .{ field.name, @typeName(field.type) });
    }
}

pub fn main() !void {
    std.debug.print("Person fields:\\n", .{});
    printFields(Person);

    const p = Person{ .name = "Ada", .age = 36 };
    std.debug.print("value: {s}, {d}\\n", .{ p.name, p.age });
    std.debug.print("@sizeOf(Person) = {d}\\n", .{@sizeOf(Person)});
    std.debug.print("@alignOf(u64) = {d}\\n", .{@alignOf(u64)});
}
`;

const arraylist = `const std = @import("std");

pub fn main() !void {
    const gpa = std.heap.page_allocator;

    // std.ArrayList is unmanaged: pass the allocator to mutating methods.
    var list: std.ArrayList(i32) = .empty;
    defer list.deinit(gpa);

    try list.append(gpa, 1);
    try list.append(gpa, 2);
    try list.appendSlice(gpa, &[_]i32{ 3, 4, 5 });

    std.debug.print("len={d} cap={d}\\n", .{ list.items.len, list.capacity });
    for (list.items, 0..) |v, i| {
        std.debug.print("  [{d}] = {d}\\n", .{ i, v });
    }

    _ = list.pop();
    std.debug.print("after pop len={d}\\n", .{list.items.len});
}
`;

const hashmap = `const std = @import("std");

pub fn main() !void {
    const gpa = std.heap.page_allocator;

    var map = std.AutoHashMap(u32, []const u8).init(gpa);
    defer map.deinit();

    try map.put(1, "one");
    try map.put(2, "two");
    try map.put(3, "three");

    if (map.get(2)) |v| {
        std.debug.print("get(2) = {s}\\n", .{v});
    }

    var it = map.iterator();
    while (it.next()) |e| {
        std.debug.print("{d} => {s}\\n", .{ e.key_ptr.*, e.value_ptr.* });
    }

    _ = map.remove(1);
    std.debug.print("count after remove = {d}\\n", .{map.count()});
}
`;

const sorting = `const std = @import("std");

pub fn main() !void {
    var nums = [_]i32{ 5, 2, 8, 1, 9, 3 };
    std.mem.sort(i32, &nums, {}, std.sort.asc(i32));
    std.debug.print("asc:  ", .{});
    for (nums) |n| std.debug.print("{d} ", .{n});
    std.debug.print("\\n", .{});

    std.mem.sort(i32, &nums, {}, std.sort.desc(i32));
    std.debug.print("desc: ", .{});
    for (nums) |n| std.debug.print("{d} ", .{n});
    std.debug.print("\\n", .{});

    const words = [_][]const u8{ "pear", "apple", "fig", "banana" };
    var sorted = words;
    std.mem.sort([]const u8, &sorted, {}, struct {
        fn less(_: void, a: []const u8, b: []const u8) bool {
            return std.mem.order(u8, a, b) == .lt;
        }
    }.less);
    for (sorted) |w| std.debug.print("{s} ", .{w});
    std.debug.print("\\n", .{});
}
`;

const allocators = `const std = @import("std");

pub fn main() !void {
    // Fixed buffer: no heap, capacity known up front.
    var buf: [128]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buf);
    const fa = fba.allocator();

    const chunk = try fa.alloc(u8, 16);
    @memset(chunk, 'A');
    std.debug.print("fba chunk = {s}\\n", .{chunk});

    // Arena: free everything in one deinit.
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const aa = arena.allocator();

    const name = try aa.dupe(u8, "playground");
    const nums = try aa.alloc(i32, 4);
    for (nums, 0..) |*n, i| n.* = @intCast(i * 10);

    std.debug.print("arena name = {s}\\n", .{name});
    for (nums) |n| std.debug.print("{d} ", .{n});
    std.debug.print("\\n", .{});
}
`;

const random_ex = `const std = @import("std");

pub fn main() !void {
    var prng = std.Random.DefaultPrng.init(0xC0FFEE);
    const r = prng.random();

    std.debug.print("int 1..10: ", .{});
    for (0..8) |_| {
        std.debug.print("{d} ", .{r.intRangeAtMost(i32, 1, 10)});
    }
    std.debug.print("\\n", .{});

    std.debug.print("float 0..1: ", .{});
    for (0..4) |_| {
        std.debug.print("{d:.3} ", .{r.float(f64)});
    }
    std.debug.print("\\n", .{});

    std.debug.print("bools: ", .{});
    for (0..8) |_| {
        std.debug.print("{} ", .{r.boolean()});
    }
    std.debug.print("\\n", .{});
}
`;

const bit_ops = `const std = @import("std");

const Flags = packed struct(u8) {
    read: bool = false,
    write: bool = false,
    exec: bool = false,
    _pad: u5 = 0,
};

pub fn main() !void {
    const f: Flags = .{ .read = true, .exec = true };
    std.debug.print("flags bits = 0b{b:0>8}\\n", .{@as(u8, @bitCast(f))});
    std.debug.print("read={} write={} exec={}\\n", .{ f.read, f.write, f.exec });

    const a: u8 = 0b10110000;
    const b: u8 = 0b11001100;
    std.debug.print("a & b = 0b{b:0>8}\\n", .{a & b});
    std.debug.print("a | b = 0b{b:0>8}\\n", .{a | b});
    std.debug.print("a ^ b = 0b{b:0>8}\\n", .{a ^ b});
    std.debug.print("~a    = 0b{b:0>8}\\n", .{~a});
}
`;

const zigg_zagg = `const std = @import("std");

pub fn main() !void {
    var i: usize = 1;
    while (i <= 16) : (i += 1) {
        if (i % 15 == 0) {
            std.debug.print("ZiggZagg\\n", .{});
        } else if (i % 3 == 0) {
            std.debug.print("Zigg\\n", .{});
        } else if (i % 5 == 0) {
            std.debug.print("Zagg\\n", .{});
        } else {
            std.debug.print("{d}\\n", .{i});
        }
    }
}
`;

const binary_search = `const std = @import("std");

fn binarySearch(comptime T: type, haystack: []const T, needle: T) ?usize {
    var lo: usize = 0;
    var hi: usize = haystack.len;
    while (lo < hi) {
        const mid = lo + (hi - lo) / 2;
        if (haystack[mid] < needle) {
            lo = mid + 1;
        } else if (haystack[mid] > needle) {
            hi = mid;
        } else {
            return mid;
        }
    }
    return null;
}

pub fn main() !void {
    const data = [_]i32{ 1, 3, 4, 7, 9, 11, 15, 18, 21 };
    const queries = [_]i32{ 7, 2, 21, 1, 12 };

    for (queries) |q| {
        if (binarySearch(i32, &data, q)) |idx| {
            std.debug.print("{d} found at {d}\\n", .{ q, idx });
        } else {
            std.debug.print("{d} not found\\n", .{q});
        }
    }
}
`;

const anytype_fmt = `const std = @import("std");

fn describe(value: anytype) void {
    const T = @TypeOf(value);
    std.debug.print("type={s} value=", .{@typeName(T)});
    switch (@typeInfo(T)) {
        .int => std.debug.print("{d}\\n", .{value}),
        .float => std.debug.print("{d:.3}\\n", .{value}),
        .bool => std.debug.print("{}\\n", .{value}),
        .pointer => |p| {
            if (p.size == .slice and p.child == u8) {
                std.debug.print("\\"{s}\\"\\n", .{value});
            } else {
                std.debug.print("(pointer)\\n", .{});
            }
        },
        else => std.debug.print("(other)\\n", .{}),
    }
}

pub fn main() !void {
    describe(@as(i32, 42));
    describe(@as(f64, 3.14159));
    describe(true);
    describe(@as([]const u8, "zig"));
}
`;

/** Shared core used by 0.15.2 and 0.16.0 (and master via 0.16). */
export const sharedExamples: Example[] = [
    { name: "Hello World", code: hello },
    { name: "Fibonacci", code: fibonacci },
    { name: "Error Handling", code: errors },
    { name: "Structs", code: structs },
    { name: "Switch", code: switch_ex },
    { name: "Loops", code: loops },
    { name: "Defer & Errdefer", code: defer_errdefer },
    { name: "Optionals", code: optionals },
    { name: "Enums", code: enums },
    { name: "Tagged Unions", code: tagged_unions },
    { name: "Arrays & Slices", code: arrays_slices },
    { name: "Pointers", code: pointers },
    { name: "Comptime", code: comptime_ex },
    { name: "Generics", code: generics },
    { name: "Type Reflection", code: reflection },
    { name: "ArrayList", code: arraylist },
    { name: "HashMap", code: hashmap },
    { name: "Sorting", code: sorting },
    { name: "Allocators", code: allocators },
    { name: "Random", code: random_ex },
    { name: "Bit Ops", code: bit_ops },
    { name: "Zigg Zagg", code: zigg_zagg },
    { name: "Binary Search", code: binary_search },
    { name: "anytype", code: anytype_fmt },
];
