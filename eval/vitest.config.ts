import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // validate.ts and run.ts are thin CLIs (git checkouts, file IO) over inputs.ts, score.ts,
      // and report.ts, which the tests cover; `pnpm eval --check` exercises run.ts end to end.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/validate.ts", "src/run.ts"],
      thresholds: { lines: 70 },
    },
  },
});
