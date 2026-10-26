import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The first test in each worker builds a ts.Program and parses TypeScript's bundled lib
    // files, which takes 2–5 s on its own and more when turbo runs packages in parallel with
    // coverage on. 5 s (the default) made those first tests time out without failing.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 85 },
    },
  },
});
