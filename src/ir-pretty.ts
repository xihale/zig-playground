/**
 * Make wasm-decompile / WAT dumps readable for the playground.
 *
 * Keep only main.zig functions (`main_*` / `$main.*`) — helpers, methods,
 * nested fns. std/runtime (including specialized print bodies) stay out of
 * the dump; call sites still show distinct names (print_N per monomorphization).
 */

export type PrettyIrResult = {
  text: string;
  /** Functions kept in the focused view. */
  shown: number;
  /** Functions omitted (std / runtime). */
  hidden: number;
  /** True when we fell back to the full dump (no main_* found). */
  fullDump: boolean;
};

/** Top-level + nested + methods from main.zig, e.g. main_fib, main_Point_sum. */
const USER_DECOMPILE_NAME = /^main_[A-Za-z0-9_]+$/;
const USER_WAT_NAME = /^\$main\./;

/**
 * Focus wasm-decompile output on main.zig functions only.
 */
export function prettyDecompile(raw: string): PrettyIrResult {
  const all = extractDecompileFunctions(raw);
  const user = all.filter((f) => USER_DECOMPILE_NAME.test(f.name));

  if (user.length === 0) {
    return {
      text: raw,
      shown: 0,
      hidden: all.length,
      fullDump: true,
    };
  }

  const cleaned = user.map((f) =>
    renameStdCallsDecompile(demangleDecompileBlock(f.body)),
  );

  const hidden = all.length - user.length;
  const header = [
    hidden > 0
      ? `// ${hidden.toLocaleString()} std/runtime functions hidden.`
      : null,
    `// Built with -OReleaseFast`,
    ``,
  ]
    .filter((l) => l !== null)
    .join("\n");

  return {
    text: header + cleaned.join("\n\n") + "\n",
    shown: user.length,
    hidden,
    fullDump: false,
  };
}

/**
 * Focus WAT on `$main.*` functions only.
 */
export function prettyWat(raw: string): PrettyIrResult {
  const all = extractWatFuncs(raw);
  const user = all.filter((f) => USER_WAT_NAME.test(f.name));
  const other = all.length - user.length;

  if (user.length === 0) {
    return { text: raw, shown: 0, hidden: other, fullDump: true };
  }

  const cleaned = user.map((f) =>
    renameStdCallsWat(demangleWatBlock(f.body)),
  );

  const header = [
    other > 0
      ? `;; ${other.toLocaleString()} std/runtime functions hidden.`
      : null,
    `;; Built with -OReleaseFast`,
    ``,
    `(module`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const body = cleaned.map((f) => indentBlock(f, 2)).join("\n");
  return {
    text: `${header}\n${body}\n)\n`,
    shown: user.length,
    hidden: other,
    fullDump: false,
  };
}

type NamedBlock = { name: string; body: string };

function extractDecompileFunctions(raw: string): NamedBlock[] {
  const lines = raw.split("\n");
  const out: NamedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const m = lines[i]!.match(/^(export\s+)?function\s+([A-Za-z0-9_]+)\b/);
    if (!m) {
      i += 1;
      continue;
    }
    const name = m[2]!;
    const start = i;
    let depth = 0;
    let sawOpen = false;
    while (i < lines.length) {
      for (const ch of lines[i]!) {
        if (ch === "{") {
          depth += 1;
          sawOpen = true;
        } else if (ch === "}") {
          depth -= 1;
        }
      }
      i += 1;
      if (sawOpen && depth <= 0) break;
      if (!sawOpen && i < lines.length && /^(export\s+)?function\s+/.test(lines[i]!)) {
        break;
      }
      if (!sawOpen && i - start > 40) break;
    }

    out.push({ name, body: lines.slice(start, i).join("\n").trimEnd() });
  }

  return out;
}

/** main_fib → fib, main_Point_sum → Point_sum. */
function demangleDecompileBlock(block: string): string {
  return block.replace(/\bmain_([A-Za-z0-9_]+)\b/g, "$1");
}

/** `debug_print_anon_N` → `print_N`; other `*_anon_N` → `*_N`. */
function renameStdCallsDecompile(block: string): string {
  let text = block.replace(/\bdebug_print_anon_(\d+)\b/g, "print_$1");
  // Underscores are word chars in JS \b — match the full mangled prefix.
  text = text.replace(/\b([A-Za-z_][A-Za-z0-9_]*)_anon_(\d+)\b/g, "$1_$2");
  return text;
}

type WatFunc = { name: string; body: string };

/** Extract top-level `(func …)` forms with their `$name`. */
function extractWatFuncs(wat: string): WatFunc[] {
  const out: WatFunc[] = [];
  let i = 0;
  while (i < wat.length) {
    const idx = wat.indexOf("(func ", i);
    if (idx < 0) break;
    let depth = 0;
    let j = idx;
    for (; j < wat.length; j++) {
      const c = wat[j]!;
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    const body = wat.slice(idx, j).trim();
    const nameMatch = body.match(/^\(func\s+(\$[^\s)]+)/);
    const name = nameMatch?.[1] ?? `$$anon_${out.length}`;
    out.push({ name, body });
    i = j;
  }
  return out;
}

/**
 * $main.fib → $fib, $main.Point.sum → $Point.sum
 */
function demangleWatBlock(block: string): string {
  return block.replace(/\$main\.([A-Za-z0-9_.]+)/g, "$$$1");
}

/** `$debug.print__anon_N` → `$print_N`; other `$…__anon_N` / `$…_anon_N` → `$…_N`. */
function renameStdCallsWat(block: string): string {
  let text = block.replace(/\$debug\.print__anon_(\d+)\b/g, "$$print_$1");
  text = text.replace(/\$([A-Za-z0-9_.]+)__anon_(\d+)\b/g, "$$$1_$2");
  text = text.replace(/\$([A-Za-z0-9_.]+)_anon_(\d+)\b/g, "$$$1_$2");
  return text;
}

function indentBlock(block: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((l) => (l.length ? pad + l : l))
    .join("\n");
}
