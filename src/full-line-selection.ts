/**
 * CodeMirror's default selection layer sizes rects to text metrics, so with
 * line-height > 1 the line box half-leading is left unpainted — a visible gap
 * at the top/bottom of a selected line.
 *
 * Strategy:
 *  1. Expand short (single-line) rects to the full line block.
 *  2. On the first doc line, also cover documentPadding.top so the wash
 *     meets the editor chrome.
 *  3. Shrink tall multi-line "bridge" rects so they do not overlap those
 *     expanded ends. Overlap with a translucent selection color double-paints
 *     and shows up as a bright horizontal band between lines.
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

                    const pieces = RectangleMarker.forRange(
                        view,
                        "cm-selectionBackground",
                        range,
                    ).filter((p) => p.width !== 0);

                    const expandedShort: RectangleMarker[] = [];
                    const tall: RectangleMarker[] = [];

                    for (const piece of pieces) {
                        if (piece.height > lineH) {
                            tall.push(piece);
                            continue;
                        }

                        const midDocY = piece.top + piece.height / 2 - padTop;
                        const block = view.lineBlockAtHeight(Math.max(0, midDocY));
                        // Cover documentPadding above the first line so
                        // selection wash matches the content inset (active line
                        // does the same via box-shadow pad-top class).
                        let top = block.top + padTop;
                        let height = block.height;
                        if (block.from === 0) {
                            top = 0;
                            height += padTop;
                        }
                        expandedShort.push(
                            new RectangleMarker(
                                "cm-selectionBackground",
                                piece.left,
                                top,
                                piece.width,
                                height,
                            ),
                        );
                    }

                    // Bridge rects already cover middle line boxes; clip them
                    // away from the (now full-height) first/last line pieces so
                    // alpha does not stack into a bright seam.
                    for (const piece of tall) {
                        let top = piece.top;
                        let bot = piece.top + piece.height;
                        for (const s of expandedShort) {
                            const sBot = s.top + s.height;
                            // Short piece above this bridge → start below it.
                            if (s.top <= top + 0.5 && sBot > top) top = sBot;
                            // Short piece below this bridge → end above it.
                            if (sBot >= bot - 0.5 && s.top < bot) bot = s.top;
                        }
                        if (bot - top > 0.5) {
                            out.push(
                                new RectangleMarker(
                                    "cm-selectionBackground",
                                    piece.left,
                                    top,
                                    piece.width,
                                    bot - top,
                                ),
                            );
                        }
                    }

                    out.push(...expandedShort);
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
