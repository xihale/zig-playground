/**
 * Twoslash-style cut markers for demo snippets.
 *
 * Markers (Zig line comments, flexible spacing):
 *   // ---cut---          alias of cut-before
 *   // ---cut-before---   drop everything above (incl. this line)
 *   // ---cut-after---    drop everything below (incl. this line)
 *   // ---cut-start--- … // ---cut-end---   drop a mid-file span
 *
 * Embed strategy (no CodeMirror block decorations — those fought active-line
 * and docView):
 *   • Editor document = visible slice only
 *   • Compile / share reassemble via prefix + display + suffix
 *   • LSP dual-doc (`cut-lsp.ts`): ZLS sees the full program; wire messages
 *     map positions between slice ↔ full (single-island cuts only)
 *   • Full UI keeps markers in the buffer so authors can edit them
 */

export type CutKind =
  | "cut-before"
  | "cut-after"
  | "cut-start"
  | "cut-end";

export type CutMarker = {
  kind: CutKind;
  /** 0-based line index. */
  line: number;
  from: number;
  to: number;
};

export type HiddenRange = { from: number; to: number };

export type CutPlan = {
  hasCuts: boolean;
  markers: CutMarker[];
  hidden: HiddenRange[];
};

/**
 * How embed mode maps the short editor buffer back to a full program.
 * `visible == null` means multi-island display (or no cuts): compile uses
 * `full` while the buffer still matches `display0`.
 */
export type CutBinding = {
  full: string;
  visible: { from: number; to: number } | null;
  display0: string;
};

const MARKER_RE =
  /^\s*\/\/\s*---\s*(cut(?:-before|-after|-start|-end)?)\s*---\s*$/;

function kindFromToken(token: string): CutKind {
  if (token === "cut" || token === "cut-before") return "cut-before";
  if (token === "cut-after") return "cut-after";
  if (token === "cut-start") return "cut-start";
  return "cut-end";
}

/** Scan source for cut marker lines. */
export function findCutMarkers(source: string): CutMarker[] {
  const markers: CutMarker[] = [];
  let offset = 0;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const hasNl = i < lines.length - 1;
    const from = offset;
    const to = offset + line.length + (hasNl ? 1 : 0);
    const m = MARKER_RE.exec(line);
    if (m) {
      markers.push({
        kind: kindFromToken(m[1]!),
        line: i,
        from,
        to,
      });
    }
    offset = to;
  }
  return markers;
}

/** Build merged hidden ranges from markers (whole lines, markers included). */
export function planCuts(source: string): CutPlan {
  const markers = findCutMarkers(source);
  if (markers.length === 0) {
    return { hasCuts: false, markers: [], hidden: [] };
  }

  const lineBounds: { from: number; to: number }[] = [];
  {
    let offset = 0;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const hasNl = i < lines.length - 1;
      const from = offset;
      const to = offset + lines[i]!.length + (hasNl ? 1 : 0);
      lineBounds.push({ from, to });
      offset = to;
    }
  }
  const lineCount = lineBounds.length;
  if (lineCount === 0) {
    return { hasCuts: false, markers, hidden: [] };
  }

  const hideLine = new Uint8Array(lineCount);

  let openStart: number | null = null;
  for (const mk of markers) {
    if (mk.kind === "cut-start") {
      if (openStart === null) openStart = mk.line;
    } else if (mk.kind === "cut-end") {
      if (openStart !== null) {
        for (let L = openStart; L <= mk.line; L++) hideLine[L] = 1;
        openStart = null;
      }
    }
  }
  if (openStart !== null) {
    for (let L = openStart; L < lineCount; L++) hideLine[L] = 1;
  }

  for (const mk of markers) {
    if (mk.kind === "cut-before") {
      for (let L = 0; L <= mk.line; L++) hideLine[L] = 1;
    }
  }
  for (const mk of markers) {
    if (mk.kind === "cut-after") {
      for (let L = mk.line; L < lineCount; L++) hideLine[L] = 1;
    }
  }

  const hidden: HiddenRange[] = [];
  let runStart: number | null = null;
  for (let L = 0; L < lineCount; L++) {
    if (hideLine[L]) {
      if (runStart === null) runStart = L;
    } else if (runStart !== null) {
      hidden.push({
        from: lineBounds[runStart]!.from,
        to: lineBounds[L - 1]!.to,
      });
      runStart = null;
    }
  }
  if (runStart !== null) {
    hidden.push({
      from: lineBounds[runStart]!.from,
      to: lineBounds[lineCount - 1]!.to,
    });
  }

  return { hasCuts: hidden.length > 0, markers, hidden };
}

/** Visible source after applying cuts. */
export function applyCuts(source: string): string {
  const plan = planCuts(source);
  if (!plan.hasCuts) return source;
  let out = "";
  let cursor = 0;
  for (const r of plan.hidden) {
    out += source.slice(cursor, r.from);
    cursor = r.to;
  }
  out += source.slice(cursor);
  return out.replace(/^\n+/, "").replace(/\n+$/, "\n");
}

function visibleRanges(
  hidden: HiddenRange[],
  length: number,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let cursor = 0;
  for (const h of hidden) {
    if (cursor < h.from) out.push({ from: cursor, to: h.from });
    cursor = h.to;
  }
  if (cursor < length) out.push({ from: cursor, to: length });
  return out;
}

/**
 * Split a full program into the short buffer shown in embed mode and a
 * binding used to reassemble for compile / share.
 */
export function bindCuts(full: string): { display: string; binding: CutBinding } {
  const plan = planCuts(full);
  const display0 = plan.hasCuts ? applyCuts(full) : full;
  if (!plan.hasCuts) {
    return { display: full, binding: { full, visible: null, display0 } };
  }

  const visibles = visibleRanges(plan.hidden, full.length);
  if (visibles.length === 1) {
    const v = visibles[0]!;
    return {
      display: full.slice(v.from, v.to),
      binding: { full, visible: v, display0 },
    };
  }
  // Multiple islands → joined display; compile keeps full while untouched.
  return {
    display: display0,
    binding: { full, visible: null, display0 },
  };
}

/** Editor buffer → full program for the zig worker / share links. */
export function resolveCompileSource(
  display: string,
  binding: CutBinding,
): string {
  if (binding.visible) {
    return (
      binding.full.slice(0, binding.visible.from) +
      display +
      binding.full.slice(binding.visible.to)
    );
  }
  if (display === binding.display0 || display === binding.full) {
    return binding.full;
  }
  // Author rewrote the demo past the cut template — run what they see.
  return display;
}
