# Zigtools Playground

Run and explore Zig in your browser, with compiler and LSP support built in.

## Multi-version compilers

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

| Workflow | Selects from `versions.json` |
|----------|------------------------------|
| **Deploy** | `--select stable` (no `schedule`), then `fill-compilers-from-release` for gaps |
| **Master compiler (periodic)** | `--select scheduled` (~every 3 days + **manual** `workflow_dispatch`), fill stables from release |

**Compiler assets are not in git.** Publish a release for fill/fallback:

```bash
npm run compilers -- --select all
tar -C public -czf compilers.tar.gz compilers
gh release upload compilers-latest compilers.tar.gz --clobber
```

Optional vars: `COMPILERS_RELEASE`, `VITE_BASE`.

Enjoy!
