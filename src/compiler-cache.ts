/**
 * Client-side compiler asset cache (per version id that is actually fetched).
 *
 * Hashed filenames (`zig.<hash>.wasm`) make the URL the content address, so
 * Cache Storage can key by the real URL: a hit is always the right bytes.
 * `meta.json` is fetched `cache: no-store` (it must reflect new hashes).
 * Non-compiler URLs pass straight through to network fetch.
 */

import { compilerIdFromAssetUrl } from "./version";

const CACHE_NAME = "zp-compilers-v1";

function absoluteUrl(href: string): string {
  try {
    return new URL(href, self.location.origin).href;
  } catch {
    return href;
  }
}

function isMetaUrl(href: string): boolean {
  return /\/meta\.json(?:\?|$)/.test(href);
}

/**
 * Fetch a `/compilers/<id>/…` asset, caching by real URL for offline reuse.
 * `meta.json` always goes to network (no-store) so new hashes are visible.
 */
export async function fetchCompilerResponse(url: URL | string): Promise<Response> {
  const href = typeof url === "string" ? url : url.href;
  const versionId = compilerIdFromAssetUrl(href);

  if (!versionId || isMetaUrl(href)) {
    return fetch(href, versionId && isMetaUrl(href) ? { cache: "no-store" } : undefined);
  }

  if (typeof caches === "undefined") {
    return fetch(href);
  }

  const abs = absoluteUrl(href);
  const cache = await caches.open(CACHE_NAME);

  const hit = await cache.match(abs);
  if (hit) return hit;

  const res = await fetch(href);
  if (!res.ok) return res;

  const buf = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  if (!headers.has("content-type")) {
    if (href.endsWith(".wasm")) headers.set("content-type", "application/wasm");
    else if (href.endsWith(".json")) headers.set("content-type", "application/json");
  }

  const stored = new Response(buf.slice(0), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
  const forCaller = new Response(buf, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });

  try {
    await cache.put(abs, stored);
  } catch {
    /* quota / private mode — ignore */
  }

  return forCaller;
}
