/**
 * `pnpm --filter @gitinside/eval validate`: check `eval/repos.json` and every label file
 * against the formats in docs/EVALUATION.md, then cross-check them, and every draw record in
 * `eval/draws/` (draw.ts) against its rule and `repos.json`, plus the backtest's
 * `eval/backtest/repos.json` (backtest/format.ts), its PR files (backtest/prs.ts), and the
 * replay's raw results (backtest/replay.ts), the follow-up files (backtest/followUp.ts), and
 * the classification files (backtest/classify.ts). Exits 1 on any problem.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifiedCounts, classifyCrossCheck, parseClassifiedFile } from "./backtest/classify.js";
import { followUpCrossCheck, parseFollowUpFile } from "./backtest/followUp.js";
import { parseBacktestReposFile } from "./backtest/format.js";
import { parsePrsFile, prsCrossCheck } from "./backtest/prs.js";
import { parseRawFile, rawCrossCheck } from "./backtest/replay.js";
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
  const rawDir = join(root, "backtest", "raw");
  const rawFiles = (existsSync(rawDir) ? readdirSync(rawDir) : [])
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      f,
      file: parseRawFile(`backtest/raw/${f}`, readFileSync(join(rawDir, f), "utf8")),
    }));
  const followUpDir = join(root, "backtest", "followup");
  const followUpFiles = (existsSync(followUpDir) ? readdirSync(followUpDir) : [])
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      f,
      file: parseFollowUpFile(`backtest/followup/${f}`, readFileSync(join(followUpDir, f), "utf8")),
    }));
  const classifiedDir = join(root, "backtest", "classified");
  const classifiedFiles = (existsSync(classifiedDir) ? readdirSync(classifiedDir) : [])
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      f,
      file: parseClassifiedFile(
        `backtest/classified/${f}`,
        readFileSync(join(classifiedDir, f), "utf8"),
      ),
    }));
  const problems = [
    ...classifiedFiles.flatMap(({ f, file }) => {
      const followUp = followUpFiles.find((u) => u.f === f);
      if (!followUp)
        return [`backtest/classified/${f}: there's no backtest/followup/${f} it classifies`];
      return classifyCrossCheck(file, followUp.file).map((p) => `backtest/classified/${f}: ${p}`);
    }),
    // Every flagged break gets a verdict.
    ...followUpFiles
      .filter(({ f, file }) => file.prs.length > 0 && !classifiedFiles.some((c) => c.f === f))
      .map(
        ({ f }) => `backtest/followup/${f}: its flagged breaks have no backtest/classified/${f}`,
      ),
    ...followUpFiles.flatMap(({ f, file }) => {
      const raw = rawFiles.find((r) => r.f === f);
      if (!raw) return [`backtest/followup/${f}: there's no backtest/raw/${f} it follows up`];
      const pin = backtest.repos.find((r) => `${r.owner}/${r.name}` === file.repo);
      if (!pin) return [`backtest/followup/${f}: ${file.repo} isn't pinned`];
      return followUpCrossCheck(file, raw.file, pin).map((p) => `backtest/followup/${f}: ${p}`);
    }),
    ...prFiles.flatMap(({ f, file }) =>
      prsCrossCheck(file, backtest, f).map((p) => `backtest/prs/${f}: ${p}`),
    ),
    ...rawFiles.flatMap(({ f, file }) => {
      const prs = prFiles.find((p) => p.f === f);
      if (!prs) return [`backtest/raw/${f}: there's no backtest/prs/${f} it replays`];
      return rawCrossCheck(file, prs.file).map((p) => `backtest/raw/${f}: ${p}`);
    }),
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
  const classified = classifiedCounts(classifiedFiles.map((c) => c.file));
  console.log(
    `eval inputs OK: ${inputs.repos.length} repos, ${inputs.labels.size} label files, ${all.length} labels at ${sites} call sites, ${draws.length} draw records, ${backtest.repos.length} backtest repos, ${prFiles.reduce((n, p) => n + p.file.prs.length, 0)} backtest PRs in ${prFiles.length} files, ${rawFiles.reduce((n, r) => n + r.file.prs.length, 0)} replayed in ${rawFiles.length} raw files, ${followUpFiles.reduce((n, f) => n + f.file.prs.length, 0)} flagged PRs followed up in ${followUpFiles.length} files, ${classified.breaks} breaks classified (${classified.verdicts.true} true, ${classified.verdicts.false} false, ${classified.verdicts.unclear} unclear; ${classified.reviewed} reviewed)`,
  );
} catch (error) {
  if (!(error instanceof EvalInputError)) throw error;
  console.error(error.message);
  process.exit(1);
}
