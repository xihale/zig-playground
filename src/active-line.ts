/**
 * Active-line chrome only while every selection is empty (plain carets).
 * With a non-empty selection the wash stacks under translucent selection
 * and brightens the head line — suppress it so selected lines look uniform.
 *
 * Stock CodeMirror Decoration.line (no DOM mutation, no layers). Focus gating is
 * pure CSS via `.cm-focused` in style.css.
 */

import { RangeSet, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
  GutterMarker,
  gutterLineClass,
  EditorView,
} from "@codemirror/view";

const lineDeco = Decoration.line({ class: "cm-activeLine" });

function activeLineDeco(view: EditorView): DecorationSet {
  if (view.state.selection.ranges.some((r) => !r.empty)) {
    return Decoration.none;
  }
  let lastLineStart = -1;
  const deco = [];
  for (const r of view.state.selection.ranges) {
    const line = view.lineBlockAt(r.head);
    if (line.from > lastLineStart) {
      deco.push(lineDeco.range(line.from));
      lastLineStart = line.from;
    }
  }
  return deco.length ? Decoration.set(deco) : Decoration.none;
}

export function highlightActiveLineEmptyOnly(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = activeLineDeco(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = activeLineDeco(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

const activeLineGutterMarker = new (class extends GutterMarker {
  elementClass = "cm-activeLineGutter";
})();

export function highlightActiveLineGutterEmptyOnly(): Extension {
  return gutterLineClass.compute(["selection"], (state) => {
    if (state.selection.ranges.some((r) => !r.empty)) {
      return RangeSet.empty;
    }
    const marks = [];
    let last = -1;
    for (const range of state.selection.ranges) {
      const linePos = state.doc.lineAt(range.head).from;
      if (linePos > last) {
        last = linePos;
        marks.push(activeLineGutterMarker.range(linePos));
      }
    }
    return marks.length ? RangeSet.of(marks) : RangeSet.empty;
  });
}
