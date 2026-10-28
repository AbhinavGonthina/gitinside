import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./vitest.globalSetup.ts"],
    // Runner tests start real child processes (one analyzes a fixture repo).
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.testkit.ts"],
      thresholds: { lines: 70 },
    },
  },
});
