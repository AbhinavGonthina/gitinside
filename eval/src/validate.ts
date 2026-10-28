/**
 * `pnpm --filter @gitinside/eval validate`: check `eval/repos.json` and every label file
 * against the formats in docs/EVALUATION.md, then cross-check them. Exits 1 on any problem.
 */
import { fileURLToPath } from "node:url";
import { EvalInputError } from "./format.js";
import { crossCheck, loadEvalInputs } from "./inputs.js";

const root = fileURLToPath(new URL("..", import.meta.url));

try {
  const inputs = loadEvalInputs(root);
  const problems = crossCheck(inputs);
  for (const p of problems) console.error(`  - ${p}`);
  if (problems.length > 0) process.exit(1);
  const all = [...inputs.labels.values()].flatMap((l) => l.edges.map((e) => ({ repo: l.repo, e })));
  const sites = new Set(all.map(({ repo, e }) => JSON.stringify([repo, e.callSite]))).size;
  console.log(
    `eval inputs OK: ${inputs.repos.length} repos, ${inputs.labels.size} label files, ${all.length} labels at ${sites} call sites`,
  );
} catch (error) {
  if (!(error instanceof EvalInputError)) throw error;
  console.error(error.message);
  process.exit(1);
}
