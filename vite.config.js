import { defineConfig } from "vite";
import { resolve } from "node:path";

// Site root (default). Custom domain: zp.xihale.top
// Subpath deploys only: set VITE_BASE=/your-prefix/ in CI.
const base = process.env.VITE_BASE || "/";

const IMMUTABLE_MAX_AGE = 365 * 24 * 60 * 60; // 1y — content-addressed files never change at a URL
const SHORT_MAX_AGE = 24 * 60 * 60; // 1d — manifests: zp-loader.js, versions.json, meta.json

/**
 * Cache-Control for `vite preview`; production is the Caddy site block on
 * zzy_hk (zp.xihale.top), which mirrors these tiers and adds ACAO *:
 *   shell + manifests -> 1d (HTML self-heals via the inline zp-refresh
 *                        script in index.html when hashed assets go missing)
 *   hashed            -> immutable (compiler assets, Vite UI chunks)
 */
function cacheControlForPath(path) {
  // Manifests and the HTML shell: short 1d cache. Stale HTML referencing
  // rsync-deleted assets recovers via the zp-refresh self-heal script.
  if (
    path === "/" ||
    path === "/zp-loader.js" ||
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

// Note: production headers live in the Caddy site block on zzy_hk; these
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
