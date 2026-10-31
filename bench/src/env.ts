import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Machine } from "./report.js";

// What the benchmarks share: the pinned repos, their checkouts, the machine, the date.

/** The bench package's folder. */
export const BENCH = fileURLToPath(new URL("../", import.meta.url));

/** A pinned public repo from bench/repos.json. */
export interface BenchRepo {
  name: string;
  url: string;
  owner: string;
  repo: string;
  sha: string;
}

/** The repos the analysis benchmark runs on (bench/repos.json `analysis`). */
export async function benchRepos(): Promise<BenchRepo[]> {
  return (
    JSON.parse(await readFile(join(BENCH, "repos.json"), "utf8")) as { analysis: BenchRepo[] }
  ).analysis;
}

/** Run git with LFS smudging off, so checkout never downloads or runs anything extra. */
export function git(cwd: string, args: string[]): string {
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
export async function checkout(repo: BenchRepo): Promise<string> {
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

/** This commit, marked when the tree has local changes (results only reproduce from a commit). */
export function gitinsideCommit(): string {
  const dirty = git(BENCH, ["status", "--porcelain"]) !== "";
  return `${git(BENCH, ["rev-parse", "HEAD"])}${dirty ? " + uncommitted changes" : ""}`;
}

/** Describe this machine; `label` says which one it is (dev machine, Oracle VM). */
export function machine(label: string): Machine {
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
export function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The value after `--<name>` on the command line, or `fallback`. */
export function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}
