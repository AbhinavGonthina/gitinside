import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffGraphs } from "@gitinside/diff";
import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvalInputError } from "../format.js";
import {
  followUpCrossCheck,
  followUpRepo,
  howFixed,
  parseFollowUpFile,
  pinnedPrOf,
  type FollowUpIo,
} from "./followUp.js";
import { committedAt, gitView, laterCommits } from "./git.js";
import type { PinnedPr, PrsFile } from "./prs.js";
import {
  commitOpener,
  replayRepo,
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
 * A repo whose `main` has five commits: `a` (diff-broken-base), `b` (diff-broken-head, which
 * breaks connections `a` had), `c` (`b` with an edited README), `d` (diff-broken-base again,
 * so every break is fixed), and `e` (`d` with another README edit).
 */
let scratch: string;
let repo: string;
const sha: Record<string, string> = {};

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(name: string, seconds: number): void {
  git("add", "--all");
  const date = `${1_780_000_000 + seconds} +0000`;
  execFileSync("git", ["-C", repo, "commit", "--quiet", "--allow-empty", "-m", name], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  sha[name] = git("rev-parse", "HEAD");
}

async function replaceWith(fixture: string): Promise<void> {
  git("rm", "--quiet", "-r", "src", "prisma");
  await cp(join(FIXTURES, fixture), repo, { recursive: true, force: true });
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "gitinside-followup-"));
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
  commit("a", 0);
  await replaceWith("diff-broken-head");
  commit("b", 60);
  await writeFile(join(repo, "README.md"), "# edited\n");
  commit("c", 120);
  await replaceWith("diff-broken-base");
  commit("d", 180);
  await writeFile(join(repo, "README.md"), "# edited again\n");
  commit("e", 240);
}, 30_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const pinned = (number: number, baseSha: string, mergeSha: string): PinnedPr => ({
  number,
  title: `PR ${number}`,
  mergedAt: `2026-07-0${number}T12:00:00Z`,
  mergeSha,
  baseSha,
  kind: "squash",
  commits: 1,
});

/** PR 1 breaks (a → b); PR 2 (c → d) fixes it. `c` and `e` are direct pushes. */
const prsFile = (): PrsFile => ({
  repo: "test/repo",
  listed: "2026-11-06",
  branch: "main",
  startSha: sha.a as string,
  endSha: sha.e as string,
  search: "repo:test/repo is:pr is:merged",
  found: 2,
  prs: [pinned(1, sha.a as string, sha.b as string), pinned(2, sha.c as string, sha.d as string)],
  excluded: [],
  overCap: [],
});

const run: ReplayRun = {
  gitinside: "f".repeat(40),
  analyzerVersion: "0.0.0-test",
  started: "2026-11-07",
  machine: { cpu: "Test CPU", cores: 4, ramGiB: 16, os: "test 1", node: "v22.0.0" },
};

/** The io over the test repo, opening commits with `open`. */
function repoIo(open: (sha: string) => Promise<ReplaySide>): FollowUpIo {
  const view = gitView(repo);
  return {
    open,
    later: (from, to) => laterCommits(repo, from, to),
    committedAt: (commit) => committedAt(repo, commit),
    isAncestor: view.isAncestor,
  };
}

const at = (seconds: number): string =>
  new Date((1_780_000_000 + seconds) * 1000).toISOString().replace(".000Z", "Z");

describe("followUpRepo on a local git repo", () => {
  it("finds the commit that fixes each break, past the pinned PRs' merges too", async () => {
    const open = commitOpener(repo);
    const raw = await replayRepo(prsFile(), run, { open, save: async () => {} });
    const broken = raw.prs[0]?.outcome === "diffed" ? raw.prs[0].broken : [];
    expect(broken.length).toBeGreaterThan(0);

    const opened: string[] = [];
    const file = await followUpRepo(
      raw,
      prsFile(),
      { endSha: sha.e as string },
      run,
      repoIo((commit) => {
        opened.push(commit);
        return open(commit);
      }),
    );

    expect(file).toMatchObject({ repo: "test/repo", replay: run.gitinside, endSha: sha.e });
    expect(file.prs).toHaveLength(1);
    expect(file.prs[0]).toMatchObject({
      number: 1,
      mergedAt: "2026-07-01T12:00:00Z",
      later: 3, // c, d, e
      checked: 2, // c still flags every break; d fixes them all
      unreadable: [],
    });
    expect(file.prs[0]?.breaks).toEqual(
      broken.map((b) => ({
        edge: b.edge,
        reason: b.reason,
        fixed: { sha: sha.d, committedAt: at(180), how: "restored", pr: 2 },
        atEnd: "clear",
      })),
    );
    // The base and merge again, c, d, then e only for `atEnd`.
    expect(opened).toEqual([sha.a, sha.b, sha.c, sha.d, sha.e]);
    expect(
      followUpCrossCheck(parseFollowUpFile("f.json", JSON.stringify(file)), raw, file),
    ).toEqual([]);
  }, 120_000);
});

/** Sides made from the goldens; a commit missing from `graphs` can't be opened. */
function fakeSides(graphs: Record<string, ArchitectureGraph>) {
  const opened: string[] = [];
  const open = async (commit: string): Promise<ReplaySide> => {
    opened.push(commit);
    const graph = graphs[commit];
    if (!graph) throw new Error(`no commit ${commit}`);
    return { graph, read: () => undefined, close: async () => {} };
  };
  return { open, opened };
}

describe("followUpRepo", () => {
  const raw = (): RawFile => {
    const diff = diffGraphs(goldenBase, goldenHead);
    return {
      repo: "test/repo",
      run,
      prs: [
        {
          number: 1,
          baseSha: sha.a as string,
          mergeSha: sha.b as string,
          outcome: "diffed",
          summary: diff.summary,
          broken: diff.broken,
        },
      ],
    };
  };

  const io = (graphs: Record<string, ArchitectureGraph>, later: string[]): FollowUpIo => ({
    open: fakeSides(graphs).open,
    later: () => later,
    committedAt: () => "2026-07-02T00:00:00Z",
    isAncestor: () => false,
  });

  it("skips a commit it can't read and says when the end still flags a break", async () => {
    const graphs = { [sha.a as string]: goldenBase, [sha.b as string]: goldenHead, z: goldenHead };
    const file = await followUpRepo(raw(), prsFile(), { endSha: "z" }, run, io(graphs, ["y", "z"]));
    expect(file.prs[0]).toMatchObject({
      later: 2,
      checked: 2,
      unreadable: [{ sha: "y", error: "no commit y" }],
    });
    for (const b of file.prs[0]?.breaks ?? [])
      expect(b).toMatchObject({ fixed: null, atEnd: "flagged" });
  });

  it("says when the end can't be read", async () => {
    const graphs = { [sha.a as string]: goldenBase, [sha.b as string]: goldenHead, x: goldenBase };
    const file = await followUpRepo(raw(), prsFile(), { endSha: "z" }, run, io(graphs, ["x", "z"]));
    expect(file.prs[0]).toMatchObject({ later: 2, checked: 1, unreadable: [] });
    for (const b of file.prs[0]?.breaks ?? []) {
      expect(b).toMatchObject({
        fixed: { sha: "x", how: "restored", pr: null },
        atEnd: "unreadable",
      });
    }
  });

  it("refuses when the breaks don't come out as the replay recorded them", async () => {
    const graphs = { [sha.a as string]: goldenBase, [sha.b as string]: goldenBase };
    await expect(
      followUpRepo(raw(), prsFile(), { endSha: "z" }, run, io(graphs, [])),
    ).rejects.toThrow("the analyzer differs from the replay's");
  });

  it("refuses another analyzer version", async () => {
    await expect(
      followUpRepo(
        raw(),
        prsFile(),
        { endSha: "z" },
        { ...run, analyzerVersion: "9.9.9" },
        io({}, []),
      ),
    ).rejects.toThrow("replayed with analyzer 0.0.0-test, this is 9.9.9");
  });

  it("leaves a repo with no broken edge with nothing to follow up", async () => {
    const none: RawFile = { ...raw(), prs: [] };
    const file = await followUpRepo(none, prsFile(), { endSha: "z" }, run, io({}, []));
    expect(file.prs).toEqual([]);
  });
});

describe("pinnedPrOf", () => {
  it("names the PR whose base..merge range holds a commit, and no PR for a direct push", () => {
    const io = { isAncestor: gitView(repo).isAncestor };
    expect(pinnedPrOf(sha.b as string, prsFile(), io)).toBe(1);
    expect(pinnedPrOf(sha.d as string, prsFile(), io)).toBe(2);
    // c is under PR 2's merge, but it's PR 2's base, so it was on the branch before PR 2.
    expect(pinnedPrOf(sha.c as string, prsFile(), io)).toBeNull();
    expect(pinnedPrOf(sha.e as string, prsFile(), io)).toBeNull();
  });
});

describe("howFixed", () => {
  const broken = { edge: "calls:a->b", from: "a" };
  const diff = (nodes: string[], edges: string[]) => ({
    nodes: { removed: nodes },
    edges: { removed: edges },
  });

  it("tells a restored edge, a removed source, and a changed call apart", () => {
    expect(howFixed(diff([], []), broken)).toBe("restored");
    expect(howFixed(diff(["b"], ["other"]), broken)).toBe("restored");
    expect(howFixed(diff(["a", "b"], ["calls:a->b"]), broken)).toBe("sourceRemoved");
    expect(howFixed(diff(["b"], ["calls:a->b"]), broken)).toBe("callChanged");
  });
});

describe("follow-up files", () => {
  const breakOf = { edge: "calls:a->b", reason: "TARGET_REMOVED", fixed: null, atEnd: "flagged" };
  const file = (later: number, checked: number) => ({
    repo: "test/repo",
    run,
    replay: run.gitinside,
    endSha: "e".repeat(40),
    prs: [
      {
        number: 1,
        baseSha: "a".repeat(40),
        mergeSha: "b".repeat(40),
        mergedAt: "2026-07-01T12:00:00Z",
        later,
        checked,
        unreadable: [],
        breaks: [breakOf],
      },
    ],
  });

  it("can't check more commits than there are", () => {
    expect(() => parseFollowUpFile("f.json", JSON.stringify(file(1, 2)))).toThrow(EvalInputError);
  });

  it("are checked against the raw file's flagged PRs and the pinned end", () => {
    const parsed = parseFollowUpFile("f.json", JSON.stringify(file(2, 1)));
    const summary = {
      nodes: { added: 0, removed: 0, modified: 0, updated: 0, renamed: 0 },
      edges: { added: 0, removed: 0, modified: 0, updated: 0, renamed: 0 },
      broken: 1,
    };
    const flagged = {
      number: 1,
      baseSha: "a".repeat(40),
      mergeSha: "b".repeat(40),
      outcome: "diffed" as const,
      summary,
      broken: [
        {
          edge: "calls:a->b",
          from: "a",
          to: "b",
          reason: "TARGET_REMOVED" as const,
          detail: "b was removed",
          sites: [],
        },
      ],
    };
    const quiet = { ...flagged, number: 2, summary: { ...summary, broken: 0 }, broken: [] };
    const rawFile: RawFile = { repo: "test/repo", run, prs: [flagged, quiet] };
    expect(followUpCrossCheck(parsed, rawFile, { endSha: "e".repeat(40) })).toEqual([]);

    expect(followUpCrossCheck({ ...parsed, repo: "test/other" }, rawFile, parsed)).toEqual([
      "follows up test/other, but the raw file is test/repo",
    ]);
    expect(
      followUpCrossCheck({ ...parsed, replay: "x" }, rawFile, { endSha: "d".repeat(40) }),
    ).toEqual([
      `follows up the replay at x, the raw file's is ${run.gitinside}`,
      `endSha is ${"e".repeat(40)}, the pinned one is ${"d".repeat(40)}`,
    ]);
    const otherEdge = { ...flagged, broken: [{ ...flagged.broken[0]!, edge: "calls:a->c" }] };
    expect(followUpCrossCheck(parsed, { ...rawFile, prs: [otherEdge] }, parsed)).toEqual([
      "prs[0].breaks aren't the raw file's broken edges of #1",
    ]);
    expect(followUpCrossCheck(parsed, { ...rawFile, prs: [quiet] }, parsed)).toEqual([
      "1 PRs followed up, but 0 have broken edges",
    ]);
  });
});
