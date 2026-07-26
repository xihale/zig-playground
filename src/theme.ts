import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// Editor chrome (background, gutters, active line, cursor, selection,
// matching brackets, scrollbars, tooltip theming, autocomplete width
// and empty-state hiding) lives in style/style.css so the same
// variable-driven rules cover both light/dark states. This theme only
// keeps the few cosmetics that CodeMirror scopes tightly and that we
// don't want to fight with !important over.
export const editorTheme = EditorView.theme({
  // CM base sets lineHeight: 1.4 on .cm-scroller — that wins over plain
  // CSS, so row height must be set here (token from style.css).
  ".cm-scroller": {
    fontFamily: "var(--editor-font-mono)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "var(--editor-line-height)",
  },
  // Override CM base (padding: 4px 0). Must live in the CM theme so
  // documentPadding / gutter positioning stay in sync with content.
  ".cm-content": {
    padding: "var(--editor-code-padding-y) 0 0",
    lineHeight: "var(--editor-line-height)",
  },
  ".cm-line": {
    lineHeight: "var(--editor-line-height)",
    // Beat CM base theme (0 2px 0 6px) so horizontal padding stays in design tokens.
    padding: "0 var(--editor-code-padding-x)",
  },
  ".cm-gutters": {
    fontFamily: "var(--editor-font-mono)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "var(--editor-line-height)",
  },
  // Same metrics as .cm-line so number glyphs share the line box.
  // Avoid display:flex here — it can desync gutter height from content lines.
  ".cm-lineNumbers .cm-gutterElement": {
    fontFamily: "var(--editor-font-mono)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "var(--editor-line-height)",
    textAlign: "right",
  },
  ".cm-completionIcon": { display: "none" },
  ".cm-completionLabel": {
    fontFamily: "var(--editor-font-mono)",
    flex: "1 1 auto",
    minWidth: "0",
    color: "var(--ink)",
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    color: "var(--autocomplete-match)",
  },
  // Type/detail is secondary; keep it short so the label leads.
  ".cm-completionDetail": {
    flex: "0 1 9em",
    maxWidth: "9em",
    fontSize: "0.8em",
    opacity: "0.55",
    fontStyle: "normal",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // Fixed-width fold gutter (open ⌄ vs closed › differ in advance).
  ".cm-foldGutter": {
    width: "1.25em",
    minWidth: "1.25em",
  },
  ".cm-foldGutter .cm-gutterElement": {
    width: "1.25em",
    minWidth: "1.25em",
    textAlign: "center",
    padding: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: "var(--editor-line-height)",
  },
  // Dark-canvas fold placeholder (default is #eee/#ddd light theme).
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--canvas-soft)",
    border: "1px solid var(--hairline)",
    color: "var(--body-mid)",
    borderRadius: "2px",
    margin: "0 2px",
    padding: "0 4px",
    cursor: "pointer",
    fontFamily: "var(--editor-font-mono)",
  },
});

// Lezer-tree fallback used before ZLS semantic tokens arrive. Class
// names match the ZLS semantic-token classes (st-*) so the colors in
// zig-theme.css apply to both layers uniformly.
export const highlightStyle = HighlightStyle.define([
  { tag: tags.definitionKeyword, class: "st-keyword" },
  { tag: tags.modifier, class: "st-modifier" },
  { tag: tags.controlKeyword, class: "st-keyword" },
  { tag: tags.keyword, class: "st-builtin" },
  { tag: tags.labelName, class: "st-label" },
  { tag: tags.function(tags.definition(tags.variableName)), class: "st-function" },
  { tag: tags.typeName, class: "st-type" },
  { tag: tags.lineComment, class: "st-comment" },
  { tag: tags.number, class: "st-number" },
  { tag: tags.string, class: "st-string" },
  { tag: tags.regexp, class: "st-regexp" },
  { tag: tags.operator, class: "st-operator" },
  { tag: tags.propertyName, class: "st-property" },
  { tag: tags.variableName, class: "st-variable" },
  { tag: tags.namespace, class: "st-namespace" },
]);

