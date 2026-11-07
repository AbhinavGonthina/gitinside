/**
 * `pnpm --filter @gitinside/eval backtest:followup [owner/name …] [--out <dir>]`: for each
 * replayed repo (a raw file in `eval/backtest/raw/`, or only those named), look for the commit
 * that fixed each flagged break among the commits after its PR's merge, up to the pinned
 * `endSha` (followUp.ts, ADR-0217), and write `<out>/<owner>__<name>.json` (default
 * `eval/backtest/followup/`). A repo with no broken edge gets a file with no PRs and isn't
 * cloned. Commits are checked out of the replay's clone (`eval/.repos/backtest/`) with the
 * replay's fact cache; the analyzer must be the replay's (the PR's own breaks are rebuilt and
 * compared first). A relative `--out` is resolved from the gitinside repo's root, not from
 * `eval/` where pnpm runs the script (`--out eval/dist/followup`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDiskCache } from "@gitinside/analyzer";
import { namedRepos, outDir, ownFiles, takeFlag, thisRun, writeAtomically } from "./cliShared.js";
import { followUpRepo, flaggedPrs } from "./followUp.js";
import { parseBacktestReposFile } from "./format.js";
import {
  committedAt,
  ensureClone,
  gitView,
  laterCommits,
  lineCommits,
  removeStrayWorktrees,
} from "./git.js";
import { parsePrsFile, prsFileName } from "./prs.js";
import { commitOpener, DIRTY_MARK, parseRawFile } from "./replay.js";

const EVAL = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = join(EVAL, "..");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = outDir(ROOT, takeFlag(args, "out"), join(EVAL, "backtest", "followup"));
  const pins = parseBacktestReposFile(
    "backtest/repos.json",
    readFileSync(join(EVAL, "backtest", "repos.json"), "utf8"),
  );
  const repos = namedRepos(pins.repos, args);
  const run = thisRun(ROOT, ownFiles(ROOT, out, repos));
  if (run.gitinside.endsWith(DIRTY_MARK)) {
    process.stderr.write("warning: the tree has uncommitted changes; the results say so\n");
  }
  mkdirSync(out, { recursive: true });
  const cache = await openDiskCache(join(EVAL, ".repos", "backtest-cache"));
  for (const repo of repos) {
    const name = prsFileName(repo);
    const rawPath = join(EVAL, "backtest", "raw", name);
    if (!existsSync(rawPath)) {
      process.stderr.write(`${repo.owner}/${repo.name}: not replayed yet, skipped\n`);
      continue;
    }
    const raw = parseRawFile(`backtest/raw/${name}`, readFileSync(rawPath, "utf8"));
    const prs = parsePrsFile(
      `backtest/prs/${name}`,
      readFileSync(join(EVAL, "backtest", "prs", name), "utf8"),
    );
    const dir = join(EVAL, ".repos", "backtest", `${repo.owner}__${repo.name}`);
    if (flaggedPrs(raw).length > 0) {
      process.stderr.write(`${prs.repo}: cloning or updating ${repo.branch}'s history\n`);
      ensureClone(dir, repo);
      const stray = removeStrayWorktrees(dir);
      if (stray > 0)
        process.stderr.write(`${prs.repo}: removed ${stray} worktrees a stopped run left\n`);
    }
    const view = gitView(dir);
    const file = await followUpRepo(raw, prs, repo, run, {
      open: commitOpener(dir, cache),
      later: (from, to) => laterCommits(dir, from, to),
      line: (from, to) => lineCommits(dir, from, to),
      committedAt: (commit) => committedAt(dir, commit),
      isAncestor: view.isAncestor,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    await writeAtomically(join(out, name), `${JSON.stringify(file, null, 2)}\n`);
    const breaks = file.prs.flatMap((p) => p.breaks);
    process.stdout.write(
      `${prs.repo}: ${file.prs.length} flagged PRs, ${breaks.length} breaks, ${breaks.filter((b) => b.fixed).length} fixed on the branch by endSha, ${breaks.filter((b) => b.offLine).length} cleared first off it\n`,
    );
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
