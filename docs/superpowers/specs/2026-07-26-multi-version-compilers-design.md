# Multi-version compilers design

**Date:** 2026-07-26  
**Status:** approved (approach A + §1; remaining sections locked for implementation)

## Goal

Ship multiple Zig (+ paired ZLS) compiler builds from one playground UI:

| Path | Behavior |
|------|----------|
| `/` | Configurable **default** version (not a hard-coded “always master”) |
| `/master` | Tracking build; CI refresh about every **3 days** |
| `/0.15.2` (etc.) | Pinned release from a fixed version list |

Each version has its own browser ZIR cache and its own compiler asset tree. Switching versions is **full-page navigation**.

## Non-goals

- In-page soft switch of wasm without reload
- Auto-discovering every Zig release from ziglang.org
- Committing wasm/tar blobs to git

## Decisions (brainstorming)

1. **Default at `/`:** configurable (`versions.json` → `default`)
2. **Switch UX:** full page nav to `/<id>/`
3. **Version set:** fixed list in repo config; master on ~3d schedule; others rebuild when list/deps change
4. **Assets:** shared frontend (`/assets/*`) + per-version compilers (`/compilers/<id>/`)
5. **ZLS:** strict pairing with each Zig id
6. **UI:** toolbar dropdown → `location` change
7. **Git:** large binaries never committed (CI/artifact/Pages only)

## Deploy layout (Pages artifact only — not in git)

```
dist/
  index.html                 # SPA shell; resolves default version at runtime
  404.html                   # copy of index.html (GH Pages SPA fallback)
  master/index.html          # same shell (clean deep links, 200)
  0.15.2/index.html
  assets/…                   # hashed UI (js/css) — long cache
  versions.json              # { default, versions[] }
  compilers/
    master/
      zig.wasm
      zls.wasm
      libcompiler_rt.a
      zig.tar.gz
      meta.json              # id, builtAt, zigVersion, zlsVersion, sizes
    0.15.2/
      …
```

### Asset / git boundary

| In git | Not in git |
|--------|------------|
| Source, `versions.json`, workflows, scripts | `zig-out/`, `dist/`, `public/compilers/**` binaries |
| Design docs | Any `*.wasm`, `zig.tar.gz` history |

CI assembles `dist/` and deploys to GitHub Pages. Contributors clone source only; run `zig build` + package script for local compilers.

Optional later: stable binaries on Release/R2; `meta.json` may grow a `baseUrl` — not required for v1.

## Runtime

### Version resolution (`src/version.ts`)

1. Fetch `/versions.json` (or bundled URL).
2. Parse first path segment of `location.pathname` (strip base if any).
3. If segment is empty → use `default`.
4. If segment is a known `id` → use it.
5. Else → treat as unknown: fall back to `default` and optionally rewrite URL later (v1: fall back quietly).

### Compiler loading

Workers no longer embed `zig-out` via `import.meta.url`. They load:

```
/compilers/<id>/zig.wasm
/compilers/<id>/zls.wasm
/compilers/<id>/libcompiler_rt.a
/compilers/<id>/zig.tar.gz
```

Main thread posts `{ init: { versionId } }` before any compile; workers gate `ensureReady` on init.

### ZIR cache (IndexedDB)

- DB name stays versioned by schema (`zig-playground-zir-v1` or bump to `v2`).
- Keys are **per compiler id**: `meta:<id>`, `blob:<id>` (multi-slot).
- Load/save always pass the active `versionId`. No cross-version reuse of ZIR.

### Share / embed

`location.pathname` already encodes version when user is on `/0.15.2/…`. Share helpers keep current path so links stay on that compiler.

## UI

- Toolbar: `<select id="version-select">` next to examples.
- Options from `versions.json`.
- On change: `location.assign(pathFor(id))` where default may be `/` or `/${id}/` (prefer `/${id}/` always for non-default; default also works at `/`).
- Embed mode: hide version select (host picks URL path).

## Build / package

### Local

```bash
zig build -Doptimize=ReleaseSmall   # or -Drelease
node scripts/package-compiler.mjs --id 0.15.2 --from zig-out
# → public/compilers/0.15.2/*  (Vite publicDir) + meta.json
npm run dev
```

### Production assemble

```bash
# For each id in versions.json that was built:
node scripts/package-compiler.mjs --id <id> --from <out> --to dist/compilers/<id>
npm run build
node scripts/assemble-dist.mjs   # versions.json, per-id index.html, 404.html
```

## CI

### `deploy.yml` (push / PR / manual)

1. Checkout playground (+ zig wasm source as sibling when building).
2. For each **stable** id in `versions.json` (or all non-schedule-only): `zig build` with that version’s deps → package under `dist/compilers/<id>`.
3. Frontend `npm ci && npm run build`.
4. `assemble-dist.mjs`.
5. Upload Pages artifact from `dist/`.

Stable ids rebuild when workflow runs (push to main / versions change). Caching of Zig package cache is encouraged; do not cache final wasm into git.

### `master.yml` (schedule ~every 3 days + manual)

1. Build only `master` compiler pair.
2. Download current Pages artifact or previous deploy if available; else full rebuild of all listed versions.
3. Replace `dist/compilers/master/` only when partial update is feasible; otherwise full matrix.
4. Redeploy Pages.

v1 practical note: if partial Pages download is awkward, master job rebuilds all configured versions (still no git blobs).

## Config: `versions.json`

```json
{
  "default": "0.15.2",
  "versions": [
    {
      "id": "0.15.2",
      "label": "0.15.2"
    },
    {
      "id": "master",
      "label": "master",
      "schedule": "3d"
    }
  ]
}
```

Adding a release = append to `versions` + wire build deps + run CI. No automatic N-latest.

## Error handling

- Missing `/compilers/<id>/…`: worker posts `{ ready: false, error }`; UI status error.
- Corrupt / version-mismatched IDB slot: ignore slot, cold compile, rewrite on success.
- Unknown path segment: fall back to default compiler assets.

## Testing / verification

- Local: package `0.15.2`, open `/`, `/0.15.2/`, switch dropdown, confirm ZIR keys isolated (second version cold vs warm).
- `vite preview` with assembled `dist/`.
- Push to `https://github.com/xihale/zig-playground`; CI green; Pages serves multi-path.

## Implementation order

1. `versions.json` + `src/version.ts`
2. ZIR multi-slot + worker asset URLs + init message
3. Toolbar select + styles
4. Package / assemble scripts + vite publicDir
5. CI workflows + gitignore
6. README

## YAGNI

- No soft navigation / service worker precache of all versions
- No Release CDN until Pages size hurts
- No auto-scrape of Zig tags
