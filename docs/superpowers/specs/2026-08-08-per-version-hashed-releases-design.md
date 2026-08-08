# Per-version hashed releases

**Date:** 2026-08-08
**Status:** Design — pending review

## Problem

Two issues with the current compiler release pipeline:

1. **Monolithic release.** One tag `compilers-latest` holds a single
   `compilers.tar.gz` (the whole `compilers/` tree). Every master rebuild
   re-tars and `--clobber`s the entire bundle, re-writing the stable pins'
   bytes for no reason. Reusable URL form is verbose (`tag/compilers-latest`).

2. **No content-addressing.** Compiler assets live at fixed URLs
   (`/compilers/<id>/zig.wasm`). Master rewrites the same path every 3 days, so
   neither the CDN nor the browser can safely cache by URL. The frontend paper
   over this with a hand-rolled `?rev=<builtAt>` Cache Storage layer: probe
   `meta.json` on a schedule, key assets by injected rev, sweep stale revs to
   avoid quota blowup (`src/compiler-cache.ts`). This is the only reason the
   `rev` machinery exists.

## Goal

- Rename the release tag to **`compilers`**, one archive **per version**
  (`<id>.tar.gz`).
- Make compiler asset **filenames carry a content hash**
  (`zig.<hash>.wasm`), so the URL *is* the content address. The CDN (Cloudflare
  in front of GitHub Pages) can then cache hashed files immutably for free, and
  the frontend deletes the entire `rev` mechanism — fixed-URL master is no
  longer a problem because master's hash changes, so its filename changes.

## Non-goals

- No change to what a "version" is, `versions.json` shape, or build modes.
- No change to the per-version dir layout under `public/compilers/<id>/` as seen
  by the WASI runtime: the compiler still sees `zig.wasm`,
  `libcompiler_rt.a`, etc. (hashing is a **network-layer** concern only).
- No new caching infrastructure. Cache Storage stays for offline reuse, just
  keyed by real URL instead of `?rev=`.

---

## Design

### 1. Release tag: `compilers` (was `compilers-latest`)

Every reference to the default tag changes:

| Location | Change |
|----------|--------|
| `.github/workflows/deploy.yml` | env default `compilers-latest` → `compilers`; download step switches to per-version archives |
| `.github/workflows/master.yml` | same default; **publish step uploads only `<id>.tar.gz`** (the rebuilt id), not the whole tree |
| `scripts/build-compilers.mjs` | `--release-tag` default + `--fill-missing` help text |
| `scripts/fill-compilers-from-release.mjs` | `--tag` default, download logic |
| `README.md` | tag name in CI table + `gh release upload` example |

`COMPILERS_RELEASE` repo var still overrides — only the *default* string moves.
Migration is a one-time re-create of the release (the publish step creates it if
absent, which it will be for the new tag).

### 2. Per-version archives

One tarball per version id: `0.16.0.tar.gz`, `0.15.2.tar.gz`, `master.tar.gz`.
Each extracts flat into `public/compilers/<id>/` (files at the archive root, no
top-level dir):

```
<id>.tar.gz
├── zig.<hash>.wasm
├── zls.<hash>.wasm              (or absent — optional, as today)
├── libcompiler_rt.<hash>.a
├── zig.<hash>.tar.gz            (inner lib/std tarball; only the *name* is hashed)
└── meta.json                    (fixed name — it's the pointer)
```

**`master.yml` publish** becomes: tar just `public/compilers/master/` and
`gh release upload compilers master.tar.gz --clobber`. Stable pins are never
re-touched on a master rebuild — a real improvement over today's blanket clobber.

**Download side** (`deploy.yml`, `master.yml` fill step,
`fill-compilers-from-release.mjs`): fetch all `*.tar.gz` from the release, extract
each `<id>.tar.gz` into `public/compilers/<id>/`. The monolithic
`compilers.tar.gz` path is removed (this is an intentional breaking change to
the cache shape; the one-time migration re-populates everything).

### 3. Filename hashing

`scripts/package-compiler.mjs` computes a SHA-256 per staged file and renames
the destination to `<base>.<hash12>.<ext>` (12 hex chars; enough to avoid
collisions across a handful of files per version, short enough for clean URLs).
`zig.tar.gz`'s **inner** content (lib/std) is untouched — only the outer
filename is hashed, since that's what the network/CDN sees.

`meta.json` becomes the **logical → physical map**:

```json
{
  "id": "0.16.0",
  "builtAt": "2026-08-08T12:00:00Z",
  "files": {
    "zig.wasm":           { "size": 12345678, "sha256": "ab12…", "name": "zig.ab12cd34ef56.wasm" },
    "zls.wasm":           { "size":  9876543, "sha256": "cd34…", "name": "zls.cd34ef56ab12.wasm" },
    "libcompiler_rt.a":   { "size":     1234, "sha256": "ef56…", "name": "libcompiler_rt.ef56ab12cd34.a" },
    "zig.tar.gz":         { "size": 4567890, "sha256": "7890…", "name": "zig.7890ab12cd34.tar.gz" }
  },
  "zigVersionString": "0.16.0",
  "hostZig": "0.16.0",
  "schedule": null,
  "label": "0.16.0"
}
```

`meta.json` itself keeps a **fixed name** (no hash): it must be re-fetchable to
learn the new hashes after a master rebuild. It stays small (a few hundred
bytes), so no immutability needed.

`libcompiler_rt.a` and `zig.tar.gz` have stable base names today; both get the
same `<base>.<hash>.<ext>` treatment for uniformity and CDN behavior.

### 4. Frontend: filename resolution + cache simplification

The frontend currently hardcodes logical names at **two distinct layers**. The
hash lives at only one of them:

| Layer | Example | Hashed? |
|-------|---------|---------|
| Network URL | `compilerAssetUrl(id, "zig.wasm")` | **Yes** → resolve to `zig.<hash>.wasm` |
| WASI argv / virtual FS names | `args = ["zig.wasm", "build-exe", …]` | **No** — the compiler recognizes these names; the hash is a transport concern |

So the change is concentrated at the `compilerAssetUrl` call sites, not the WASI
argv strings.

**New helper** in `src/version.ts`:

```ts
// Load + cache meta.json for an id, return logical→physical resolver.
export async function compilerAssetUrlHashed(
  versionId: string, logicalName: string
): Promise<string>
```

It fetches `/compilers/<id>/meta.json` once per id (memoized), reads
`files[logicalName].name`, returns the full URL. Call sites become `await`
calls:

- `src/utils.ts:29` — `getZigArchive` → `zig.tar.gz`
- `src/workers/zig.shared.ts:155-156` — `libcompiler_rt.a`, `zig.wasm`
- `src/workers/zig.ts:95-96` — same two (legacy worker path)
- `src/workers/zls.ts:75` — `zls.wasm`

All four call sites already sit inside `async` functions and are already
`Promise.all`-d together, so adding one awaited meta fetch (parallelized with
the others) is natural. `meta.json` is tiny so this adds no latency worth
measuring.

**Staleness note:** the per-id meta is memoized for the page session. If master
rebuilds while a tab is open, the stale map points at a still-valid immutable
file (old hash) — the user just doesn't get *this session's* new master until a
hard reload re-fetches `meta.json` (no-store). This is acceptable and is exactly
the guarantee hashing buys us: a stale pointer is never a *broken* pointer.

**`src/compiler-cache.ts` — delete the rev machinery.** Remove: `revisionFor`,
`fetchBuiltAt`, `metaRevalidateSeconds` callers, `cacheKey`, `dropStaleRevs`,
`revisionMemo`, `MetaProbe`. What remains:

```ts
export async function fetchCompilerResponse(url): Promise<Response> {
  const versionId = compilerIdFromAssetUrl(href);
  if (!versionId) return fetch(href);                       // non-compiler asset
  if (typeof caches === "undefined") return fetch(href);    // no Cache Storage
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(href);                      // key = real URL
  if (hit) return hit;
  const res = await fetch(href);
  if (!res.ok) return res;
  // store + return (same clone dance as today)
}
```

Keyed by real URL. Hashed files never change at a URL → entries are implicitly
correct forever; `meta.json` is fetched `cache: "no-store"` (it must reflect new
hashes). No sweeping, no probing, no master-3-day logic. The whole point of
hashing was to make this deletion possible.

**`src/version.ts`** — drop `parseScheduleSeconds` / `compilerCachePolicy` /
`metaRevalidateSeconds` / `compilerCacheControlHeader` (the rolling-vs-stable
revalidate distinction collapses: everything hashed is immutable, `meta.json` is
short). Keep `compilerIdFromAssetUrl`, `compilerAssetBase`, path helpers.

### 5. WASI argv stays logical

The runtime args (`["zig.wasm", "build-exe", "main.zig", "libcompiler_rt.a",
…]` in `zig.shared.ts:257` / `zig.ts:130`) and the virtual-FS filenames
(`["libcompiler_rt.a", new File(...)]`) are **unchanged**. The hash is purely how
bytes get from CDN into the worker; once buffered, they're presented under the
logical names the compiler expects. This is why the change is small.

---

## Files changed

**CI**
- `.github/workflows/deploy.yml` — tag default `compilers`; per-version download
- `.github/workflows/master.yml` — tag default `compilers`; publish only
  `<id>.tar.gz`

**Scripts**
- `scripts/package-compiler.mjs` — SHA-256 per file; hashed dest names; new
  `meta.json` shape (`files[name] = {size, sha256, name}`)
- `scripts/fill-compilers-from-release.mjs` — tag default; download all
  `<id>.tar.gz`, extract each; drop monolithic-tar fallback
- `scripts/build-compilers.mjs` — `--release-tag` default + help text only

**Frontend**
- `src/version.ts` — add `compilerAssetUrlHashed`; delete schedule/revalidate
  helpers and cache-policy exports
- `src/compiler-cache.ts` — delete rev machinery; key Cache Storage by real URL
- `src/utils.ts` — `getZigArchive` awaits hashed name
- `src/workers/zig.shared.ts`, `src/workers/zig.ts`, `src/workers/zls.ts` —
  asset fetch call sites use hashed names; WASI argv unchanged

**Docs**
- `README.md` — tag name, archive shape, remove rolling/master-3d note

## Migration

One-time: the new `compilers` tag is created by the first publish run. Both
workflows rebuild missing ids from source on first run (existing
`--skip-existing` + "missing after download → rebuild" logic already handles
this). The old `compilers-latest` release can be deleted manually after the new
tag is populated.
