import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The testkit is test code (the property tests' generators), built only so the viewer can share it.
      exclude: ["src/**/*.test.ts", "src/testkit.ts"],
      thresholds: { lines: 85 },
    },
  },
});
