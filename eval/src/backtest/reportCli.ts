/**
 * `pnpm --filter @gitinside/eval backtest:report [--check]`: render the PR backtest's report
 * (report.ts, ADR-0219) from the committed files in `eval/backtest/` and
 * `eval/backtest/limitations.md`, and write `eval/backtest/results/<date>.md`, dated by the
 * newest input. Refuses when `validate` would reject the files or the backtest isn't complete.
 *
 * `--check` writes nothing: it renders the report and exits 1 unless the committed file of
 * that name has exactly those bytes. Nothing is analyzed or downloaded, so it takes a second.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { firstDifference } from "../report.js";
import { backtestProblems, loadBacktestInputs } from "./inputs.js";
import { backtestReportFileName, renderBacktestReport } from "./report.js";

const EVAL = fileURLToPath(new URL("../../", import.meta.url));

function main(): void {
  const check = process.argv.includes("--check");
  const inputs = loadBacktestInputs(EVAL);
  const problems = backtestProblems(inputs);
  if (problems.length > 0) throw new Error(`backtest inputs:\n  - ${problems.join("\n  - ")}`);
  const text = renderBacktestReport(
    inputs,
    readFileSync(join(EVAL, "backtest", "limitations.md"), "utf8"),
  );
  const dir = join(EVAL, "backtest", "results");
  const name = backtestReportFileName(inputs);
  const shown = `eval/backtest/results/${name}`;
  const path = join(dir, name);
  if (check) {
    if (!existsSync(path)) throw new Error(`${shown} isn't committed; run backtest:report`);
    const diff = firstDifference(readFileSync(path, "utf8"), text);
    if (diff) {
      throw new Error(
        `${shown} is NOT reproduced. First difference at line ${diff.line}:\n` +
          `  committed:   ${diff.expected}\n  regenerated: ${diff.actual}`,
      );
    }
    process.stdout.write(`${shown} reproduced byte-for-byte\n`);
    return;
  }
  const replaced = existsSync(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, text);
  process.stdout.write(`${replaced ? "replaced" : "wrote"} ${shown}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
