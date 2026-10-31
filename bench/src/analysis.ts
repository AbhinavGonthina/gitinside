import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
import { renderReport, summarize, type RunResult } from "./report.js";

// Analysis-time benchmark (EVALUATION.md §2): for each repo in bench/repos.json, check out the
// pinned SHA under bench/.repos/ (gitignored), run `analyze` once to warm up and then
// MEASURED_RUNS times, each in a fresh process, and write bench/results/<date>-analysis-<name>.{md,json}.
// The checked-out repo is only read by the analyzer; nothing in it is installed or executed.
//
// Usage: pnpm bench [--label "<machine label>"]

const RUN_ONCE = fileURLToPath(new URL("./run-once.js", import.meta.url));
const WARMUP_RUNS = 1;
const MEASURED_RUNS = 5;

/** One analyze run in a fresh Node process. */
function runOnce(dir: string, repo: BenchRepo): RunResult {
  const out = execFileSync(process.execPath, [RUN_ONCE, dir, repo.owner, repo.repo, repo.sha], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out) as RunResult;
}

async function main(): Promise<void> {
  const label = flag("label", "dev machine");
  const repos = await benchRepos();
  const gitinsideSha = gitinsideCommit();
  const date = today();
  await mkdir(join(BENCH, "results"), { recursive: true });

  for (const repo of repos) {
    process.stderr.write(`${repo.name}: checking out ${repo.sha}\n`);
    const dir = await checkout(repo);
    const runs: RunResult[] = [];
    for (let i = 0; i < WARMUP_RUNS + MEASURED_RUNS; i++) {
      const run = runOnce(dir, repo);
      const kind = i < WARMUP_RUNS ? "warm-up" : `run ${i - WARMUP_RUNS + 1}`;
      process.stderr.write(`${repo.name}: ${kind} ${Math.round(run.totalMs)} ms\n`);
      if (i >= WARMUP_RUNS) runs.push(run);
    }
    const meta = {
      date,
      repo: { name: repo.name, url: repo.url, sha: repo.sha },
      gitinsideSha,
      analyzerVersion: ANALYZER_VERSION,
      warmupRuns: WARMUP_RUNS,
      machine: machine(label),
    };
    const summary = summarize(runs);
    const base = join(BENCH, "results", `${date}-analysis-${repo.name}`);
    await writeFile(`${base}.json`, `${JSON.stringify({ meta, summary, runs }, null, 2)}\n`);
    await writeFile(`${base}.md`, renderReport(meta, summary));
    process.stderr.write(`${repo.name}: wrote ${base}.md\n`);
  }
}

await main();
