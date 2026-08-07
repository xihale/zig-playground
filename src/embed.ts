/**
 * Embed / share-link helpers for blog & doc iframes.
 *
 * Preferred URL shape (everything in the hash — never hits server logs):
 *   #z/<base64url deflate-raw utf-8>
 *   #embed/z/<payload>
 *   #embed/autorun/z/<payload>
 *
 * Legacy (still read):
 *   ?embed=1&code=<uri-encoded>
 *   ?embed=1&b64=<base64url utf-8>
 *   #embed=1&b64=... / #b64=...
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

function truthy(v: string | null): boolean {
  if (v === null) return false;
  const s = v.toLowerCase();
  return s === "" || s === "1" || s === "true" || s === "yes";
}

/** Hash without leading `#`. */
function rawHash(): string {
  return location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
}

/**
 * Path-style hash: `z/…`, `embed/z/…`, `embed/autorun/z/…`.
 * Returns null when the hash is not this form (legacy key=value).
 */
function parseZHash(hash: string): {
  embed: boolean;
  /** Explicit autorun from path; null means "default for mode". */
  autorun: boolean | null;
  payload: string;
} | null {
  if (!hash) return null;
  // Reject legacy `key=value` hashes early (e.g. b64=…, embed=1&…).
  if (hash.includes("=") && !hash.startsWith("z/") && !hash.startsWith("embed/")) {
    return null;
  }
  const m = hash.match(/^(?:(embed)(?:\/(autorun))?\/)?z\/(.+)$/i);
  if (!m) return null;
  return {
    embed: !!m[1],
    autorun: m[2] ? true : m[1] ? false : null,
    payload: m[3]!,
  };
}

/** Merge `?query` and legacy `#key=value` params. Hash overrides query. */
function readLegacyParams(): URLSearchParams {
  const params = new URLSearchParams(location.search);
  const hash = rawHash();
  // Only parse as search params when it looks like key=value, not z/ paths.
  if (hash && hash.includes("=") && !parseZHash(hash)) {
    const hashParams = new URLSearchParams(hash);
    for (const [k, v] of hashParams) {
      params.set(k, v);
    }
  }
  return params;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64: string): Uint8Array | null {
  try {
    const padded = b64
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(b64.length / 4) * 4, "=");
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** base64url → UTF-8 string. Returns null on failure. */
export function decodeBase64Url(b64: string): string | null {
  const bytes = base64UrlToBytes(b64);
  if (!bytes) return null;
  return new TextDecoder().decode(bytes);
}

/** UTF-8 string → base64url (no padding). */
export function encodeBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Compress source → base64url(deflate-raw). */
export async function encodeZ(text: string): Promise<string> {
  const compressed = await deflateRaw(new TextEncoder().encode(text));
  return bytesToBase64Url(compressed);
}

/** base64url(deflate-raw) → source. Returns null on failure. */
export async function decodeZ(payload: string): Promise<string | null> {
  const bytes = base64UrlToBytes(payload);
  if (!bytes) return null;
  try {
    const inflated = await inflateRaw(bytes);
    return new TextDecoder().decode(inflated);
  } catch {
    return null;
  }
}

function pageBase(base?: string): string {
  return base ?? `${location.origin}${location.pathname}`;
}

/** Full playground URL with compressed source in the hash. */
export async function buildShareUrl(
  source: string,
  opts: { base?: string } = {},
): Promise<string> {
  const payload = await encodeZ(source);
  return `${pageBase(opts.base)}#z/${payload}`;
}

/** Embed URL — mode + payload entirely in the hash. */
export async function buildEmbedUrl(
  source: string,
  opts: { base?: string; autorun?: boolean } = {},
): Promise<string> {
  const payload = await encodeZ(source);
  const prefix = opts.autorun === true ? "embed/autorun/z/" : "embed/z/";
  return `${pageBase(opts.base)}#${prefix}${payload}`;
}

/** iframe snippet for blogs / docs. */
export async function buildIframeSnippet(
  source: string,
  opts: { base?: string; height?: number; autorun?: boolean } = {},
): Promise<string> {
  const src = await buildEmbedUrl(source, {
    base: opts.base,
    autorun: opts.autorun,
  });
  const height = opts.height ?? 800;
  // Path-style hash has no bare `&`; keep escape for safety / legacy callers.
  const safeSrc = src.replace(/&/g, "&amp;");
  // border:0 kills the default frame; outline:none kills the focus ring the
  // host browser draws on the <iframe> element itself (visible as a white
  // border after the iframe gains focus, esp. in Firefox/Safari).
  return `<iframe src="${safeSrc}" width="100%" height="${height}" loading="lazy" style="border:0;border-radius:0;outline:none"></iframe>`;
}

export async function parseEmbedConfig(): Promise<EmbedConfig> {
  const hash = rawHash();
  const zPath = parseZHash(hash);

  if (zPath) {
    const code = await decodeZ(zPath.payload);
    // Path may be only `#z/…` while legacy `?embed=1` still marks embed.
    const legacy = readLegacyParams();
    const embedFromQuery =
      truthy(legacy.get("embed")) ||
      (legacy.has("embed") && legacy.get("embed") === "");
    const embed = zPath.embed || embedFromQuery;
    const autorun =
      zPath.autorun !== null
        ? zPath.autorun
        : legacy.get("autorun") !== null
          ? truthy(legacy.get("autorun"))
          : !embed;
    return { embed, code, autorun };
  }

  const params = readLegacyParams();

  const embed =
    truthy(params.get("embed")) ||
    (params.has("embed") && params.get("embed") === "");

  let code: string | null = null;
  const b64 = params.get("b64");
  if (b64) {
    code = decodeBase64Url(b64);
  } else if (params.has("code")) {
    code = params.get("code");
  }

  const autorunParam = params.get("autorun");
  // Embed defaults to NO auto-run; full app defaults to auto-run.
  const autorun = autorunParam === null ? !embed : truthy(autorunParam);

  return { embed, code, autorun };
}
