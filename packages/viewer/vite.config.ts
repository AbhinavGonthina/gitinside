import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Library mode: one ES module bundle for apps/web. React stays external so the
// app supplies a single copy. Types come from tsc (tsconfig.build.json), which
// runs after this and writes into the same dist/. Fontsource stays external
// too: library mode inlines every asset, which would turn ~150 kB of woff2
// subsets into base64 in style.css; the app's bundler emits them as files
// instead (ADR-0047). The tokens are dist/style.css (`@gitinside/viewer/styles.css`).
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime", /^@fontsource-variable\//],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
