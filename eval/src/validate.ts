/**
 * `pnpm --filter @gitinside/eval validate`: check `eval/repos.json` and every label file
 * against the formats in docs/EVALUATION.md, then cross-check them, and every draw record in
 * `eval/draws/` (draw.ts) against its rule and `repos.json`, plus the backtest's
 * `eval/backtest/repos.json` (backtest/format.ts). Exits 1 on any problem.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBacktestReposFile } from "./backtest/format.js";
import { parsePrsFile, prsCrossCheck } from "./backtest/prs.js";
import { drawCrossCheck, loadDrawFiles } from "./draw.js";
import { EvalInputError } from "./format.js";
import { crossCheck, loadEvalInputs } from "./inputs.js";

const root = fileURLToPath(new URL("..", import.meta.url));

try {
  const inputs = loadEvalInputs(root);
  const draws = loadDrawFiles(root);
  const backtest = parseBacktestReposFile(
    "backtest/repos.json",
    readFileSync(join(root, "backtest", "repos.json"), "utf8"),
  );
  const prsDir = join(root, "backtest", "prs");
  const prFiles = (existsSync(prsDir) ? readdirSync(prsDir) : [])
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      f,
      file: parsePrsFile(`backtest/prs/${f}`, readFileSync(join(prsDir, f), "utf8")),
    }));
  const problems = [
    ...prFiles.flatMap(({ f, file }) =>
      prsCrossCheck(file, backtest, f).map((p) => `backtest/prs/${f}: ${p}`),
    ),
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
  console.log(
    `eval inputs OK: ${inputs.repos.length} repos, ${inputs.labels.size} label files, ${all.length} labels at ${sites} call sites, ${draws.length} draw records, ${backtest.repos.length} backtest repos, ${prFiles.reduce((n, p) => n + p.file.prs.length, 0)} backtest PRs in ${prFiles.length} files`,
  );
} catch (error) {
  if (!(error instanceof EvalInputError)) throw error;
  console.error(error.message);
  process.exit(1);
}
