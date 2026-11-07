/**
 * `pnpm --filter @gitinside/eval validate`: check `eval/repos.json` and every label file
 * against the formats in docs/EVALUATION.md, then cross-check them, and every draw record in
 * `eval/draws/` (draw.ts) against its rule and `repos.json`, plus the backtest's
 * `eval/backtest/repos.json` (backtest/format.ts), its PR files (backtest/prs.ts), and the
 * replay's raw results (backtest/replay.ts), the follow-up files (backtest/followUp.ts), and
 * the classification files (backtest/classify.ts), read through backtest/inputs.ts. Exits 1 on
 * any problem.
 */
import { fileURLToPath } from "node:url";
import { classifiedCounts } from "./backtest/classify.js";
import { backtestProblems, loadBacktestInputs } from "./backtest/inputs.js";
import { drawCrossCheck, loadDrawFiles } from "./draw.js";
import { EvalInputError } from "./format.js";
import { crossCheck, loadEvalInputs } from "./inputs.js";

const root = fileURLToPath(new URL("..", import.meta.url));

try {
  const inputs = loadEvalInputs(root);
  const draws = loadDrawFiles(root);
  const backtest = loadBacktestInputs(root);
  const problems = [
    ...backtestProblems(backtest),
    ...crossCheck(inputs),
    ...draws.flatMap(({ file, draw }) =>
      drawCrossCheck(
        draw,
        inputs.repos,
        draws.map((d) => d.draw),
      ).map((p) => `draws/${file}: ${p}`),
    ),
  ];
  for (const p of problems) console.error(`  - ${p}`);
  if (problems.length > 0) process.exit(1);
  const all = [...inputs.labels.values()].flatMap((l) => l.edges.map((e) => ({ repo: l.repo, e })));
  const sites = new Set(all.map(({ repo, e }) => JSON.stringify([repo, e.callSite]))).size;
  const classified = classifiedCounts(backtest.classified.map((c) => c.file));
  console.log(
    `eval inputs OK: ${inputs.repos.length} repos, ${inputs.labels.size} label files, ${all.length} labels at ${sites} call sites, ${draws.length} draw records, ${backtest.repos.repos.length} backtest repos, ${backtest.prs.reduce((n, p) => n + p.file.prs.length, 0)} backtest PRs in ${backtest.prs.length} files, ${backtest.raw.reduce((n, r) => n + r.file.prs.length, 0)} replayed in ${backtest.raw.length} raw files, ${backtest.followUp.reduce((n, f) => n + f.file.prs.length, 0)} flagged PRs followed up in ${backtest.followUp.length} files, ${classified.breaks} breaks classified (${classified.verdicts.true} true, ${classified.verdicts.false} false, ${classified.verdicts.unclear} unclear; ${classified.reviewed} reviewed)`,
  );
} catch (error) {
  if (!(error instanceof EvalInputError)) throw error;
  console.error(error.message);
  process.exit(1);
}
