# Zigtools Playground

Run and explore Zig in your browser, with compiler and LSP support built in.

## Multi-version compilers

**Site:** https://zp.xihale.top/

| Path | Meaning |
|------|---------|
| `/` | Configurable default (`versions.json` → `default`, currently **0.16.0**) |
| `/0.16.0/` | Current stable pin (same binaries as `/`) |
| `/0.15.2/` | Older pin (binaries from Release; rebuild only when forced/missing) |

Shared UI under `/assets/`. Per-version compilers:

```
/compilers/<id>/zig.<hash>.wasm
/compilers/<id>/zls.<hash>.wasm
/compilers/<id>/libcompiler_rt.<hash>.a
/compilers/<id>/zig.<hash>.tar.gz
/compilers/<id>/meta.json
```

Compiler asset filenames carry a content hash so the CDN (Cloudflare) can cache
them immutably; `meta.json` maps logical names → hashed filenames (the one
fixed-name file). **Large binaries are never committed.**

Design: [`docs/superpowers/specs/2026-07-26-multi-version-compilers-design.md`](docs/superpowers/specs/2026-07-26-multi-version-compilers-design.md)

## Consume the compilers from another site

This site also ships a small ESM **loader** — `https://zp.xihale.top/zp-loader.js` —
so other projects can fetch these compilers without re-implementing the
hash-filename / `meta.json` / Cache-Storage logic. Import it directly (works in
Web Workers):

```js
import {
  fetchCompilerFile,
  compileCompilerWasm,
  getZigLibDir,
  listVersions,
} from "https://zp.xihale.top/zp-loader.js";
```

Always pass **logical** names — the loader resolves the content-hash filename
from each version's `meta.json`:

| Logical name | What |
|--------------|------|
| `zig.wasm` | the compiler |
| `zls.wasm` | the language server |
| `libcompiler_rt.a` | compiler-rt archive |
| `zig.tar.gz` | the standard-library tree |

### Examples

```js
// 1) List the published versions (cache: no-store).
const { default: def, versions } = await listVersions();
// → { default: "0.16.0", versions: [{id:"0.16.0",label:"0.16.0"}, …] }

// 2) Compile zig.wasm + load the std-lib tree for a version.
const zigModule = await compileCompilerWasm("0.16.0", "zig.wasm");
const stdLibDir = await getZigLibDir("0.16.0"); // WASI Directory from zig.tar.gz

// 3) Fetch any logical file as bytes (e.g. compiler-rt).
const crt = await fetchCompilerFile("0.16.0", "libcompiler_rt.a");
```

**Notes:**
- Cross-origin fetch is permitted (the host serves permissive CORS). Large assets
  are cached by the loader via Cache Storage keyed by the hashed URL, so a hit is
  always the right bytes — offline-friendly after first load.
- `meta.json` is always revalidated (`cache: "no-store"`), so new builds are
  visible without a cache-bust.
- **Self-hosting:** call `configure({ origin: "https://your.host" })` once before
  any other call to point at your own `/compilers/<id>/…` tree. The default
  origin is the loader's own host (`zp.xihale.top`).

### How builds are chosen

[`versions.json`](versions.json) is the **build orchestrator**, not only the UI list:

| Field | Role |
|-------|------|
| `default` | `/` resolves to this id |
| `versions[].id` / `label` | URL path + dropdown |
| `versions[].zig.path` / `zig.git` | Source for that id (local path preferred; else clone `git.ref`) |
| `versions[].zig.patch` | Optional repo-relative patch applied after clone (CI) |
| `versions[].zls.url` / `hash` | Paired ZLS package |
| `versions[].zigVersionString` | Passed as `-Dzig-version-string` |

**Source trees (do not use GitHub `ziglang/zig` master — it is a Codeberg stub):**

| id | build | git | hostZig | notes |
|----|-------|-----|---------|-------|
| `0.16.0` | **`in-tree`** | **`codeberg.org/ziglang/zig@0.16.0`** | `0.16.0` | zig.wasm in-tree + ZLS 0.16.0 (Zig is not a package from 0.16) |
| `0.15.2` | `playground` | `github.com/ziglang/zig@0.15.2` | `0.15.2` | full zig+zls via repo `build.zig` |

Local overrides: `../zig-0.16.0`, `../zig-wasm` (0.15.2). Hosts via `zvm i 0.16.0`.

(A `master` tracking build existed until 2026-08; re-enable by restoring the
versions.json entry — the toolchain in scripts/ still supports
`schedule`/`hostZig: master` in-tree builds.)

```bash
npm run compilers:plan          # dry-run: who would build
npm run compilers:stable        # all pinned versions
npm run compilers -- --only 0.16.0
```

## Installation

Requires host Zig matching each pin (`0.16.0` for the default; `0.15.2` if building that pin). Install with `zvm i 0.16.0`.

```bash
npm run compilers:stable    # reads versions.json → zig build → public/compilers/<id>
npm install
npm run dev
```

Open `/` (→ 0.16.0) or `/0.16.0/` / `/0.15.2/`. Toolbar dropdown does full-page navigation.

### Production dist

```bash
npm run compilers:stable    # or :scheduled / --select all
npm run build               # vite + assemble-dist
npm run preview
```

## CI

| Workflow | When compilers are built |
|----------|---------------------------|
| **Deploy** (every push) | **Reuses Release.** Downloads per-version `<id>.tar.gz` from `compilers` → only builds frontend. Source rebuild only if an id is missing after download, or **Run workflow → rebuild_compilers**. |
| **Master compiler** | Builds `schedule` ids with **hostZig=master** from Codeberg (~every 3 days + **manual**). On success, uploads only `master.tar.gz` to the `compilers` Release — stable pins stay untouched. |

So: **compile once, upload Release, reuse forever** until you force rebuild or the release is incomplete.

```bash
# One-time (or when upgrading a pin): produce + publish binaries.
# Each version id becomes its own <id>.tar.gz on the `compilers` release
# (archives are flat — files at the root, no top-level dir).
npm run compilers -- --select all
for id in $(node -e 'console.log(require("./versions.json").versions.map(v=>v.id).join(" "))'); do
  tar -C "public/compilers/$id" -czf "$id.tar.gz" .
  gh release upload compilers "$id.tar.gz" --clobber
done
# after that, normal commits only redeploy the UI
```

Optional vars: `COMPILERS_RELEASE`, `VITE_BASE` (default `/` for zp.xihale.top).

Hosting: push webhook → socket-activated receiver on the gx VPS → `deploy.sh`
(see `scripts/server/README.md`).

Enjoy!
