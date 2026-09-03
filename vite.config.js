import { defineConfig } from "vite";
import { resolve } from "node:path";

// Site root (default). Custom domain: zp.xihale.top
// Subpath deploys only: set VITE_BASE=/your-prefix/ in CI.
const base = process.env.VITE_BASE || "/";

const IMMUTABLE_MAX_AGE = 365 * 24 * 60 * 60; // 1y — content-addressed files never change at a URL
const SHORT_MAX_AGE = 5 * 24 * 60 * 60; // 5d — manifests: versions.json, meta.json

/**
 * Cache-Control for `vite preview`; production is the Caddy site block on
 * gx (zp.xihale.top), which mirrors these tiers and adds ACAO *:
 *   zp-loader.js      -> no-cache (fixed-name remote code, byte-pinned by
 *                        consumers via loaderSha256; must revalidate so a
 *                        re-pin never races a stale browser cache)
 *   shell + manifests -> 5d (retired hashed assets survive in the server-side
 *                        attic ~7d — deploy.sh — so a cached shell never 404s)
 *   hashed            -> immutable (compiler assets, Vite UI chunks)
 */
function cacheControlForPath(path) {
  // zp-loader.js: fixed-name SDK consumed cross-site and byte-pinned by
  // consumers (loaderSha256) — revalidate always, else a consumer's re-pin
  // fails against a stale browser cache (fail-closed = bricked compiler).
  if (path === "/zp-loader.js") {
    return "no-cache";
  }

  // Manifests and the HTML shell: 5d cache. Must stay below the server-side
  // retired-asset retention (scripts/server/deploy.sh attic, ~7d).
  if (
    path === "/" ||
    path.endsWith(".html") ||
    path.endsWith("versions.json") ||
    path.endsWith("/meta.json")
  ) {
    return `public, max-age=${SHORT_MAX_AGE}`;
  }

  // Compiler assets under /compilers/<id>/ are filename-hashed → immutable.
  // meta.json (the one fixed-name file) is handled by the no-cache branch above.
  if (/\/compilers\/[^/]+\//.test(path)) {
    return `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`;
  }

  // Vite content-hashed UI chunks under /assets/
  if (/\.(?:js|css|wasm|a|gz|svg|png|woff2?)$/i.test(path)) {
    return `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`;
  }

  return null;
}

// Note: production headers live in the Caddy site block on gx; these
// apply to `vite preview`. Client-side longevity for compilers is handled by
// src/compiler-cache.ts (Cache Storage).
export default defineConfig({
  base,
  publicDir: "public",
  plugins: [
    {
      name: "cache-control-headers",
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0] ?? "";
          const cc = cacheControlForPath(path);
          if (cc) res.setHeader("Cache-Control", cc);
          next();
        });
      },
      configureServer(server) {
        // Dev: SPA fallback for /master/, /0.15.2/ so path routing works.
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0] ?? "";
          if (
            path !== "/" &&
            !path.includes(".") &&
            !path.startsWith("/src") &&
            !path.startsWith("/@") &&
            !path.startsWith("/node_modules") &&
            !path.includes("/compilers")
          ) {
            req.url = "/index.html";
          }
          next();
        });
      },
    },
  ],
  build: {
    // Keep multi-MB wasm/tar as separate files (never inlined).
    assetsInlineLimit: 0,
  },
  root: resolve("."),
});
