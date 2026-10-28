import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Library mode: one ES module bundle for apps/web. React stays external so the
// app supplies a single copy. Types come from tsc (tsconfig.build.json), which
// runs after this and writes into the same dist/.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
