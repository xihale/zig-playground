# Zigtools Playground

Run and explore Zig in your browser, with compiler and LSP support built in.

## Multi-version compilers

| Path | Meaning |
|------|---------|
| `/` | Configurable default (`versions.json` → `default`) |
| `/master/` | Tracking build (CI ~every 3 days) |
| `/0.15.2/` | Pinned release |

Shared UI assets live under `/assets/`. Each compiler (Zig + paired ZLS + std tarball) lives under:

```
/compilers/<id>/zig.wasm
/compilers/<id>/zls.wasm
/compilers/<id>/libcompiler_rt.a
/compilers/<id>/zig.tar.gz
```

**Large binaries are never committed.** Package them locally or in CI; only source + `versions.json` stay in git. Browser ZIR cache is keyed per version id (IndexedDB).

Design: [`docs/superpowers/specs/2026-07-26-multi-version-compilers-design.md`](docs/superpowers/specs/2026-07-26-multi-version-compilers-design.md)

## Installation

You can either:

- Use it online: https://playground.zigtools.org/ (upstream) or your Pages deploy
- Run it locally:

Requires Zig `0.15.2` and a wasm-capable Zig tree at `../zig-wasm` (see `build.zig.zon`). Compiles Zig + ZLS for WebAssembly.

```bash
zig build -Doptimize=ReleaseSmall
node scripts/package-compiler.mjs --id 0.15.2
npm install
npm run dev
```

Open `/` or `/0.15.2/`. Switch versions via the toolbar dropdown (full page navigation).

### Production dist

```bash
zig build -Doptimize=ReleaseSmall -Dwasm-opt   # optional wasm-opt
node scripts/package-compiler.mjs --id 0.15.2
# optionally also package master after a master build:
# node scripts/package-compiler.mjs --id master
npm run build   # vite build + assemble-dist (per-id index.html, 404.html)
npm run preview
```

## Version list

Edit [`versions.json`](versions.json):

```json
{
  "default": "0.15.2",
  "versions": [
    { "id": "0.15.2", "label": "0.15.2" },
    { "id": "master", "label": "master", "schedule": "3d" }
  ]
}
```

## CI

- `deploy.yml` — try source build (`zig build -Drelease`), else download release tag `compilers-latest`; deploy Pages on `main`/`master`
- `master.yml` — schedule `0 0 */3 * *` rebuilds `master` and redeploys

**Compiler assets are not in git.** After a local package:

```bash
node scripts/package-compiler.mjs --id 0.15.2
tar -C public -czf compilers.tar.gz compilers
gh release create compilers-latest compilers.tar.gz --notes "wasm trees for CI/Pages"
# or: gh release upload compilers-latest compilers.tar.gz --clobber
```

Optional repo variables: `ZIG_WASM_REPO`, `ZIG_WASM_REF`, `COMPILERS_RELEASE`.

Enjoy!
