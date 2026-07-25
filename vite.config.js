import { defineConfig } from "vite";

// Hashed build assets (*.wasm, zig.tar.gz, …) are safe to cache for a long time.
// index.html stays short-lived so clients discover new hashes after deploy.
export default defineConfig({
  plugins: [
    {
      name: "long-cache-hashed-assets",
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split("?")[0] ?? "";
          if (path === "/" || path.endsWith(".html")) {
            res.setHeader("Cache-Control", "no-cache");
          } else if (/\.(?:wasm|js|css|a|gz|svg|png|woff2?)$/i.test(path)) {
            res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
          }
          next();
        });
      },
    },
  ],
  build: {
    // Keep multi-MB wasm/tar as separate hashed files (never inlined).
    assetsInlineLimit: 0,
  },
});
