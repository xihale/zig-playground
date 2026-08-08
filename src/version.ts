/**
 * Multi-version compiler routing.
 *
 * Path rules (see docs/superpowers/specs/2026-07-26-multi-version-compilers-design.md):
 *   /              → versions.default (currently 0.16.0)
 *   /0.16.0/       → id "0.16.0"
 *   /0.15.2/       → id "0.15.2"
 *   /master/       → id "master"
 *
 * Compiler binaries live at /compilers/<id>/… (never git).
 */

import manifestJson from "../versions.json";
import {
  compilerAssetBase as coreAssetBase,
  compilerAssetUrl as coreAssetUrl,
  compilerAssetUrlHashed as coreAssetUrlHashed,
  compilerIdFromAssetUrl as coreIdFromAssetUrl,
  compilerMeta as coreMeta,
  type CompilerMeta,
  type CompilerMetaFile,
} from "./compiler-core";

export type VersionEntry = {
  id: string;
  label: string;
  schedule?: string;
};

export type VersionsManifest = {
  default: string;
  versions: VersionEntry[];
};

export type { CompilerMeta, CompilerMetaFile };

export type ResolvedVersion = {
  id: string;
  entry: VersionEntry;
  /** True when URL had no version segment and we used `default`. */
  fromDefault: boolean;
  manifest: VersionsManifest;
};

function validateManifest(data: VersionsManifest): VersionsManifest {
  if (!data?.default || !Array.isArray(data.versions) || data.versions.length === 0) {
    throw new Error("versions.json: missing default/versions");
  }
  const ids = new Set(data.versions.map((v) => v.id));
  if (!ids.has(data.default)) {
    throw new Error(`versions.json: default "${data.default}" not in versions`);
  }
  return data;
}

const bundledManifest = validateManifest(manifestJson as VersionsManifest);

/** Sync access to the shipped manifest (bundled at build time). */
export function loadVersionsManifest(): VersionsManifest {
  return bundledManifest;
}

/** Strip Vite deploy base (usually `/`; subpath only if VITE_BASE is set) so the first remaining segment can be a version id. */
function pathAfterBase(pathname: string): string {
  const base = import.meta.env.BASE_URL || "/";
  if (base === "/") return pathname;
  const prefix = base.replace(/\/$/, "");
  if (pathname === prefix || pathname.startsWith(prefix + "/")) {
    const rest = pathname.slice(prefix.length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return pathname;
}

/** First non-empty path segment after the deploy base. */
export function pathVersionSegment(pathname: string = location.pathname): string | null {
  const parts = pathAfterBase(pathname).split("/").filter(Boolean);
  return parts[0] ?? null;
}

export function resolveVersion(
  manifest: VersionsManifest,
  pathname: string = location.pathname,
): ResolvedVersion {
  const segment = pathVersionSegment(pathname);
  const byId = new Map(manifest.versions.map((v) => [v.id, v]));

  if (segment && byId.has(segment)) {
    const entry = byId.get(segment)!;
    return { id: entry.id, entry, fromDefault: false, manifest };
  }

  const entry = byId.get(manifest.default)!;
  return { id: entry.id, entry, fromDefault: true, manifest };
}

/** Canonical path for a version id (respects Vite `base` / project Pages). */
export function pathForVersion(id: string, manifest: VersionsManifest): string {
  const base = import.meta.env.BASE_URL || "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  if (id === manifest.default) return root;
  return `${root}${id}/`;
}

/**
 * The app serves compiler assets from its own deploy base (Vite `BASE_URL`,
 * usually `/`). The loader (`src/loader.ts`) passes its own origin instead.
 * This indirection is the only thing keeping `compiler-core.ts` reusable.
 */
function appOrigin(): string {
  return import.meta.env.BASE_URL || "/";
}

/** Absolute URL prefix for compiler assets of a version. */
export function compilerAssetBase(versionId: string): string {
  return coreAssetBase(appOrigin(), versionId);
}

export function compilerAssetUrl(versionId: string, file: string): string {
  return coreAssetUrl(appOrigin(), versionId, file);
}

/** Fetch (once per id per session) and return the logical→physical file map. */
export async function compilerMeta(versionId: string): Promise<CompilerMeta | null> {
  return coreMeta(appOrigin(), versionId);
}

/**
 * Resolve a logical compiler asset name (e.g. "zig.wasm") to its hashed URL.
 * Falls back to the logical URL if meta.json is missing (e.g. legacy deploy).
 */
export async function compilerAssetUrlHashed(
  versionId: string,
  logicalName: string,
): Promise<string> {
  return coreAssetUrlHashed(appOrigin(), versionId, logicalName);
}

/** Extract version id from `/compilers/<id>/…` (absolute or site-relative). */
export function compilerIdFromAssetUrl(href: string): string | null {
  return coreIdFromAssetUrl(href);
}
