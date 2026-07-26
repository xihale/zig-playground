/**
 * Dual-document bridge for Twoslash cut embeds.
 *
 * Editor buffer = visible slice (short demo).
 * ZLS document  = full program (prefix + slice + suffix).
 *
 * The CodeMirror LSP client always talks in editor (display) coordinates.
 * This transport wrapper rewrites wire messages so the server sees full
 * coordinates and content, then maps diagnostics / ranges back.
 *
 * Only single-island cuts (`binding.visible != null`) support mapping.
 * Multi-island / no-cut modes pass through unchanged.
 */

import { Text } from "@codemirror/state";
import type { Transport } from "@codemirror/lsp-client";
import {
  resolveCompileSource,
  type CutBinding,
} from "./cut.ts";

export type CutLspBridge = {
  /** Active cut binding, or null when the buffer is the full program. */
  binding: CutBinding | null;
  /** Current editor buffer (display slice or full source). */
  getDisplay: () => string;
};

/** Mutable bridge — set from editor before the LSP plugin opens the file. */
export const cutLspBridge: CutLspBridge = {
  binding: null,
  getDisplay: () => "",
};

export function setCutLspBridge(
  binding: CutBinding | null,
  getDisplay: () => string,
) {
  cutLspBridge.binding = binding;
  cutLspBridge.getDisplay = getDisplay;
}

/** True when dual-doc mapping is active. */
export function isCutDualDoc(): boolean {
  return cutLspBridge.binding?.visible != null;
}

type LspPos = { line: number; character: number };
type LspRange = { start: LspPos; end: LspPos };

function toText(source: string): Text {
  // CodeMirror Text uses \n separators; preserve trailing empty line.
  return Text.of(source.split("\n"));
}

function posToOffset(doc: Text, pos: LspPos): number {
  if (pos.line < 0) return 0;
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return Math.min(line.from + Math.max(0, pos.character), line.to);
}

function offsetToPos(doc: Text, offset: number): LspPos {
  const o = Math.max(0, Math.min(offset, doc.length));
  const line = doc.lineAt(o);
  return { line: line.number - 1, character: o - line.from };
}

function liveFull(display: string, binding: CutBinding): string {
  return resolveCompileSource(display, binding);
}

function displayPosToFull(
  pos: LspPos,
  display: string,
  binding: CutBinding,
): LspPos {
  const dDoc = toText(display);
  const fDoc = toText(liveFull(display, binding));
  const dOff = posToOffset(dDoc, pos);
  const fOff = binding.visible!.from + dOff;
  return offsetToPos(fDoc, fOff);
}

function fullPosToDisplay(
  pos: LspPos,
  display: string,
  binding: CutBinding,
): LspPos | null {
  const dDoc = toText(display);
  const fDoc = toText(liveFull(display, binding));
  const fOff = posToOffset(fDoc, pos);
  const from = binding.visible!.from;
  const to = from + dDoc.length;
  if (fOff < from || fOff > to) return null;
  return offsetToPos(dDoc, fOff - from);
}

function displayRangeToFull(
  range: LspRange,
  display: string,
  binding: CutBinding,
): LspRange {
  return {
    start: displayPosToFull(range.start, display, binding),
    end: displayPosToFull(range.end, display, binding),
  };
}

function fullRangeToDisplay(
  range: LspRange,
  display: string,
  binding: CutBinding,
): LspRange | null {
  const start = fullPosToDisplay(range.start, display, binding);
  const end = fullPosToDisplay(range.end, display, binding);
  if (!start || !end) return null;
  return { start, end };
}

/** Rewrite client → server messages. */
function rewriteOutgoing(data: any, display: string, binding: CutBinding): void {
  const method: string | undefined = data.method;
  if (!method) return;

  if (method === "textDocument/didOpen" && data.params?.textDocument) {
    data.params.textDocument.text = liveFull(display, binding);
    return;
  }

  if (method === "textDocument/didChange" && data.params) {
    // Always full-document replace so incremental display edits don't
    // desync the server's full-file view.
    data.params.contentChanges = [{ text: liveFull(display, binding) }];
    return;
  }

  // Position-based requests (hover, completion, definition, …).
  if (data.params?.position) {
    data.params.position = displayPosToFull(
      data.params.position,
      display,
      binding,
    );
  }
  if (data.params?.range) {
    data.params.range = displayRangeToFull(
      data.params.range,
      display,
      binding,
    );
  }
}

function mapDiagnostic(
  diag: any,
  display: string,
  binding: CutBinding,
): any | null {
  if (!diag?.range) return null;
  const range = fullRangeToDisplay(diag.range, display, binding);
  if (!range) return null;
  return { ...diag, range };
}

function mapLocation(
  loc: any,
  display: string,
  binding: CutBinding,
): any | null {
  if (!loc?.range) return loc;
  const range = fullRangeToDisplay(loc.range, display, binding);
  if (!range) return null;
  return { ...loc, range };
}

function mapTextEdit(
  edit: any,
  display: string,
  binding: CutBinding,
): any | null {
  if (!edit?.range) return edit;
  const range = fullRangeToDisplay(edit.range, display, binding);
  if (!range) return null;
  return { ...edit, range };
}

/** Rewrite server → client messages. */
function rewriteIncoming(data: any, display: string, binding: CutBinding): void {
  if (data.method === "textDocument/publishDiagnostics" && data.params) {
    const diags = Array.isArray(data.params.diagnostics)
      ? data.params.diagnostics
      : [];
    data.params.diagnostics = diags
      .map((d: any) => mapDiagnostic(d, display, binding))
      .filter(Boolean);
    return;
  }

  // JSON-RPC responses
  if (data.result == null) return;
  const r = data.result;

  // Hover
  if (typeof r === "object" && r !== null && "contents" in r) {
    if (r.range) {
      const range = fullRangeToDisplay(r.range, display, binding);
      if (range) r.range = range;
      else delete r.range;
    }
    return;
  }

  // Location | Location[] | LocationLink[]
  if (Array.isArray(r)) {
    data.result = r
      .map((item: any) => {
        if (item?.targetRange) {
          // LocationLink
          const targetRange = fullRangeToDisplay(
            item.targetRange,
            display,
            binding,
          );
          const targetSelectionRange = item.targetSelectionRange
            ? fullRangeToDisplay(item.targetSelectionRange, display, binding)
            : null;
          if (!targetRange) return null;
          return {
            ...item,
            targetRange,
            targetSelectionRange: targetSelectionRange ?? targetRange,
          };
        }
        return mapLocation(item, display, binding);
      })
      .filter(Boolean);
    return;
  }

  if (r?.uri && r?.range) {
    const mapped = mapLocation(r, display, binding);
    data.result = mapped;
    return;
  }

  // CompletionList | CompletionItem[]
  if (Array.isArray(r?.items) || (Array.isArray(r) && r[0]?.label != null)) {
    const items = Array.isArray(r?.items) ? r.items : r;
    const mapItem = (item: any) => {
      if (item?.textEdit) {
        const te = mapTextEdit(item.textEdit, display, binding);
        if (te) item = { ...item, textEdit: te };
        else {
          const { textEdit: _drop, ...rest } = item;
          item = rest;
        }
      }
      if (Array.isArray(item?.additionalTextEdits)) {
        item = {
          ...item,
          additionalTextEdits: item.additionalTextEdits
            .map((e: any) => mapTextEdit(e, display, binding))
            .filter(Boolean),
        };
      }
      return item;
    };
    if (Array.isArray(r?.items)) {
      r.items = r.items.map(mapItem);
    } else {
      data.result = r.map(mapItem);
    }
  }
}

/**
 * Wrap a transport so ZLS sees the full stitched program while the
 * editor / CM LSP client keep talking in display-slice coordinates.
 */
export function wrapTransportForCuts(inner: Transport): Transport {
  const handlers: ((value: string) => void)[] = [];

  const onInner = (value: string) => {
    let out = value;
    try {
      const binding = cutLspBridge.binding;
      if (binding?.visible) {
        const data = JSON.parse(value);
        rewriteIncoming(data, cutLspBridge.getDisplay(), binding);
        out = JSON.stringify(data);
      }
    } catch {
      // Pass through on parse/map failure.
    }
    for (const h of handlers) h(out);
  };

  inner.subscribe(onInner);

  return {
    send(message: string) {
      try {
        const binding = cutLspBridge.binding;
        if (binding?.visible) {
          const data = JSON.parse(message);
          rewriteOutgoing(data, cutLspBridge.getDisplay(), binding);
          inner.send(JSON.stringify(data));
          return;
        }
      } catch {
        // fall through
      }
      inner.send(message);
    },
    subscribe(handler: (value: string) => void) {
      handlers.push(handler);
    },
    unsubscribe(handler: (value: string) => void) {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    },
  };
}
