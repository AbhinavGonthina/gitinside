import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYZER_VERSION } from "@gitinside/analyzer";
import {
  BENCH,
  benchRepos,
  checkout,
  flag,
  git,
  gitinsideCommit,
  machine,
  today,
  type BenchRepo,
} from "./env.js";
import {
  renderIncrementalReport,
  summarizeCase,
  type IncrementalCase,
} from "./incrementalReport.js";
import type { RunResult } from "./report.js";

// Full vs incremental analysis benchmark (M6.8, EVALUATION.md §2) on the first repo in
// bench/repos.json: `analyze` with no cache (cold) against `analyze` with a disk fact cache
// (warm), each run in a fresh Node process. Two modes:
//
// - Default: the cache is filled from the pinned tree; then nothing changed, and a one-line
//   edit to each file in EDITS (restored after each pair). Writes
//   bench/results/<date>-incremental-<name>.{md,json}.
// - `--commits`: the COMMITS first-parent commits after the pinned SHA on the default branch,
//   checked out one at a time in a separate full-history checkout, the cache carried from one
//   commit to the next (filled at the pinned SHA). Writes <date>-incremental-<name>-commits.*.
//
// The checkouts are only read (and briefly appended to); nothing in them is installed or run.
//
// Usage: pnpm bench:incremental [--commits] [--runs 5] [--label "<machine label>"]

const RUN_ONCE = fileURLToPath(new URL("./run-once.js", import.meta.url));
const WARMUP_RUNS = 1;
/** Real commits replayed in `--commits` mode (EVALUATION.md §2). */
const COMMITS = 10;

/** Files edited, one per case: a leaf app, and a package nearly every service imports. */
const EDITS: Record<string, { title: string; file: string }[]> = {
  calcom: [
    { title: "One leaf app edited", file: "apps/api/v2/src/main.ts" },
    { title: "A shared package edited", file: "packages/lib/constants.ts" },
  ],
};

/** One analyze run in a fresh Node process, with the fact cache in `cacheDir` if given. */
function runOnce(dir: string, repo: BenchRepo, cacheDir?: string): RunResult {
  const args = [RUN_ONCE, dir, repo.owner, repo.repo, repo.sha];
  if (cacheDir !== undefined) args.push("--cache", cacheDir);
  const out = execFileSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out) as RunResult;
}

/**
 * One cold and one warm run on the same tree, cold first when `coldFirst`, so that a machine
 * getting slower or faster over the benchmark doesn't favor one side.
 */
function pair(
  dir: string,
  repo: BenchRepo,
  cacheDir: string,
  coldFirst: boolean,
): { cold: RunResult; warm: RunResult } {
  if (coldFirst) {
    const cold = runOnce(dir, repo);
    return { cold, warm: runOnce(dir, repo, cacheDir) };
  }
  const warm = runOnce(dir, repo, cacheDir);
  return { cold: runOnce(dir, repo), warm };
}

function log(repo: BenchRepo, what: string, r: RunResult): void {
  const c = r.cache;
  const cache = c ? ` (hits ${c.hits}, misses ${c.misses}, writes ${c.writes})` : "";
  process.stderr.write(`${repo.name}: ${what} ${Math.round(r.totalMs)} ms${cache}\n`);
}

/** The default mode's cases: nothing changed, then each file in EDITS. */
async function editCases(
  dir: string,
  repo: BenchRepo,
  cacheDir: string,
  runs: number,
): Promise<IncrementalCase[]> {
  const edits = EDITS[repo.name];
  if (!edits) throw new Error(`no files to edit are listed for ${repo.name}`);
  const unchanged: IncrementalCase = { title: "Nothing changed", cold: [], warm: [] };
  for (let i = 0; i < runs; i++) {
    const { cold, warm } = pair(dir, repo, cacheDir, i % 2 === 0);
    log(repo, `unchanged ${i + 1} cold`, cold);
    log(repo, `unchanged ${i + 1} warm`, warm);
    unchanged.cold.push(cold);
    unchanged.warm.push(warm);
  }
  const cases = [unchanged];
  for (const { title, file } of edits) {
    const path = join(dir, file);
    const original = await readFile(path);
    const c: IncrementalCase = { title, edit: file, cold: [], warm: [] };
    for (let i = 0; i < runs; i++) {
      // A new constant per pair: the warm run must not find this exact edit in the cache.
      await writeFile(
        path,
        `${original.toString("utf8")}\nexport const gitinsideBench${i} = ${i};\n`,
      );
      try {
        const { cold, warm } = pair(dir, repo, cacheDir, i % 2 === 0);
        log(repo, `${file} ${i + 1} cold`, cold);
        log(repo, `${file} ${i + 1} warm`, warm);
        c.cold.push(cold);
        c.warm.push(warm);
      } finally {
        await writeFile(path, original);
      }
    }
    cases.push(c);
  }
  return cases;
}

/**
 * A checkout of `repo`'s default branch back to a day before its pinned commit, in
 * bench/.repos/<name>-history, and the `count` commits that follow the pinned one on the
 * branch's first-parent line, oldest first. Throws if the pinned commit isn't on that line.
 */
function historyCheckout(repo: BenchRepo, pinnedDate: string, count: number): string[] {
  const dir = join(BENCH, ".repos", `${repo.name}-history`);
  if (!existsSync(join(dir, ".git"))) {
    execFileSync("git", ["init", "--quiet", dir]);
    git(dir, ["remote", "add", "origin", repo.url]);
  }
  const since = new Date(Date.parse(pinnedDate) - 24 * 60 * 60 * 1000).toISOString();
  git(dir, ["fetch", "--quiet", `--shallow-since=${since}`, "origin", "HEAD"]);
  const line = git(dir, ["rev-list", "--first-parent", "--reverse", `${repo.sha}..FETCH_HEAD`]);
  const commits = line.split("\n").filter(Boolean).slice(0, count);
  const first = commits[0];
  if (commits.length < count || !first || git(dir, ["rev-parse", `${first}^`]) !== repo.sha) {
    throw new Error(`${repo.sha} isn't followed by ${count} first-parent commits on the branch`);
  }
  return commits;
}

/** The `--commits` mode's case: each commit after the pinned SHA, the cache carried along. */
function commitCase(
  dir: string,
  repo: BenchRepo,
  cacheDir: string,
  commits: string[],
): IncrementalCase {
  const c: IncrementalCase = {
    title: `${commits.length} consecutive commits`,
    commits,
    cold: [],
    warm: [],
  };
  commits.forEach((sha, i) => {
    git(dir, ["checkout", "--quiet", "--detach", "--force", sha]);
    const { cold, warm } = pair(dir, { ...repo, sha }, cacheDir, i % 2 === 0);
    log(repo, `${sha.slice(0, 7)} cold`, cold);
    log(repo, `${sha.slice(0, 7)} warm`, warm);
    c.cold.push(cold);
    c.warm.push(warm);
  });
  return c;
}

async function main(): Promise<void> {
  const label = flag("label", "dev machine");
  const runs = Number(flag("runs", "5"));
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const commitsMode = process.argv.includes("--commits");
  const repo = (await benchRepos())[0];
  if (!repo) throw new Error("bench/repos.json lists no analysis repo");
  const gitinsideSha = gitinsideCommit();
  const date = today();

  process.stderr.write(`${repo.name}: checking out ${repo.sha}\n`);
  let dir = await checkout(repo);
  let commits: string[] = [];
  if (commitsMode) {
    commits = historyCheckout(repo, git(dir, ["log", "-1", "--format=%cI"]), COMMITS);
    dir = join(BENCH, ".repos", `${repo.name}-history`);
    git(dir, ["checkout", "--quiet", "--detach", "--force", repo.sha]);
  }
  const cacheDir = join(BENCH, ".repos", `${repo.name}${commitsMode ? "-history" : ""}-cache`);
  await rm(cacheDir, { recursive: true, force: true });

  for (let i = 0; i < WARMUP_RUNS; i++) log(repo, "warm-up (cold)", runOnce(dir, repo));
  const fill = runOnce(dir, repo, cacheDir);
  log(repo, "filling the cache", fill);

  const cases = commitsMode
    ? [commitCase(dir, repo, cacheDir, commits)]
    : await editCases(dir, repo, cacheDir, runs);

  const meta = {
    date,
    repo: { name: repo.name, url: repo.url, sha: repo.sha },
    gitinsideSha,
    analyzerVersion: ANALYZER_VERSION,
    warmupRuns: WARMUP_RUNS,
    machine: machine(label),
    fill,
  };
  const summaries = cases.map(summarizeCase);
  await mkdir(join(BENCH, "results"), { recursive: true });
  const name = `${date}-incremental-${repo.name}${commitsMode ? "-commits" : ""}`;
  const base = join(BENCH, "results", name);
  await writeFile(`${base}.json`, `${JSON.stringify({ meta, summaries, cases }, null, 2)}\n`);
  await writeFile(`${base}.md`, renderIncrementalReport(meta, summaries));
  process.stderr.write(`${repo.name}: wrote ${base}.md\n`);
}

await main();
