import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Library mode: one ES module bundle for apps/web. React stays external so the
// app supplies a single copy. Types come from tsc (tsconfig.build.json), which
// runs after this and writes into the same dist/. Fontsource stays external
// too: library mode inlines every asset, which would turn ~150 kB of woff2
// subsets into base64 in style.css; the app's bundler emits them as files
// instead (ADR-0047). The tokens are dist/style.css (`@gitinside/viewer/styles.css`).
// simple-icons is bundled: only the logos brands.ts names survive tree-shaking
// (ADR-0048). The schema (a dependency: types plus `compareStrings`) stays external.
// Three entries: `index` (components, no CSS imports left, so plain Node can
// import it), `fonts` (only the Fontsource imports; ADR-0056), and `image`
// (the README badge and live image as SVG text, for server code; ADR-0071).
// `index` starts with "use client": its components use hooks, so React Server
// Components (apps/web) must treat the bundle as client code; server
// components can still render them with serializable props.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: { index: "src/index.ts", fonts: "src/fonts.ts", image: "src/image.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        /^@fontsource-variable\//,
        /^@gitinside\//,
      ],
      output: {
        banner: (chunk) => (chunk.name === "index" ? '"use client";' : ""),
      },
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
