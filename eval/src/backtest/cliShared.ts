/**
 * What the backtest's commands that analyze commits share: the run line they record (ADR-0216),
 * their flags, and how they save files.
 */
import { execFileSync } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { ANALYZER_VERSION } from "@gitinside/analyzer";
import { hasChangesBesides } from "./git.js";
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
