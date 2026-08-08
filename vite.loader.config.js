import { defineConfig } from "vite";

/**
 * Second Vite build (library mode) that bundles `src/loader.ts` into a single
 * self-contained ESM module served at `/zp-loader.js`.
 *
 * Run AFTER the main app build (see `build` script in package.json). The main
 * config emits `dist/`; this appends `dist/zp-loader.js` without clobbering it
 * (`emptyOutDir: false`).
 *
 * Output is un-minified on purpose: it's a small, readable SDK consumers link
 * to directly, and its filename is fixed (no content hash), so it must
 * revalidate (Cache-Control handled in vite.config.js / Pages).
 */
export default defineConfig({
  // `root` must match the app build so `src/` resolves the same way.
  build: {
    lib: {
      entry: "src/loader.ts",
      formats: ["es"],
      fileName: () => "zp-loader.js",
    },
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    // Keep multi-MB deps (untar.js, browser_wasi_shim) as they are small here;
    // bundle everything into the single file — consumers want one import.
    rollupOptions: {
      output: {
        // Single self-contained file: no chunk splitting, no hash in name.
        // (`codeSplitting: false` is the current API; `inlineDynamicImports`
        // is the deprecated alias Vite warns about.)
        codeSplitting: false,
      },
    },
  },
});
