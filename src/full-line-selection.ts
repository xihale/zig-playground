/**
 * CodeMirror's default selection layer sizes rects to text metrics, so with
 * line-height > 1 the line box half-leading is left unpainted — a visible gap
 * at the top/bottom of a selected line. Expand single-line rects to the full
 * line block.
 *
 * Multi-line selections emit a tall "between" rect that already covers middle
 * lines (including half-leading). Those must be left alone: mapping them by
 * midpoint collapses them to one line and leaves every other row empty.
 */
import { EditorView, RectangleMarker, layer } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export function fullLineSelection(): Extension {
    return [
        layer({
            above: false,
            // Single token — classList.add rejects spaces.
            class: "cm-full-line-selection",
            update: (update) =>
                update.docChanged ||
                update.selectionSet ||
                update.viewportChanged ||
                update.geometryChanged,
            markers(view) {
                const padTop = view.documentPadding.top;
                const lineH = view.defaultLineHeight;
                const out: RectangleMarker[] = [];

                for (const range of view.state.selection.ranges) {
                    if (range.empty) continue;

                    for (const piece of RectangleMarker.forRange(
                        view,
                        "cm-selectionBackground",
                        range,
                    )) {
                        // Zero-width caret leftovers from range ends — drop them.
                        if (piece.width === 0) continue;

                        // Tall rects already bridge full line boxes between the
                        // first and last lines of a multi-line selection.
                        if (piece.height > lineH) {
                            out.push(piece);
                            continue;
                        }

                        const midDocY = piece.top + piece.height / 2 - padTop;
                        const block = view.lineBlockAtHeight(Math.max(0, midDocY));
                        out.push(
                            new RectangleMarker(
                                "cm-selectionBackground",
                                piece.left,
                                block.top + padTop,
                                piece.width,
                                block.height,
                            ),
                        );
                    }
                }
                return out;
            },
        }),
        // Hide the stock selection layer so we don't double-paint.
        EditorView.theme({
            ".cm-selectionLayer .cm-selectionBackground": {
                display: "none",
            },
            ".cm-full-line-selection .cm-selectionBackground": {
                display: "block",
            },
        }),
    ];
}
