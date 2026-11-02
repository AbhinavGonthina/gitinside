import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYZER_VERSION } from "@gitinside/analyzer";
import {
  BENCH,
  benchRepos,
  checkout,
  flag,
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

// Full vs incremental analysis benchmark (M6.8, EVALUATION.md §2): on the first repo in
// bench/repos.json, compare `analyze` with no cache against `analyze` with a disk fact cache
// filled from the unedited tree, when nothing changed and after a one-line edit to each file
// in EDITS. Writes bench/results/<date>-incremental-<name>.{md,json}. The checkout is only read
// and briefly appended to (restored after each pair); nothing in it is installed or run.
//
// Usage: pnpm bench:incremental [--runs 5] [--label "<machine label>"]

const RUN_ONCE = fileURLToPath(new URL("./run-once.js", import.meta.url));
const WARMUP_RUNS = 1;

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
  const cache = r.cache ? ` (hits ${r.cache.hits}, misses ${r.cache.misses})` : "";
  process.stderr.write(`${repo.name}: ${what} ${Math.round(r.totalMs)} ms${cache}\n`);
}

async function main(): Promise<void> {
  const label = flag("label", "dev machine");
  const runs = Number(flag("runs", "5"));
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const repo = (await benchRepos())[0];
  if (!repo) throw new Error("bench/repos.json lists no analysis repo");
  const edits = EDITS[repo.name];
  if (!edits) throw new Error(`no files to edit are listed for ${repo.name}`);
  const gitinsideSha = gitinsideCommit();
  const date = today();

  process.stderr.write(`${repo.name}: checking out ${repo.sha}\n`);
  const dir = await checkout(repo);
  const cacheDir = join(BENCH, ".repos", `${repo.name}-cache`);
  await rm(cacheDir, { recursive: true, force: true });

  for (let i = 0; i < WARMUP_RUNS; i++) log(repo, "warm-up (cold)", runOnce(dir, repo));
  const fill = runOnce(dir, repo, cacheDir);
  log(repo, "filling the cache", fill);

  const cases: IncrementalCase[] = [];
  const unchanged: IncrementalCase = { title: "Nothing changed", cold: [], warm: [] };
  for (let i = 0; i < runs; i++) {
    const { cold, warm } = pair(dir, repo, cacheDir, i % 2 === 0);
    log(repo, `unchanged ${i + 1} cold`, cold);
    log(repo, `unchanged ${i + 1} warm`, warm);
    unchanged.cold.push(cold);
    unchanged.warm.push(warm);
  }
  cases.push(unchanged);

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
  const base = join(BENCH, "results", `${date}-incremental-${repo.name}`);
  await writeFile(`${base}.json`, `${JSON.stringify({ meta, summaries, cases }, null, 2)}\n`);
  await writeFile(`${base}.md`, renderIncrementalReport(meta, summaries));
  process.stderr.write(`${repo.name}: wrote ${base}.md\n`);
}

await main();
