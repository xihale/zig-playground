/**
 * zp-loader — the served compiler SDK.
 *
 * Import from another site to download Zig compiler assets from this playground
 * without re-implementing the hashed-filename / meta.json / Cache-Storage logic:
 *
 *   import {
 *     fetchCompilerFile,
 *     compileCompilerWasm,
 *     getZigLibDir,
 *     listVersions,
 *   } from "https://zp.xihale.top/zp-loader.js";
 *
 * Logical names (always pass these — the loader resolves content-hash filenames
 * from each version's meta.json):
 *   - "zig.wasm"           the compiler
 *   - "zls.wasm"           the language server
 *   - "libcompiler_rt.a"   compiler-rt archive
 *   - "zig.tar.gz"         the standard-library tree
 *
 * Works in Web Workers (Cache Storage is shared per-origin). Cross-origin fetch
 * is permitted (the host serves permissive CORS). Self-host by calling
 * `configure({ origin: "https://your.host" })` before any other call.
 *
 * See README "Consume the compilers from another site" for full examples.
 */

import {
  compilerMeta as coreMeta,
  type CompilerMeta,
  type CompilerOrigin,
} from "./compiler-core";
import { fetchCompilerResponse } from "./compiler-cache";
import {
  fetchCompilerFile as fetchCompilerFileFor,
  compileCompilerWasm as compileCompilerWasmFor,
  getZigArchiveFor,
} from "./utils";

export type { CompilerMeta };

/** Slimmed versions manifest exposed to consumers (build details are internal). */
export type LoaderVersionEntry = { id: string; label: string };
export type LoaderVersions = {
  default: string;
  versions: LoaderVersionEntry[];
};

/**
 * Origin serving `/compilers/<id>/…` and `/versions.json`.
 *
 * Defaults to this module's own origin, so when served from
 * `https://zp.xihale.top/zp-loader.js` it self-resolves to
 * `https://zp.xihale.top/compilers/<id>/…`. Override with `configure()`.
 */
let configuredOrigin: CompilerOrigin = (() => {
  try {
    return new URL(import.meta.url).origin;
  } catch {
    return "/";
  }
})();

export type LoaderOptions = { origin?: CompilerOrigin };

/** Override the asset origin (for self-hosting). Call once before other calls. */
export function configure(opts: LoaderOptions): void {
  if (opts.origin != null) configuredOrigin = opts.origin;
}

/** Current asset origin (the loader's own origin unless reconfigured). */
export function origin(): CompilerOrigin {
  return configuredOrigin;
}

/** Fetch a logical compiler file as bytes (hash resolved from meta.json). */
export async function fetchCompilerFile(
  versionId: string,
  logicalName: string,
): Promise<ArrayBuffer> {
  return fetchCompilerFileFor(configuredOrigin, versionId, logicalName);
}

/** Compile a logical `.wasm` compiler asset (hash resolved from meta.json). */
export async function compileCompilerWasm(
  versionId: string,
  logicalName: string,
): Promise<WebAssembly.Module> {
  return compileCompilerWasmFor(configuredOrigin, versionId, logicalName);
}

/**
 * Load the std-lib tarball (`zig.tar.gz`) as a WASI directory tree.
 * Re-untars each call; consumers usually cache the result per version id.
 */
export async function getZigLibDir(versionId: string) {
  return getZigArchiveFor(configuredOrigin, versionId);
}

/** Fetch (once per id per session) the logical→physical file map for a version. */
export async function metaJson(versionId: string): Promise<CompilerMeta | null> {
  return coreMeta(configuredOrigin, versionId);
}

/**
 * Fetch the published version list (`versions.json`, `cache: "no-store"`).
 * Build internals (git refs, patches) are stripped from the return type.
 */
export async function listVersions(): Promise<LoaderVersions> {
  const root = configuredOrigin.includes("://")
    ? `${new URL(configuredOrigin).origin}/`
    : configuredOrigin.endsWith("/")
      ? configuredOrigin
      : `${configuredOrigin}/`;
  const res = await fetch(`${root}versions.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch versions.json: HTTP ${res.status}`);
  const data = (await res.json()) as {
    default: string;
    versions: { id: string; label: string }[];
  };
  return {
    default: data.default,
    versions: (data.versions ?? []).map((v) => ({ id: v.id, label: v.label })),
  };
}

/**
 * Low-level escape hatch: fetch any `/compilers/<id>/…` URL through the loader's
 * Cache-Storage layer (used when a consumer already knows the hashed URL, or for
 * `meta.json` which must always revalidate).
 */
export async function fetchRaw(url: URL | string): Promise<Response> {
  return fetchCompilerResponse(url);
}
