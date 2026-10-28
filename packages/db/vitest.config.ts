import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Each file migrates its own database (PGlite in WASM, or a fresh
    // database on TEST_DATABASE_URL); the first PGlite start is slow.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.testkit.ts"],
      thresholds: { lines: 70 },
    },
  },
});
