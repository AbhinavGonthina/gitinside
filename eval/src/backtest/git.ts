/**
 * The backtest's local clones (`eval/.repos/backtest/<owner>__<name>`, gitignored): each pinned
 * repo's branch history without file contents (`--filter=blob:none`), which is all the PR
 * list needs; the replay fetches blobs as it checks commits out. Like the eval's checkouts, a
 * clone is only read: LFS smudging, line-ending conversion, and symlinks are off, and no hook
 * is ever installed in it. The replay's temporary worktrees are added to these clones, so a
 * replay starts by removing any a killed run left ({@link removeStrayWorktrees}).
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
  // Refs from repos.json come after `--end-of-options`, so git never reads one as an option
  // (format.ts also rejects a branch name starting with `-`).
  const fetch = ["fetch", "--quiet", "--filter=blob:none", "--end-of-options", "origin"];
  if (!view.has(repo.endSha)) git(dir, [...fetch, repo.branch]);
  if (!view.has(repo.endSha)) git(dir, [...fetch, repo.endSha]);
}

/** Paths of the git repo at `dir`'s worktrees other than its own checkout. */
function otherWorktrees(dir: string): string[] {
  return git(dir, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .slice(1);
}

/**
 * Remove every worktree of the clone at `dir` but its own checkout, and return how many there
 * were. A replay killed mid-run (a job's timeout, a stopped process) leaves its open sides'
 * worktrees registered, with or without their folders; the replay's own are temporary, so
 * none may outlive a run. Not handled: two replays sharing one clone at once (the second
 * would remove the first's).
 */
export function removeStrayWorktrees(dir: string): number {
  const stray = otherWorktrees(dir);
  // Forget the ones whose folders are already gone, then remove the rest.
  git(dir, ["worktree", "prune"]);
  for (const tree of otherWorktrees(dir)) git(dir, ["worktree", "remove", "--force", tree]);
  return stray.length;
}

/**
 * Whether the git repo at `root` has uncommitted changes (tracked or untracked) other than
 * `own`, repo-relative paths (`/`-separated) that the caller writes itself: a replay's raw
 * files, so a run writing to the tracked `eval/backtest/raw/` can be restarted and still call
 * itself clean. Names are matched literally; an own path outside the repo is ignored.
 */
export function hasChangesBesides(root: string, own: string[]): boolean {
  const excluded = own
    .filter((path) => !path.startsWith("../") && !path.startsWith("/") && !/^[A-Za-z]:/.test(path))
    .map((path) => `:(exclude,literal)${path}`);
  const status = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", ".", ...excluded],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  return status.trim() !== "";
}

/**
 * The commits of the git repo at `dir` that descend from `from` and are `to` or its ancestors
 * (`from` itself left out), oldest first: by commit time, never a commit before one of its
 * parents (`--date-order`). These are every state a fix for a break `from` merged can be in,
 * the branch's direct pushes and PR branches' commits included, up to `to`.
 */
export function laterCommits(dir: string, from: string, to: string): string[] {
  const out = git(dir, [
    "rev-list",
    "--ancestry-path",
    "--date-order",
    "--reverse",
    "--end-of-options",
    `${from}..${to}`,
    "--",
  ]);
  return out.split("\n").filter((line) => line !== "");
}

/**
 * The commits on `to`'s first-parent line that descend from `from` (`from` itself left out),
 * oldest first: the states the branch itself held after it got `from`, not a side branch's
 * commits. When `from` came in under a merge's second parent (a `git pull` merge), the line
 * starts at that merge; first-parent commits before it don't hold `from` and are left out.
 */
export function lineCommits(dir: string, from: string, to: string): string[] {
  const holding = new Set(laterCommits(dir, from, to));
  const out = git(dir, [
    "rev-list",
    "--first-parent",
    "--reverse",
    "--end-of-options",
    `${from}..${to}`,
    "--",
  ]);
  return out.split("\n").filter((line) => line !== "" && holding.has(line));
}

/** When commit `sha` of the git repo at `dir` was committed, in UTC (ISO 8601, to the second). */
export function committedAt(dir: string, sha: string): string {
  const seconds = Number(
    git(dir, ["show", "-s", "--format=%ct", "--end-of-options", sha, "--"]).trim(),
  );
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

/** A {@link GitView} over the git repo at `dir`. */
export function gitView(dir: string): GitView {
  return {
    // `rev-parse --verify --quiet` exits 1 for an unknown object (`cat-file -e` exits 128).
    has: (sha) =>
      succeeds(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`]),
    parents: (sha) => {
      const [, ...parents] = git(dir, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        "--end-of-options",
        sha,
        "--",
      ])
        .trim()
        .split(" ");
      return parents;
    },
    isAncestor: (ancestor, descendant) =>
      succeeds(dir, ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant]),
    firstParentMessages: (sha, count) =>
      git(dir, [
        "log",
        "--first-parent",
        "--format=%B%x00",
        "-n",
        String(count),
        "--end-of-options",
        sha,
        "--",
      ])
        .split("\0")
        .slice(0, -1)
        .map((m) => m.replace(/^\n/, ""))
        .reverse(),
    firstParentAncestor: (sha, steps) => {
      const lines = git(dir, [
        "rev-list",
        "--first-parent",
        "-n",
        String(steps + 1),
        "--end-of-options",
        sha,
        "--",
      ])
        .trim()
        .split("\n");
      return lines.length === steps + 1 ? lines[steps] : undefined;
    },
  };
}
