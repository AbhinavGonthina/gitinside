/**
 * `pnpm --filter @gitinside/eval backtest:replay [owner/name …] [--limit <n>] [--out <dir>]`:
 * replay the pinned PRs (replay.ts, ADR-0216). For each repo with a PR file in
 * `eval/backtest/prs/` (or only those named), make sure its clone in `eval/.repos/backtest/`
 * holds `endSha`, then analyze and diff each PR's base and merge commits with one fact cache
 * (`eval/.repos/backtest-cache/`), writing `<out>/<owner>__<name>.json` (default
 * `eval/backtest/raw/`) after every PR. An existing raw file is continued if the same clean
 * gitinside commit wrote it, and refused otherwise. `--limit` stops after that many PRs per
 * repo, for a smoke run (write it to a gitignored `--out`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYZER_VERSION, openDiskCache } from "@gitinside/analyzer";
import { parseBacktestReposFile } from "./format.js";
import { ensureClone } from "./git.js";
import { parsePrsFile, prsFileName } from "./prs.js";
import {
  cannotResume,
  commitOpener,
  DIRTY_MARK,
  parseRawFile,
  replayRepo,
  type RawFile,
  type ReplayRun,
} from "./replay.js";

const EVAL = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = join(EVAL, "..");

function git(args: string[]): string {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

/** Today's local date as YYYY-MM-DD. */
function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** This run: the gitinside commit (marked if the tree has changes), analyzer, machine, day. */
function thisRun(): ReplayRun {
  const dirty = git(["status", "--porcelain"]) !== "";
  const cpu = cpus();
  return {
    gitinside: `${git(["rev-parse", "HEAD"])}${dirty ? DIRTY_MARK : ""}`,
    analyzerVersion: ANALYZER_VERSION,
    started: today(),
    machine: {
      cpu: cpu[0]?.model.trim() ?? "unknown",
      cores: cpu.length,
      ramGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      os: `${platform()} ${release()}`,
      node: process.version,
    },
  };
}

/** The value after `--<name>`, removed from `args`, or `undefined`. */
function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  args.splice(at, 2);
  return value;
}

/** Write via a sibling temp file and a rename, so a stopped run never leaves half a file. */
async function writeAtomically(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitText = takeFlag(args, "limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) {
    throw new Error("--limit must be a whole number of at least 1");
  }
  const out = resolve(ROOT, takeFlag(args, "out") ?? join(EVAL, "backtest", "raw"));
  const asked = args.map((a) => a.toLowerCase());
  const pins = parseBacktestReposFile(
    "backtest/repos.json",
    readFileSync(join(EVAL, "backtest", "repos.json"), "utf8"),
  );
  const repos = pins.repos.filter(
    (r) => asked.length === 0 || asked.includes(`${r.owner}/${r.name}`.toLowerCase()),
  );
  if (repos.length < asked.length)
    throw new Error(`not every repo named is pinned: ${asked.join(", ")}`);
  const run = thisRun();
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
