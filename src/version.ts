/**
 * Multi-version compiler routing.
 *
 * Path rules (see docs/superpowers/specs/2026-07-26-multi-version-compilers-design.md):
 *   /              → versions.default
 *   /master/       → id "master"
 *   /0.15.2/       → id "0.15.2"
 *
 * Compiler binaries live at /compilers/<id>/… (never git).
 */

import manifestJson from "../versions.json";

export type VersionEntry = {
  id: string;
  label: string;
  schedule?: string;
};

export type VersionsManifest = {
  default: string;
  versions: VersionEntry[];
};

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

/** First non-empty path segment, ignoring a leading base (empty for root deploy). */
export function pathVersionSegment(pathname: string = location.pathname): string | null {
  const parts = pathname.split("/").filter(Boolean);
  // GitHub project pages would be /repo/... — we deploy to user/org root or custom domain.
  // Only treat a segment as a version if it matches a known id (caller checks).
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

/** Canonical path for a version id (`/` for default, `/id/` otherwise). */
export function pathForVersion(id: string, manifest: VersionsManifest): string {
  if (id === manifest.default) return "/";
  return `/${id}/`;
}

/** Absolute URL prefix for compiler assets of a version. */
export function compilerAssetBase(versionId: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}compilers/${versionId}/`;
}

export function compilerAssetUrl(versionId: string, file: string): string {
  return `${compilerAssetBase(versionId)}${file}`;
}
