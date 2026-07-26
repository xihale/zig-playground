import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// Chrome (colors, gutters, selection, autocomplete, fold) lives in
// style/style.css. This theme only sets metrics CodeMirror's base theme
// wins over plain CSS (lineHeight, documentPadding-linked content padding).
export const editorTheme = EditorView.theme({
  ".cm-scroller": {
    fontFamily: "var(--editor-font-mono)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "var(--editor-line-height)",
  },
  // documentPadding must track content padding — set here, not only in CSS.
  ".cm-content": {
    padding: "var(--editor-code-padding-y) 0 0",
    lineHeight: "var(--editor-line-height)",
  },
  ".cm-line": {
    lineHeight: "var(--editor-line-height)",
    padding: "0 var(--editor-code-padding-x)",
  },
  ".cm-gutters": {
    fontFamily: "var(--editor-font-mono)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "var(--editor-line-height)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    fontFamily: "var(--editor-font-mono)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "var(--editor-line-height)",
    textAlign: "right",
  },
});

// Lezer fallback before ZLS semantic tokens. Classes match st-* in zig-theme.css.
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
