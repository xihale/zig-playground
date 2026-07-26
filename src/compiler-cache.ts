/**
 * Client-side compiler asset cache (per version id that is actually fetched).
 *
 * GitHub Pages hardcodes `Cache-Control: max-age=600`, so multi-MB wasm/tar
 * would re-download every 10 minutes without this layer.
 *
 * Path-lazy: only the active route's id is fetched (`/` → default, `/0.15.2/`,
 * `/master/`). Other version trees are never requested until the user navigates.
 *
 * Revision tracking (only for the active fetch):
 *   1. Remember `meta.builtAt` in Cache Storage with a probe timestamp.
 *   2. Re-fetch meta when the probe is older than half a rebuild cycle
 *      (master `schedule: "3d"` → ~1.5d). Stable pins re-probe rarely (1y).
 *   3. Large assets are keyed by builtAt; a new stamp → download, old revs dropped.
 */

import {
  compilerAssetUrl,
  compilerIdFromAssetUrl,
  metaRevalidateSeconds,
} from "./version";

const CACHE_NAME = "zp-compilers-v1";
const META_PROBE_PREFIX = "zp-meta-probe:";

type MetaProbe = {
  builtAt: string;
  probedAt: number;
};

/** In-memory memo for concurrent fetches in one worker boot. */
const revisionMemo = new Map<string, Promise<string | null>>();

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

function probeRequestUrl(versionId: string): string {
  // Synthetic key — not a real network path.
  return `${META_PROBE_PREFIX}${encodeURIComponent(versionId)}`;
}

async function readProbe(cache: Cache, versionId: string): Promise<MetaProbe | null> {
  try {
    const res = await cache.match(probeRequestUrl(versionId));
    if (!res) return null;
    const data = (await res.json()) as Partial<MetaProbe>;
    if (
      typeof data.builtAt !== "string" ||
      !data.builtAt ||
      typeof data.probedAt !== "number"
    ) {
      return null;
    }
    return { builtAt: data.builtAt, probedAt: data.probedAt };
  } catch {
    return null;
  }
}

async function writeProbe(cache: Cache, versionId: string, probe: MetaProbe): Promise<void> {
  const body = JSON.stringify(probe);
  await cache.put(
    probeRequestUrl(versionId),
    new Response(body, {
      headers: { "content-type": "application/json" },
    }),
  );
}

async function fetchBuiltAt(versionId: string): Promise<string | null> {
  try {
    const res = await fetch(compilerAssetUrl(versionId, "meta.json"), {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const meta = (await res.json()) as { builtAt?: unknown };
    return typeof meta.builtAt === "string" && meta.builtAt.length > 0
      ? meta.builtAt
      : null;
  } catch {
    return null;
  }
}

/**
 * Build stamp for a compiler tree. Reuses a cached probe until half the
 * version's rebuild cycle has elapsed; then re-hits meta.json.
 */
async function revisionFor(versionId: string): Promise<string | null> {
  let pending = revisionMemo.get(versionId);
  if (!pending) {
    pending = (async () => {
      if (typeof caches === "undefined") {
        return fetchBuiltAt(versionId);
      }

      const cache = await caches.open(CACHE_NAME);
      const maxAgeMs = metaRevalidateSeconds(versionId) * 1000;
      const cached = await readProbe(cache, versionId);
      if (cached && Date.now() - cached.probedAt < maxAgeMs) {
        return cached.builtAt;
      }

      const builtAt = await fetchBuiltAt(versionId);
      if (builtAt) {
        try {
          await writeProbe(cache, versionId, { builtAt, probedAt: Date.now() });
        } catch {
          /* quota — still return the stamp for this session */
        }
        return builtAt;
      }

      // Network failed: keep serving the last known stamp if any.
      return cached?.builtAt ?? null;
    })();
    revisionMemo.set(versionId, pending);
  }
  return pending;
}

function cacheKey(assetAbsUrl: string, rev: string): string {
  const u = new URL(assetAbsUrl);
  u.searchParams.set("rev", rev);
  return u.href;
}

/** Drop older revs of the same asset so quota does not grow forever on master. */
async function dropStaleRevs(cache: Cache, assetAbsUrl: string, keepKey: string) {
  try {
    const au = new URL(assetAbsUrl);
    const keys = await cache.keys();
    for (const req of keys) {
      if (req.url === keepKey) continue;
      try {
        const ru = new URL(req.url);
        if (
          ru.origin === au.origin &&
          ru.pathname === au.pathname &&
          ru.searchParams.has("rev")
        ) {
          await cache.delete(req);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Fetch a `/compilers/<id>/…` asset, keyed by meta.builtAt (probed on a schedule).
 * Non-compiler URLs pass through to network fetch.
 */
export async function fetchCompilerResponse(url: URL | string): Promise<Response> {
  const href = typeof url === "string" ? url : url.href;
  const versionId = compilerIdFromAssetUrl(href);

  // Direct meta requests still go to network; revision logic is separate.
  if (!versionId || isMetaUrl(href)) {
    return fetch(href, versionId && isMetaUrl(href) ? { cache: "no-store" } : undefined);
  }

  if (typeof caches === "undefined") {
    return fetch(href);
  }

  const abs = absoluteUrl(href);
  const rev = await revisionFor(versionId);
  if (!rev) {
    return fetch(href);
  }

  const key = cacheKey(abs, rev);
  const cache = await caches.open(CACHE_NAME);

  const hit = await cache.match(key);
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
    await cache.put(key, stored);
    await dropStaleRevs(cache, abs, key);
  } catch {
    /* quota / private mode — ignore */
  }

  return forCaller;
}
