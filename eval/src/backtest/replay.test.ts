import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FactCache } from "@gitinside/analyzer";
import { diffGraphs } from "@gitinside/diff";
import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvalInputError } from "../format.js";
import type { PinnedPr, PrsFile } from "./prs.js";
import {
  cannotResume,
  commitOpener,
  DIRTY_MARK,
  parseRawFile,
  rawCrossCheck,
  replayRepo,
  SideCache,
  type RawFile,
  type ReplayRun,
  type ReplaySide,
} from "./replay.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const golden = (name: string): ArchitectureGraph =>
  parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));
const goldenBase = golden("diff-broken-base");
const goldenHead = golden("diff-broken-head");

/**
 * A repo whose `main` has three commits: `a` (diff-broken-base), `b` (diff-broken-head,
 * which breaks connections `a` had), and `c` (`b` with an edited README).
 */
let scratch: string;
let repo: string;
const sha: Record<string, string> = {};

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(name: string): void {
  git("add", "--all");
  git("commit", "--quiet", "--allow-empty", "-m", name);
  sha[name] = git("rev-parse", "HEAD");
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "gitinside-replay-"));
  repo = join(scratch, "repo");
  const hooks = join(scratch, "hooks");
  await cp(join(FIXTURES, "diff-broken-base"), repo, { recursive: true });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  // An empty hooks folder, so no global hook of this machine runs in the test repo.
  await mkdir(hooks);
  git("config", "core.hooksPath", hooks);
  commit("a");
  git("rm", "--quiet", "-r", "src", "prisma");
  await cp(join(FIXTURES, "diff-broken-head"), repo, { recursive: true, force: true });
  commit("b");
  await writeFile(join(repo, "README.md"), "# edited\n");
  commit("c");
}, 30_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const MISSING = "0".repeat(40);

const pinned = (number: number, baseSha: string, mergeSha: string): PinnedPr => ({
  number,
  title: `PR ${number}`,
  mergedAt: `2026-07-0${number}T12:00:00Z`,
  mergeSha,
  baseSha,
  kind: "squash",
  commits: 1,
});

/** PR 1 breaks (a → b), PR 2 changes no connection (b → c), PR 3's base isn't in the repo. */
const prsFile = (): PrsFile => ({
  repo: "test/repo",
  listed: "2026-11-06",
  branch: "main",
  startSha: sha.a as string,
  endSha: sha.c as string,
  search: "repo:test/repo is:pr is:merged",
  found: 3,
  prs: [
    pinned(1, sha.a as string, sha.b as string),
    pinned(2, sha.b as string, sha.c as string),
    pinned(3, MISSING, sha.c as string),
  ],
  excluded: [],
  overCap: [],
});

const run: ReplayRun = {
  gitinside: "f".repeat(40),
  analyzerVersion: "0.0.0-test",
  started: "2026-11-06",
  machine: { cpu: "Test CPU", cores: 4, ramGiB: 16, os: "test 1", node: "v22.0.0" },
};

/** A fact cache in memory. */
function memoryCache(): FactCache & { size: () => number } {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => {
      if (value !== undefined) map.set(key, value);
    },
    size: () => map.size,
  };
}

/** Worktrees of the test repo, its own checkout included. */
const worktrees = (): number =>
  git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

describe("replayRepo on a local git repo", () => {
  it("diffs each PR's base and merge commit, records failures, and removes its worktrees", async () => {
    const cache = memoryCache();
    const open = commitOpener(repo, cache);
    const opened: string[] = [];
    const saved: number[] = [];
    const raw = await replayRepo(prsFile(), run, {
      open: (commit) => {
        opened.push(commit);
        return open(commit);
      },
      save: async (file) => {
        saved.push(file.prs.length);
      },
    });

    const [first, second, third] = raw.prs;
    const expected = diffGraphs(goldenBase, goldenHead).broken;
    expect(expected.length).toBeGreaterThan(0);
    expect(first).toMatchObject({ number: 1, outcome: "diffed", broken: expected });
    expect(second).toMatchObject({ number: 2, outcome: "diffed", broken: [] });
    expect(third).toMatchObject({ number: 3, outcome: "failed", stage: "base" });
    // b is PR 1's merge and PR 2's base: analyzed once. PR 3 stops at its missing base.
    expect(opened).toEqual([sha.a, sha.b, sha.c, MISSING]);
    expect(saved).toEqual([1, 2, 3]);
    expect(cache.size()).toBeGreaterThan(0);
    expect(worktrees()).toBe(1);
    // What it saves is a valid raw file that agrees with the PR file.
    const reread = parseRawFile("raw.json", JSON.stringify(raw));
    expect(rawCrossCheck(reread, prsFile())).toEqual([]);
  }, 120_000);

  it("refuses to open anything but a full SHA", async () => {
    const open = commitOpener(repo);
    await expect(open("main")).rejects.toThrow("main is not a full commit SHA");
    await expect(open(FIXTURES)).rejects.toThrow("is not a full commit SHA");
  });
});

/** Sides made from the goldens; `b` and `c` are both the head golden. */
function fakeSides(graphs: Record<string, ArchitectureGraph>) {
  const opened: string[] = [];
  const closed: string[] = [];
  const open = async (commit: string): Promise<ReplaySide> => {
    opened.push(commit);
    const graph = graphs[commit];
    if (!graph) throw new Error(`no commit ${commit}`);
    return { graph, read: () => undefined, close: async () => void closed.push(commit) };
  };
  return { open, opened, closed };
}

describe("replayRepo", () => {
  const graphs = () => ({
    [sha.a as string]: goldenBase,
    [sha.b as string]: goldenHead,
    [sha.c as string]: goldenHead,
  });

  it("continues a stopped run without replaying what it holds", async () => {
    const sides = fakeSides(graphs());
    const first = await replayRepo(
      prsFile(),
      run,
      { ...sides, save: async () => {} },
      { limit: 1 },
    );
    expect(first.prs.map((p) => p.number)).toEqual([1]);
    const rest = await replayRepo(
      prsFile(),
      run,
      { ...sides, save: async () => {} },
      {
        previous: first,
      },
    );
    expect(rest.prs.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(rest.prs[0]).toEqual(first.prs[0]);
    // The second run opened b again (the first run closed it), then c and the missing base.
    expect(sides.opened).toEqual([sha.a, sha.b, sha.b, sha.c, MISSING]);
    expect([...sides.closed].sort()).toEqual([...(sides.opened.slice(0, 4) as string[])].sort());
  });

  it("refuses to continue a raw file that isn't a prefix of the PR file", async () => {
    const sides = fakeSides(graphs());
    const done = await replayRepo(prsFile(), run, { ...sides, save: async () => {} });
    const other = { ...done, prs: [done.prs[1], done.prs[0]] } as RawFile;
    await expect(
      replayRepo(prsFile(), run, { ...sides, save: async () => {} }, { previous: other }),
    ).rejects.toThrow("can't resume test/repo: prs[0].number is 2, the PR file's is 1");
  });

  it("records a diff that throws as failed at the diff stage", async () => {
    const sides = fakeSides({
      ...graphs(),
      [sha.b as string]: { ...goldenHead, analyzerVersion: "9.9.9" },
    });
    const raw = await replayRepo(prsFile(), run, { ...sides, save: async () => {} }, { limit: 1 });
    expect(raw.prs[0]).toMatchObject({ number: 1, outcome: "failed", stage: "diff" });
  });

  it("records a merge commit that can't be opened as failed at the head stage", async () => {
    const sides = fakeSides({ [sha.a as string]: goldenBase });
    const raw = await replayRepo(prsFile(), run, { ...sides, save: async () => {} }, { limit: 1 });
    expect(raw.prs[0]).toEqual({
      number: 1,
      baseSha: sha.a,
      mergeSha: sha.b,
      outcome: "failed",
      stage: "head",
      error: `no commit ${sha.b}`,
    });
  });
});

describe("SideCache", () => {
  it("keeps the most recently used sides, closing the one it evicts", async () => {
    const sides = fakeSides({ x: goldenBase, y: goldenBase, z: goldenBase });
    const cache = new SideCache(sides.open, 2);
    await cache.get("x");
    await cache.get("y");
    await cache.get("x"); // x is now the most recent
    await cache.get("z"); // evicts y
    expect(sides.closed).toEqual(["y"]);
    await cache.get("x");
    expect(sides.opened).toEqual(["x", "y", "z"]);
    await cache.closeAll();
    expect([...sides.closed].sort()).toEqual(["x", "y", "z"]);
  });

  it("holds at least a PR's two sides", () => {
    expect(() => new SideCache(fakeSides({}).open, 1)).toThrow("at least 2 sides");
  });

  it("remembers a failure instead of opening the commit again", async () => {
    const sides = fakeSides({});
    const cache = new SideCache(sides.open);
    expect(await cache.get("w")).toEqual({ error: "no commit w" });
    expect(await cache.get("w")).toEqual({ error: "no commit w" });
    expect(sides.opened).toEqual(["w"]);
  });

  it("names a failure that has no message", async () => {
    const cache = new SideCache(async () => {
      throw new Error("");
    });
    expect(await cache.get("v")).toEqual({ error: "failed with no message" });
  });
});

describe("cannotResume", () => {
  const file = (r: ReplayRun): RawFile => ({ repo: "test/repo", run: r, prs: [] });

  it("lets the same clean commit, analyzer, and machine continue", () => {
    expect(cannotResume(file(run), { ...run, started: "2026-11-07" })).toBeUndefined();
  });

  it("refuses uncommitted changes, another commit, analyzer, or machine", () => {
    const dirty = { ...run, gitinside: `${run.gitinside}${DIRTY_MARK}` };
    expect(cannotResume(file(dirty), dirty)).toMatch("uncommitted");
    expect(cannotResume(file(run), dirty)).toMatch("uncommitted");
    expect(cannotResume(file(run), { ...run, gitinside: "e".repeat(40) })).toMatch(
      "started at gitinside",
    );
    expect(cannotResume(file(run), { ...run, analyzerVersion: "0.0.1" })).toMatch(
      "started with analyzer",
    );
    expect(cannotResume(file(run), { ...run, machine: { ...run.machine, cores: 8 } })).toMatch(
      "another machine",
    );
  });
});

describe("raw files", () => {
  const diffed = (number: number, broken = 0) => ({
    number,
    baseSha: "a".repeat(40),
    mergeSha: "b".repeat(40),
    outcome: "diffed",
    summary: {
      nodes: { added: 0, removed: 0, modified: 0, updated: 0, renamed: 0 },
      edges: { added: 0, removed: 0, modified: 0, updated: 0, renamed: 0 },
      broken,
    },
    broken: [],
  });

  it("must count their broken edges in the summary", () => {
    const text = JSON.stringify({ repo: "test/repo", run, prs: [diffed(1, 1)] });
    expect(() => parseRawFile("raw.json", text)).toThrow(EvalInputError);
    expect(() => parseRawFile("raw.json", text)).toThrow("summary.broken");
  });

  it("are checked against the PR file's repo, order, and length", () => {
    const prs = prsFile();
    const raw = parseRawFile("raw.json", JSON.stringify({ repo: "test/repo", run, prs: [] }));
    expect(rawCrossCheck({ ...raw, repo: "test/other" }, prs)).toEqual([
      "replays test/other, but the PR file lists test/repo",
    ]);
    const entry = { ...diffed(1), baseSha: sha.a as string, mergeSha: sha.c as string };
    const four = parseRawFile(
      "raw.json",
      JSON.stringify({ repo: "test/repo", run, prs: [entry, entry, entry, entry] }),
    );
    const problems = rawCrossCheck(four, prs);
    expect(problems[0]).toBe("4 PRs replayed, but only 3 are pinned");
    expect(problems).toContain(`prs[0].mergeSha is ${sha.c}, the PR file's is ${sha.b}`);
    expect(problems).toContain("prs[1].number is 1, the PR file's is 2");
  });
});
