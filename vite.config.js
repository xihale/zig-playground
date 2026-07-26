import { defineConfig } from "vite";
import { resolve } from "node:path";

// GitHub project Pages: set VITE_BASE=/zig-playground/ in CI.
// Local / custom domain: leave unset (defaults to "/").
const base = process.env.VITE_BASE || "/";

// Hashed build assets (*.wasm under /compilers, UI chunks, …) are safe to cache.
// index.html stays short-lived so clients discover new hashes after deploy.
export default defineConfig({
  base,
  publicDir: "public",
  plugins: [
    {
      name: "long-cache-hashed-assets",
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0] ?? "";
          if (path === "/" || path.endsWith(".html") || path.endsWith("versions.json")) {
            res.setHeader("Cache-Control", "no-cache");
          } else if (path.includes("/compilers/")) {
            // Versioned compiler trees: long cache; replace whole tree on upgrade.
            res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
          } else if (/\.(?:wasm|js|css|a|gz|svg|png|woff2?)$/i.test(path)) {
            res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
          }
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
