import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffGraphs, renderMermaidSummary } from "@gitinside/diff";
import {
  parseGraph,
  parseGraphDiff,
  stringifyDiff,
  stringifyGraph,
  type ArchitectureGraph,
} from "@gitinside/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { openSide } from "./revisions.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const baseDir = join(FIXTURES, "diff-broken-base");
const headDir = join(FIXTURES, "diff-broken-head");
const golden = (dir: string): ArchitectureGraph =>
  parseGraph(JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")));
const goldenBase = golden(baseDir);
const goldenHead = golden(headDir);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-revisions-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capture() {
  const io = {
    out: "",
    err: "",
    stdout: (t: string) => (io.out += t),
    stderr: (t: string) => (io.err += t),
  };
  return io;
}

const git = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

/** A repo with diff-broken-base committed, then diff-broken-head on top. */
async function brokenRepo(): Promise<string> {
  const repo = join(dir, "repo");
  await cp(baseDir, repo, { recursive: true });
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "core.autocrlf", "false");
  const commit = (message: string) =>
    git(
      repo,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    );
  git(repo, "add", "--all");
  commit("base");
  git(repo, "rm", "--quiet", "-r", "src", "prisma");
  await cp(headDir, repo, { recursive: true, force: true });
  git(repo, "add", "--all");
  commit("head");
  return repo;
}

const worktrees = (repo: string): number =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

describe("gitinside diff", () => {
  it("diffs two graph files exactly as diffGraphs does", async () => {
    const io = capture();
    const argv = ["diff", join(baseDir, "expected.json"), join(headDir, "expected.json")];
    expect(await runCli(argv, io)).toBe(0);
    expect(io.err).toBe("");
    expect(io.out).toBe(stringifyDiff(diffGraphs(goldenBase, goldenHead)));
  });

  it("analyzes two folders and finds the fixture pair's broken connections", async () => {
    const io = capture();
    expect(await runCli(["diff", baseDir, headDir], io)).toBe(0);
    const diff = parseGraphDiff(JSON.parse(io.out));
    const expected = diffGraphs(goldenBase, goldenHead);
    expect(diff.broken).toEqual(expected.broken);
    // The goldens name each repo after its fixture folder, so their system nodes differ
    // (one `updated` node); analyzed here, both take the name in package.json.
    expect(expected.nodes.updated.map((c) => c.node.kind)).toContain("system");
    const { nodes } = expected.summary;
    expect(diff.summary).toEqual({
      ...expected.summary,
      nodes: { ...nodes, updated: nodes.updated - 1 },
    });
  }, 60_000);

  it("prints a Mermaid summary with --format mermaid and writes --out", async () => {
    const io = capture();
    const out = join(dir, "summary.mmd");
    const argv = ["diff", baseDir, headDir, "--format", "mermaid", "--out", out];
    expect(await runCli(argv, io)).toBe(0);
    expect(io.out).toBe("");
    const diff = diffGraphs(goldenBase, goldenHead);
    expect(await readFile(out, "utf8")).toBe(renderMermaidSummary(diff, goldenBase, goldenHead));
  }, 60_000);

  it("checks out git refs in temporary worktrees, records their SHAs, and removes them", async () => {
    const repo = await brokenRepo();
    const io = capture();
    expect(await runCli(["diff", "HEAD~1", "main", "--repo", repo], io)).toBe(0);
    const diff = parseGraphDiff(JSON.parse(io.out));
    expect(diff.base.repo.sha).toBe(git(repo, "rev-parse", "HEAD~1"));
    expect(diff.head.repo.sha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(diff.broken).toEqual(diffGraphs(goldenBase, goldenHead).broken);
    expect(worktrees(repo)).toBe(1);
  }, 60_000);

  it("runs no git hook while checking out", async () => {
    const repo = await brokenRepo();
    const sentinel = join(dir, "hook-ran");
    const hook = join(repo, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\necho ran > '${sentinel.replaceAll("\\", "/")}'\n`);
    await chmod(hook, 0o755);
    const io = capture();
    expect(await runCli(["diff", "HEAD~1", "HEAD", "--repo", repo], io)).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
  }, 60_000);

  it("removes the first worktree when the second side fails", async () => {
    const repo = await brokenRepo();
    const io = capture();
    expect(await runCli(["diff", "HEAD", "no-such-branch", "--repo", repo], io)).toBe(1);
    expect(io.err).toMatch(/no-such-branch is not a file, a folder, or a commit/);
    expect(worktrees(repo)).toBe(1);
  }, 60_000);

  it("refuses an option smuggled in as a ref", async () => {
    const repo = await brokenRepo();
    const io = capture();
    expect(await runCli(["diff", "HEAD", "--output=x", "--repo", repo], io)).toBe(2);
    const side = openSide("--output=x", repo);
    await expect(side).rejects.toThrow(/is not a file, a folder, or a commit/);
  }, 60_000);

  it("reports a file that isn't JSON or isn't a graph", async () => {
    const notJson = join(dir, "a.json");
    const notGraph = join(dir, "b.json");
    await writeFile(notJson, "{");
    await writeFile(notGraph, '{"nodes": []}');
    const good = join(baseDir, "expected.json");

    let io = capture();
    expect(await runCli(["diff", notJson, good], io)).toBe(1);
    expect(io.err).toMatch(/a\.json is not JSON/);
    io = capture();
    expect(await runCli(["diff", good, notGraph], io)).toBe(1);
    expect(io.err).toMatch(/b\.json is not a GitInside architecture graph/);
  });

  it("refuses graphs from two analyzer versions", async () => {
    const other = join(dir, "other.json");
    await writeFile(other, stringifyGraph({ ...goldenHead, analyzerVersion: "0.0.1" }));
    const io = capture();
    expect(await runCli(["diff", join(baseDir, "expected.json"), other], io)).toBe(1);
    expect(io.err).toMatch(/^error: .*analyzer/);
  });

  it("reports a ref outside any git repo", async () => {
    const io = capture();
    expect(await runCli(["diff", "HEAD", "HEAD", "--repo", dir], io)).toBe(1);
    expect(io.err).toMatch(/HEAD is not a file, a folder, or a commit in the git repo at/);
  });

  it.each([
    [["diff"]],
    [["diff", "a"]],
    [["diff", "a", "b", "c"]],
    [["diff", "a", "b", "--format"]],
    [["diff", "a", "b", "--format", "svg"]],
    [["diff", "a", "b", "--sha", "abc1234"]],
  ])("rejects bad usage %j with exit 2", async (argv) => {
    const io = capture();
    expect(await runCli(argv, io)).toBe(2);
    expect(io.err).toMatch(/Usage/);
  });
});
