// @vitest-environment node
import {
  analyses,
  completeAnalysis,
  computeUsage,
  countComputeUsage,
  failAnalysis,
  rateLimits,
  repos,
  startAnalysis,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { jobIdFor } from "@gitinside/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeGitHub, type FakeGitHub, type FakeRepo } from "./github.testkit";
import {
  createHeadCache,
  graphPath,
  movedPath,
  RECHECKS_PER_HOUR,
  UNKNOWN_LOOKUPS_PER_HOUR,
  viewBase,
  viewRepo,
  type RepoViewDeps,
} from "./repoView";
import { createCodeSizeCache } from "./codeSize";
import { QUEUE_UNAVAILABLE } from "./enqueue";
import { fakeTaskQueue } from "./google.testkit";
import { SIZE_HOLD_DAYS } from "./sizeHold";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const VERSION = "0.2.0";
const ID = 4242;
/** The worker's job ID for a commit of the shop at this analyzer version. */
const jobFor = (sha: string) =>
  jobIdFor({ kind: "analyze", owner: "acme", repo: "shop", sha }, VERSION);

let t: TestDb;
let shop: FakeRepo;
let gh: FakeGitHub;
let tasks: ReturnType<typeof fakeTaskQueue>;
let clock: number;
let deps: RepoViewDeps;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(analyses);
  await t.db.delete(repos);
  await t.db.delete(rateLimits);
  await t.db.delete(computeUsage);
  shop = { id: ID, owner: "Acme", name: "Shop", sha: OLD };
  gh = fakeGitHub([shop]);
  tasks = fakeTaskQueue("v".repeat(43));
  clock = 1_000_000;
  deps = {
    db: t.db,
    queue: tasks.queue,
    github: { fetch: gh.fetch },
    analyzerVersion: VERSION,
    heads: createHeadCache({ now: () => clock }),
  };
});

async function repoId(): Promise<string> {
  const facts = { providerRepoId: ID, owner: "Acme", name: "Shop", visibility: "public" as const };
  return (await upsertRepo(t.db, { ...facts, defaultBranch: "main" })).id;
}

/** A finished analysis of `sha`. Each call finishes later than the one before (`now()`). */
async function done(sha: string, version = VERSION) {
  const { id } = await startAnalysis(t.db, {
    repoId: await repoId(),
    sha,
    analyzerVersion: version,
  });
  await completeAnalysis(t.db, id, {
    snapshotKey: `public/acme/shop/${sha}/${version}.json.gz`,
    stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
  });
  return id;
}

async function rows() {
  return t.db
    .select({ sha: analyses.sha, status: analyses.status, version: analyses.analyzerVersion })
    .from(analyses)
    .orderBy(analyses.sha, analyses.analyzerVersion);
}

async function repoSlots(): Promise<number> {
  const all = await t.db.select().from(rateLimits);
  return all.find((r) => r.key === `repo:${ID}`)?.count ?? 0;
}

const ready = (sha: string, head: object, version = VERSION) => ({
  status: "ready",
  owner: "Acme",
  repo: "Shop",
  sha,
  analyzerVersion: version,
  graphUrl: `/api/graph/Acme/Shop/${sha}`,
  head,
});

describe("viewRepo", () => {
  it("offers to analyze a repo with no finished analysis, in GitHub's spelling, asking once a minute", async () => {
    const notAnalyzed = { status: "not-analyzed", owner: "Acme", repo: "Shop" };
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(notAnalyzed);
    expect(gh.requests).toHaveLength(2); // repo + commit
    // A failed or running analysis isn't a diagram either.
    const { id } = await startAnalysis(t.db, {
      repoId: await repoId(),
      sha: OLD,
      analyzerVersion: VERSION,
    });
    await failAnalysis(t.db, id, "LIMIT_FILES");
    expect(await viewRepo({ owner: "ACME", repo: "shop" }, deps)).toEqual(notAnalyzed);
    expect(gh.requests).toHaveLength(2);
    clock += 61_000;
    await viewRepo({ owner: "acme", repo: "shop" }, deps);
    expect(gh.requests).toHaveLength(4);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("offers to analyze a name GitHub can't find or can't be asked about, as written", async () => {
    const asWritten = { status: "not-analyzed", owner: "acme", repo: "nope" };
    expect(await viewRepo({ owner: "acme", repo: "nope" }, deps)).toEqual(asWritten);
    gh.failNext(new Error("offline"));
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({
      ...asWritten,
      repo: "shop",
    });
    // Failures aren't remembered: the next view asks again.
    expect(await viewRepo({ owner: "acme", repo: "nope" }, deps)).toEqual(asWritten);
    expect(gh.requests).toHaveLength(3);
  });

  it("asks GitHub about at most UNKNOWN_LOOKUPS_PER_HOUR unknown names an hour, site-wide", async () => {
    deps.unknownLookupsPerHour = 2;
    for (const repo of ["a", "b", "c", "d"]) await viewRepo({ owner: "acme", repo }, deps);
    expect(gh.requests).toHaveLength(2);
    // Past the cap, even a real repo is offered unchecked (and its answer wasn't kept).
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "not-analyzed",
      owner: "acme",
      repo: "shop",
    });
    expect(gh.requests).toHaveLength(2);
    expect(UNKNOWN_LOOKUPS_PER_HOUR).toBe(500);
  });

  it("follows a rename: the old name moves to the new one, asking once a minute (M5.13b3)", async () => {
    await done(OLD);
    shop.owner = "Shopco";
    shop.name = "Store";
    shop.formerNames = ["Acme/Shop"];
    const moved = { status: "moved", owner: "Shopco", repo: "Store" };
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "current" }),
    );
    // Stored under the new name now (the next analysis's upsert), the old name finds nothing.
    await t.db.update(repos).set({ owner: "Shopco", name: "Store" });
    const requests = gh.requests.length;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(moved);
    expect(gh.requests.length - requests).toBe(3); // 301, the repo, its commit
    expect(await viewRepo({ owner: "Acme", repo: "SHOP" }, deps)).toEqual(moved);
    expect(gh.requests.length - requests).toBe(3);
    expect(await viewRepo({ owner: "shopco", repo: "store" }, deps)).toMatchObject({
      status: "ready",
      owner: "Shopco",
      repo: "Store",
      graphUrl: `/api/graph/Shopco/Store/${OLD}`,
      head: { state: "current" },
    });
    // A permalink never asks GitHub, under either name.
    const asked = gh.requests.length;
    expect(await viewRepo({ owner: "acme", repo: "shop", sha: OLD }, deps)).toEqual({
      status: "missing",
    });
    expect(gh.requests).toHaveLength(asked);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("finds a repo analyzed under its old name by GitHub's ID, then checks it as usual", async () => {
    await done(OLD);
    shop.owner = "Shopco";
    shop.name = "Store";
    shop.sha = NEW;
    // Stored as Acme/Shop; the new name finds it through GitHub, which is asked once.
    expect(await viewRepo({ owner: "shopco", repo: "store" }, deps)).toMatchObject({
      ...ready(OLD, { state: "updating", sha: NEW }),
    });
    expect(gh.requests).toHaveLength(3); // repo + commit + languages (the size check)
    expect(await repoSlots()).toBe(1);
  });

  it("serves a permalink as is, never checking GitHub; an unknown commit is missing", async () => {
    await done(OLD);
    shop.sha = NEW;
    expect(await viewRepo({ owner: "ACME", repo: "shop", sha: OLD }, deps)).toEqual(
      ready(OLD, { state: "pinned" }),
    );
    expect(await viewRepo({ owner: "acme", repo: "shop", sha: NEW }, deps)).toEqual({
      status: "missing",
    });
    expect(gh.requests).toEqual([]);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("shows an up-to-date diagram, asking GitHub at most once a minute", async () => {
    await done(OLD);
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "current" }),
    );
    clock += 59_000;
    await viewRepo({ owner: "Acme", repo: "SHOP" }, deps);
    expect(gh.requests).toHaveLength(2); // repo + commit, once
    clock += 2_000;
    await viewRepo({ owner: "acme", repo: "shop" }, deps);
    expect(gh.requests).toHaveLength(4);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("re-analyzes a new commit once, charged to the repo, and keeps showing the old diagram", async () => {
    await done(OLD);
    shop.sha = NEW;
    const jobId = jobFor(NEW);
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW, jobId }),
    );
    expect(tasks.jobs()).toEqual([{ kind: "analyze", owner: "Acme", repo: "Shop", sha: NEW }]);
    expect(await rows()).toEqual([
      { sha: OLD, status: "done", version: VERSION },
      { sha: NEW, status: "queued", version: VERSION },
    ]);
    // The progress page finds the row by the job's ID (ADR-0139).
    const stored = await t.db.select({ sha: analyses.sha, jobId: analyses.jobId }).from(analyses);
    expect(stored.find((row) => row.sha === NEW)?.jobId).toBe(jobId);
    expect(await repoSlots()).toBe(1);

    // The next view finds it in flight: the same job back, nothing charged.
    clock += 120_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW, jobId }),
    );
    expect(await repoSlots()).toBe(1);

    // Once it's done, the new diagram is shown.
    const row = (await t.db.select().from(analyses)).find((r) => r.sha === NEW);
    await completeAnalysis(t.db, row!.id, {
      snapshotKey: "k",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(NEW, { state: "current" }),
    );
  });

  it("re-analyzes the same commit when the analyzer version changed", async () => {
    await done(OLD, "0.1.0");
    const view = await viewRepo({ owner: "acme", repo: "shop" }, deps);
    expect(view).toEqual(ready(OLD, { state: "updating", sha: OLD, jobId: jobFor(OLD) }, "0.1.0"));
    expect(await rows()).toContainEqual({ sha: OLD, status: "queued", version: VERSION });
  });

  it("shows a newer commit's finished diagram when it's the newest by commit, not by finish", async () => {
    await done(NEW);
    await done(OLD); // an older commit analyzed later finishes last
    shop.sha = NEW;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(NEW, { state: "current" }),
    );
    expect(tasks.google.tasks).toEqual([]);
  });

  it("doesn't re-run a failed analysis of the latest commit on view", async () => {
    await done(OLD);
    const { id } = await startAnalysis(t.db, {
      repoId: await repoId(),
      sha: NEW,
      analyzerVersion: VERSION,
    });
    await failAnalysis(t.db, id, "LIMIT_FILES");
    shop.sha = NEW;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "behind", sha: NEW, reason: "failed", errorCode: "LIMIT_FILES" }),
    );
    expect(tasks.google.tasks).toEqual([]);
  });

  it("doesn't analyze newer commits for a week after one hit a limit, unless it halves (#11)", async () => {
    await done(OLD);
    const { id } = await startAnalysis(t.db, {
      repoId: await repoId(),
      sha: NEW,
      analyzerVersion: VERSION,
    });
    await failAnalysis(t.db, id, "LIMIT_TIME");
    // As queued by the website (the done row's size doesn't matter).
    await t.db.update(analyses).set({ repoSizeKb: 900_000 });
    const failed = (await t.db.select().from(analyses)).find((row) => row.id === id);
    const until = new Date(failed!.finishedAt!.getTime() + SIZE_HOLD_DAYS * 86_400_000);
    const third = "c".repeat(40);
    Object.assign(shop, { sha: third, sizeKb: 450_001 });
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, {
        state: "behind",
        sha: third,
        reason: "too-big",
        errorCode: "LIMIT_TIME",
        until: until.toISOString(),
      }),
    );
    expect(tasks.google.tasks).toEqual([]);
    expect(await repoSlots()).toBe(0);

    shop.sizeKb = 450_000;
    clock += 61_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: third, jobId: jobFor(third) }),
    );
  });

  it("doesn't analyze a newer commit while analyses are paused for the month's compute, but shows the diagram (M5.18d)", async () => {
    await done(OLD);
    shop.sha = NEW;
    await countComputeUsage(t.db, { taskOperations: 800_000 });
    const now = new Date();
    const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "behind", sha: NEW, reason: "paused", until: until.toISOString() }),
    );
    expect(tasks.google.tasks).toEqual([]);
    expect(await repoSlots()).toBe(0);
    expect(await rows()).toEqual([{ sha: OLD, status: "done", version: VERSION }]);
    // Permalinks never reach the check.
    expect(await viewRepo({ owner: "acme", repo: "shop", sha: OLD }, deps)).toEqual(
      ready(OLD, { state: "pinned" }),
    );

    // A new month (here: the count cleared) lets it through.
    await t.db.delete(computeUsage);
    clock += 61_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW, jobId: jobFor(NEW) }),
    );
  });

  it("doesn't analyze a newer commit with too much code by GitHub's count, asking once a commit (#11)", async () => {
    await done(OLD);
    Object.assign(shop, {
      sha: NEW,
      languages: { TypeScript: 220_594_269, JavaScript: 1_159_274 },
    });
    deps.codeSizes = createCodeSizeCache();
    const behind = ready(OLD, {
      state: "behind",
      sha: NEW,
      reason: "too-much-code",
      codeBytes: 221_753_543,
    });
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(behind);
    expect(tasks.google.tasks).toEqual([]);
    expect(await repoSlots()).toBe(0);
    expect(await rows()).toEqual([{ sha: OLD, status: "done", version: VERSION }]);

    // Past the head cache's minute: the repo and commit asked again, the count remembered.
    clock += 61_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(behind);
    expect(gh.requests.map((r) => new URL(r.url).pathname.split("/").pop())).toEqual([
      "shop",
      "HEAD",
      "languages",
      "shop",
      "HEAD",
    ]);

    // A cleanup in the next commit gets it analyzed.
    const third = "c".repeat(40);
    Object.assign(shop, { sha: third, languages: { TypeScript: 40_000_000 } });
    clock += 61_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: third, jobId: jobFor(third) }),
    );
  });

  it("asks GitHub again once a newer analysis is published within the minute (M5 review)", async () => {
    await done(OLD);
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "current" }),
    );
    // A push, then `/api/analyze` (which asks GitHub itself) runs a job that finishes before
    // this process's remembered answer, naming OLD, runs out.
    shop.sha = NEW;
    await done(NEW);
    clock += 30_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(NEW, { state: "current" }),
    );
    expect(gh.requests).toHaveLength(4); // asked again, not "OLD is up to date"
    // The new answer is remembered as before.
    await viewRepo({ owner: "acme", repo: "shop" }, deps);
    expect(gh.requests).toHaveLength(4);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("stops after the repo's hourly budget of re-analyses", async () => {
    await done(OLD);
    deps.rechecksPerHour = 1;
    shop.sha = NEW;
    await viewRepo({ owner: "acme", repo: "shop" }, deps);
    const third = "c".repeat(40);
    shop.sha = third;
    clock += 61_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "behind", sha: third, reason: "limited" }),
    );
    expect(tasks.jobs()).toMatchObject([{ sha: NEW }]);
    expect(RECHECKS_PER_HOUR).toBe(6);
  });

  it("gives the slot back when the queue is down, and tries again on the next view", async () => {
    await done(OLD);
    shop.sha = NEW;
    tasks.setDown(true);
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "behind", sha: NEW, reason: "unavailable" }),
    );
    expect(await repoSlots()).toBe(0);
    // Not left queued with no task to run it.
    expect(await rows()).toContainEqual({ sha: NEW, status: "failed", version: VERSION });

    // A row that never got its task isn't a failed analysis: the next view queues it.
    tasks.setDown(false);
    clock += 61_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW, jobId: jobFor(NEW) }),
    );
    expect(tasks.google.tasks).toHaveLength(1);
    expect(await repoSlots()).toBe(1);
    const stored = await t.db.select().from(analyses);
    expect(stored.find((r) => r.sha === NEW)?.errorCode).toBeNull();
  });

  it("without a queue, a row that never got its task is behind (unavailable), not failed", async () => {
    await done(OLD);
    const { id } = await startAnalysis(t.db, {
      repoId: await repoId(),
      sha: NEW,
      analyzerVersion: VERSION,
    });
    await failAnalysis(t.db, id, QUEUE_UNAVAILABLE);
    shop.sha = NEW;
    deps.queue = undefined;
    // Without a queue it isn't retried, and it's no reason to say the analysis failed.
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "behind", sha: NEW, reason: "unavailable" }),
    );
  });

  it("reports a newer commit without analyzing it when no queue is configured", async () => {
    await done(OLD);
    shop.sha = NEW;
    deps.queue = undefined;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "behind", sha: NEW, reason: "unavailable" }),
    );
    // In flight already (queued by /api/analyze): updating, without a job ID.
    await startAnalysis(t.db, { repoId: await repoId(), sha: NEW, analyzerVersion: VERSION });
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW }),
    );
    // With a queue, even a down one, a running commit needs no task: its job is linked.
    deps.queue = tasks.queue;
    tasks.setDown(true);
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW, jobId: jobFor(NEW) }),
    );
    expect(tasks.google.requests).toEqual([]);
  });

  it("still shows the diagram when GitHub can't be asked, and doesn't remember the failure", async () => {
    await done(OLD);
    gh.failNext(new TypeError("fetch failed"));
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "unknown" }),
    );
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "current" }),
    );
  });

  it("stops serving a repo GitHub no longer shows publicly, permalinks included (M5 review)", async () => {
    await done(OLD);
    shop.private = true;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({ status: "missing" });
    // Hidden in the database: the permalink, which never asks GitHub, stops too, and the
    // repo page stays "not analyzed" once GitHub shows it again, until someone asks for an
    // analysis (which restores the row; analyze.test.ts).
    expect(await viewRepo({ owner: "acme", repo: "shop", sha: OLD }, deps)).toEqual({
      status: "missing",
    });
    shop.private = false;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "not-analyzed",
      owner: "Acme",
      repo: "Shop",
    });
    await repoId();
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "current" }),
    );
  });

  it("stops serving a repo GitHub blocks (451), and doesn't remember the answer", async () => {
    await done(OLD);
    gh.failNext(new Response("", { status: 451 }));
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({ status: "missing" });
    expect(await viewRepo({ owner: "acme", repo: "shop", sha: OLD }, deps)).toEqual({
      status: "missing",
    });
  });

  it("treats a name now held by a different repo as not analyzed", async () => {
    await done(OLD);
    shop.id = 9999; // the old repo was renamed away and a new one took its name
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "not-analyzed",
      owner: "Acme",
      repo: "Shop",
    });
    expect(tasks.google.tasks).toEqual([]);
  });
});

describe("movedPath", () => {
  it("opens the new name with the query as it came, repeated keys in order", () => {
    expect(movedPath({ owner: "Shopco", repo: "Store" })).toBe("/Shopco/Store");
    expect(
      movedPath(
        { owner: "Shopco", repo: "my.store" },
        { sel: "service:api/", base: ["x", OLD], none: undefined },
      ),
    ).toBe(`/Shopco/my.store?sel=service%3Aapi%2F&base=x&base=${OLD}`);
  });
});

describe("viewBase", () => {
  const shown = { owner: "Acme", repo: "Shop" };

  it("finds the base commit's published analysis, never asking GitHub or enqueueing", async () => {
    await done(OLD);
    await done(NEW);
    expect(await viewBase(shown, OLD, t.db)).toEqual({
      status: "ready",
      sha: OLD,
      graphUrl: `/api/graph/Acme/Shop/${OLD}`,
    });
    expect(gh.requests).toEqual([]);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("says a full SHA nobody analyzed is missing, and anything else is invalid", async () => {
    await done(NEW);
    expect(await viewBase(shown, OLD, t.db)).toEqual({ status: "missing", sha: OLD });
    // A failed analysis has no graph to compare with.
    const { id } = await startAnalysis(t.db, {
      repoId: await repoId(),
      sha: OLD,
      analyzerVersion: VERSION,
    });
    await failAnalysis(t.db, id, "LIMIT_FILES");
    expect(await viewBase(shown, OLD, t.db)).toEqual({ status: "missing", sha: OLD });
    for (const bad of ["main", "aaaaaaa", "A".repeat(40), `${OLD}0`, ""]) {
      expect(await viewBase(shown, bad, t.db)).toEqual({ status: "invalid" });
    }
  });

  it("finds nothing of another repo, or of a hidden one", async () => {
    await done(OLD);
    expect(await viewBase({ owner: "acme", repo: "other" }, OLD, t.db)).toEqual({
      status: "missing",
      sha: OLD,
    });
    shop.private = true;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({ status: "missing" });
    expect(await viewBase(shown, OLD, t.db)).toEqual({ status: "missing", sha: OLD });
  });
});

describe("createHeadCache", () => {
  const answer = (sha: string) =>
    ({
      ok: true,
      repo: {
        providerRepoId: 1,
        owner: "a",
        name: "b",
        visibility: "public",
        defaultBranch: "main",
        sha,
      },
    }) as const;

  it("forgets answers after the TTL and never keeps failures", () => {
    let now = 0;
    const cache = createHeadCache({ ttlMs: 10, now: () => now });
    cache.set("a/b", answer(OLD));
    cache.set("a/c", { ok: false, code: "GITHUB_UNAVAILABLE" });
    expect(cache.get("a/b")).toEqual(answer(OLD));
    expect(cache.get("a/c")).toBeUndefined();
    now = 10;
    expect(cache.get("a/b")).toBeUndefined();
  });

  it("drops the oldest entry past its size", () => {
    const cache = createHeadCache({ maxEntries: 2 });
    cache.set("x/1", answer(OLD));
    cache.set("x/2", answer(OLD));
    cache.set("x/1", answer(NEW)); // refreshed: now the newest
    cache.set("x/3", answer(OLD));
    expect(cache.get("x/2")).toBeUndefined();
    expect(cache.get("x/1")).toEqual(answer(NEW));
    expect(cache.get("x/3")).toEqual(answer(OLD));
  });
});

describe("graphPath", () => {
  it("encodes names into the graph route", () => {
    expect(graphPath("acme", "shop.web", OLD)).toBe(`/api/graph/acme/shop.web/${OLD}`);
  });
});
