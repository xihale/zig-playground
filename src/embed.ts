/**
 * Embed / share-link helpers for blog & doc iframes.
 *
 * URL shape (query and/or hash; hash wins on conflict for `code`/`b64`):
 *   ?embed=1&code=<uri-encoded source>
 *   ?embed=1&b64=<base64url utf-8 source>
 *   #embed=1&b64=...
 *
 * Prefer `b64` for multi-line snippets (no extra percent-encoding pain).
 *
 * Twoslash-style cuts (see `cut.ts`) can live in the source so the full
 * program is available to the compiler/LSP while embed UI only shows the
 * marked slice:
 *   // ---cut--- / // ---cut-before---
 *   // ---cut-after---
 *   // ---cut-start--- … // ---cut-end---
 */

export type EmbedConfig = {
  /** Minimal chrome: editor + output only. */
  embed: boolean;
  /** Source from the URL, or null if none was supplied. */
  code: string | null;
  /** When false, skip the initial auto-run (still editable). Default true. */
  autorun: boolean;
};

/** Merge `?query` and `#hash` params. Hash overrides query on same key. */
function readParams(): URLSearchParams {
  const params = new URLSearchParams(location.search);
  if (location.hash.length > 1) {
    const hash = location.hash.startsWith("#")
      ? location.hash.slice(1)
      : location.hash;
    // Support both `#embed=1&b64=...` and bare `#b64=...`.
    const hashParams = new URLSearchParams(hash);
    for (const [k, v] of hashParams) {
      params.set(k, v);
    }
  }
  return params;
}

function truthy(v: string | null): boolean {
  if (v === null) return false;
  const s = v.toLowerCase();
  return s === "" || s === "1" || s === "true" || s === "yes";
}

/** base64url → UTF-8 string. Returns null on failure. */
export function decodeBase64Url(b64: string): string | null {
  try {
    const padded = b64
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(b64.length / 4) * 4, "=");
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** UTF-8 string → base64url (no padding). Handy for building embed URLs. */
export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pageBase(base?: string): string {
  return base ?? `${location.origin}${location.pathname}`;
}

/** Full playground URL with source in the hash (opens normal UI). */
export function buildShareUrl(source: string, opts: { base?: string } = {}): string {
  const hash = new URLSearchParams();
  hash.set("b64", encodeBase64Url(source));
  return `${pageBase(opts.base)}#${hash.toString()}`;
}

/** Build an embed URL for the current origin (or a given base). */
export function buildEmbedUrl(
  source: string,
  opts: { base?: string; autorun?: boolean } = {},
): string {
  const params = new URLSearchParams();
  params.set("embed", "1");
  // Embed default is no auto-run; write the param either way so the link
  // is explicit and survives future default changes.
  if (opts.autorun === true) params.set("autorun", "1");
  // Put payload in the hash so long snippets never hit server logs / proxies.
  const hash = new URLSearchParams();
  hash.set("b64", encodeBase64Url(source));
  return `${pageBase(opts.base)}?${params.toString()}#${hash.toString()}`;
}

/** iframe snippet for blogs / docs. */
export function buildIframeSnippet(
  source: string,
  opts: { base?: string; height?: number; autorun?: boolean } = {},
): string {
  const src = buildEmbedUrl(source, {
    base: opts.base,
    autorun: opts.autorun,
  });
  const height = opts.height ?? 400;
  // Escape & for attribute safety (URL already encodes other chars).
  const safeSrc = src.replace(/&/g, "&amp;");
  return `<iframe src="${safeSrc}" width="100%" height="${height}" loading="lazy" style="border:0;border-radius:0"></iframe>`;
}

export function parseEmbedConfig(): EmbedConfig {
  const params = readParams();

  const embed =
    truthy(params.get("embed")) ||
    // bare `?embed` / `#embed` shows as empty string via has+get
    (params.has("embed") && params.get("embed") === "");

  let code: string | null = null;

  const b64 = params.get("b64");
  if (b64) {
    code = decodeBase64Url(b64);
  } else if (params.has("code")) {
    // URLSearchParams already percent-decodes.
    code = params.get("code");
  }

  const autorunParam = params.get("autorun");
  // Embed defaults to NO auto-run: show code, fetch nothing until the
  // user clicks Run. Full app defaults to auto-running the initial example.
  const autorun =
    autorunParam === null ? !embed : truthy(autorunParam);

  return { embed, code, autorun };
}
