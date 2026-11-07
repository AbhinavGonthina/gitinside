import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasChangesBesides, removeStrayWorktrees } from "./git.js";

let scratch: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "gitinside-backtest-git-"));
  repo = join(scratch, "repo");
  await mkdir(join(repo, "raw"), { recursive: true });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  const hooks = join(scratch, "hooks");
  await mkdir(hooks);
  git("config", "core.hooksPath", hooks);
  await writeFile(join(repo, "raw", "a__done.json"), "{}\n");
  await writeFile(join(repo, "README.md"), "# test\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "start");
}, 30_000);

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Worktrees of the test repo, its own checkout included. */
const worktrees = (): number =>
  git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

describe("removeStrayWorktrees", () => {
  it("removes the worktrees a killed run left, whether their folders remain or not", async () => {
    const kept = join(scratch, "kept");
    const gone = join(scratch, "gone");
    git("worktree", "add", "--detach", "--quiet", kept, "HEAD");
    git("worktree", "add", "--detach", "--quiet", gone, "HEAD");
    await writeFile(join(kept, "README.md"), "# edited in the worktree\n");
    await rm(gone, { recursive: true, force: true });
    expect(worktrees()).toBe(3);

    expect(removeStrayWorktrees(repo)).toBe(2);
    expect(worktrees()).toBe(1);
    expect(existsSync(kept)).toBe(false);
    // The repo's own checkout is untouched.
    expect(git("status", "--porcelain")).toBe("");
  }, 30_000);

  it("does nothing when there's no other worktree", () => {
    expect(removeStrayWorktrees(repo)).toBe(0);
    expect(worktrees()).toBe(1);
  });
});

describe("hasChangesBesides", () => {
  it("is false for a clean tree", () => {
    expect(hasChangesBesides(repo, ["raw/b__new.json"])).toBe(false);
  });

  it("ignores the run's own raw files, untracked or modified", async () => {
    await writeFile(join(repo, "raw", "b__new.json"), "{}\n");
    await writeFile(join(repo, "raw", "a__done.json"), '{ "more": true }\n');
    expect(hasChangesBesides(repo, ["raw/a__done.json", "raw/b__new.json"])).toBe(false);
  });

  it("counts any other change, another raw file included", async () => {
    await writeFile(join(repo, "raw", "b__new.json"), "{}\n");
    expect(hasChangesBesides(repo, [])).toBe(true);
    expect(hasChangesBesides(repo, ["raw/c__other.json"])).toBe(true);
    await writeFile(join(repo, "README.md"), "# edited\n");
    expect(hasChangesBesides(repo, ["raw/b__new.json"])).toBe(true);
  });

  it("ignores an own file outside the repo and reads names literally", async () => {
    await writeFile(join(repo, "raw", "b__new.json"), "{}\n");
    // A glob character in an own file's name must not hide other files.
    expect(hasChangesBesides(repo, ["raw/*.json", "../elsewhere.json"])).toBe(true);
  });
});
