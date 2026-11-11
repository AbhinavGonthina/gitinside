// @vitest-environment node
import {
  ACCESS_TTL_SECONDS,
  accessCache,
  analyses,
  completeAnalysis,
  computeUsage,
  consumeRateLimit,
  countComputeUsage,
  createSession,
  failAnalysis,
  findPublishedAnalysis,
  findSession,
  installations,
  queueAnalysis,
  rateLimits,
  recordPullRequestDiff,
  recordPullRequestHead,
  repos,
  sessions,
  startAnalysis,
  upsertInstallation,
  upsertRepo,
  upsertUser,
  users,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { jobIdFor } from "@gitinside/worker";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { AuthDeps } from "./authRoute";
import { GRAPH_MAX_DURATION_SECONDS } from "./graphRoute";
import { fakeGitHub, type FakeGitHub, type FakeRepo } from "./github.testkit";
import {
  EXPIRES_IN,
  FAKE_CLIENT,
  fakeOAuth,
  type FakeAccount,
  type FakeInstallation,
  type FakeOAuth,
  type FakeRepo as OAuthRepo,
} from "./githubOAuth.testkit";
import {
  createHeadCache,
  graphPath,
  movedPath,
  PURGE_AGAIN_MS,
  RECHECKS_PER_HOUR,
  RepoAccessUnavailableError,
  UNKNOWN_LOOKUPS_PER_HOUR,
  viewBase,
  viewRepo,
  type RepoViewDeps,
} from "./repoView";
import { hashToken, newToken, SESSION_COOKIE, sealTokens, sessionKeys } from "./session";
import { STRANDED_AFTER_SECONDS, taskIdFor } from "./cloudTasks";
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
  await t.db.delete(accessCache);
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
  // This analyzer's graphs on their own URL (ADR-0258), an older version's on the plain one.
  graphUrl: `/api/graph/Acme/Shop/${sha}${version === VERSION ? `?v=${VERSION}` : ""}`,
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
      graphUrl: `/api/graph/Shopco/Store/${OLD}?v=${VERSION}`,
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

  describe("a demo pin's permalink (ADR-0255)", () => {
    const pin = { providerRepoId: ID, owner: "acme", name: "shop", sha: NEW };
    beforeEach(() => {
      deps.demos = [pin];
    });

    it("queues the pinned commit nobody analyzed, charged to the repo, once", async () => {
      // The default branch is elsewhere: the pin is analyzed at its own commit.
      const queued = {
        status: "queued",
        owner: "Acme",
        repo: "Shop",
        sha: NEW,
        jobId: jobFor(NEW),
      };
      expect(await viewRepo({ owner: "ACME", repo: "Shop", sha: NEW }, deps)).toEqual(queued);
      expect(tasks.google.tasks).toHaveLength(1);
      expect(await rows()).toEqual([{ sha: NEW, status: "queued", version: VERSION }]);
      expect(await repoSlots()).toBe(1);
      // In flight: the same job, nothing queued or charged again.
      expect(await viewRepo({ owner: "acme", repo: "shop", sha: NEW }, deps)).toEqual(queued);
      expect(tasks.google.tasks).toHaveLength(1);
      expect(await repoSlots()).toBe(1);
      // Finished: the permalink serves it as any other, without asking GitHub.
      await t.db.delete(analyses);
      await done(NEW);
      const asked = gh.requests.length;
      expect(await viewRepo({ owner: "acme", repo: "shop", sha: NEW }, deps)).toEqual(
        ready(NEW, { state: "pinned" }),
      );
      expect(gh.requests).toHaveLength(asked);
    });

    it("leaves every other commit a 404 that never asks GitHub", async () => {
      expect(await viewRepo({ owner: "acme", repo: "shop", sha: OLD }, deps)).toEqual({
        status: "missing",
      });
      expect(await viewRepo({ owner: "acme", repo: "shop2", sha: NEW }, deps)).toEqual({
        status: "missing",
      });
      expect(gh.requests).toEqual([]);
      expect(tasks.google.tasks).toEqual([]);
    });

    it("is a 404 when the name is another repo on GitHub now, or none it shows", async () => {
      deps.demos = [{ ...pin, providerRepoId: ID + 1 }];
      expect(await viewRepo({ owner: "acme", repo: "shop", sha: NEW }, deps)).toEqual({
        status: "missing",
      });
      deps.demos = [{ ...pin, name: "nope" }];
      expect(await viewRepo({ owner: "acme", repo: "nope", sha: NEW }, deps)).toEqual({
        status: "missing",
      });
      expect(tasks.google.tasks).toEqual([]);
      expect(await rows()).toEqual([]);
    });

    it("is unavailable when it can't be queued: GitHub down, no queue, a permanent failure, the repo's limit", async () => {
      const view = { owner: "acme", repo: "shop", sha: NEW };
      gh.failNext(new Error("offline"));
      expect(await viewRepo(view, deps)).toEqual({ status: "unavailable" });
      expect(await viewRepo(view, { ...deps, queue: undefined })).toEqual({
        status: "unavailable",
      });
      expect(tasks.google.tasks).toEqual([]);

      // A failure that would fail again isn't re-run, and costs no GitHub call. Not a `LIMIT_*`
      // one, which the size hold would refuse anyway.
      const { id } = await startAnalysis(t.db, {
        repoId: await repoId(),
        sha: NEW,
        analyzerVersion: VERSION,
      });
      await failAnalysis(t.db, id, "TAR_INVALID");
      const asked = gh.requests.length;
      expect(await viewRepo(view, deps)).toEqual({ status: "unavailable" });
      expect(gh.requests).toHaveLength(asked);
      expect(tasks.google.tasks).toEqual([]);

      await t.db.delete(analyses);
      await consumeRateLimit(t.db, `repo:${ID}`, 1);
      expect(await viewRepo(view, { ...deps, rechecksPerHour: 1 })).toEqual({
        status: "unavailable",
      });
      expect(tasks.google.tasks).toEqual([]);
    });

    it("queues the current analyzer version over an older one's graph, once (M9.1b2b)", async () => {
      await done(NEW, "0.1.0");
      const queued = {
        status: "queued",
        owner: "Acme",
        repo: "Shop",
        sha: NEW,
        jobId: jobFor(NEW),
      };
      expect(await viewRepo({ owner: "acme", repo: "shop", sha: NEW }, deps)).toEqual(queued);
      expect(tasks.google.tasks).toHaveLength(1);
      expect(await rows()).toEqual([
        { sha: NEW, status: "done", version: "0.1.0" },
        { sha: NEW, status: "queued", version: VERSION },
      ]);
      expect(await repoSlots()).toBe(1);
      expect(await viewRepo({ owner: "acme", repo: "shop", sha: NEW }, deps)).toEqual(queued);
      expect(tasks.google.tasks).toHaveLength(1);
      expect(await repoSlots()).toBe(1);
      // Finished: this version's graph, with no GitHub call.
      await t.db.delete(analyses);
      await done(NEW, "0.1.0");
      await done(NEW);
      const asked = gh.requests.length;
      expect(await viewRepo({ owner: "acme", repo: "shop", sha: NEW }, deps)).toEqual(
        ready(NEW, { state: "pinned" }),
      );
      expect(gh.requests).toHaveLength(asked);
    });

    it("keeps an older version's graph when the current one can't be queued", async () => {
      await done(NEW, "0.1.0");
      const old = ready(NEW, { state: "pinned" }, "0.1.0");
      const view = { owner: "acme", repo: "shop", sha: NEW };
      gh.failNext(new Error("offline"));
      expect(await viewRepo(view, deps)).toEqual(old);
      expect(await viewRepo(view, { ...deps, queue: undefined })).toEqual(old);
      const { id } = await startAnalysis(t.db, {
        repoId: await repoId(),
        sha: NEW,
        analyzerVersion: VERSION,
      });
      await failAnalysis(t.db, id, "TAR_INVALID");
      expect(await viewRepo(view, deps)).toEqual(old);
      expect(tasks.google.tasks).toEqual([]);
    });

    it("queues a failure that could pass again, under the repo's limits (F1)", async () => {
      await done(NEW, "0.1.0");
      const view = { owner: "acme", repo: "shop", sha: NEW };
      const queued = {
        status: "queued",
        owner: "Acme",
        repo: "Shop",
        sha: NEW,
        jobId: jobFor(NEW),
      };
      const { id } = await startAnalysis(t.db, {
        repoId: await repoId(),
        sha: NEW,
        analyzerVersion: VERSION,
      });
      await failAnalysis(t.db, id, "WORKER_ERROR");
      expect(await viewRepo(view, deps)).toEqual(queued);
      expect(tasks.google.tasks).toHaveLength(1);
      expect(await repoSlots()).toBe(1);
      expect((await rows()).at(-1)).toEqual({ sha: NEW, status: "queued", version: VERSION });

      // Failed again with the repo's hour used up: the older graph, nothing queued.
      await startAnalysis(t.db, { repoId: await repoId(), sha: NEW, analyzerVersion: VERSION });
      await failAnalysis(t.db, id, "DOWNLOAD_FAILED");
      expect(await viewRepo(view, { ...deps, rechecksPerHour: 1 })).toEqual(
        ready(NEW, { state: "pinned" }, "0.1.0"),
      );
      expect(tasks.google.tasks).toHaveLength(1);
    });

    it("asks GitHub at most once a minute while its job is in flight (F2)", async () => {
      const queued = {
        status: "queued",
        owner: "Acme",
        repo: "Shop",
        sha: NEW,
        jobId: jobFor(NEW),
      };
      const view = { owner: "acme", repo: "shop", sha: NEW };
      expect(await viewRepo(view, deps)).toEqual(queued);
      const asked = gh.requests.length;
      expect(asked).toBeGreaterThan(0);
      for (let i = 0; i < 3; i++) expect(await viewRepo(view, deps)).toEqual(queued);
      expect(gh.requests).toHaveLength(asked);
      clock += 61_000;
      expect(await viewRepo(view, deps)).toEqual(queued);
      expect(gh.requests.length).toBeGreaterThan(asked);
      expect(tasks.google.tasks).toHaveLength(1);
    });

    it("keeps an older version's graph of a commit that isn't a pin, never asking GitHub", async () => {
      await done(OLD, "0.1.0");
      expect(await viewRepo({ owner: "acme", repo: "shop", sha: OLD }, deps)).toEqual(
        ready(OLD, { state: "pinned" }, "0.1.0"),
      );
      expect(gh.requests).toEqual([]);
      expect(tasks.google.tasks).toEqual([]);
    });
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

  it("gives a commit queued past every attempt of its task a fresh task, charged to the repo (R10)", async () => {
    await done(OLD);
    shop.sha = NEW;
    // Queued that long ago, with its task: Cloud Tasks gave up on it before the worker wrote
    // anything, and its name stays taken for a day. (The done row's entry doesn't matter.)
    const key = { repoId: await repoId(), sha: NEW, analyzerVersion: VERSION };
    await queueAnalysis(t.db, key, { jobId: jobFor(NEW) });
    const queuedAt = new Date(Date.now() - (STRANDED_AFTER_SECONDS + 5) * 1000);
    await t.db.update(analyses).set({ queuedAt });
    const job = { owner: "Acme", repo: "Shop", sha: NEW };
    await tasks.queue.createTask(job, taskIdFor(jobFor(NEW), queuedAt));

    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW, jobId: jobFor(NEW) }),
    );
    expect(tasks.google.tasks).toHaveLength(2);
    expect(new Set(tasks.taskIds()).size).toBe(2);
    expect(await rows()).toContainEqual({ sha: NEW, status: "queued", version: VERSION });
    expect(await repoSlots()).toBe(1);
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

  it("drops the repo's CDN-cached graphs once it's hidden, never before (M8.4d1)", async () => {
    await done(OLD);
    const purged: [number, boolean][] = [];
    deps.purgeRepo = async (providerRepoId) => {
      // Purged after the row is hidden, so the CDN's next ask can't cache the graph again.
      const published = await findPublishedAnalysis(t.db, { providerRepoId });
      purged.push([providerRepoId, published === undefined]);
    };
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "current" }),
    );
    gh.failNext(new TypeError("fetch failed"));
    clock += 61_000;
    await viewRepo({ owner: "acme", repo: "shop" }, deps);
    expect(purged).toEqual([]);

    shop.private = true;
    clock += 61_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({ status: "missing" });
    expect(purged).toEqual([[ID, true]]);
  });

  it("purges again once every graph answer read before the hide has ended (F14)", async () => {
    await done(OLD);
    let purges = 0;
    deps.purgeRepo = async () => {
      purges += 1;
    };
    const later: [() => Promise<void>, number][] = [];
    deps.later = (task, delayMs) => later.push([task, delayMs]);
    shop.private = true;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({ status: "missing" });
    expect(purges).toBe(1);
    expect(later.map(([, delayMs]) => delayMs)).toEqual([PURGE_AGAIN_MS]);
    // A graph route call that found the repo public has ended by then, CDN copy and all.
    expect(PURGE_AGAIN_MS).toBeGreaterThan(GRAPH_MAX_DURATION_SECONDS * 1000);
    const [task] = later[0] ?? [];
    await task?.();
    expect(purges).toBe(2);

    // A failed second purge is logged like the first, never thrown into the background.
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    deps.purgeRepo = () => Promise.reject(new Error("429 from https://secret.example"));
    await expect(task?.()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "cdn_purge_failed", error: "Error" }));
  });

  it("still hides a repo whose purge fails, logging the failure by name only", async () => {
    await done(OLD);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    deps.purgeRepo = () => Promise.reject(new Error("429 from https://secret.example"));
    gh.failNext(new Response("", { status: 451 }));
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({ status: "missing" });
    expect(await viewRepo({ owner: "acme", repo: "shop", sha: OLD }, deps)).toEqual({
      status: "missing",
    });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "cdn_purge_failed", error: "Error" }));
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

  it("fetches a base by this analyzer version from its versioned URL (ADR-0258)", async () => {
    await done(OLD, "0.1.0");
    await done(NEW);
    expect(await viewBase(shown, NEW, t.db, VERSION)).toMatchObject({
      graphUrl: `/api/graph/Acme/Shop/${NEW}?v=${VERSION}`,
    });
    expect(await viewBase(shown, OLD, t.db, VERSION)).toMatchObject({
      graphUrl: `/api/graph/Acme/Shop/${OLD}`,
    });
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

  it("says where the pull request's stored diff of exactly this base and commit is (M8.6f1)", async () => {
    await done(OLD);
    await done(NEW);
    const id = await repoId();
    const eventBase = "e".repeat(40);
    await recordPullRequestHead(t.db, {
      repoId: id,
      number: 7,
      baseSha: eventBase,
      headSha: NEW,
      headAt: new Date("2026-11-08T10:00:00Z"),
    });
    await recordPullRequestDiff(t.db, {
      repoId: id,
      number: 7,
      baseSha: eventBase,
      headSha: NEW,
      diffKey: `private/41/${id}/diffs/${OLD}-${NEW}/${VERSION}.json.gz`,
      brokenCount: 1,
    });
    const head = { ...shown, sha: NEW, analyzerVersion: VERSION };
    expect(await viewBase(head, OLD, t.db)).toEqual({
      status: "ready",
      sha: OLD,
      graphUrl: `/api/graph/Acme/Shop/${OLD}`,
      diffUrl: `/api/diff/Acme/Shop/${OLD}/${NEW}`,
    });
    // Another version's page, another commit, or no commit named: no stored diff.
    for (const other of [{ ...head, analyzerVersion: "0.1.0" }, { ...head, sha: OLD }, shown]) {
      expect(await viewBase(other, OLD, t.db), JSON.stringify(other)).not.toHaveProperty("diffUrl");
    }
  });
});

describe("viewRepo and viewBase for a private repo (M8.4c1)", () => {
  const NOW = Date.parse("2026-11-07T12:00:00.000Z");
  const SECRET_ID = 77;
  const OCTO: FakeAccount = { id: 3_000_000_007, login: "octo" };
  const HUBOT: FakeAccount = { id: 3_000_000_008, login: "hubot" };
  const KEYS = sessionKeys("s".repeat(43));
  const ACME: FakeInstallation = {
    id: 41,
    account: { login: "acme", type: "Organization" },
    selection: "selected",
    repos: [{ owner: "Acme", name: "Secret", private: true, id: SECRET_ID }],
  };
  const secret = { owner: "acme", repo: "secret" };
  const graphUrl = (sha: string) => `/api/graph/Acme/Secret/${sha}`;
  const shown = (sha: string, head: object) => ({
    status: "ready",
    owner: "Acme",
    repo: "Secret",
    sha,
    analyzerVersion: VERSION,
    graphUrl: `${graphUrl(sha)}?v=${VERSION}`,
    head,
    private: { providerRepoId: SECRET_ID },
  });

  let github: FakeOAuth;
  let auth: AuthDeps;
  /** Acme/Secret as GitHub shows it to OCTO's token: its default branch is at NEW. */
  let secretRepo: OAuthRepo;
  beforeEach(async () => {
    await t.db.delete(sessions);
    await t.db.delete(users);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    github = fakeOAuth();
    secretRepo = { owner: "Acme", name: "Secret", private: true, id: SECRET_ID, sha: NEW };
    github.install(OCTO, [{ ...ACME, repos: [secretRepo] }]);
    auth = {
      db: t.db,
      client: { ...FAKE_CLIENT, fetch: github.fetch },
      keys: KEYS,
      now: () => NOW,
    };
    await t.db.delete(installations);
    await upsertInstallation(t.db, {
      githubInstallationId: 41,
      accountId: 1041,
      accountLogin: "acme",
      accountType: "Organization",
      suspendedAt: null,
    });
    await privateDone(OLD);
    await privateDone(NEW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A finished analysis of `sha` of the private Acme/Secret (linked to installation 41), finishing after the one before. */
  async function privateDone(sha: string) {
    const { id: repoId } = await upsertRepo(t.db, {
      providerRepoId: SECRET_ID,
      owner: "Acme",
      name: "Secret",
      visibility: "private",
      defaultBranch: "main",
      githubInstallationId: 41,
    });
    const { id } = await startAnalysis(t.db, { repoId, sha, analyzerVersion: VERSION });
    await completeAnalysis(t.db, id, {
      snapshotKey: `private/41/${repoId}/${sha}/${VERSION}.json.gz`,
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
  }

  /** A live session for `account`, and the deps of a page it views. */
  async function signIn(account: FakeAccount) {
    const issued = github.issue(account);
    const token = newToken();
    const tokenHash = hashToken(token);
    const userId = await upsertUser(t.db, { githubUserId: account.id, login: account.login });
    await createSession(t.db, {
      userId,
      tokenHash,
      githubTokens: sealTokens(KEYS, tokenHash, {
        accessToken: issued.accessToken,
        accessExpiresAt: NOW + EXPIRES_IN * 1000,
        refreshToken: issued.refreshToken,
        refreshExpiresAt: NOW + 1e10,
      }),
      lifetimeSeconds: 3600,
    });
    const cookie = `theme=dark; ${SESSION_COOKIE}=${token}`;
    return { deps: viewing(cookie), tokenHash, issued };
  }

  const viewing = (cookie: string | null): RepoViewDeps => ({ ...deps, viewer: { cookie, auth } });
  const lookups = () => github.requests.filter((r) => r.url.includes("/repositories/")).length;

  it("shows the newest analysis to a user GitHub shows the repo to, checked once a minute", async () => {
    const octo = await signIn(OCTO);
    expect(await viewRepo(secret, octo.deps)).toEqual(shown(NEW, { state: "current" }));
    expect(await viewRepo({ ...secret, sha: OLD }, octo.deps)).toEqual(
      shown(OLD, { state: "pinned" }),
    );
    // The access check, then the latest commit by ID with the user's token (M8.4c2).
    expect(github.requests.map((r) => r.url)).toEqual([
      `https://api.github.com/repositories/${SECRET_ID}`,
      `https://api.github.com/repositories/${SECRET_ID}`,
      `https://api.github.com/repositories/${SECRET_ID}/commits/HEAD`,
    ]);
    expect(lookups()).toBe(3);
    // Nothing asked with the server's token (it can't see the repo), nothing queued.
    expect(gh.requests).toEqual([]);
    expect(tasks.google.tasks).toEqual([]);
  });

  describe("check-on-view with the viewer's token (M8.4c2)", () => {
    const NEWER = "c".repeat(40);
    const jobId = jobIdFor(
      { kind: "analyze", owner: "Acme", repo: "Secret", sha: NEWER, installationId: 41 },
      VERSION,
    );
    const slots = async () =>
      (await t.db.select().from(rateLimits)).find((r) => r.key === `repo:${SECRET_ID}`)?.count ?? 0;

    it("queues a newer commit through the repo's installation, charged to the repo", async () => {
      const octo = await signIn(OCTO);
      secretRepo.sha = NEWER;
      expect(await viewRepo(secret, octo.deps)).toEqual(
        shown(NEW, { state: "updating", sha: NEWER, jobId }),
      );
      expect(tasks.jobs()).toEqual([
        { kind: "analyze", owner: "Acme", repo: "Secret", sha: NEWER, installationId: 41 },
      ]);
      expect(await slots()).toBe(1);
      // Its code was counted with the user's token too, never the server's.
      expect(github.requests.map((r) => r.url)).toContain(
        "https://api.github.com/repos/Acme/Secret/languages",
      );
      expect(gh.requests).toEqual([]);

      // The next view within the minute asks GitHub nothing and follows the same job.
      const before = github.requests.length;
      expect(await viewRepo(secret, octo.deps)).toEqual(
        shown(NEW, { state: "updating", sha: NEWER, jobId }),
      );
      expect(github.requests).toHaveLength(before);
      expect(tasks.google.tasks).toHaveLength(1);
      expect(await slots()).toBe(1);

      // Once it's done, the newer diagram is shown.
      const row = (await t.db.select().from(analyses)).find((r) => r.sha === NEWER);
      await completeAnalysis(t.db, row!.id, {
        snapshotKey: "k",
        stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
      });
      clock += 120_000;
      expect(await viewRepo(secret, octo.deps)).toEqual(shown(NEWER, { state: "current" }));
    });

    it("says the installation is gone when the repo isn't linked to one, queueing nothing", async () => {
      const octo = await signIn(OCTO);
      secretRepo.sha = NEWER;
      await t.db.update(repos).set({ installationId: null });
      expect(await viewRepo(secret, octo.deps)).toEqual(
        shown(NEW, {
          state: "behind",
          sha: NEWER,
          reason: "failed",
          errorCode: "INSTALLATION_NOT_FOUND",
        }),
      );
      expect(tasks.google.tasks).toEqual([]);
      expect(await slots()).toBe(0);
    });

    it("says the installation is suspended, refunding the repo's slot", async () => {
      const octo = await signIn(OCTO);
      secretRepo.sha = NEWER;
      await t.db.update(installations).set({ suspendedAt: new Date(NOW) });
      expect(await viewRepo(secret, octo.deps)).toEqual(
        shown(NEW, {
          state: "behind",
          sha: NEWER,
          reason: "failed",
          errorCode: "INSTALLATION_SUSPENDED",
        }),
      );
      expect(tasks.google.tasks).toEqual([]);
      expect(await slots()).toBe(0);
      expect((await rows()).map((r) => r.sha)).not.toContain(NEWER);
    });

    it("analyzes the shown commit again as a public job when GitHub says the repo is public now (M8.4d2)", async () => {
      // The server's token sees it too, now that it's public.
      const server = fakeGitHub([{ id: SECRET_ID, owner: "Acme", name: "Secret", sha: NEW }]);
      deps.github = { fetch: server.fetch };
      const octo = await signIn(OCTO);
      secretRepo.private = false;
      const publicJob = jobIdFor(
        { kind: "analyze", owner: "Acme", repo: "Secret", sha: NEW },
        VERSION,
      );

      // Still shown to octo from its private snapshot, behind the check, while it's redone.
      expect(await viewRepo(secret, octo.deps)).toEqual(
        shown(NEW, { state: "updating", sha: NEW, jobId: publicJob }),
      );
      expect(tasks.jobs()).toEqual([{ kind: "analyze", owner: "Acme", repo: "Secret", sha: NEW }]);
      expect(await slots()).toBe(1);
      const [repo] = await t.db.select({ visibility: repos.visibility }).from(repos);
      expect(repo?.visibility).toBe("public");
      const row = (await t.db.select().from(analyses)).find((r) => r.sha === NEW);
      expect(row).toMatchObject({ status: "queued", snapshotKey: null, jobId: publicJob });

      // Meanwhile nobody else gets a private snapshot, though the repo's row is public.
      expect(await viewRepo({ ...secret, sha: OLD }, deps)).toEqual({ status: "missing" });
      expect(await viewRepo({ ...secret, sha: OLD }, octo.deps)).toEqual(
        shown(OLD, { state: "pinned" }),
      );
      // The next view shows OLD (NEW isn't finished any more), following the same job.
      expect(await viewRepo(secret, octo.deps)).toEqual(
        shown(OLD, { state: "updating", sha: NEW, jobId: publicJob }),
      );
      expect(tasks.google.tasks).toHaveLength(1);

      // Done under the public key, it's everyone's, with no private mark.
      const publicKey = `public/acme/secret/${NEW}/${VERSION}.json.gz`;
      await completeAnalysis(t.db, row!.id, {
        snapshotKey: publicKey,
        stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
      });
      const { private: _private, ...everyone } = shown(NEW, { state: "current" });
      clock += 120_000;
      expect(await viewRepo(secret, deps)).toEqual(everyone);
      expect(await viewRepo(secret, octo.deps)).toEqual(everyone);
    });

    it("queues a public page's newer commit afresh when it was analyzed privately (M8.4d2)", async () => {
      // Public again, with a public analysis of OLD; NEW was analyzed while it was private.
      const server = fakeGitHub([{ id: SECRET_ID, owner: "Acme", name: "Secret", sha: NEW }]);
      deps.github = { fetch: server.fetch };
      await t.db.delete(analyses);
      const { id: repoId } = await upsertRepo(t.db, {
        providerRepoId: SECRET_ID,
        owner: "Acme",
        name: "Secret",
        visibility: "public",
        defaultBranch: "main",
      });
      for (const [sha, snapshotKey] of [
        [OLD, `public/acme/secret/${OLD}/${VERSION}.json.gz`],
        [NEW, `private/41/${repoId}/${NEW}/${VERSION}.json.gz`],
      ] as const) {
        const { id } = await startAnalysis(t.db, { repoId, sha, analyzerVersion: VERSION });
        const stats = { files: 1, nodes: 1, edges: 0, unresolved: 0 };
        await completeAnalysis(t.db, id, { snapshotKey, stats });
      }
      const publicJob = jobIdFor(
        { kind: "analyze", owner: "Acme", repo: "Secret", sha: NEW },
        VERSION,
      );

      const { private: _private, ...oldShown } = shown(OLD, {
        state: "updating",
        sha: NEW,
        jobId: publicJob,
      });
      expect(await viewRepo(secret, deps)).toEqual(oldShown);
      expect(tasks.jobs()).toEqual([{ kind: "analyze", owner: "Acme", repo: "Secret", sha: NEW }]);
      expect(await slots()).toBe(1);
      // NEW's permalink isn't served from its private snapshot.
      expect(await viewRepo({ ...secret, sha: NEW }, deps)).toEqual({ status: "missing" });
      const queued = (await t.db.select().from(analyses)).find((r) => r.sha === NEW);
      expect(queued).toMatchObject({ status: "queued", snapshotKey: null, jobId: publicJob });
    });

    it("is unknown when GitHub can't answer, asking again on the next view", async () => {
      const octo = await signIn(OCTO);
      expect((await viewRepo(secret, octo.deps)).status).toBe("ready"); // the check, remembered
      const cold: RepoViewDeps = { ...octo.deps, heads: createHeadCache({ now: () => clock }) };
      github.failNext(new Response("oops", { status: 502 }));
      expect(await viewRepo(secret, cold)).toEqual(shown(NEW, { state: "unknown" }));
      expect(await viewRepo(secret, cold)).toEqual(shown(NEW, { state: "current" }));
    });

    it("never answers a public page of the same name from a private repo's remembered head", async () => {
      const octo = await signIn(OCTO);
      expect((await viewRepo(secret, octo.deps)).status).toBe("ready");
      // The private answer sits under `#77@…`; a public lookup of the name asks GitHub itself.
      expect(gh.requests).toEqual([]);
      expect(await viewRepo(secret, deps)).toEqual({ status: "not-analyzed", ...secret });
      expect(gh.requests).toHaveLength(1);
    });
  });

  describe("a public repo that turned private, on the view that hides it (F15)", () => {
    beforeEach(async () => {
      // Acme/Secret was analyzed while public; the server's token doesn't see it any more.
      await t.db.delete(accessCache);
      await t.db.delete(analyses);
      await t.db.delete(repos);
      const { id: repoId } = await upsertRepo(t.db, {
        providerRepoId: SECRET_ID,
        owner: "Acme",
        name: "Secret",
        visibility: "public",
        defaultBranch: "main",
      });
      for (const sha of [OLD, NEW]) {
        const { id } = await startAnalysis(t.db, { repoId, sha, analyzerVersion: VERSION });
        await completeAnalysis(t.db, id, {
          snapshotKey: `public/acme/secret/${sha}/${VERSION}.json.gz`,
          stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
        });
      }
      deps.github = { fetch: fakeGitHub([]).fetch };
    });
    const visibility = async () =>
      (await t.db.select({ visibility: repos.visibility }).from(repos))[0]?.visibility;

    it("shows it to a signed-in viewer the check allows, hidden from everyone else", async () => {
      const octo = await signIn(OCTO);
      expect(await viewRepo(secret, octo.deps)).toEqual(shown(NEW, { state: "current" }));
      expect(await visibility()).toBe("private");
      expect(await viewRepo({ ...secret, sha: NEW }, deps)).toEqual({ status: "missing" });
    });

    it("is a 404 to a viewer the check refuses, as before", async () => {
      const hubot = await signIn(HUBOT);
      expect(await viewRepo(secret, hubot.deps)).toEqual({ status: "missing" });
      expect(await visibility()).toBe("private");
    });
  });

  it("goes on exactly as for a name nobody analyzed when signed out, refused, or without a viewer", async () => {
    const hubot = await signIn(HUBOT); // signed in, but not in Acme's installation
    const cases: [string, RepoViewDeps][] = [
      ["no viewer (the README images)", deps],
      ["signed out", viewing(null)],
      ["a dead cookie", viewing(`${SESSION_COOKIE}=${newToken()}`)],
      ["refused", hubot.deps],
    ];
    for (const [name, d] of cases) {
      // What any unanalyzed name gets: the lookup as written (GitHub doesn't show it), a 404.
      expect(await viewRepo(secret, d), name).toEqual({ status: "not-analyzed", ...secret });
      expect(await viewRepo({ ...secret, sha: NEW }, d), name).toEqual({ status: "missing" });
    }
    expect(lookups()).toBe(1); // hubot's refusal, remembered
  });

  it("refuses once access removed on GitHub is 60 s old", async () => {
    const octo = await signIn(OCTO);
    expect((await viewRepo(secret, octo.deps)).status).toBe("ready");
    github.install(OCTO, []);
    const [row] = await t.db.select().from(accessCache);
    await t.db.update(accessCache).set({
      checkedAt: new Date((row?.checkedAt.getTime() ?? 0) - ACCESS_TTL_SECONDS * 1000),
    });
    expect(await viewRepo({ ...secret, sha: NEW }, octo.deps)).toEqual({ status: "missing" });
  });

  it("ends the session when GitHub refuses the user's token, showing nothing", async () => {
    const octo = await signIn(OCTO);
    github.revoke(octo.issued.accessToken);
    expect(await viewRepo({ ...secret, sha: NEW }, octo.deps)).toEqual({ status: "missing" });
    expect(await findSession(t.db, octo.tokenHash)).toBeUndefined();
  });

  it("throws when the check can't decide, remembering nothing", async () => {
    const octo = await signIn(OCTO);
    github.failNext(new Response("oops", { status: 502 }));
    await expect(viewRepo(secret, octo.deps)).rejects.toThrow(RepoAccessUnavailableError);
    expect((await viewRepo(secret, octo.deps)).status).toBe("ready");
  });

  it("shows a public repo of the same name as before, without a check", async () => {
    const octo = await signIn(OCTO);
    await done(OLD); // the public Acme/Shop
    expect(await viewRepo({ owner: "acme", repo: "shop", sha: OLD }, octo.deps)).toEqual(
      ready(OLD, { state: "pinned" }),
    );
    expect(lookups()).toBe(0);
  });

  it("compares with the private repo's own analyses, by GitHub's ID", async () => {
    const octo = await signIn(OCTO);
    const view = await viewRepo(secret, octo.deps);
    if (view.status !== "ready") throw new Error(`not shown: ${view.status}`);
    expect(await viewBase(view, OLD, t.db)).toEqual({
      status: "ready",
      sha: OLD,
      graphUrl: graphUrl(OLD),
    });
    const other = "c".repeat(40);
    expect(await viewBase(view, other, t.db)).toEqual({
      status: "missing",
      sha: other,
    });
    // Without the check's mark, a private repo's commits are never found by name.
    expect(await viewBase({ owner: "Acme", repo: "Secret" }, OLD, t.db)).toEqual({
      status: "missing",
      sha: OLD,
    });
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
    expect(graphPath("acme", "shop", OLD, "0.3.0")).toBe(`/api/graph/acme/shop/${OLD}?v=0.3.0`);
  });
});
