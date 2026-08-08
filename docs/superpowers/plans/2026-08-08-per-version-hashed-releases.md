# Per-Version Hashed Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the compiler release tag to `compilers`, store one tarball per version id, and content-hash compiler asset filenames so the CDN can cache them immutably and the frontend can delete its `?rev=` cache machinery.

**Architecture:** `package-compiler.mjs` hashes each staged file and renames it `zig.<hash12>.wasm` (etc.), writing a `meta.json` mapping logical names → hashed filenames. The frontend fetches `meta.json` once per version id, resolves logical names to hashed URLs before fetching, and Cache Storage keys by the real (hashed) URL — no rev injection, no stale-rev sweeping. CI uploads/downloads per-version `<id>.tar.gz` against tag `compilers` instead of one monolithic `compilers.tar.gz`. WASI argv and virtual-FS filenames stay logical (`zig.wasm`, `libcompiler_rt.a`) — hashing is a network-layer concern only.

**Tech Stack:** Node.js (build/packaging scripts, `node:crypto`), TypeScript (frontend), GitHub Actions (`.github/workflows/*.yml`), `gh` CLI (release upload/download).

**Spec:** `docs/superpowers/specs/2026-08-08-per-version-hashed-releases-design.md`

---

## File Map

**Create:**
- (none — all changes to existing files)

**Modify:**
- `scripts/package-compiler.mjs` — compute SHA-256 per file; rename dest to `<base>.<hash12>.<ext>`; emit new `meta.json` shape (`files[logical] = {size, sha256, name}`).
- `scripts/fill-compilers-from-release.mjs` — default tag `compilers`; download all `<id>.tar.gz` and extract each into `public/compilers/<id>/`; drop monolithic-tar fallback.
- `scripts/build-compilers.mjs` — `--release-tag` default `compilers`; help text.
- `src/version.ts` — add `compilerAssetUrlHashed()`; delete schedule/cache-policy/revalidate helpers.
- `src/compiler-cache.ts` — delete rev machinery (`revisionFor`, `fetchBuiltAt`, `cacheKey`, `dropStaleRevs`, `revisionMemo`, `MetaProbe`); key Cache Storage by real URL; `meta.json` fetched `cache: no-store`.
- `src/utils.ts` — `getZigArchive` resolves hashed `zig.tar.gz`.
- `src/workers/zig.shared.ts`, `src/workers/zig.ts`, `src/workers/zls.ts` — asset fetch sites resolve hashed names; WASI argv unchanged.
- `.github/workflows/deploy.yml` — tag default `compilers`; per-version download.
- `.github/workflows/master.yml` — tag default `compilers`; publish only `<id>.tar.gz` for the rebuilt id.
- `README.md` — tag name, archive shape; drop rolling/master-3d note.

---

## Task 1: Hash filenames in package-compiler.mjs

**Files:**
- Modify: `scripts/package-compiler.mjs`

Responsible: produce hashed filenames and the logical→physical map in `meta.json`.

- [ ] **Step 1: Add crypto import**

At `scripts/package-compiler.mjs:11`, add `createHash` to the `node:fs` import block — no, `createHash` is from `node:crypto`. Add a new import line right after the existing `node:fs` import (after line 13's `fileURLToPath` import):

```js
import { createHash } from "node:crypto";
```

- [ ] **Step 2: Add a sha256 helper**

Add after the `arg()` function definition (around line 21). Returns the full hex digest and the short truncation in one read:

```js
function sha256OfFile(filePath, shortLen = 12) {
  const h = createHash("sha256").update(readFileSync(filePath));
  const full = h.digest("hex");
  return { full, short: full.slice(0, shortLen) };
}
```

This requires `readFileSync` from `node:fs` — add it to the existing `node:fs` import on line 11:

```js
import { cpSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
```

- [ ] **Step 3: Rewrite the packaging loop to hash + rename**

Replace the `files` array declaration (lines 33-38) and the loop that copies (lines 40-58). The new version hashes each staged file, derives a hashed destination name, copies to that name, and records both logical + physical names:

```js
/** logical base name → hashed physical filename */
function hashedName(logicalName, hash) {
  const dot = logicalName.lastIndexOf(".");
  if (dot <= 0) return `${logicalName}.${hash}`;
  // zig.tar.gz → zig.<hash>.tar.gz  (keep all extensions)
  const base = logicalName.slice(0, dot);
  const ext = logicalName.slice(dot);
  return `${base}.${hash}${ext}`;
}

const logicalFiles = [
  { src: join(from, "bin", "zig.wasm"), logical: "zig.wasm", required: true },
  { src: join(from, "bin", "zls.wasm"), logical: "zls.wasm", required: !optionalZls },
  { src: join(from, "libcompiler_rt.a"), logical: "libcompiler_rt.a", required: true },
  { src: join(from, "zig.tar.gz"), logical: "zig.tar.gz", required: true },
];

for (const f of logicalFiles) {
  if (!existsSync(f.src)) {
    if (f.required) {
      console.error(`missing ${f.src} — run zig build first`);
      process.exit(1);
    }
    console.warn(`optional missing ${f.src} — skipping`);
  }
}

mkdirSync(to, { recursive: true });
const metaFiles = {};
for (const f of logicalFiles) {
  if (!existsSync(f.src)) continue;
  const { full, short } = sha256OfFile(f.src);
  const destName = hashedName(f.logical, short);
  const dest = join(to, destName);
  cpSync(f.src, dest);
  const size = statSync(dest).size;
  metaFiles[f.logical] = { size, sha256: full, name: destName };
  console.log(`  ${destName}  (${size} bytes)`);
}
```

Note: the filename uses the 12-char truncation (`short`); the `sha256` field in `meta.json` is the full 64-char digest. Both come from one hash read.

- [ ] **Step 4: Update meta.json shape**

Replace the `meta` object (lines 60-65) to use the new `metaFiles` shape. The `id` and `builtAt` stay; `files` now holds `{size, sha256, name}` per logical name:

```js
const meta = {
  id,
  builtAt: new Date().toISOString(),
  files: metaFiles,
};
writeFileSync(join(to, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(`packaged compiler "${id}" → ${to}`);
```

- [ ] **Step 5: Smoke-test locally**

Run against an existing staged tree if present (otherwise skip the assertion — just confirm the script parses):

```bash
node -e "import('./scripts/package-compiler.mjs').catch(e => { if (!/missing/..test(e.message)) throw e })" 2>&1 | head -20
node --check scripts/package-compiler.mjs && echo "syntax ok"
```

Expected: "syntax ok". If a staged `zig-out` exists the first command also prints the missing-file error (expected — no build run here).

- [ ] **Step 6: Commit**

```bash
git add scripts/package-compiler.mjs
git commit -m "Hash compiler asset filenames; record logical→physical map in meta.json"
```

---

## Task 2: build-compilers.mjs — default tag + help text

**Files:**
- Modify: `scripts/build-compilers.mjs`

Only the `--release-tag` default and its help line. The meta enrichment (`enrichMeta`) reads the new shape from Task 1 but does not need changes — it does `Object.assign(meta, extra)` over whatever `package-compiler.mjs` wrote, which already includes `files`.

- [ ] **Step 1: Change the releaseTag default**

At `scripts/build-compilers.mjs:48`:

```js
let releaseTag = process.env.COMPILERS_RELEASE || "compilers";
```

- [ ] **Step 2: Update help text**

At `scripts/build-compilers.mjs:83`:

```
  --release-tag <tag>             Release tag for --fill-missing (default: compilers)
```

- [ ] **Step 3: Verify parse**

```bash
node --check scripts/build-compilers.mjs && echo ok
node scripts/build-compilers.mjs --select all --dry-run 2>&1 | head -20
```

Expected: dry-run plan prints without error (no build happens).

- [ ] **Step 4: Commit**

```bash
git add scripts/build-compilers.mjs
git commit -m "Default release tag to 'compilers'"
```

---

## Task 3: fill-compilers-from-release.mjs — per-version download

**Files:**
- Modify: `scripts/fill-compilers-from-release.mjs`

Switch from monolithic `compilers.tar.gz` to downloading all `<id>.tar.gz` and extracting each into `public/compilers/<id>/`. Drop the monolithic-tar + flat-dir fallbacks (intentional breaking change per spec §2).

- [ ] **Step 1: Change tag default**

At `scripts/fill-compilers-from-release.mjs:30`:

```js
const tag = arg("--tag", process.env.COMPILERS_RELEASE || "compilers");
```

- [ ] **Step 2: Rewrite the download + extract section**

Replace lines 60-100 (the `tmp` setup through the end of the `else { // flat per-id dirs }` block) with per-version handling. The new code downloads every asset matching `<id>.tar.gz` (but not a legacy `compilers.tar.gz`), then extracts each into a per-id stage dir:

```js
const tmp = join(root, ".zig-version-cache", "release-download");
mkdirSync(tmp, { recursive: true });
// clean previous extract
for (const name of readdirSync(tmp)) {
  rmSync(join(tmp, name), { recursive: true, force: true });
}

const dl = spawnSync(
  "gh",
  ["release", "download", tag, "--repo", repo, "--dir", tmp, "--clobber", "--pattern", "*.tar.gz"],
  { stdio: "inherit", env: process.env },
);
if (dl.status !== 0) {
  console.error(`fill: failed to download release ${tag} from ${repo}`);
  failIfRequired(missing);
  process.exit(requireAll || requireStable ? 1 : 0);
}

// Extract each <id>.tar.gz into stage/compilers/<id>/ (flat — files at archive root).
const stage = join(tmp, "stage");
mkdirSync(join(stage, "compilers"), { recursive: true });
for (const name of readdirSync(tmp)) {
  if (!name.endsWith(".tar.gz") || name === "compilers.tar.gz") continue;
  const id = name.replace(/\.tar\.gz$/, "");
  const dest = join(stage, "compilers", id);
  mkdirSync(dest, { recursive: true });
  const x = spawnSync("tar", ["-xzf", join(tmp, name), "-C", dest], { stdio: "inherit" });
  if (x.status !== 0) {
    console.error(`fill: failed to extract ${name}`);
    process.exit(1);
  }
  console.log(`  extracted ${name} → ${id}`);
}
```

Note: `--pattern "*.tar.gz"` is a glob the `gh` CLI accepts for `release download`. A leftover legacy `compilers.tar.gz` (if someone hasn't deleted the old release) is skipped by the `name === "compilers.tar.gz"` guard.

- [ ] **Step 3: Confirm the rest still works**

The loop at lines 102-115 (`for (const v of missing) { … cpSync(src, dest, …) }`) copies `stage/compilers/<id>` → `public/compilers/<id>`. It reads `src/zig.wasm` as the presence check — but with hashed filenames there is no bare `zig.wasm` anymore. Update the presence check to `meta.json` instead (it's the one fixed-name file):

At `scripts/fill-compilers-from-release.mjs`, find the block:

```js
for (const v of missing) {
  const src = join(stage, "compilers", v.id);
  const dest = join(publicCompilers, v.id);
  if (existsSync(join(src, "zig.wasm"))) {
```

Change the condition to check for `meta.json`:

```js
  if (existsSync(join(src, "meta.json"))) {
```

And the later "still missing" check (around line 118) uses `existsSync(join(publicCompilers, v.id, "zig.wasm"))`:

```js
const still = manifest.versions.filter(
  (v) => !existsSync(join(publicCompilers, v.id, "zig.wasm")),
);
for (const v of manifest.versions) {
  const ok = existsSync(join(publicCompilers, v.id, "zig.wasm"));
```

Both of these should also flip to `meta.json`:

```js
const still = manifest.versions.filter(
  (v) => !existsSync(join(publicCompilers, v.id, "meta.json")),
);
for (const v of manifest.versions) {
  const ok = existsSync(join(publicCompilers, v.id, "meta.json"));
```

- [ ] **Step 4: Syntax check**

```bash
node --check scripts/fill-compilers-from-release.mjs && echo ok
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add scripts/fill-compilers-from-release.mjs
git commit -m "Download per-version <id>.tar.gz from release (tag default: compilers)"
```

---

## Task 4: Frontend — add compilerAssetUrlHashed to version.ts

**Files:**
- Modify: `src/version.ts`

Add the hashed-name resolver and its memo, then delete the schedule/cache-policy/revalidate helpers that the rev machinery depended on.

- [ ] **Step 1: Add a MetaFile type and memo**

After the `VersionsManifest` type definition (around line 24), add:

```ts
export type CompilerMetaFile = { size: number; sha256: string; name: string };
export type CompilerMeta = {
  id: string;
  builtAt: string;
  files: Record<string, CompilerMetaFile>;
};
```

- [ ] **Step 2: Add compilerAssetUrlHashed**

After the existing `compilerAssetUrl` function (ends at line 103), add:

```ts
const metaMemo = new Map<string, Promise<CompilerMeta | null>>();

/** Fetch (once per id per session) and return the logical→physical file map. */
export async function compilerMeta(versionId: string): Promise<CompilerMeta | null> {
  let p = metaMemo.get(versionId);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(compilerAssetUrl(versionId, "meta.json"), {
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
    metaMemo.set(versionId, p);
  }
  return p;
}

/**
 * Resolve a logical compiler asset name (e.g. "zig.wasm") to its hashed URL.
 * Falls back to the logical URL if meta.json is missing (e.g. legacy deploy).
 */
export async function compilerAssetUrlHashed(
  versionId: string,
  logicalName: string,
): Promise<string> {
  const meta = await compilerMeta(versionId);
  const entry = meta?.files?.[logicalName];
  if (!entry?.name) return compilerAssetUrl(versionId, logicalName);
  return compilerAssetUrl(versionId, entry.name);
}
```

- [ ] **Step 3: Delete the now-unused cache-policy helpers**

Delete lines 105-173 (the block comment about `Cache-Control` through the end of `compilerCacheControlHeader`). Specifically remove: `CompilerCachePolicy`, `STABLE_MAX_AGE_SECONDS`, `DEFAULT_ROLLING_SECONDS`, `parseScheduleSeconds`, `compilerCachePolicy`, `metaRevalidateSeconds`, `compilerCacheControlHeader`. The hashing scheme makes the rolling-vs-stable distinction obsolete.

Keep `compilerIdFromAssetUrl` (still used by the cache layer) and everything above it.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -30
```

Expected: errors only from `compiler-cache.ts` referencing the deleted `metaRevalidateSeconds` (fixed in Task 5). No errors from `version.ts` itself.

- [ ] **Step 5: Commit**

```bash
git add src/version.ts
git commit -m "Add compilerAssetUrlHashed; drop schedule/cache-policy helpers"
```

---

## Task 5: Frontend — simplify compiler-cache.ts (delete rev machinery)

**Files:**
- Modify: `src/compiler-cache.ts`

Key Cache Storage by the real (hashed) URL. Delete all rev injection.

- [ ] **Step 1: Replace the entire file body**

The file currently spans 221 lines. Replace from the top comment block (line 1) through the end with this simplified version. Keep the same module purpose (offline reuse via Cache Storage) but with no rev logic:

```ts
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
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -30
```

Expected: no errors from `compiler-cache.ts` or `version.ts`. Remaining errors (if any) come from the worker call sites still using the synchronous `compilerAssetUrl` — fixed in Tasks 6-8.

- [ ] **Step 3: Commit**

```bash
git add src/compiler-cache.ts
git commit -m "Key Cache Storage by real URL; delete rev/stale-rev machinery"
```

---

## Task 6: Frontend — resolve hashed names in utils.ts

**Files:**
- Modify: `src/utils.ts`

`getZigArchive` builds the URL for `zig.tar.gz`. Make it async-resolve the hashed name.

- [ ] **Step 1: Update getZigArchive**

At `src/utils.ts:28-30`, replace:

```ts
export async function getZigArchive(versionId: string): Promise<Directory> {
    return loadZigArchive(compilerAssetUrl(versionId, "zig.tar.gz"));
}
```

with:

```ts
export async function getZigArchive(versionId: string): Promise<Directory> {
    const url = await compilerAssetUrlHashed(versionId, "zig.tar.gz");
    return loadZigArchive(url);
}
```

- [ ] **Step 2: Update the import**

At `src/utils.ts:4`, change:

```ts
import { compilerAssetUrl } from "./version";
```

to:

```ts
import { compilerAssetUrlHashed } from "./version";
```

(`compilerAssetUrl` is no longer used directly in this file after the change.)

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -30
```

Expected: no new errors from `utils.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/utils.ts
git commit -m "getZigArchive resolves hashed zig.tar.gz name"
```

---

## Task 7: Frontend — resolve hashed names in workers/zig.shared.ts and workers/zig.ts

**Files:**
- Modify: `src/workers/zig.shared.ts`
- Modify: `src/workers/zig.ts`

Both workers have parallel `Promise.all` blocks that fetch `libcompiler_rt.a` and `zig.wasm`. The WASI argv strings (`"zig.wasm"`, `"libcompiler_rt.a"`) stay logical — only the `compilerAssetUrl(...)` fetch sites change.

- [ ] **Step 1: Update zig.shared.ts fetch sites**

At `src/workers/zig.shared.ts`, find the import (around line 17) and add `compilerAssetUrlHashed`:

```ts
import { compileWasmAsset, fetchAssetBuffer, getZigArchive } from "../utils";
```

becomes — confirm `compilerAssetUrl` and `compilerAssetUrlHashed` imports. Look at the existing imports and ensure both name-resolver and any still-needed `compilerAssetUrl` are present:

```ts
import { compileWasmAsset, fetchAssetBuffer, getZigArchive } from "../utils";
import { compilerAssetUrl, compilerAssetUrlHashed } from "../version";
```

(If `compilerAssetUrl` is no longer referenced after the edits below, drop it — the typecheck in Step 4 will tell you.)

Then in `ensureCompiler` (lines 152-157), replace the two `compilerAssetUrl(versionId, ...)` calls with awaited hashed resolvers. The `Promise.all` becomes:

```ts
        const [zirHit, libDirectory, compilerRt, zigModule] = await Promise.all([
            loadZirCacheEntries(versionId),
            getZigArchive(versionId),
            (async () => fetchAssetBuffer(await compilerAssetUrlHashed(versionId, "libcompiler_rt.a")))(),
            (async () => compileWasmAsset(await compilerAssetUrlHashed(versionId, "zig.wasm")))(),
        ]);
```

The IIFE wrappers keep each asset's `compilerAssetUrlHashed` fetch parallelized with the others (instead of serializing two awaits before the `Promise.all`).

- [ ] **Step 2: Confirm WASI argv untouched in zig.shared.ts**

The args at lines 257-265 (`"zig.wasm"`, `"build-exe"`, `"main.zig"`, `"libcompiler_rt.a"`, …) and the virtual-FS entry at line 281 (`["libcompiler_rt.a", new File(...)]`) stay exactly as-is. These are names the compiler/wasi-shim recognize, not URLs.

- [ ] **Step 3: Apply the same change to workers/zig.ts (legacy worker)**

At `src/workers/zig.ts`, update the import (around line 2) the same way, then the `Promise.all` block at lines 92-97:

```ts
            const [zirHit, libDirectory, compilerRt, zigModule] = await Promise.all([
                loadZirCacheEntries(id),
                getZigArchive(id),
                (async () => fetchAssetBuffer(await compilerAssetUrlHashed(id, "libcompiler_rt.a")))(),
                (async () => compileWasmAsset(await compilerAssetUrlHashed(id, "zig.wasm")))(),
            ]);
```

WASI argv at lines 130-140 and the FS entry at line 149 stay logical.

- [ ] **Step 4: Typecheck + build**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -30
```

Expected: no errors. If tsc reports `compilerAssetUrl` unused in either file, remove it from that file's import.

- [ ] **Step 5: Commit**

```bash
git add src/workers/zig.shared.ts src/workers/zig.ts
git commit -m "Resolve hashed compiler asset names in zig workers (WASI argv unchanged)"
```

---

## Task 8: Frontend — resolve hashed name in workers/zls.ts

**Files:**
- Modify: `src/workers/zls.ts`

- [ ] **Step 1: Update the zls.wasm fetch**

At `src/workers/zls.ts:75`, replace:

```ts
        const zlsModule = await compileWasmAsset(compilerAssetUrl(versionId, "zls.wasm"));
```

with:

```ts
        const zlsModule = await compileWasmAsset(await compilerAssetUrlHashed(versionId, "zls.wasm"));
```

- [ ] **Step 2: Update imports**

At the top of `src/workers/zls.ts`, find the import of `compilerAssetUrl` from `../version` and change it to `compilerAssetUrlHashed`. If other code in the file still uses `compilerAssetUrl`, keep both. Confirm with the typecheck.

- [ ] **Step 3: Confirm WASI argv stays logical**

Line 63 (`const args = ["zls.wasm"];`) is a runtime argument to the wasm instance, not a URL — leave it as `"zls.wasm"`.

- [ ] **Step 4: Typecheck + build**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -30
npm run build 2>&1 | tail -20
```

Expected: clean typecheck; build produces `dist/`.

- [ ] **Step 5: Commit**

```bash
git add src/workers/zls.ts
git commit -m "Resolve hashed zls.wasm name in zls worker"
```

---

## Task 9: CI — deploy.yml per-version download

**Files:**
- Modify: `.github/workflows/deploy.yml`

Change the tag default and the download step to fetch per-version archives.

- [ ] **Step 1: Change tag default (two spots)**

At `.github/workflows/deploy.yml:49`:

```yaml
          COMPILERS_RELEASE: ${{ vars.COMPILERS_RELEASE || 'compilers' }}
```

At line 173 (in the "Ensure every versions.json id is packaged" step's error echo):

```yaml
          echo "Upload compilers (per-version <id>.tar.gz), or Run workflow with rebuild_compilers=true."
```

And the top-of-file comment at line 26:

```yaml
# Compilers are REUSED from GitHub Release `compilers` by default.
```

- [ ] **Step 2: Replace the download step body**

Replace the `run:` block of the "Download compilers from Release (reuse)" step (lines 50-63) with per-version download logic. The `--pattern '*.tar.gz'` pulls every per-version archive; extract each into `public/compilers/<id>/`:

```yaml
        run: |
          set -euo pipefail
          TAG="${COMPILERS_RELEASE}"
          mkdir -p public/compilers .zig-version-cache/release-download
          if gh release download "$TAG" --repo "$GITHUB_REPOSITORY" \
              --dir .zig-version-cache/release-download --clobber \
              --pattern '*.tar.gz' 2>/dev/null; then
            for f in .zig-version-cache/release-download/*.tar.gz; do
              [ -e "$f" ] || continue
              id=$(basename "$f" .tar.gz)
              mkdir -p "public/compilers/$id"
              tar -xzf "$f" -C "public/compilers/$id"
              echo "extracted $id.tar.gz"
            done
          else
            echo "no archives on $TAG — trying fill script"
            node scripts/fill-compilers-from-release.mjs || true
          fi
          ls -la public/compilers || true
```

- [ ] **Step 3: Update the "missing package" presence check**

The "Detect whether a source compiler rebuild is needed" step (lines 77-84) and "Ensure every versions.json id is packaged" (lines 159-166) both probe for `zig.wasm`. With hashed names that file no longer exists at that path — switch both to `meta.json`. In each, change:

```js
            const miss = m.versions.filter(v => !existsSync(join("public/compilers", v.id, "zig.wasm")));
```

to:

```js
            const miss = m.versions.filter(v => !existsSync(join("public/compilers", v.id, "meta.json")));
```

(Two occurrences — one in each step.)

- [ ] **Step 4: Update the "Require default compiler" check**

At lines 177-182, `test -f "public/compilers/${DEFAULT}/zig.wasm"` should become a `meta.json` check:

```yaml
      - name: Require default compiler
        run: |
          DEFAULT=$(node -p "require('./versions.json').default")
          test -f "public/compilers/${DEFAULT}/meta.json"
          echo "compilers ready:"
          ls public/compilers
```

- [ ] **Step 5: Lint check**

```bash
node -e "const y=require('fs').readFileSync('.github/workflows/deploy.yml','utf8'); console.log('lines:', y.split('\n').length)" 
```

Expected: prints a line count (sanity — file parses as text). Optionally `npx --yes actionlint .github/workflows/deploy.yml 2>&1 | head` if actionlint is available.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "deploy.yml: download per-version archives; tag default compilers"
```

---

## Task 10: CI — master.yml per-version upload/download

**Files:**
- Modify: `.github/workflows/master.yml`

Two changes: download step mirrors deploy.yml (per-version), and publish uploads only `master.tar.gz` (not the whole tree).

- [ ] **Step 1: Change tag defaults**

At `.github/workflows/master.yml:57` and `:113`:

```yaml
          COMPILERS_RELEASE: ${{ vars.COMPILERS_RELEASE || 'compilers' }}
```

- [ ] **Step 2: Rewrite the fill-from-release step**

Replace the body of the "Fill non-scheduled ids from release" step (lines 58-80) — keep the scheduled-tree-clear inline node script at the end, but change the download to per-version archives:

```yaml
        run: |
          set -euo pipefail
          TAG="${COMPILERS_RELEASE}"
          mkdir -p public/compilers .zig-version-cache/release-download
          if gh release download "$TAG" --repo "$GITHUB_REPOSITORY" \
              --dir .zig-version-cache/release-download --clobber \
              --pattern '*.tar.gz' 2>/dev/null; then
            for f in .zig-version-cache/release-download/*.tar.gz; do
              [ -e "$f" ] || continue
              id=$(basename "$f" .tar.gz)
              mkdir -p "public/compilers/$id"
              tar -xzf "$f" -C "public/compilers/$id"
              echo "extracted $id.tar.gz"
            done
          else
            node scripts/fill-compilers-from-release.mjs || true
          fi
          # Remove scheduled trees so we rebuild them fresh (keep fallback stables).
          node --input-type=module -e '
            import { loadVersionsManifest, selectVersions } from "./scripts/versions-lib.mjs";
            import { rmSync, existsSync } from "node:fs";
            import { join } from "node:path";
            for (const v of selectVersions(loadVersionsManifest(), { select: "scheduled" })) {
              const p = join("public/compilers", v.id);
              if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); console.log("cleared", v.id); }
            }
          '
          ls -la public/compilers || true
```

- [ ] **Step 3: Update the "Ensure all versions.json ids packaged" check**

At lines 93-107, change the two `zig.wasm` presence checks to `meta.json`:

```js
            const miss = m.versions.filter(v => !existsSync(join("public/compilers", v.id, "meta.json")));
```

and the error echo stays as-is (`echo "::error::Missing: $MISSING"`).

- [ ] **Step 4: Rewrite the publish step to upload only the rebuilt id**

Replace the "Publish compilers-latest Release" step (lines 109-124). The new version tars each scheduled id's dir and uploads just those (typically `master.tar.gz`):

```yaml
      - name: Publish compilers Release (per rebuilt id)
        env:
          GH_TOKEN: ${{ github.token }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          COMPILERS_RELEASE: ${{ vars.COMPILERS_RELEASE || 'compilers' }}
        run: |
          set -euo pipefail
          IDS=$(node --input-type=module -e '
            import { loadVersionsManifest, selectVersions } from "./scripts/versions-lib.mjs";
            process.stdout.write(selectVersions(loadVersionsManifest(), { select: "scheduled" }).map(v => v.id).join(" "));
          ')
          if gh release view "$COMPILERS_RELEASE" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
            CREATE=""
          else
            CREATE="--title Compiler-assets --notes Prebuilt per-version zig/zls wasm trees."
          fi
          for id in $IDS; do
            tar -C "public/compilers/$id" -czf "$id.tar.gz" .
            if [ -n "$CREATE" ]; then
              gh release create "$COMPILERS_RELEASE" "$id.tar.gz" --repo "$GITHUB_REPOSITORY" $CREATE
              CREATE=""
            else
              gh release upload "$COMPILERS_RELEASE" "$id.tar.gz" --repo "$GITHUB_REPOSITORY" --clobber
            fi
            echo "uploaded $id.tar.gz to $COMPILERS_RELEASE"
          done
```

Note: `gh release create` must run on the first asset (you can't create an empty release and then upload in the same invocation pattern). The `$CREATE` flag toggles between create+upload (first id) and plain upload (subsequent). Stable pins are never touched here.

- [ ] **Step 5: Lint check**

```bash
npx --yes actionlint .github/workflows/master.yml 2>&1 | head
```

Expected: no errors (actionlint runs if available; otherwise skip).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/master.yml
git commit -m "master.yml: upload per-version <id>.tar.gz; tag default compilers"
```

---

## Task 11: README — update CI/docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the CI table**

At `README.md:90-91`, replace:

```markdown
| **Deploy** (every push) | **Reuses Release.** Downloads `compilers-latest` → only builds frontend. Source rebuild only if packages missing after download, or **Run workflow → rebuild_compilers**. |
| **Master compiler** | Builds `schedule` ids with **hostZig=master** from Codeberg (~every 3 days + **manual**). On success, refreshes `compilers-latest` Release. Other ids filled from previous Release. |
```

with:

```markdown
| **Deploy** (every push) | **Reuses Release.** Downloads per-version `<id>.tar.gz` from `compilers` → only builds frontend. Source rebuild only if an id is missing after download, or **Run workflow → rebuild_compilers**. |
| **Master compiler** | Builds `schedule` ids with **hostZig=master** from Codeberg (~every 3 days + **manual**). On success, uploads only `master.tar.gz` to the `compilers` Release — stable pins stay untouched. |
```

- [ ] **Step 2: Update the gh release example**

At `README.md:99`:

```bash
gh release upload compilers compilers.tar.gz --clobber
```

becomes per-version. Replace lines ~95-99 (the `# One-time …` block) with:

```bash
# One-time (or when upgrading a pin): produce + publish binaries.
# Each version id becomes its own <id>.tar.gz on the `compilers` release.
npm run compilers -- --select all
for id in $(node -e 'console.log(require("./versions.json").versions.map(v=>v.id).join(" "))'); do
  tar -C public/compilers -czf "$id.tar.gz" "$id"
  gh release upload compilers "$id.tar.gz" --clobber
done
# after that, normal commits only redeploy the UI
```

- [ ] **Step 3: Update the compiler-asset path docs**

At `README.md` around line 18-26, the path block:

```
/compilers/<id>/zig.wasm
/compilers/<id>/zls.wasm
/compilers/<id>/libcompiler_rt.a
/compilers/<id>/zig.tar.gz
```

Add a note that filenames carry a content hash:

```
Compiler asset filenames carry a content hash (e.g. `/compilers/<id>/zig.<hash12>.wasm`)
so the CDN can cache them immutably. The logical names live in `meta.json`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: per-version release archives + hashed asset filenames"
```

---

## Task 12: End-to-end local verification

**Files:** (none — verification only)

This task verifies the whole chain locally without a full compiler build (which needs host Zig per version). It exercises: packaging produces hashed names + meta, the fill script handles per-version archives, and the frontend build resolves hashed names.

- [ ] **Step 1: Fabricate a fake compiler tree and package it**

```bash
mkdir -p /tmp/fake-zig-out/bin
echo "fake wasm" > /tmp/fake-zig-out/bin/zig.wasm
echo "fake zls" > /tmp/fake-zig-out/bin/zls.wasm
echo "fake crt" > /tmp/fake-zig-out/libcompiler_rt.a
tar -czf /tmp/fake-zig-out/zig.tar.gz -C /tmp fake 2>/dev/null || echo "fake std tar (content irrelevant)"
node scripts/package-compiler.mjs --id 99.9.9 --from /tmp/fake-zig-out --to /tmp/fake-pkg
ls /tmp/fake-pkg
cat /tmp/fake-pkg/meta.json
```

Expected: `/tmp/fake-pkg/` contains `zig.<hash>.wasm`, `zls.<hash>.wasm`, `libcompiler_rt.<hash>.a`, `zig.<hash>.tar.gz`, and `meta.json`. The `meta.json` `files` object has keys `zig.wasm`/`zls.wasm`/`libcompiler_rt.a`/`zig.tar.gz`, each with `{size, sha256, name}`.

- [ ] **Step 2: Confirm the typecheck is clean across the frontend**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | head
```

Expected: no output (clean).

- [ ] **Step 3: Confirm the production build still assembles**

```bash
npm run build 2>&1 | tail -15
```

Expected: build completes; `dist/` produced. (The build doesn't fetch compilers — it only needs the frontend to compile, which validates that the hashed-name resolver wiring is syntactically/type correct.)

- [ ] **Step 4: Clean up the fake artifacts**

```bash
rm -rf /tmp/fake-zig-out /tmp/fake-pkg
```

- [ ] **Step 5: Final commit (if any uncommitted helper changes remain)**

```bash
git status --short
```

Expected: clean tree (everything committed in Tasks 1-11). If anything remains, commit it.

---

## Migration note (post-merge, not a task)

After the first `master.yml` run creates the new `compilers` release and populates `<id>.tar.gz` for all ids, the legacy `compilers-latest` release can be deleted manually:

```bash
gh release delete compilers-latest --yes
gh release delete-branch compilers-latest  # if a tag branch exists
```

This is a human step, not automated — it lives in the deployer's runbook.
