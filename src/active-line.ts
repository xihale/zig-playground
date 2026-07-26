/**
 * Active-line chrome only while every selection is empty (plain carets).
 * With a non-empty selection the line wash stacks under the translucent
 * selection color and makes the head line look brighter — suppress it so
 * selected lines read as one uniform band.
 *
 * The first line also gets a pad-top class so the wash extends into
 * `.cm-content` documentPadding (box-shadow), matching the full-line
 * selection layer.
 */
import { RangeSet } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutterLineClass,
  type ViewUpdate,
} from "@codemirror/view";

const lineDeco = Decoration.line({ class: "cm-activeLine" });
const lineDecoFirst = Decoration.line({
  class: "cm-activeLine cm-activeLine-pad-top",
});

function makeGutterMarker(extra: string) {
  return new (class extends GutterMarker {
    elementClass = "cm-activeLineGutter" + extra;
  })();
}

const gutterPlain = makeGutterMarker("");
const gutterTop = makeGutterMarker(" cm-activeLineGutter-pad-top");

export function highlightActiveLineEmptyOnly() {
  return ViewPlugin.fromClass(
    class {
      decorations: Decoration;
      constructor(view: EditorView) {
        this.decorations = this.getDeco(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = this.getDeco(update.view);
        }
      }
      getDeco(view: EditorView) {
        if (view.state.selection.ranges.some((r) => !r.empty)) {
          return Decoration.none;
        }
        let lastLineStart = -1;
        const deco = [];
        for (const r of view.state.selection.ranges) {
          const line = view.lineBlockAt(r.head);
          if (line.from > lastLineStart) {
            const decoLine = line.from === 0 ? lineDecoFirst : lineDeco;
            deco.push(decoLine.range(line.from));
            lastLineStart = line.from;
          }
        }
        return Decoration.set(deco);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export function highlightActiveLineGutterEmptyOnly() {
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
        const marker = linePos === 0 ? gutterTop : gutterPlain;
        marks.push(marker.range(linePos));
      }
    }
    return RangeSet.of(marks);
  });
}
