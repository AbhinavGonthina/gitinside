/**
 * `pnpm --filter @gitinside/eval backtest:replay [owner/name …] [--limit <n>] [--out <dir>]`:
 * replay the pinned PRs (replay.ts, ADR-0216). For each repo with a PR file in
 * `eval/backtest/prs/` (or only those named), make sure its clone in `eval/.repos/backtest/`
 * holds `endSha`, then analyze and diff each PR's base and merge commits with one fact cache
 * (`eval/.repos/backtest-cache/`), writing `<out>/<owner>__<name>.json` (default
 * `eval/backtest/raw/`) after every PR. An existing raw file is continued if the same clean
 * gitinside commit wrote it, and refused otherwise; the raw files a run writes don't make the
 * tree dirty, so a restart with the default `--out` resumes. Worktrees a killed run left in a
 * clone are removed first. `--limit` stops after that many PRs per repo, for a smoke run
 * (write it to a gitignored `--out`). A relative `--out` is resolved from the gitinside repo's
 * root, not from `eval/` where pnpm runs the script (`--out eval/dist/raw`).
 * `.github/workflows/backtest-replay.yml` runs it on GitHub's runners, one job per repo.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDiskCache } from "@gitinside/analyzer";
import {
  namedRepos,
  outDir,
  ownFiles,
  parseLimit,
  takeFlag,
  thisRun,
  writeAtomically,
} from "./cliShared.js";
import { parseBacktestReposFile } from "./format.js";
import { ensureClone, removeStrayWorktrees } from "./git.js";
import { parsePrsFile, prsFileName } from "./prs.js";
import {
  cannotResume,
  commitOpener,
  DIRTY_MARK,
  parseRawFile,
  replayRepo,
  type RawFile,
} from "./replay.js";

const EVAL = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = join(EVAL, "..");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limit = parseLimit(takeFlag(args, "limit"));
  const out = outDir(ROOT, takeFlag(args, "out"), join(EVAL, "backtest", "raw"));
  const pins = parseBacktestReposFile(
    "backtest/repos.json",
    readFileSync(join(EVAL, "backtest", "repos.json"), "utf8"),
  );
  const repos = namedRepos(pins.repos, args);
  // A restarted run sees its own raw files as changes; they mustn't make it call itself dirty.
  const run = thisRun(ROOT, ownFiles(ROOT, out, repos));
  if (run.gitinside.endsWith(DIRTY_MARK)) {
    process.stderr.write("warning: the tree has uncommitted changes; the results say so\n");
  }
  mkdirSync(out, { recursive: true });
  const cache = await openDiskCache(join(EVAL, ".repos", "backtest-cache"));
  for (const repo of repos) {
    const name = prsFileName(repo);
    const prs = parsePrsFile(
      `backtest/prs/${name}`,
      readFileSync(join(EVAL, "backtest", "prs", name), "utf8"),
    );
    const path = join(out, name);
    let previous: RawFile | undefined;
    if (existsSync(path)) {
      previous = parseRawFile(path, readFileSync(path, "utf8"));
      const why = cannotResume(previous, run);
      if (why !== undefined) {
        throw new Error(`${path} can't be continued (${why}); delete it to start over`);
      }
    }
    const dir = join(EVAL, ".repos", "backtest", `${repo.owner}__${repo.name}`);
    process.stderr.write(`${prs.repo}: cloning or updating ${repo.branch}'s history\n`);
    ensureClone(dir, repo);
    const stray = removeStrayWorktrees(dir);
    if (stray > 0)
      process.stderr.write(`${prs.repo}: removed ${stray} worktrees a stopped run left\n`);
    const raw = await replayRepo(
      prs,
      // A continued file keeps the run line of the run that started it (same commit and machine).
      previous?.run ?? run,
      {
        open: commitOpener(dir, cache),
        save: (file) => writeAtomically(path, `${JSON.stringify(file, null, 2)}\n`),
        log: (line) => process.stderr.write(`${line}\n`),
      },
      { ...(previous ? { previous } : {}), ...(limit === undefined ? {} : { limit }) },
    );
    const diffed = raw.prs.filter((p) => p.outcome === "diffed");
    const broken = diffed.reduce((n, p) => n + p.broken.length, 0);
    process.stdout.write(
      `${prs.repo}: ${raw.prs.length} of ${prs.prs.length} replayed, ${raw.prs.length - diffed.length} failed, ${broken} broken edges\n`,
    );
  }
  const stats = cache.stats();
  process.stderr.write(`fact cache: ${stats.hits} hits, ${stats.misses} misses\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
