import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // validate.ts, run.ts, review.ts, and drawCli.ts are thin CLIs (git checkouts, GitHub
      // search, file IO) over inputs.ts, score.ts, report.ts, sample.ts, and draw.ts, which the
      // tests cover; `pnpm eval --check` exercises run.ts end to end. The backtest's four
      // commands (backtest/*Cli.ts) are thin too: they clone repos, ask GitHub, and analyze
      // hundreds of commits through prs.ts, replay.ts, followUp.ts, and report.ts, and take
      // their arguments (repos named, --limit, where --out lands) through cliShared.ts, all
      // tested; report.test.ts renders the committed report as reportCli.ts does (M7 review F9).
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/validate.ts",
        "src/run.ts",
        "src/review.ts",
        "src/drawCli.ts",
        "src/backtest/listCli.ts",
        "src/backtest/replayCli.ts",
        "src/backtest/followUpCli.ts",
        "src/backtest/reportCli.ts",
      ],
      thresholds: { lines: 70 },
    },
  },
});
