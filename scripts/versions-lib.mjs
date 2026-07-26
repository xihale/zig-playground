/**
 * Shared helpers for versions.json (build orchestration + tooling).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function loadVersionsManifest(path = join(root, "versions.json")) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!data?.default || !Array.isArray(data.versions) || data.versions.length === 0) {
    throw new Error("versions.json: missing default/versions");
  }
  const ids = new Set();
  for (const v of data.versions) {
    if (!v.id) throw new Error("versions.json: entry missing id");
    if (ids.has(v.id)) throw new Error(`versions.json: duplicate id ${v.id}`);
    ids.add(v.id);
    // playground builds need zls package coords; in-tree may use zlsFallbackId only.
    const mode = v.build || "playground";
    if (mode === "playground" && (!v.zls?.url || !v.zls?.hash)) {
      throw new Error(`versions.json: ${v.id} missing zls.url / zls.hash`);
    }
    if (!v.zig?.path && !v.zig?.git?.repo) {
      throw new Error(`versions.json: ${v.id} needs zig.path and/or zig.git`);
    }
  }
  if (!ids.has(data.default)) {
    throw new Error(`versions.json: default "${data.default}" not in versions`);
  }
  return data;
}

/**
 * @param {object} manifest
 * @param {{ select?: 'all'|'stable'|'scheduled', only?: string[] }} opts
 */
export function selectVersions(manifest, opts = {}) {
  const only = opts.only?.length ? new Set(opts.only) : null;
  const select = opts.select || "all";

  let list = manifest.versions;
  if (only) {
    list = list.filter((v) => only.has(v.id));
    for (const id of only) {
      if (!list.some((v) => v.id === id)) {
        throw new Error(`unknown version id: ${id}`);
      }
    }
  } else if (select === "stable") {
    // No schedule field → pin / release builds (rebuild on push).
    list = list.filter((v) => !v.schedule);
  } else if (select === "scheduled") {
    // e.g. master with schedule: "3d"
    list = list.filter((v) => !!v.schedule);
  } else if (select === "all") {
    // keep all
  } else {
    throw new Error(`unknown select mode: ${select}`);
  }

  return list;
}

export function resolveLocalZigPath(entry) {
  if (!entry.zig?.path) return null;
  const p = resolve(root, entry.zig.path);
  return existsSync(p) ? p : null;
}
