import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // The CLI entry points clone repos, spawn processes, and drive a browser; the logic
      // they use lives in these modules, which is what the unit tests cover.
      include: ["src/report.ts", "src/fps.ts", "src/renderGraphs.ts", "src/renderReport.ts"],
      thresholds: { lines: 70 },
    },
  },
});
