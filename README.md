# Zigtools Playground

Run and explore Zig in your browser, with compiler and LSP support built in.

## Multi-version compilers

**Site:** https://zp.xihale.top/

| Path | Meaning |
|------|---------|
| `/` | Configurable default (`versions.json` → `default`) |
| `/master/` | Tracking build (`schedule: "3d"`, CI + manual) |
| `/0.15.2/` | Pinned release (no `schedule` → rebuild on deploy) |

Shared UI under `/assets/`. Per-version compilers:

```
/compilers/<id>/zig.wasm
/compilers/<id>/zls.wasm
/compilers/<id>/libcompiler_rt.a
/compilers/<id>/zig.tar.gz
```

**Large binaries are never committed.** Browser ZIR cache is keyed per version id.

Design: [`docs/superpowers/specs/2026-07-26-multi-version-compilers-design.md`](docs/superpowers/specs/2026-07-26-multi-version-compilers-design.md)

### How builds are chosen

[`versions.json`](versions.json) is the **build orchestrator**, not only the UI list:

| Field | Role |
|-------|------|
| `default` | `/` resolves to this id |
| `versions[].id` / `label` | URL path + dropdown |
| `versions[].schedule` | If set (e.g. `"3d"`), built by periodic/manual **Master** workflow; if absent, built on every **Deploy** |
| `versions[].zig.path` / `zig.git` | Source for that id (local path preferred) |
| `versions[].zls.url` / `hash` | Paired ZLS package |
| `versions[].zigVersionString` | Passed as `-Dzig-version-string` |

```bash
npm run compilers:plan          # dry-run: who would build
npm run compilers:stable        # no schedule
npm run compilers:scheduled     # has schedule (master, …)
npm run compilers -- --only 0.15.2
```

## Installation

Requires Zig `0.15.2` and (for local path builds) a wasm-capable tree at `../zig-wasm`.

```bash
npm run compilers:stable    # reads versions.json → zig build → public/compilers/<id>
npm install
npm run dev
```

Open `/` or `/0.15.2/`. Toolbar dropdown does full-page navigation.

### Production dist

```bash
npm run compilers:stable    # or :scheduled / --select all
npm run build               # vite + assemble-dist
npm run preview
```

## CI

| Workflow | When compilers are built |
|----------|---------------------------|
| **Deploy** (every push) | **Does not rebuild by default.** Downloads `compilers-latest` Release and only builds frontend. Rebuilds wasm only if `versions.json` / `build.zig*` / compiler scripts changed, or you manually **Run workflow → rebuild_compilers**. |
| **Master compiler** | Builds entries with `schedule` (~every 3 days + **manual**). Stables come from Release. |

So: **compile once, upload Release, reuse forever** until you change the version list or force rebuild.

```bash
# One-time (or when upgrading a pin): produce + publish binaries
npm run compilers -- --select all
tar -C public -czf compilers.tar.gz compilers
gh release upload compilers-latest compilers.tar.gz --clobber
# after that, normal commits only redeploy the UI
```

Optional vars: `COMPILERS_RELEASE`, `VITE_BASE` (default `/` for zp.xihale.top).

Custom domain: `public/CNAME` → `zp.xihale.top` (copied into Pages dist).

Enjoy!
