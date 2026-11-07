/**
 * What the backtest's commands share: the run line they record (ADR-0216), their arguments
 * and flags, and how they save files. The commands themselves (`*Cli.ts`) are thin wiring of
 * these and the tested modules to the clone, GitHub, and the disk.
 */
import { execFileSync } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { ANALYZER_VERSION } from "@gitinside/analyzer";
import { hasChangesBesides } from "./git.js";
import { prsFileName } from "./prs.js";
import { DIRTY_MARK, type ReplayRun } from "./replay.js";

/** Today's local date as YYYY-MM-DD. */
function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * This run, from the gitinside repo at `root`: its commit (marked if the tree has changes
 * besides `own`, the repo-relative files the run writes), analyzer, machine, day.
 */
export function thisRun(root: string, own: string[]): ReplayRun {
  const dirty = hasChangesBesides(root, own);
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const cpu = cpus();
  return {
    gitinside: `${head}${dirty ? DIRTY_MARK : ""}`,
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
export function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  args.splice(at, 2);
  return value;
}

/**
 * The pinned repos the command's arguments name (`owner/name`, any case), in pin order, or
 * every pin when they name none. Throws, listing them, when a name isn't pinned.
 */
export function namedRepos<R extends { owner: string; name: string }>(
  pinned: readonly R[],
  args: readonly string[],
): R[] {
  const key = (r: { owner: string; name: string }): string => `${r.owner}/${r.name}`.toLowerCase();
  const asked = new Set(args.map((a) => a.toLowerCase()));
  const unknown = [...asked].filter((a) => !pinned.some((r) => key(r) === a));
  if (unknown.length > 0) throw new Error(`not pinned: ${unknown.join(", ")}`);
  return pinned.filter((r) => asked.size === 0 || asked.has(key(r)));
}

/**
 * `--limit`'s value as a whole number of at least 1, or `undefined` when it's absent.
 */
export function parseLimit(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const limit = Number(text);
  if (!(Number.isInteger(limit) && limit >= 1)) {
    throw new Error("--limit must be a whole number of at least 1");
  }
  return limit;
}

/**
 * The folder `--out` names, `fallback` when it's absent. A relative one is resolved from the
 * gitinside repo's `root`, not the working directory: pnpm runs the commands in `eval/`, so
 * `--out eval/dist/x` means the same from anywhere.
 */
export function outDir(root: string, value: string | undefined, fallback: string): string {
  return resolve(root, value ?? fallback);
}

/**
 * The files a run writes in `out` for `repos`, relative to `root` with forward slashes, as
 * `thisRun` takes them (a file outside the repo comes out starting with `../`, or as another
 * drive's absolute path, and git can't see it anyway).
 */
export function ownFiles(
  root: string,
  out: string,
  repos: readonly { owner: string; name: string }[],
): string[] {
  return repos.map((r) =>
    relative(root, join(out, prsFileName(r)))
      .split(sep)
      .join("/"),
  );
}

/** Write via a sibling temp file and a rename, so a stopped run never leaves half a file. */
export async function writeAtomically(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
