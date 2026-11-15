// @vitest-environment node
import {
  COMPUTE_ALLOWANCE,
  WORKER_MEMORY_GB,
  analyses,
  analysisCounts,
  completeAnalysis,
  computeUsage,
  countComputeUsage,
  deleteDoneAnalyses,
  failAnalysis,
  hideRepo,
  queueAnalysis,
  rateLimits,
  repos,
  startAnalysis,
  upsertRepo,
  type AnalysisStats,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { jobIdFor } from "@gitinside/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { QUEUE_UNAVAILABLE } from "./enqueue";
import { COMMITS_PAGE, TITLE_LENGTH } from "./github";
import { fakeGitHub, type FakeCommit, type FakeGitHub, type FakeRepo } from "./github.testkit";
import { fakeTaskQueue } from "./google.testkit";
import {
  createTimelineCache,
  handleTimelineRequest,
  TIMELINE_COMMITS,
  TIMELINE_COMPUTE_RATIO,
  TIMELINE_QUEUES_PER_HOUR,
  TIMELINE_QUEUES_PER_REQUEST,
  viewTimeline,
  type Timeline,
  type TimelineDeps,
} from "./timeline";

const VERSION = "0.3.10";
const ID = 4242;
/** The `i`th commit's SHA (0 is the branch's tip). */
const sha = (i: number) => i.toString(16).padStart(2, "0").repeat(20);
/** A straight line of `n` commits, newest first, the last with no parent. */
const line = (n: number): FakeCommit[] =>
  Array.from({ length: n }, (_, i) => ({
    sha: sha(i),
    parents: i === n - 1 ? [] : [sha(i + 1)],
    message: `Commit ${i}\n\nThe body.`,
    date: `2026-11-${String(30 - i).padStart(2, "0")}T12:00:00Z`,
  }));
/** The worker's job ID for a commit of the shop at this analyzer version. */
const jobFor = (commit: string) =>
  jobIdFor({ kind: "analyze", owner: "Acme", repo: "Shop", sha: commit }, VERSION);
/** Counts as the worker records them (M11.4a). */
const COUNTED: AnalysisStats = {
  files: 4,
  nodes: 10,
  edges: 7,
  unresolved: 1,
  services: 2,
  broken: 1,
};
const COUNTS = { services: 2, files: 4, nodes: 10, edges: 7, unresolved: 1, broken: 1 };

let t: TestDb;
let shop: FakeRepo;
let gh: FakeGitHub;
let tasks: ReturnType<typeof fakeTaskQueue>;
let clock: number;
let deps: TimelineDeps;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(analysisCounts);
  await t.db.delete(analyses);
  await t.db.delete(repos);
  await t.db.delete(rateLimits);
  await t.db.delete(computeUsage);
  shop = { id: ID, owner: "Acme", name: "Shop", sha: sha(0), commits: line(14) };
  gh = fakeGitHub([shop]);
  tasks = fakeTaskQueue("v".repeat(43));
  clock = 1_000_000;
  deps = {
    db: t.db,
    queue: tasks.queue,
    github: { fetch: gh.fetch },
    analyzerVersion: VERSION,
    commits: createTimelineCache({ now: () => clock }),
  };
});

async function repoId(visibility: "public" | "private" = "public"): Promise<string> {
  return (
    await upsertRepo(t.db, {
      providerRepoId: ID,
      owner: "Acme",
      name: "Shop",
      visibility,
      defaultBranch: "main",
    })
  ).id;
}

/** A finished analysis of `commit` (by `version`), with counts unless `stats` says otherwise. */
async function done(
  commit: string,
  { stats = COUNTED, version = VERSION, key = `public/acme/shop/${commit}.json.gz` } = {},
): Promise<string> {
  const { id } = await startAnalysis(t.db, {
    repoId: await repoId(),
    sha: commit,
    analyzerVersion: version,
  });
  await completeAnalysis(t.db, id, { snapshotKey: key, stats });
  return id;
}

/** The timeline, which must be found. */
async function timeline(): Promise<Timeline> {
  const result = await viewTimeline({ owner: "acme", repo: "shop" }, deps);
  if (result.status !== "ok") throw new Error(`no timeline: ${result.status}`);
  return result.timeline;
}

const states = (found: Timeline) => found.steps.map((step) => step.state);
/** The `rate_limits` count under `key`. */
async function slots(key: string): Promise<number> {
  const all = await t.db.select().from(rateLimits);
  return all.find((row) => row.key === key)?.count ?? 0;
}
/** The SHAs of the jobs on the queue, in order. */
const queuedShas = () => tasks.jobs().map((job) => (job as { sha: string }).sha);
/** Instance time that puts the month's memory allowance at `share`. */
const memoryShareMs = (share: number) =>
  Math.ceil(((COMPUTE_ALLOWANCE.memoryGbSeconds * share) / WORKER_MEMORY_GB) * 1000);

describe("viewTimeline", () => {
  it("answers only a repo with a published analysis, before asking GitHub", async () => {
    expect(await viewTimeline({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "not-analyzed",
    });
    // A private repo: the same answer as a name nobody analyzed.
    const { id } = await startAnalysis(t.db, {
      repoId: await repoId("private"),
      sha: sha(0),
      analyzerVersion: VERSION,
    });
    await completeAnalysis(t.db, id, { snapshotKey: "private/41/x.json.gz", stats: COUNTED });
    expect(await viewTimeline({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "not-analyzed",
    });
    expect(gh.requests).toEqual([]);
    // Analyzed publicly, then hidden after GitHub said it went private.
    await done(sha(1));
    expect((await viewTimeline({ owner: "acme", repo: "shop" }, deps)).status).toBe("ok");
    gh.requests.length = 0;
    const [row] = await t.db.select().from(repos);
    await hideRepo(t.db, row!.id);
    expect(await viewTimeline({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "not-analyzed",
    });
    expect(gh.requests).toEqual([]);
  });

  it("lists the default branch's 12 newest first-parent commits, newest first, in GitHub's spelling", async () => {
    await done(sha(0));
    const found = await timeline();
    expect(found).toMatchObject({
      format: 1,
      owner: "Acme",
      repo: "Shop",
      branch: "main",
      analyzerVersion: VERSION,
    });
    expect(found.steps.map((step) => step.sha)).toEqual(
      Array.from({ length: TIMELINE_COMMITS }, (_, i) => sha(i)),
    );
    expect(found.steps[1]).toMatchObject({
      sha: sha(1),
      date: "2026-11-29T12:00:00Z",
      title: "Commit 1",
    });
    expect(TIMELINE_COMMITS).toBe(12);
    // One page of commits, asked for at the tip GitHub named.
    const asked = gh.requests
      .map((r) => new URL(r.url))
      .find((u) => u.pathname.endsWith("/commits"));
    expect(asked?.searchParams.get("sha")).toBe(sha(0));
    expect(asked?.searchParams.get("per_page")).toBe(String(COMMITS_PAGE));
  });

  it("follows first parents past a merged branch's commits, and stops where the page ends", async () => {
    // GitHub lists every ancestor by date: the merged branch's commit sits between them.
    shop.commits = [
      { sha: sha(0), parents: [sha(1), sha(9)], message: "Merge pull request #7" },
      { sha: sha(9), parents: [sha(2)], message: "Work on a branch" },
      { sha: sha(1), parents: [sha(2)] },
      { sha: sha(2), parents: [sha(3)] },
      // sha(3) isn't on the page (past GitHub's 100): the line ends at sha(2).
    ];
    await done(sha(0));
    expect((await timeline()).steps.map((step) => step.sha)).toEqual([sha(0), sha(1), sha(2)]);
  });

  it("gives each commit's state, its counts when kept, and its job when in flight", async () => {
    deps.queue = undefined;
    const evicted = await done(sha(2));
    await deleteDoneAnalyses(t.db, [
      { id: evicted, snapshotKey: `public/acme/shop/${sha(2)}.json.gz` },
    ]);
    await done(sha(0));
    // Finished before M11.4a wrote counts.
    await done(sha(1), { stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 } });
    const id = await repoId();
    await queueAnalysis(
      t.db,
      { repoId: id, sha: sha(3), analyzerVersion: VERSION },
      { jobId: jobFor(sha(3)) },
    );
    await startAnalysis(t.db, { repoId: id, sha: sha(4), analyzerVersion: VERSION });
    const failed = await startAnalysis(t.db, { repoId: id, sha: sha(5), analyzerVersion: VERSION });
    await failAnalysis(t.db, failed.id, "LIMIT_FILES");
    const lost = await startAnalysis(t.db, { repoId: id, sha: sha(6), analyzerVersion: VERSION });
    await failAnalysis(t.db, lost.id, QUEUE_UNAVAILABLE);
    // Analyzed privately before the repo went public (ADR-0239), or by an older version.
    await done(sha(7), { key: `private/41/${sha(7)}.json.gz` });
    await done(sha(8), { version: "0.3.9" });

    const found = await timeline();
    expect(
      found.steps.slice(0, 10).map(({ sha: _, date: _d, title: _t, ...step }) => step),
    ).toEqual([
      { state: "analyzed", counts: COUNTS },
      { state: "no-counts" },
      { state: "not-kept", counts: COUNTS },
      { state: "queued", jobId: jobFor(sha(3)) },
      { state: "running", jobId: null },
      { state: "failed", errorCode: "LIMIT_FILES" },
      { state: "not-analyzed" },
      { state: "not-analyzed" },
      { state: "not-analyzed" },
      { state: "not-analyzed" },
    ]);
    expect(found.queueing).toEqual({ state: "unavailable" });
  });

  it("queues the two newest not-analyzed commits per request, charged to the timeline's own slot", async () => {
    await done(sha(0));
    const id = await repoId();
    const failed = await startAnalysis(t.db, { repoId: id, sha: sha(1), analyzerVersion: VERSION });
    // Not a `LIMIT_*` code: that would hold the repo (sizeHold.ts) and queue nothing.
    await failAnalysis(t.db, failed.id, "WORKER_ERROR");
    const evicted = await done(sha(3));
    await deleteDoneAnalyses(t.db, [
      { id: evicted, snapshotKey: `public/acme/shop/${sha(3)}.json.gz` },
    ]);

    const found = await timeline();
    // A failure and an evicted commit aren't due: sha(2) and sha(4) are the newest that are.
    expect(queuedShas()).toEqual([sha(2), sha(4)]);
    expect(states(found).slice(0, 6)).toEqual([
      "analyzed",
      "failed",
      "queued",
      "not-kept",
      "queued",
      "not-analyzed",
    ]);
    expect(found.steps[2]).toMatchObject({ state: "queued", jobId: jobFor(sha(2)) });
    expect(found.queueing).toEqual({ state: "open" });
    expect(TIMELINE_QUEUES_PER_REQUEST).toBe(2);
    expect(await slots(`timeline:${ID}`)).toBe(2);
    // Check-on-view's slot is left for the README image and the repo page.
    expect(await slots(`repo:${ID}`)).toBe(0);
  });

  it("queues at most 6 commits per repo an hour", async () => {
    await done(sha(0));
    for (let i = 0; i < 3; i++) expect((await timeline()).queueing).toEqual({ state: "open" });
    expect(queuedShas()).toEqual([1, 2, 3, 4, 5, 6].map(sha));
    const limited = await timeline();
    expect(limited.queueing).toEqual({ state: "limited" });
    expect(queuedShas()).toHaveLength(TIMELINE_QUEUES_PER_HOUR);
    expect(states(limited).slice(7)).toEqual(Array(5).fill("not-analyzed"));
    expect(TIMELINE_QUEUES_PER_HOUR).toBe(6);
  });

  it("queues nothing once a compute allowance is at half, and from just under it queues", async () => {
    await done(sha(0));
    await countComputeUsage(t.db, { instanceMs: memoryShareMs(TIMELINE_COMPUTE_RATIO) });
    const held = await timeline();
    const until = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1));
    expect(held.queueing).toEqual({ state: "budget", until: until.toISOString() });
    expect(tasks.google.tasks).toEqual([]);
    expect(await slots(`timeline:${ID}`)).toBe(0);
    expect(TIMELINE_COMPUTE_RATIO).toBe(0.5);

    await t.db.delete(computeUsage);
    await countComputeUsage(t.db, {
      instanceMs: memoryShareMs(TIMELINE_COMPUTE_RATIO) - 1_000,
    });
    expect((await timeline()).queueing).toEqual({ state: "open" });
    expect(queuedShas()).toEqual([sha(1), sha(2)]);
  });

  it("says why when check-on-view's own rules refuse, charging nothing", async () => {
    await done(sha(0));
    shop.languages = { TypeScript: 200 * 1024 * 1024 };
    const found = await timeline();
    expect(found.queueing).toEqual({ state: "too-much-code", codeBytes: 200 * 1024 * 1024 });
    expect(tasks.google.tasks).toEqual([]);
    expect(await slots(`timeline:${ID}`)).toBe(0);

    delete shop.languages;
    const failed = await startAnalysis(t.db, {
      repoId: await repoId(),
      sha: sha(1),
      analyzerVersion: VERSION,
    });
    await failAnalysis(t.db, failed.id, "LIMIT_FILES");
    const held = await timeline();
    expect(held.queueing).toMatchObject({ state: "too-big", errorCode: "LIMIT_FILES" });
    expect(tasks.google.tasks).toEqual([]);
  });

  it("queues nothing when nothing is due", async () => {
    shop.commits = line(2);
    await done(sha(0));
    await done(sha(1));
    const found = await timeline();
    expect(found.queueing).toEqual({ state: "open" });
    expect(states(found)).toEqual(["analyzed", "analyzed"]);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("remembers GitHub's answer for a minute", async () => {
    await done(sha(0));
    await timeline();
    await timeline();
    expect(gh.requests.filter((r) => !r.url.endsWith("/languages"))).toHaveLength(3);
    clock += 61_000;
    await timeline();
    expect(gh.requests.filter((r) => !r.url.endsWith("/languages"))).toHaveLength(6);
  });

  it("answers missing when GitHub doesn't show the repo or the name is another repo's now", async () => {
    await done(sha(0));
    shop.private = true;
    expect(await viewTimeline({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "missing",
    });
    shop.private = false;
    shop.id = ID + 1;
    expect(await viewTimeline({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "missing",
    });
    expect(tasks.google.tasks).toEqual([]);
  });

  it("answers github-unavailable when GitHub can't be asked, remembering nothing", async () => {
    await done(sha(0));
    gh.failNext(new Error("offline"));
    expect(await viewTimeline({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "github-unavailable",
    });
    // The repo answers, its commits don't.
    const fetch = gh.fetch;
    deps.github = {
      fetch: (input, init) =>
        String(input instanceof Request ? input.url : input).includes("/commits?")
          ? Promise.resolve(new Response("not json"))
          : fetch(input, init),
    };
    expect(await viewTimeline({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "github-unavailable",
    });
    deps.github = { fetch };
    expect((await timeline()).steps).toHaveLength(TIMELINE_COMMITS);
  });

  it("cuts long titles, and leaves out a date it can't read", async () => {
    shop.commits = [
      { sha: sha(0), parents: [], message: `  ${"é".repeat(150)}  \nbody`, date: null },
    ];
    await done(sha(0));
    const [step] = (await timeline()).steps;
    expect(step?.title).toBe(`${"é".repeat(TITLE_LENGTH - 1)}…`);
    expect(Array.from(step?.title ?? "")).toHaveLength(TITLE_LENGTH);
    expect(step?.date).toBeNull();
  });
});

describe("handleTimelineRequest", () => {
  it("answers the timeline as uncached JSON", async () => {
    await done(sha(0));
    const response = await handleTimelineRequest({ owner: "acme", repo: "shop" }, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Timeline;
    expect(body.steps).toHaveLength(TIMELINE_COMMITS);
    expect(body.queueing).toEqual({ state: "open" });
  });

  it("refuses a malformed name, a name nobody analyzed, and a missing repo with 404s", async () => {
    const answer = async (owner: string, repo: string) => {
      const response = await handleTimelineRequest({ owner, repo }, deps);
      return { status: response.status, body: (await response.json()) as unknown };
    };
    expect(await answer("-bad", "shop")).toEqual({ status: 404, body: { error: "NOT_FOUND" } });
    expect(await answer("acme", "shop")).toEqual({
      status: 404,
      body: { error: "NOT_ANALYZED" },
    });
    await done(sha(0));
    shop.private = true;
    expect(await answer("acme", "shop")).toEqual({ status: 404, body: { error: "NOT_FOUND" } });
    shop.private = false;
    gh.failNext(new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    expect(await answer("acme", "shop")).toEqual({
      status: 503,
      body: { error: "GITHUB_UNAVAILABLE" },
    });
  });

  it("answers 503 without the database or when it fails, naming no detail", async () => {
    const response = await handleTimelineRequest({ owner: "acme", repo: "shop" }, undefined);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "UNAVAILABLE" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    const broken = {
      ...deps,
      db: new Proxy(t.db, {
        get: () => {
          throw new TypeError("password=hunter2");
        },
      }),
    };
    const failed = await handleTimelineRequest({ owner: "acme", repo: "shop" }, broken);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "UNAVAILABLE" });
    expect(error.mock.calls).toEqual([['{"event":"timeline_failed","error":"TypeError"}']]);
  });
});
