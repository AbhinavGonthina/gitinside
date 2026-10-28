/**
 * `pnpm --filter @gitinside/eval review-sample --seed <YYYY-MM-DD> [--out <file>]`: print (or
 * write) the owner's label review sample as a Markdown checklist (sample.ts). The seed is the
 * date the review issue is opened, so the list in the issue can be regenerated exactly.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { labelFileName, type EvalRepo, type LabelFile } from "./format.js";
import { crossCheck, loadEvalInputs } from "./inputs.js";
import { drawReviewSample, renderReviewSample } from "./sample.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function option(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
}

try {
  const seed = option("--seed") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(seed)) {
    throw new Error("--seed <YYYY-MM-DD> is required: the date the review issue is opened");
  }
  const inputs = loadEvalInputs(root);
  const problems = crossCheck(inputs);
  const entries: { repo: EvalRepo; labels: LabelFile }[] = [];
  for (const repo of inputs.repos) {
    const labels = inputs.labels.get(labelFileName(repo.owner, repo.name));
    if (labels) entries.push({ repo, labels });
    else problems.push(`${repo.owner}/${repo.name} has no label file`);
  }
  if (problems.length > 0) throw new Error(`eval inputs:\n  - ${problems.join("\n  - ")}`);
  const text = renderReviewSample(drawReviewSample(entries, seed), seed);
  const out = option("--out");
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
