import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { analyze } from "./analyze.js";

const execFileAsync = promisify(execFile);

/** One side of `gitinside diff`: its graph and, for trees on disk, its file text. */
export interface DiffSide {
  graph: ArchitectureGraph;
  /** Text of a repo-relative file, or `undefined` when unknown (a graph file, a missing path). */
  read: (path: string) => string | undefined;
  /** Remove the side's temporary worktree, if it has one. Safe to call more than once. */
  close: () => Promise<void>;
}

/** Text of `path` under `root`, or `undefined` if it's missing or escapes `root`. */
function treeReader(root: string): (path: string) => string | undefined {
  const top = resolve(root);
  return (path) => {
    const full = resolve(top, path);
    if (!full.startsWith(top + sep)) return undefined;
    try {
      return readFileSync(full, "utf8");
    } catch {
      return undefined;
    }
  };
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

/** The full SHA `ref` names in `repo`, or `undefined` if it names no commit there. */
async function commitOf(repo: string, ref: string): Promise<string | undefined> {
  try {
    const sha = await git(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check `sha` out into a fresh temporary `git worktree` and analyze it. The checkout
 * runs with an empty hooks folder, so no repo or user hook runs (SECURITY.md: the code is
 * parsed, never executed); the worktree is removed again by `close`.
 */
async function openCommit(repo: string, sha: string): Promise<DiffSide> {
  const scratch = await mkdtemp(join(tmpdir(), "gitinside-diff-"));
  const hooks = join(scratch, "hooks");
  const tree = join(scratch, "tree");
  let added = false;
  const close = async (): Promise<void> => {
    if (added) {
      added = false;
      await git(repo, ["worktree", "remove", "--force", tree]).catch(() => undefined);
    }
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    await mkdir(hooks);
    await git(repo, [
      "-c",
      `core.hooksPath=${hooks}`,
      "worktree",
      "add",
      "--detach",
      "--quiet",
      tree,
      sha,
    ]);
    added = true;
    return { graph: await analyze(tree, { sha }), read: treeReader(tree), close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Open one side of a diff from `spec`, tried in this order:
 * 1. A file: a graph written by `gitinside analyze` (no file text, so renames are found
 *    only for unchanged files).
 * 2. A folder: analyzed as it is on disk.
 * 3. A commit, branch, or tag in the git repo at `repo`: checked out into a temporary
 *    worktree and analyzed, with the full SHA recorded in the graph.
 *
 * Throws when `spec` is none of these, or when the graph or analysis fails.
 */
export async function openSide(spec: string, repo: string): Promise<DiffSide> {
  const info = await stat(spec).catch(() => undefined);
  const none = async (): Promise<void> => undefined;
  if (info?.isFile()) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(spec, "utf8"));
    } catch (error) {
      throw new Error(
        `${spec} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = parseGraphOrUndefined(value);
    if (parsed === undefined) throw new Error(`${spec} is not a GitInside architecture graph`);
    return { graph: parsed, read: () => undefined, close: none };
  }
  if (info?.isDirectory())
    return { graph: await analyze(spec), read: treeReader(spec), close: none };
  const sha = await commitOf(repo, spec);
  if (sha === undefined) {
    throw new Error(`${spec} is not a file, a folder, or a commit in the git repo at ${repo}`);
  }
  return openCommit(repo, sha);
}

function parseGraphOrUndefined(value: unknown): ArchitectureGraph | undefined {
  try {
    return parseGraph(value);
  } catch {
    return undefined;
  }
}
