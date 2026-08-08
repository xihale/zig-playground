/**
 * Origin-parameterized compiler-asset core — the single source of truth for the
 * "version id → hashed filenames → fetch with cache" contract.
 *
 * Consumed by:
 *   - src/version.ts     (the app; passes `import.meta.env.BASE_URL` as origin)
 *   - src/loader.ts      (the served SDK; passes its own origin, overridable)
 *
 * Nothing here imports Vite (`import.meta.env`) or the bundled `versions.json`,
 * so the core is safe to bundle into the standalone loader.
 */

export type CompilerMetaFile = { size: number; sha256: string; name: string };
export type CompilerMeta = {
  id: string;
  builtAt: string;
  files: Record<string, CompilerMetaFile>;
};

/**
 * Origin for compiler assets. Either an absolute origin like
 * `"https://zp.xihale.top"` (cross-site consumer / the loader's self-origin) or
 * a site-relative base like `"/"` (the app). Trailing slash optional.
 */
export type CompilerOrigin = string;

/** Normalize an origin to a root ending in `/`. */
function rootOf(origin: CompilerOrigin): string {
  if (origin.includes("://")) {
    // Absolute: keep scheme://host, ensure trailing `/`.
    const u = new URL(origin);
    return u.origin + "/";
  }
  return origin.endsWith("/") ? origin : `${origin}/`;
}

/** Absolute URL prefix for compiler assets of a version under `origin`. */
export function compilerAssetBase(
  origin: CompilerOrigin,
  versionId: string,
): string {
  return `${rootOf(origin)}compilers/${versionId}/`;
}

/** Full URL for a (physical or logical) compiler file under `origin`. */
export function compilerAssetUrl(
  origin: CompilerOrigin,
  versionId: string,
  file: string,
): string {
  return `${compilerAssetBase(origin, versionId)}${file}`;
}

/** Extract version id from `/compilers/<id>/…` (absolute or site-relative). */
export function compilerIdFromAssetUrl(href: string): string | null {
  try {
    const path = href.includes("://")
      ? new URL(href).pathname
      : href.split("?")[0] ?? href;
    const m = path.match(/\/compilers\/([^/]+)\//);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

const metaMemo = new Map<string, Promise<CompilerMeta | null>>();

/**
 * Fetch (once per origin+id per session) and return the logical→physical file
 * map. `meta.json` is the one fixed-name file and is always revalidated
 * (`cache: "no-store"`) so new hashes are visible.
 */
export async function compilerMeta(
  origin: CompilerOrigin,
  versionId: string,
): Promise<CompilerMeta | null> {
  const key = `${origin}|${versionId}`;
  let p = metaMemo.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(compilerAssetUrl(origin, versionId, "meta.json"), {
          cache: "no-store",
        });
        if (!res.ok) return null;
        const data = (await res.json()) as Partial<CompilerMeta>;
        if (!data?.files || typeof data.files !== "object") return null;
        return data as CompilerMeta;
      } catch {
        return null;
      }
    })();
    metaMemo.set(key, p);
  }
  return p;
}

/**
 * Resolve a logical compiler asset name (e.g. "zig.wasm") to its hashed URL.
 * Falls back to the logical URL if meta.json is missing (e.g. legacy deploy).
 */
export async function compilerAssetUrlHashed(
  origin: CompilerOrigin,
  versionId: string,
  logicalName: string,
): Promise<string> {
  const meta = await compilerMeta(origin, versionId);
  const entry = meta?.files?.[logicalName];
  if (!entry?.name) return compilerAssetUrl(origin, versionId, logicalName);
  return compilerAssetUrl(origin, versionId, entry.name);
}
