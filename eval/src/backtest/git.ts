/**
 * The backtest's local clones (`eval/.repos/backtest/<owner>__<name>`, gitignored): each pinned
 * repo's branch history without file contents (`--filter=blob:none`), which is all the PR
 * list needs; the replay fetches blobs as it checks commits out. Like the eval's checkouts, a
 * clone is only read: LFS smudging, line-ending conversion, and symlinks are off, and no hook
 * is ever installed in it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BacktestRepo } from "./format.js";
import type { GitView } from "./prs.js";

const CONFIG = [
  "filter.lfs.smudge=",
  "filter.lfs.required=false",
  "core.autocrlf=false",
  "core.symlinks=false",
];

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...CONFIG.flatMap((c) => ["-c", c]), ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Whether `git` exits 0, for commands that answer yes or no by exit code. */
function succeeds(dir: string, args: string[]): boolean {
  try {
    git(dir, args);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

/**
 * Make sure `dir` holds a blobless clone of `repo`'s branch that contains `repo.endSha`,
 * cloning or fetching as needed.
 */
export function ensureClone(
  dir: string,
  repo: Pick<BacktestRepo, "url" | "branch" | "endSha">,
): void {
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    const config = CONFIG.flatMap((c) => ["--config", c]);
    execFileSync(
      "git",
      ["clone", "--quiet", "--filter=blob:none", "--no-checkout", "--single-branch"].concat([
        "--branch",
        repo.branch,
        ...config,
        "--",
        repo.url,
        dir,
      ]),
      { stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
    );
  }
  const view = gitView(dir);
  if (!view.has(repo.endSha)) {
    git(dir, ["fetch", "--quiet", "--filter=blob:none", "origin", repo.branch]);
  }
  if (!view.has(repo.endSha))
    git(dir, ["fetch", "--quiet", "--filter=blob:none", "origin", repo.endSha]);
}

/** A {@link GitView} over the git repo at `dir`. */
export function gitView(dir: string): GitView {
  return {
    // `rev-parse --verify --quiet` exits 1 for an unknown object (`cat-file -e` exits 128).
    has: (sha) =>
      succeeds(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`]),
    parents: (sha) => {
      const [, ...parents] = git(dir, ["rev-list", "--parents", "-n", "1", sha, "--"])
        .trim()
        .split(" ");
      return parents;
    },
    isAncestor: (ancestor, descendant) =>
      succeeds(dir, ["merge-base", "--is-ancestor", ancestor, descendant]),
    firstParentMessages: (sha, count) =>
      git(dir, ["log", "--first-parent", "--format=%B%x00", "-n", String(count), sha, "--"])
        .split("\0")
        .slice(0, -1)
        .map((m) => m.replace(/^\n/, ""))
        .reverse(),
    firstParentAncestor: (sha, steps) => {
      const lines = git(dir, ["rev-list", "--first-parent", "-n", String(steps + 1), sha, "--"])
        .trim()
        .split("\n");
      return lines.length === steps + 1 ? lines[steps] : undefined;
    },
  };
}
