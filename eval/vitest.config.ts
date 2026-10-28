import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // validate.ts, run.ts, and review.ts are thin CLIs (git checkouts, file IO) over inputs.ts,
      // score.ts, report.ts, and sample.ts, which the tests cover; `pnpm eval --check`
      // exercises run.ts end to end.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/validate.ts", "src/run.ts", "src/review.ts"],
      thresholds: { lines: 70 },
    },
  },
});
