import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYZER_VERSION } from "@gitinside/analyzer";
import { renderReport, summarize, type Machine, type RunResult } from "./report.js";

// Analysis-time benchmark (EVALUATION.md §2): for each repo in bench/repos.json, check out the
// pinned SHA under bench/.repos/ (gitignored), run `analyze` once to warm up and then
// MEASURED_RUNS times, each in a fresh process, and write bench/results/<date>-analysis-<name>.{md,json}.
// The checked-out repo is only read by the analyzer; nothing in it is installed or executed.
//
// Usage: pnpm bench [--label "<machine label>"]

const BENCH = fileURLToPath(new URL("../", import.meta.url));
const RUN_ONCE = fileURLToPath(new URL("./run-once.js", import.meta.url));
const WARMUP_RUNS = 1;
const MEASURED_RUNS = 5;

interface BenchRepo {
  name: string;
  url: string;
  owner: string;
  repo: string;
  sha: string;
}

/** Run git with LFS smudging off, so checkout never downloads or runs anything extra. */
function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  ).trim();
}

/** Shallow-fetch exactly `sha` into bench/.repos/<name>, reusing an existing checkout. */
async function checkout(repo: BenchRepo): Promise<string> {
  const dir = join(BENCH, ".repos", repo.name);
  if (existsSync(join(dir, ".git")) && git(dir, ["rev-parse", "HEAD"]) === repo.sha) return dir;
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    git(dir, ["init", "--quiet"]);
    git(dir, ["remote", "add", "origin", repo.url]);
  }
  git(dir, ["fetch", "--quiet", "--depth", "1", "origin", repo.sha]);
  git(dir, ["checkout", "--quiet", "--detach", "--force", "FETCH_HEAD"]);
  return dir;
}

/** One analyze run in a fresh Node process. */
function runOnce(dir: string, repo: BenchRepo): RunResult {
  const out = execFileSync(process.execPath, [RUN_ONCE, dir, repo.owner, repo.repo, repo.sha], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out) as RunResult;
}

/** Describe this machine; `label` says which one it is (dev machine, Oracle VM). */
function machine(label: string): Machine {
  const cpu = cpus();
  return {
    label,
    cpu: cpu[0]?.model.trim() ?? "unknown",
    cores: cpu.length,
    ramGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    os: `${platform()} ${release()}`,
    node: process.version,
  };
}

/** Today's local date as YYYY-MM-DD. Benchmarks are dated; graphs never are. */
function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function main(): Promise<void> {
  const labelAt = process.argv.indexOf("--label");
  const label = labelAt >= 0 ? (process.argv[labelAt + 1] ?? "") : "dev machine";
  const repos = (
    JSON.parse(await readFile(join(BENCH, "repos.json"), "utf8")) as {
      analysis: BenchRepo[];
    }
  ).analysis;
  // Results are only reproducible from a commit, so say when the tree had local changes.
  const dirty = git(BENCH, ["status", "--porcelain"]) !== "";
  const gitinsideSha = `${git(BENCH, ["rev-parse", "HEAD"])}${dirty ? " + uncommitted changes" : ""}`;
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
