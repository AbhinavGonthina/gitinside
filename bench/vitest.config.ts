import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // The CLI entry points clone repos and spawn processes; the logic they use lives in
      // report.ts, which is what the unit tests cover.
      include: ["src/report.ts"],
      thresholds: { lines: 70 },
    },
  },
});
