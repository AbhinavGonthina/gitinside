import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // validate.ts is a thin CLI over inputs.ts, which the tests cover.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/validate.ts"],
      thresholds: { lines: 70 },
    },
  },
});
