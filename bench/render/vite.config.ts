import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the render benchmark's page into render/dist (gitignored). Relative
// asset paths, so src/render.ts can serve the folder from any port.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  worker: { format: "es" },
});
