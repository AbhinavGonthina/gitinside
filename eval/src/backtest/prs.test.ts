import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvalInputError } from "../format.js";
import type { BacktestReposFile } from "./format.js";
import { gitView } from "./git.js";
import {
  classifyPr,
  inWindow,
  parsePrsFile,
  prsCrossCheck,
  selectPrs,
  type GitView,
  type ListedPr,
  type PrsFile,
} from "./prs.js";

/**
 * A repo whose `main` gets one PR of each kind (history oldest first):
 *
 *   c0 ── c1 (start) ── m1 (merge of f1, PR 1) ── s1 (squash, PR 2) ── r1 ── r2 (rebase, PR 3)
 *         └─ f1                                                         ── q1 (squash of 2, PR 4: end)
 *
 * plus `x1`, a commit on a branch that never reached `main`.
 */
let dir: string;
let hooks: string;
const sha: Record<string, string> = {};
let view: GitView;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function commit(name: string, message: string): void {
  git("commit", "--quiet", "--allow-empty", "-m", message);
  sha[name] = git("rev-parse", "HEAD");
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gitinside-backtest-"));
  // An empty hooks folder, so no global hook of this machine runs in the test repo.
  hooks = mkdtempSync(join(tmpdir(), "gitinside-hooks-"));
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", hooks);
  commit("c0", "root");
  commit("c1", "start");
  git("checkout", "--quiet", "-b", "feature");
  commit("f1", "feat: a");
  git("checkout", "--quiet", "main");
  git("merge", "--quiet", "--no-ff", "feature", "-m", "Merge pull request #1");
  sha.m1 = git("rev-parse", "HEAD");
  commit("s1", "fix: b (#2)");
  commit("r1", "chore: one\n\nwith a body");
  commit("r2", "chore: two");
  commit("q1", "feat: squashed (#4)");
  git("checkout", "--quiet", "-b", "side", sha.c1 as string);
  commit("x1", "never merged");
  // `stack`, a later branch from q1: PR 12 (b1) is stacked on PR 11 (a1), and GitHub marks
  // PR 11 merged by PR 12's merge commit `st`; then PR 13's head `gm` merges the branch (k1)
  // in, and the branch is fast-forwarded to it.
  git("checkout", "--quiet", "-b", "a", sha.q1 as string);
  commit("a1", "feat: the base of a stack");
  git("checkout", "--quiet", "-b", "b");
  commit("b1", "feat: on top of it");
  git("checkout", "--quiet", "-b", "stack", sha.q1 as string);
  git("merge", "--quiet", "--no-ff", "b", "-m", "Merge pull request #12 from acme/b");
  sha.st = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "-b", "g");
  commit("g1", "feat: g");
  git("checkout", "--quiet", "stack");
  commit("k1", "a direct push");
  git("checkout", "--quiet", "g");
  git("merge", "--quiet", "--no-ff", "stack", "-m", "Merge branch 'stack' into g");
  sha.gm = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "stack");
  git("merge", "--quiet", "--ff-only", "g");
  git("checkout", "--quiet", "main");
  view = gitView(dir);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(hooks, { recursive: true, force: true });
});

const repo = () => ({ branch: "main", endSha: sha.q1 as string });

function pr(
  number: number,
  mergeSha: string,
  commits = 1,
  extra: Partial<ListedPr> = {},
): ListedPr {
  return {
    number,
    title: `PR ${number}`,
    mergedAt: `2026-07-0${number}T12:00:00Z`,
    baseRef: "main",
    mergeSha,
    // PR 1's head is f1, the second parent of its merge m1; the others aren't merges.
    headSha: number === 1 ? (sha.f1 as string) : "e".repeat(40),
    commits,
    ...extra,
  };
}

const MESSAGES: Record<number, string[]> = {
  3: ["chore: one\r\n\r\nwith a body  \n", "chore: two"],
  4: ["wip", "more wip"],
};
const messages = (n: number): string[] => MESSAGES[n] ?? [];

describe("gitView", () => {
  it("reads parents, ancestry, and first-parent history", () => {
    expect(view.has(sha.m1 as string)).toBe(true);
    expect(view.has("0".repeat(40))).toBe(false);
    expect(view.parents(sha.m1 as string)).toEqual([sha.c1, sha.f1]);
    expect(view.isAncestor(sha.c1 as string, sha.q1 as string)).toBe(true);
    expect(view.isAncestor(sha.q1 as string, sha.q1 as string)).toBe(true);
    expect(view.isAncestor(sha.f1 as string, sha.q1 as string)).toBe(true);
    expect(view.isAncestor(sha.x1 as string, sha.q1 as string)).toBe(false);
    expect(view.firstParentMessages(sha.r2 as string, 2)).toEqual([
      "chore: one\n\nwith a body\n",
      "chore: two\n",
    ]);
    expect(view.firstParentAncestor(sha.r2 as string, 2)).toBe(sha.s1);
    expect(view.firstParentAncestor(sha.c1 as string, 5)).toBeUndefined();
  });
});

describe("classifyPr", () => {
  it("takes a merge commit's first parent as the base", () => {
    expect(classifyPr(pr(1, sha.m1 as string), repo(), view, messages)).toEqual({
      kind: "merge",
      baseSha: sha.c1,
    });
  });

  it("excludes a merge commit that isn't the PR's own: a stacked PR's child, or another PR's", () => {
    const stack = { branch: "main", endSha: sha.gm as string };
    expect(
      classifyPr(pr(12, sha.st as string, 1, { headSha: sha.b1 as string }), stack, view, messages),
    ).toEqual({ kind: "merge", baseSha: sha.q1 });
    // PR 11's head a1 is under b1, so GitHub called it merged when PR 12 landed.
    expect(
      classifyPr(pr(11, sha.st as string, 1, { headSha: sha.a1 as string }), stack, view, messages),
    ).toEqual({
      reason: `its merge commit ${sha.st} merges ${sha.b1}, not the PR's head ${sha.a1}: another PR's merge (a stacked PR is marked merged when its child lands)`,
    });
    // The second parent matches, but the subject names another PR.
    expect(
      classifyPr(pr(14, sha.st as string, 1, { headSha: sha.b1 as string }), stack, view, messages),
    ).toEqual({
      reason: `its merge commit ${sha.st} is "Merge pull request #12 from acme/b", another PR's merge`,
    });
  });

  it("excludes a head that merges the branch in and was fast-forwarded onto it", () => {
    const stack = { branch: "main", endSha: sha.gm as string };
    expect(
      classifyPr(pr(13, sha.gm as string, 2, { headSha: sha.gm as string }), stack, view, messages),
    ).toEqual({
      reason: `its head ${sha.gm} is a merge commit the branch was fast-forwarded to, so its first parent is the PR's own branch, not main's previous state`,
    });
  });

  it("takes a one-commit PR's parent as the base", () => {
    expect(classifyPr(pr(2, sha.s1 as string), repo(), view, messages)).toEqual({
      kind: "squash",
      baseSha: sha.m1,
    });
  });

  it("takes the commit below a rebased PR's commits, matched by their messages", () => {
    expect(classifyPr(pr(3, sha.r2 as string, 2), repo(), view, messages)).toEqual({
      kind: "rebase",
      baseSha: sha.s1,
    });
  });

  it("reads a multi-commit PR whose messages aren't on the branch as a squash", () => {
    expect(classifyPr(pr(4, sha.q1 as string, 2), repo(), view, messages)).toEqual({
      kind: "squash",
      baseSha: sha.r2,
    });
    // Same commits but one message missing from the PR's list: not a rebase either.
    const short = (n: number): string[] => (n === 3 ? ["chore: two"] : []);
    expect(classifyPr(pr(3, sha.r2 as string, 2), repo(), view, short)).toEqual({
      kind: "squash",
      baseSha: sha.r1,
    });
  });

  it("excludes a PR whose merge commit isn't in the branch's history at endSha", () => {
    const off = (s: string): string => `its merge commit ${s} isn't in main's history at endSha`;
    expect(classifyPr(pr(5, sha.x1 as string), repo(), view, messages)).toEqual({
      reason: off(sha.x1 as string),
    });
    const unknown = "f".repeat(40);
    expect(classifyPr(pr(5, unknown), repo(), view, messages)).toEqual({ reason: off(unknown) });
  });

  it("keeps a PR whose merge commit joined the branch through a later merge's second parent", () => {
    // As in a maintainer's `git pull` merge ("Merge branch 'main' of …") on top of GitHub's
    // branch: f1 stands for GitHub's tip, reached from endSha only through m1's second parent.
    expect(classifyPr(pr(5, sha.f1 as string), repo(), view, messages)).toEqual({
      kind: "squash",
      baseSha: sha.c1,
    });
  });

  it("excludes a PR into another branch, a root commit, and a huge one", () => {
    expect(
      classifyPr(pr(6, sha.s1 as string, 1, { baseRef: "next" }), repo(), view, messages),
    ).toEqual({
      reason: "merged into next, not main",
    });
    expect(classifyPr(pr(8, sha.q1 as string, 251), repo(), view, messages)).toEqual({
      reason: "251 commits, more than the 250 GitHub lists",
    });
    expect(classifyPr(pr(9, sha.c0 as string), repo(), view, messages)).toEqual({
      reason: `its merge commit ${sha.c0} has no parent`,
    });
  });

  it("excludes a rebase longer than the history", () => {
    const deep = (n: number): string[] => (n === 10 ? ["root", "start", "feat: a"] : []);
    const fake: GitView = { ...view, firstParentMessages: () => ["root", "start", "feat: a"] };
    expect(classifyPr(pr(10, sha.c1 as string, 3), repo(), fake, deep)).toEqual({
      reason: `the history below ${sha.c1} is too short`,
    });
  });
});

describe("inWindow", () => {
  it("keeps exactly the window's UTC days", () => {
    const window = { from: "2026-07-01", to: "2026-09-30" };
    expect(inWindow("2026-06-30T23:59:59Z", window)).toBe(false);
    expect(inWindow("2026-07-01T00:00:00Z", window)).toBe(true);
    expect(inWindow("2026-09-30T23:59:59Z", window)).toBe(true);
    expect(inWindow("2026-10-01T00:00:00Z", window)).toBe(false);
  });
});

describe("selectPrs", () => {
  const settings = { window: { from: "2026-07-01", to: "2026-07-31" }, maxPrsPerRepo: 2 };

  it("walks merge order, excludes without using up the cap, and lists the rest as over it", () => {
    const listed: Record<number, ListedPr> = {
      1: pr(1, sha.m1 as string),
      2: pr(2, sha.s1 as string),
      5: pr(5, sha.x1 as string),
      3: pr(3, sha.r2 as string, 2),
    };
    const looked: number[] = [];
    const searched = [
      { number: 3, mergedAt: "2026-07-20T00:00:00Z" },
      { number: 2, mergedAt: "2026-07-10T00:00:00Z" },
      { number: 5, mergedAt: "2026-07-05T00:00:00Z" },
      { number: 1, mergedAt: "2026-07-10T00:00:00Z" },
      { number: 6, mergedAt: "2026-08-01T00:00:00Z" },
      { number: 7, mergedAt: "2026-06-30T23:00:00Z" },
    ];
    const out = selectPrs(searched, repo(), settings, {
      facts: (s) => {
        looked.push(s.number);
        return { ...(listed[s.number] as ListedPr), mergedAt: s.mergedAt };
      },
      messages,
      git: view,
    });
    expect(out.found).toBe(4);
    expect(out.excluded.map((p) => p.number)).toEqual([5]);
    expect(out.prs.map((p) => [p.number, p.kind, p.baseSha])).toEqual([
      [1, "merge", sha.c1],
      [2, "squash", sha.m1],
    ]);
    expect(out.overCap).toEqual([{ number: 3, mergedAt: "2026-07-20T00:00:00Z" }]);
    // The PR past the cap and those outside the window are never looked up.
    expect(looked).toEqual([5, 1, 2]);
    expect(out.prs[0]).toEqual({
      number: 1,
      title: "PR 1",
      mergedAt: "2026-07-10T00:00:00Z",
      mergeSha: sha.m1,
      baseSha: sha.c1,
      kind: "merge",
      commits: 1,
    });
  });
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const file = (overrides: Partial<PrsFile> = {}): PrsFile => ({
  repo: "acme/shop",
  listed: "2026-11-06",
  branch: "main",
  startSha: A,
  endSha: B,
  search: "repo:acme/shop is:pr is:merged base:main merged:2026-06-30..2026-10-01",
  found: 3,
  prs: [
    {
      number: 2,
      title: "x",
      mergedAt: "2026-07-02T00:00:00Z",
      mergeSha: C,
      baseSha: A,
      kind: "squash",
      commits: 1,
    },
  ],
  excluded: [{ number: 1, mergedAt: "2026-07-01T00:00:00Z", reason: "merged into next, not main" }],
  overCap: [{ number: 3, mergedAt: "2026-07-03T00:00:00Z" }],
  ...overrides,
});

function issues(text: string): string {
  try {
    parsePrsFile("prs/acme__shop.json", text);
  } catch (error) {
    expect(error).toBeInstanceOf(EvalInputError);
    return (error as Error).message;
  }
  throw new Error("expected an EvalInputError");
}

describe("parsePrsFile", () => {
  it("accepts a consistent file", () => {
    expect(parsePrsFile("f", JSON.stringify(file())).prs).toHaveLength(1);
  });

  it("requires found to add up, merge order, and each PR once", () => {
    expect(issues(JSON.stringify(file({ found: 4 })))).toContain(
      "4 found, but prs, excluded and overCap hold 3",
    );
    const late = { ...file().prs[0]!, number: 4, mergedAt: "2026-07-01T00:00:00Z" };
    expect(issues(JSON.stringify(file({ found: 4, prs: [...file().prs, late] })))).toContain(
      "out of merge order",
    );
    expect(
      issues(JSON.stringify(file({ overCap: [{ number: 2, mergedAt: "2026-07-03T00:00:00Z" }] }))),
    ).toContain("PR #2 is listed twice");
  });

  it("rejects a PR over the cap that merged before a kept one, and a base equal to its merge", () => {
    expect(
      issues(JSON.stringify(file({ overCap: [{ number: 3, mergedAt: "2026-07-01T12:00:00Z" }] }))),
    ).toContain("the cap takes the earliest");
    const same = { ...file().prs[0]!, baseSha: C };
    expect(issues(JSON.stringify(file({ prs: [same] })))).toContain("the base must differ");
  });
});

describe("prsCrossCheck", () => {
  const pins = {
    window: { from: "2026-07-01", to: "2026-07-31" },
    maxPrsPerRepo: 1,
    repos: [{ owner: "acme", name: "shop", branch: "main", startSha: A, endSha: B }],
  } as unknown as BacktestReposFile;

  it("agrees with the pin it was listed from", () => {
    expect(prsCrossCheck(file(), pins, "acme__shop.json")).toEqual([]);
  });

  it("reports another name, branch, SHAs, dates outside the window, and the cap", () => {
    expect(prsCrossCheck(file({ repo: "acme/other" }), pins, "acme__other.json")).toEqual([
      "acme/other isn't pinned in repos.json",
    ]);
    const kept = file().prs[0]!;
    expect(
      prsCrossCheck(
        file({
          branch: "dev",
          endSha: C,
          found: 2,
          prs: [kept, { ...kept, number: 4, mergedAt: "2026-08-01T00:00:00Z" }],
          overCap: [],
        }),
        pins,
        "shop.json",
      ),
    ).toEqual([
      "holds acme/shop, so it must be named acme__shop.json",
      "branch is dev, repos.json says main",
      `endSha is ${C}, repos.json says ${B}`,
      "PR #4 merged at 2026-08-01T00:00:00Z, outside the window",
      "2 PRs, more than maxPrsPerRepo (1)",
    ]);
    expect(
      prsCrossCheck(file({ prs: [], found: 2 }), { ...pins, maxPrsPerRepo: 5 }, "acme__shop.json"),
    ).toEqual(["PRs over the cap are listed, but only 0 were kept"]);
  });
});
