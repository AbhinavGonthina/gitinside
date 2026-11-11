// @vitest-environment node
import {
  analyses,
  completeAnalysis,
  computeUsage,
  computeUsageThisMonth,
  countComputeUsage,
  failAnalysis,
  hideRepo,
  queueAnalysis,
  rateLimits,
  repos,
  startAnalysis,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { jobIdFor } from "@gitinside/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  REPO_ANALYSIS_MINUTES,
  requestAnalysis,
  UNAVAILABLE_MESSAGE,
  type AnalyzeDeps,
} from "./analyze";
import { SIGNED_IN_HOURLY_LIMIT } from "./serverDeps";
import {
  CHALLENGE_AFTER_PER_ADDRESS,
  CHALLENGE_AFTER_SITE,
  CHALLENGE_FAILED_MESSAGE,
  CHALLENGE_UNAVAILABLE_MESSAGE,
  challengeMessage,
  SITE_ANALYZE_KEY,
  type Verdict,
} from "./botCheck";
import { rateLimitKey, userRateLimitKey } from "./clientIp";
import { STRANDED_AFTER_SECONDS, taskIdFor } from "./cloudTasks";
import { QUEUE_UNAVAILABLE } from "./enqueue";
import { fakeGitHub, type FakeGitHub } from "./github.testkit";
import { fakeTaskQueue } from "./google.testkit";
import { MAX_GITHUB_CODE_BYTES } from "./codeSize";
import { failureView, pausedMessage, sizeHoldMessage, tooMuchCodeMessage } from "./jobs";

const SHA = "e".repeat(40);
const VERSION = "0.1.0";
const SECRET = "r".repeat(43);
const IP = "203.0.113.7";
const SHOP = { id: 4242, owner: "Acme", name: "Shop", sha: SHA };
const JOB_ID = jobIdFor({ kind: "analyze", owner: "acme", repo: "shop", sha: SHA }, VERSION);

let t: TestDb;
let gh: FakeGitHub;
let tasks: ReturnType<typeof fakeTaskQueue>;
let deps: AnalyzeDeps;

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
  gh = fakeGitHub([SHOP, { id: 7, owner: "acme", name: "empty", sha: null }]);
  tasks = fakeTaskQueue(SECRET);
  deps = {
    db: t.db,
    queue: tasks.queue,
    github: { fetch: gh.fetch },
    analyzerVersion: VERSION,
    rateLimitSecret: SECRET,
    hourlyLimit: 5,
    signedInHourlyLimit: SIGNED_IN_HOURLY_LIMIT,
  };
});

async function analysisRows() {
  return t.db
    .select({ status: analyses.status, sha: analyses.sha, errorCode: analyses.errorCode })
    .from(analyses);
}

async function jobIds() {
  return (await t.db.select({ jobId: analyses.jobId }).from(analyses)).map((r) => r.jobId);
}

async function slotsUsed(address = IP): Promise<number> {
  const rows = await t.db.select().from(rateLimits);
  return rows.find((r) => r.key === rateLimitKey(SECRET, address))?.count ?? 0;
}

/** When the repo with GitHub ID `providerRepoId` was claimed for a new analysis, if it is. */
async function claimOf(providerRepoId: number): Promise<Date | undefined> {
  const rows = await t.db.select().from(repos);
  return rows.find((r) => r.providerRepoId === providerRepoId)?.analysisClaimedAt ?? undefined;
}

async function doneAnalysis() {
  const { id: repoId } = await upsertRepo(t.db, {
    providerRepoId: SHOP.id,
    owner: "acme",
    name: "shop",
    visibility: "public",
    defaultBranch: "main",
  });
  const { id } = await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: VERSION });
  return { repoId, id };
}

/** The first instant of the next UTC month, by this machine's clock. */
function nextUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

describe("requestAnalysis, the monthly compute budget (M5.18d)", () => {
  it("counts the task it creates as one Cloud Tasks operation", async () => {
    expect((await requestAnalysis("acme/shop", IP, deps)).status).toBe(202);
    expect(await computeUsageThisMonth(t.db)).toMatchObject({ taskOperations: 1, instanceMs: 0 });
  });

  it("counts a create call the queue refused too", async () => {
    tasks.setDown(true);
    expect((await requestAnalysis("acme/shop", IP, deps)).status).toBe(503);
    expect((await computeUsageThisMonth(t.db)).taskOperations).toBe(1);
  });

  it("refuses a new analysis at 80% of the free allowance until the next UTC month, using nothing", async () => {
    await countComputeUsage(t.db, { taskOperations: 800_000 });
    const until = nextUtcMonth();
    const answer = await requestAnalysis("acme/shop", IP, deps);
    expect(answer).toMatchObject({
      status: 503,
      body: {
        error: "ANALYSIS_PAUSED",
        message: pausedMessage(until),
        retryAt: until.toISOString(),
      },
    });
    expect(Number(answer.headers?.["retry-after"])).toBeGreaterThan(0);
    expect(answer.body).toMatchObject({
      message: expect.stringMatching(
        /^Analysis is paused until .+ UTC: .+ Diagrams already made still work\.$/,
      ),
    });
    expect(await analysisRows()).toEqual([]);
    expect(tasks.google.requests).toEqual([]);
    expect(await slotsUsed()).toBe(0);
    expect(await claimOf(SHOP.id)).toBeUndefined();
    expect((await computeUsageThisMonth(t.db)).taskOperations).toBe(800_000);
  });

  it("lets new analyses through just under 80%", async () => {
    await countComputeUsage(t.db, { taskOperations: 799_999 });
    expect((await requestAnalysis("acme/shop", IP, deps)).status).toBe(202);
  });

  it("refuses a new analysis at 80% of Secret Manager's free accesses (M5.14b3g2)", async () => {
    await countComputeUsage(t.db, { secretAccesses: 8_000 });
    const answer = await requestAnalysis("acme/shop", IP, deps);
    expect(answer).toMatchObject({ status: 503, body: { error: "ANALYSIS_PAUSED" } });
    expect(tasks.google.requests).toEqual([]);
  });

  it("still serves finished diagrams and a commit already in flight while paused", async () => {
    await countComputeUsage(t.db, { runRequests: 1_600_000 });
    await doneAnalysis(); // running
    expect(await requestAnalysis("acme/shop", IP, deps)).toMatchObject({
      status: 202,
      body: { status: "queued", jobId: JOB_ID },
    });

    const { id } = await t.db
      .select({ id: analyses.id })
      .from(analyses)
      .then(([row]) => row!);
    await completeAnalysis(t.db, id, {
      snapshotKey: "public/acme/shop/x.json.gz",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    expect(await requestAnalysis("acme/shop", IP, deps)).toMatchObject({
      status: 200,
      body: { status: "done" },
    });
  });
});

describe("requestAnalysis", () => {
  it("queues a new commit: the repo and a queued row, one task, one slot used", async () => {
    const answer = await requestAnalysis("https://github.com/acme/shop/tree/main/src", IP, deps);
    expect(answer).toEqual({
      status: 202,
      body: { status: "queued", jobId: JOB_ID, owner: "Acme", repo: "Shop", sha: SHA },
    });
    expect(tasks.jobs()).toEqual([{ kind: "analyze", owner: "Acme", repo: "Shop", sha: SHA }]);
    expect(await analysisRows()).toEqual([{ status: "queued", sha: SHA, errorCode: null }]);
    // The progress page finds the row by the job's ID (ADR-0139), the worker's own.
    expect(await jobIds()).toEqual([JOB_ID]);
    const [repo] = await t.db.select().from(repos);
    expect(repo).toMatchObject({ providerRepoId: SHOP.id, owner: "Acme", name: "Shop" });
    expect(await slotsUsed()).toBe(1);
  });

  it("serves a done analysis from the cache without the queue or the rate limit", async () => {
    const { id } = await doneAnalysis();
    await completeAnalysis(t.db, id, {
      snapshotKey: "public/acme/shop/x.json.gz",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    // Even with this address's limit used up and the queue down.
    await t.db.insert(rateLimits).values({
      key: rateLimitKey(SECRET, IP),
      windowStart: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000),
      count: 5,
    });
    tasks.setDown(true);
    const answer = await requestAnalysis("acme/shop", IP, deps);
    expect(answer).toEqual({
      status: 200,
      body: { status: "done", owner: "Acme", repo: "Shop", sha: SHA },
    });
    expect(tasks.google.requests).toEqual([]);
    expect(await slotsUsed()).toBe(5);
  });

  it("a cache hit restores a repo hidden while it was private (M5 review)", async () => {
    const { repoId, id } = await doneAnalysis();
    await completeAnalysis(t.db, id, {
      snapshotKey: "k",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    await hideRepo(t.db, repoId);
    expect((await requestAnalysis("acme/shop", IP, deps)).status).toBe(200);
    const [repo] = await t.db.select().from(repos);
    expect(repo).toMatchObject({ visibility: "public", owner: "Acme", name: "Shop" });
  });

  it("analyzes again, publicly, a commit analyzed while the repo was private (M8.4d2)", async () => {
    const { repoId, id } = await doneAnalysis();
    await completeAnalysis(t.db, id, {
      snapshotKey: `private/41/${repoId}/${SHA}/${VERSION}.json.gz`,
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    await hideRepo(t.db, repoId);
    const answer = await requestAnalysis("acme/shop", IP, deps);
    expect(answer).toEqual({
      status: 202,
      body: { status: "queued", jobId: JOB_ID, owner: "Acme", repo: "Shop", sha: SHA },
    });
    // A new analysis by every rule: a public job, one task, the caller's slot, the repo's claim.
    expect(tasks.jobs()).toEqual([{ kind: "analyze", owner: "Acme", repo: "Shop", sha: SHA }]);
    expect(await slotsUsed()).toBe(1);
    expect(await claimOf(SHOP.id)).toBeDefined();
    const [row] = await t.db.select().from(analyses);
    expect(row).toMatchObject({ id, status: "queued", snapshotKey: null, jobId: JOB_ID });
    const [repo] = await t.db.select().from(repos);
    expect(repo?.visibility).toBe("public");
    // Asked again, it's the same job.
    const again = await requestAnalysis("acme/shop", "198.51.100.1", deps);
    expect(again).toMatchObject({ status: 202, body: { jobId: JOB_ID } });
    expect(tasks.google.tasks).toHaveLength(1);
  });

  it("creates no task when the queued row can't be written", async () => {
    const db = new Proxy(t.db, {
      get(target, key, receiver) {
        if (key === "transaction") return () => Promise.reject(new Error("connection lost"));
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    await expect(requestAnalysis("acme/shop", IP, { ...deps, db })).rejects.toThrow(
      "connection lost",
    );
    expect(tasks.google.tasks).toEqual([]);
    expect(await analysisRows()).toEqual([]);
  });

  it("a different analyzer version's result isn't a cache hit", async () => {
    const { id } = await doneAnalysis();
    await completeAnalysis(t.db, id, {
      snapshotKey: "k",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    const answer = await requestAnalysis("acme/shop", IP, { ...deps, analyzerVersion: "0.2.0" });
    expect(answer.status).toBe(202);
    expect(tasks.google.tasks).toHaveLength(1);
  });

  it("dedupes a commit in flight: the same job, no slot used, no second task", async () => {
    await requestAnalysis("acme/shop", IP, deps);
    const again = await requestAnalysis("ACME/SHOP", "198.51.100.1", deps);
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ jobId: JOB_ID });
    expect(await slotsUsed("198.51.100.1")).toBe(0);
    expect(tasks.google.tasks).toHaveLength(1);
    // A running row counts as in flight too.
    await t.db.update(analyses).set({ status: "running", startedAt: new Date() });
    expect((await requestAnalysis("acme/shop", "198.51.100.1", deps)).status).toBe(202);
    expect(await slotsUsed("198.51.100.1")).toBe(0);
    expect(tasks.google.tasks).toHaveLength(1);
  });

  describe("a commit queued past every attempt of its task (R10)", () => {
    /**
     * Queued that long ago, with its task: Cloud Tasks gave up on it before the worker wrote
     * anything (3 cold-start 503s), and its name stays taken for a day.
     */
    async function strand() {
      const { id: repoId } = await upsertRepo(t.db, {
        providerRepoId: SHOP.id,
        owner: "Acme",
        name: "Shop",
        visibility: "public",
        defaultBranch: "main",
      });
      const key = { repoId, sha: SHA, analyzerVersion: VERSION };
      await queueAnalysis(t.db, key, { jobId: JOB_ID });
      const queuedAt = new Date(Date.now() - (STRANDED_AFTER_SECONDS + 5) * 1000);
      await t.db.update(analyses).set({ queuedAt });
      const job = { owner: "Acme", repo: "Shop", sha: SHA };
      await tasks.queue.createTask(job, taskIdFor(JOB_ID, queuedAt));
    }

    it("gets a fresh task, counted as a new analysis", async () => {
      await strand();
      const answer = await requestAnalysis("acme/shop", "198.51.100.1", deps);
      expect(answer).toMatchObject({ status: 202, body: { status: "queued", jobId: JOB_ID } });
      expect(tasks.google.tasks).toHaveLength(2);
      expect(new Set(tasks.taskIds()).size).toBe(2);
      expect(await analysisRows()).toEqual([{ status: "queued", sha: SHA, errorCode: null }]);
      expect(await slotsUsed("198.51.100.1")).toBe(1);
    });

    it("meets the limits of a new analysis: paused at 80% of the month's compute", async () => {
      await strand();
      await countComputeUsage(t.db, { taskOperations: 800_000 });
      const answer = await requestAnalysis("acme/shop", "198.51.100.1", deps);
      expect(answer).toMatchObject({ status: 503, body: { error: "ANALYSIS_PAUSED" } });
      expect(tasks.google.tasks).toHaveLength(1);
      expect(await slotsUsed("198.51.100.1")).toBe(0);
    });

    it("stays in flight while both dispatch slots are busy: its task may be waiting", async () => {
      await strand();
      const { id: repoId } = await upsertRepo(t.db, {
        providerRepoId: 9,
        owner: "acme",
        name: "busy",
        visibility: "public",
        defaultBranch: "main",
      });
      for (const sha of ["1", "2"]) {
        await startAnalysis(t.db, { repoId, sha: sha.repeat(40), analyzerVersion: VERSION });
      }
      const answer = await requestAnalysis("acme/shop", "198.51.100.1", deps);
      expect(answer).toMatchObject({ status: 202, body: { status: "queued", jobId: JOB_ID } });
      expect(tasks.google.tasks).toHaveLength(1);
      expect(await slotsUsed("198.51.100.1")).toBe(0);
    });
  });

  it("racing requests for a new commit: one task, one slot kept between them", async () => {
    const addresses = ["198.51.100.1", "198.51.100.2", "198.51.100.3"];
    const answers = await Promise.all(addresses.map((a) => requestAnalysis("acme/shop", a, deps)));
    expect(answers.map((a) => a.status)).toEqual([202, 202, 202]);
    expect(tasks.google.tasks).toHaveLength(1);
    const used = await Promise.all(addresses.map((a) => slotsUsed(a)));
    expect(used.reduce((sum, n) => sum + n, 0)).toBe(1);
    // Whichever of them queued it, the repo stays claimed for this commit (#11).
    expect(await claimOf(SHOP.id)).toBeDefined();
    expect((await requestAnalysis("acme/shop", IP, deps)).status).toBe(202);
    gh = fakeGitHub([{ ...SHOP, sha: "f".repeat(40) }]);
    const newer = await requestAnalysis("acme/shop", IP, { ...deps, github: { fetch: gh.fetch } });
    expect(newer.status).toBe(429);
  });

  it("re-queues a failed commit, counting it as a new analysis", async () => {
    const { id } = await doneAnalysis();
    await failAnalysis(t.db, id, "DOWNLOAD_FAILED");
    const answer = await requestAnalysis("acme/shop", IP, deps);
    expect(answer.status).toBe(202);
    expect(await analysisRows()).toEqual([{ status: "queued", sha: SHA, errorCode: null }]);
    expect(tasks.google.tasks).toHaveLength(1);
    expect(await slotsUsed()).toBe(1);
  });

  describe("a commit that failed permanently isn't queued again (R8)", () => {
    async function failedWith(code: string, hoursAgo = 1) {
      const { id } = await doneAnalysis();
      await failAnalysis(t.db, id, code);
      await t.db.update(analyses).set({ finishedAt: new Date(Date.now() - hoursAgo * 3_600_000) });
    }

    it("refuses it with the job page's reason, using nothing", async () => {
      for (const code of ["TAR_INVALID", "TAR_UNSAFE_PATH"]) {
        await t.db.delete(analyses);
        await failedWith(code);
        expect(await requestAnalysis("acme/shop", IP, deps), code).toEqual({
          status: 422,
          body: { error: "ANALYSIS_FAILED", message: failureView(code).message },
        });
        expect(await analysisRows()).toEqual([{ status: "failed", sha: SHA, errorCode: code }]);
      }
      expect(tasks.google.requests).toEqual([]);
      expect(await slotsUsed()).toBe(0);
      expect(await claimOf(SHOP.id)).toBeUndefined();
    });

    it("refuses a commit that hit a limit once the repo's 7-day hold is over", async () => {
      await failedWith("LIMIT_FILES", 8 * 24);
      expect(await requestAnalysis("acme/shop", IP, deps)).toEqual({
        status: 422,
        body: { error: "ANALYSIS_FAILED", message: failureView("LIMIT_FILES").message },
      });
      expect(tasks.google.requests).toEqual([]);
    });

    it("retries a commit GitHub refused before, now that it serves the repo again", async () => {
      // An installation's refusal too: a private job's, for a repo that's public now.
      for (const code of [
        "REPO_NOT_FOUND",
        "REPO_NOT_PUBLIC",
        "REPO_UNAVAILABLE",
        "INSTALLATION_NOT_FOUND",
        "INSTALLATION_SUSPENDED",
        "REPO_NOT_INSTALLED",
        // GitHub refusing the worker's download (planning #26): the worker's fix can pass.
        "DOWNLOAD_REFUSED",
      ]) {
        // Seven requests from one address: past its hourly limit without this.
        await t.db.delete(rateLimits);
        await t.db.delete(analyses);
        await t.db.update(repos).set({ analysisClaimSha: null, analysisClaimedAt: null });
        await failedWith(code);
        expect((await requestAnalysis("acme/shop", IP, deps)).status, code).toBe(202);
      }
    });
  });

  describe("a repo that was too big (#11)", () => {
    const NEWER = "f".repeat(40);
    /** The current commit's analysis, queued at `sizeKb`, failed with `code` `hoursAgo` hours ago. */
    async function tooBigBefore(code: string, hoursAgo: number, sizeKb = 900_000) {
      gh = fakeGitHub([{ ...SHOP, sizeKb }]);
      expect(
        (await requestAnalysis("acme/shop", IP, { ...deps, github: { fetch: gh.fetch } })).status,
      ).toBe(202);
      const [row] = await t.db.select().from(analyses);
      await startAnalysis(t.db, { repoId: row!.repoId, sha: SHA, analyzerVersion: VERSION });
      await failAnalysis(t.db, row!.id, code);
      await t.db.update(analyses).set({ finishedAt: new Date(Date.now() - hoursAgo * 3_600_000) });
      await t.db.delete(rateLimits);
      // Asking again for a newer commit isn't held back by the per-repo limit.
      await t.db.update(repos).set({ analysisClaimSha: null, analysisClaimedAt: null });
      return row!;
    }
    const ask = (sizeKb: number | null, sha = NEWER, address = IP) => {
      gh = fakeGitHub([{ ...SHOP, sha, sizeKb }]);
      return requestAnalysis("acme/shop", address, { ...deps, github: { fetch: gh.fetch } });
    };

    it("stores GitHub's size on the queued row", async () => {
      await ask(123_456);
      const [row] = await t.db.select({ size: analyses.repoSizeKb }).from(analyses);
      expect(row?.size).toBe(123_456);
    });

    it("refuses new commits for 7 days after a LIMIT_* failure: why, until when, no slot, no task", async () => {
      await tooBigBefore("LIMIT_FILES", 24);
      const [failed] = await t.db.select().from(analyses);
      const until = new Date(failed!.finishedAt!.getTime() + 7 * 86_400_000);
      const now = Date.now();
      const answer = await requestAnalysis("acme/shop", "198.51.100.9", {
        ...deps,
        github: { fetch: fakeGitHub([{ ...SHOP, sha: NEWER, sizeKb: 800_000 }]).fetch },
        now: () => now,
      });
      expect(answer).toEqual({
        status: 422,
        body: {
          error: "REPO_TOO_BIG",
          message: sizeHoldMessage("LIMIT_FILES", until),
          retryAt: until.toISOString(),
        },
        headers: { "retry-after": String(Math.ceil((until.getTime() - now) / 1000)) },
      });
      expect(answer.body).toMatchObject({
        message: expect.stringMatching(
          /^An earlier analysis of this repo hit a limit\. This repo has over .+ source files\. .+ It won't be analyzed again until .+ UTC, or sooner if it shrinks to half its size\.$/,
        ) as string,
      });
      expect(await slotsUsed("198.51.100.9")).toBe(0);
      expect(tasks.google.tasks).toHaveLength(1);
      expect(await analysisRows()).toEqual([
        { status: "failed", sha: SHA, errorCode: "LIMIT_FILES" },
      ]);
      // The failed commit itself isn't queued again either.
      expect((await ask(800_000, SHA)).status).toBe(422);
    });

    it("every LIMIT_* code holds the repo; other failures don't", async () => {
      for (const code of [
        "LIMIT_SOURCE_SIZE",
        "LIMIT_SIZE",
        "LIMIT_ENTRIES",
        "LIMIT_TIME",
        "LIMIT_MEMORY",
      ]) {
        await t.db.delete(analyses);
        await tooBigBefore(code, 1);
        expect((await ask(900_000)).body).toMatchObject({ error: "REPO_TOO_BIG" });
      }
      await t.db.delete(analyses);
      await tooBigBefore("DOWNLOAD_FAILED", 1);
      expect((await ask(900_000)).status).toBe(202);
    });

    it("lets the repo in again after 7 days", async () => {
      await tooBigBefore("LIMIT_TIME", 7 * 24 + 1);
      expect((await ask(900_000)).status).toBe(202);
    });

    it("lets it in early once it shrinks to half its size, not before", async () => {
      await tooBigBefore("LIMIT_SOURCE_SIZE", 2, 900_000);
      expect((await ask(450_001)).status).toBe(422);
      // GitHub didn't say: nothing is guessed, the hold stays.
      expect((await ask(null)).status).toBe(422);
      expect((await ask(450_000)).status).toBe(202);
    });

    it("an unknown size at the failure keeps the hold whatever the size now", async () => {
      await tooBigBefore("LIMIT_FILES", 2, 900_000);
      await t.db.update(analyses).set({ repoSizeKb: null });
      expect((await ask(1)).status).toBe(422);
    });

    it("still serves a finished commit and an analysis in flight", async () => {
      const failed = await tooBigBefore("LIMIT_FILES", 2);
      // A commit queued before the failure keeps its job.
      const { id } = await startAnalysis(t.db, {
        repoId: failed.repoId,
        sha: NEWER,
        analyzerVersion: VERSION,
      });
      const inFlight = await ask(900_000);
      expect(inFlight.status).toBe(202);
      // Finished: served from the cache, and the repo fits after all, so the hold ends.
      await completeAnalysis(t.db, id, {
        snapshotKey: "k",
        stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
      });
      expect((await ask(900_000)).status).toBe(200);
      expect((await ask(900_000, "9".repeat(40))).status).toBe(202);
    });
  });

  describe("a repo with too much code by GitHub's count (#11)", () => {
    const HUGE = { TypeScript: 220_594_269, JavaScript: 1_159_274 }; // VS Code, 2026-10-31
    const ask = (languages: Record<string, unknown>, extra: Partial<AnalyzeDeps> = {}) => {
      gh = fakeGitHub([{ ...SHOP, languages }]);
      return requestAnalysis("acme/shop", IP, { ...deps, github: { fetch: gh.fetch }, ...extra });
    };

    it("is refused before any slot, row, or task: GitHub's count and what to do", async () => {
      const answer = await ask(HUGE);
      expect(answer).toEqual({
        status: 422,
        body: { error: "REPO_TOO_BIG", message: tooMuchCodeMessage(221_753_543) },
      });
      expect(await slotsUsed()).toBe(0);
      expect(await analysisRows()).toEqual([]);
      expect(tasks.google.tasks).toEqual([]);
    });

    it("up to the limit, or with GitHub's count unknown, it's queued as usual", async () => {
      expect((await ask({ TypeScript: MAX_GITHUB_CODE_BYTES })).status).toBe(202);
      await t.db.delete(analyses);
      expect((await ask({ TypeScript: "lots" })).status).toBe(202);
      await t.db.delete(analyses);
      // GitHub down for the count alone.
      gh = fakeGitHub([{ ...SHOP, languages: HUGE }]);
      const fetch: typeof gh.fetch = (input, init) =>
        String(input).endsWith("/languages")
          ? Promise.reject(new TypeError("fetch failed"))
          : gh.fetch(input, init);
      expect((await requestAnalysis("acme/shop", IP, { ...deps, github: { fetch } })).status).toBe(
        202,
      );
    });

    it("isn't asked for a commit in flight", async () => {
      await ask({ TypeScript: 1 });
      expect(gh.requests).toHaveLength(3); // repo, commit, languages
      // In flight now: the same job back, GitHub's count not asked even if it grew.
      expect((await ask(HUGE)).status).toBe(202);
      expect(gh.requests.map((r) => new URL(r.url).pathname)).toEqual([
        "/repos/acme/shop",
        "/repos/Acme/Shop/commits/HEAD",
      ]);
    });
  });

  it("enforces 5 new analyses per hour per address, with when to come back", async () => {
    // Six repos: one repo gets a single new analysis per 30 minutes whoever asks.
    gh = fakeGitHub(
      Array.from({ length: 6 }, (_, i) => ({
        id: 100 + i,
        owner: "acme",
        name: `r${i}`,
        sha: SHA,
      })),
    );
    deps.github = { fetch: gh.fetch };
    for (let i = 0; i < 5; i++) {
      expect((await requestAnalysis(`acme/r${i}`, IP, deps)).status).toBe(202);
    }
    const now = Date.now();
    const limited = await requestAnalysis("acme/r5", IP, { ...deps, now: () => now });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: "RATE_LIMITED" });
    const body = limited.body as { message: string; retryAt: string };
    expect(body.message).toMatch(
      /^You've analyzed 5 repos this hour\. Try again in (a minute|\d+ minutes)\.$/,
    );
    const reset = Date.parse(body.retryAt);
    expect(reset % 3_600_000).toBe(0);
    expect(Number(limited.headers?.["retry-after"])).toBe(
      Math.max(1, Math.ceil((reset - now) / 1000)),
    );
    expect(tasks.google.tasks).toHaveLength(5);
    // The refused request left the repo free for the next asker...
    expect(await claimOf(106)).toBeUndefined();
    // ...and another address still has its own five.
    expect((await requestAnalysis("acme/r5", "198.51.100.1", deps)).status).toBe(202);
  });

  describe("signed in (M8.2b, SPEC §3)", () => {
    const AT = new Date("2026-10-31T14:30:00.000Z");
    const HOUR_START = new Date("2026-10-31T14:00:00.000Z");
    const USER = "0b6c1d7e-1111-4222-8333-444455556666";
    const repos3 = Array.from({ length: 3 }, (_, i) => ({
      id: 400 + i,
      owner: "acme",
      name: `r${i}`,
      sha: SHA,
    }));

    beforeEach(() => {
      gh = fakeGitHub(repos3);
      deps.github = { fetch: gh.fetch };
      deps.rateLimitClock = () => AT;
    });

    const used = async (key: string) =>
      (await t.db.select().from(rateLimits)).find((r) => r.key === key)?.count ?? 0;

    it("gives a user 30 new analyses an hour, counted by user ID, never by address", async () => {
      expect(SIGNED_IN_HOURLY_LIMIT).toBe(30);
      await t.db.insert(rateLimits).values({
        key: userRateLimitKey(USER),
        windowStart: HOUR_START,
        count: SIGNED_IN_HOURLY_LIMIT - 1,
      });
      expect((await requestAnalysis("acme/r0", { userId: USER }, deps)).status).toBe(202);
      expect(await used(userRateLimitKey(USER))).toBe(SIGNED_IN_HOURLY_LIMIT);

      const now = AT.getTime();
      const limited = await requestAnalysis(
        "acme/r1",
        { userId: USER },
        { ...deps, now: () => now },
      );
      expect(limited).toMatchObject({
        status: 429,
        body: {
          error: "RATE_LIMITED",
          message: "You've analyzed 30 repos this hour. Try again in 30 minutes.",
          retryAt: "2026-10-31T15:00:00.000Z",
        },
        headers: { "retry-after": "1800" },
      });
      // No address was charged, and the user's slots aren't any address's.
      expect(await used(rateLimitKey(SECRET, IP))).toBe(0);
      expect((await requestAnalysis("acme/r1", IP, deps)).status).toBe(202);
      expect(await used(userRateLimitKey(USER))).toBe(SIGNED_IN_HOURLY_LIMIT);
    });

    it("keeps a user's count apart from another user's", async () => {
      expect(userRateLimitKey(USER)).toBe(`user:${USER}`);
      expect(userRateLimitKey(USER)).not.toBe(userRateLimitKey(USER.replace("0b", "0c")));
      expect((await requestAnalysis("acme/r0", { userId: USER }, deps)).status).toBe(202);
      expect(await used(userRateLimitKey(USER))).toBe(1);
      expect(await used(userRateLimitKey(USER.replace("0b", "0c")))).toBe(0);
    });

    it("offers signing in to a signed-out address at its limit, once sign-in is set up", async () => {
      await t.db.insert(rateLimits).values({
        key: rateLimitKey(SECRET, IP),
        windowStart: HOUR_START,
        count: 5,
      });
      const now = AT.getTime();
      const ask = (signIn: boolean) =>
        requestAnalysis("acme/r0", IP, { ...deps, now: () => now, signInAvailable: signIn });
      expect((await ask(true)).body).toMatchObject({
        message:
          "You've analyzed 5 repos this hour. Try again in 30 minutes, or sign in for a higher limit.",
      });
      expect((await ask(false)).body).toMatchObject({
        message: "You've analyzed 5 repos this hour. Try again in 30 minutes.",
      });
    });
  });

  describe("one new analysis per repo per 30 minutes, whoever asks (#11)", () => {
    const NEWER = "f".repeat(40);
    const ask = (sha: string, address: string, extra: Partial<AnalyzeDeps> = {}) => {
      gh = fakeGitHub([{ ...SHOP, sha }]);
      return requestAnalysis("acme/shop", address, {
        ...deps,
        github: { fetch: gh.fetch },
        ...extra,
      });
    };
    /** Move the repo's claim `minutes` into the past. */
    const ageClaim = (minutes: number) =>
      t.db.update(repos).set({ analysisClaimedAt: new Date(Date.now() - minutes * 60_000) });

    it("refuses a newer commit from another address: why, when, no slot, no row, no task", async () => {
      expect((await ask(SHA, IP)).status).toBe(202);
      const claimedAt = (await claimOf(SHOP.id))!.getTime();
      const now = claimedAt + 12 * 60_000 + 30_000;
      const answer = await ask(NEWER, "198.51.100.9", { now: () => now });
      const retryAt = new Date(claimedAt + REPO_ANALYSIS_MINUTES * 60_000);
      expect(answer).toEqual({
        status: 429,
        body: {
          error: "REPO_RATE_LIMITED",
          message:
            "Someone asked for a new analysis of this repo in the past 30 minutes, and each repo " +
            "gets one every 30 minutes. Try again in 18 minutes.",
          retryAt: retryAt.toISOString(),
        },
        headers: { "retry-after": String(Math.ceil((retryAt.getTime() - now) / 1000)) },
      });
      expect(await slotsUsed("198.51.100.9")).toBe(0);
      expect(await analysisRows()).toEqual([{ status: "queued", sha: SHA, errorCode: null }]);
      expect(tasks.google.tasks).toHaveLength(1);
      // The claim stands as it was.
      expect((await claimOf(SHOP.id))!.getTime()).toBe(claimedAt);
    });

    it("lets a newer commit in once 30 minutes have passed", async () => {
      await ask(SHA, IP);
      await ageClaim(REPO_ANALYSIS_MINUTES - 1);
      expect((await ask(NEWER, "198.51.100.9")).status).toBe(429);
      await ageClaim(REPO_ANALYSIS_MINUTES);
      expect((await ask(NEWER, "198.51.100.9")).status).toBe(202);
      expect(tasks.google.tasks).toHaveLength(2);
      // The newer commit holds the repo now.
      expect((await ask("9".repeat(40), IP)).status).toBe(429);
    });

    it("the claiming commit still dedupes, and a failed run of it can be retried", async () => {
      await ask(SHA, IP);
      expect((await ask(SHA, "198.51.100.9")).body).toMatchObject({ jobId: JOB_ID });
      const [row] = await t.db.select().from(analyses);
      await startAnalysis(t.db, { repoId: row!.repoId, sha: SHA, analyzerVersion: VERSION });
      await failAnalysis(t.db, row!.id, "DOWNLOAD_FAILED");
      expect((await ask(SHA, "198.51.100.9")).status).toBe(202);
      expect(tasks.google.tasks).toHaveLength(2);
      expect(await slotsUsed("198.51.100.9")).toBe(1);
    });

    it("a cache hit or a commit in flight never claims the repo", async () => {
      const { repoId, id } = await doneAnalysis();
      await completeAnalysis(t.db, id, {
        snapshotKey: "k",
        stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
      });
      expect((await ask(SHA, IP)).status).toBe(200);
      expect(await claimOf(SHOP.id)).toBeUndefined();
      await startAnalysis(t.db, { repoId, sha: NEWER, analyzerVersion: VERSION });
      expect((await ask(NEWER, IP)).status).toBe(202);
      expect(await claimOf(SHOP.id)).toBeUndefined();
    });

    it("keeps the claim when a racing request queued the claimed commit first", async () => {
      gh = fakeGitHub([SHOP]);
      // GitHub's code count is asked after the cache lookup and before the claim: the
      // racing request queues the commit then, so this one finds it queued, not entered.
      const fetch: typeof gh.fetch = async (input, init) => {
        if (String(input).endsWith("/languages")) {
          const { id: repoId } = await upsertRepo(t.db, {
            providerRepoId: SHOP.id,
            owner: "acme",
            name: "shop",
            visibility: "public",
            defaultBranch: "main",
          });
          await queueAnalysis(
            t.db,
            { repoId, sha: SHA, analyzerVersion: VERSION },
            { jobId: JOB_ID },
          );
        }
        return gh.fetch(input, init);
      };
      const answer = await requestAnalysis("acme/shop", IP, { ...deps, github: { fetch } });
      expect(answer.body).toMatchObject({ status: "queued", jobId: JOB_ID });
      expect(await slotsUsed()).toBe(0);
      expect(await claimOf(SHOP.id)).toBeDefined();
      expect((await ask(NEWER, "198.51.100.9")).status).toBe(429);
    });

    it("gives the claim back when the request queued nothing new", async () => {
      tasks.setDown(true);
      expect((await ask(SHA, IP)).status).toBe(503);
      expect(await claimOf(SHOP.id)).toBeUndefined();
      tasks.setDown(false);
      expect((await ask(NEWER, IP)).status).toBe(202);
    });

    it("an address over its hourly limit doesn't hold the repo", async () => {
      await t.db.insert(rateLimits).values({
        key: rateLimitKey(SECRET, IP),
        windowStart: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000),
        count: 5,
      });
      expect((await ask(SHA, IP)).body).toMatchObject({ error: "RATE_LIMITED" });
      expect(await claimOf(SHOP.id)).toBeUndefined();
      expect((await ask(NEWER, "198.51.100.9")).status).toBe(202);
    });

    it("racing requests for different new commits: one is queued, the rest refused", async () => {
      const shas = ["1", "2", "3", "4"].map((c) => c.repeat(40));
      const answers = await Promise.all(
        shas.map((sha, i) => {
          const github = { fetch: fakeGitHub([{ ...SHOP, sha }]).fetch };
          return requestAnalysis("acme/shop", `198.51.100.${i + 1}`, { ...deps, github });
        }),
      );
      expect(answers.map((a) => a.status).sort()).toEqual([202, 429, 429, 429]);
      expect(tasks.google.tasks).toHaveLength(1);
    });
  });

  it("words the wait in minutes", async () => {
    const key = rateLimitKey(SECRET, IP);
    const [row] = await t.db
      .insert(rateLimits)
      .values({
        key,
        windowStart: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000),
        count: 5,
      })
      .returning();
    const reset = row!.windowStart.getTime() + 3_600_000;
    const at = async (msBefore: number) =>
      (
        (await requestAnalysis("acme/shop", IP, { ...deps, now: () => reset - msBefore })).body as {
          message: string;
        }
      ).message;
    expect(await at(30_000)).toContain("Try again in a minute.");
    expect(await at(23 * 60_000)).toContain("Try again in 23 minutes.");
    expect(await at(-5_000)).toContain("Try again in a minute.");
  });

  it("queue down: 503 in UX.md's words, slot refunded, the row failed (not left queued)", async () => {
    tasks.setDown(true);
    const answer = await requestAnalysis("acme/shop", IP, deps);
    expect(answer).toEqual({
      status: 503,
      body: { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE },
    });
    expect(await slotsUsed()).toBe(0);
    expect(await analysisRows()).toEqual([
      { status: "failed", sha: SHA, errorCode: QUEUE_UNAVAILABLE },
    ]);
    // Asking again once it's back queues it, as a new analysis.
    tasks.setDown(false);
    expect((await requestAnalysis("acme/shop", IP, deps)).status).toBe(202);
    expect(tasks.google.tasks).toHaveLength(1);
    expect(await slotsUsed()).toBe(1);
  });

  it("rethrows errors that aren't the queue being unavailable, giving the slot and claim back (R7)", async () => {
    const broken: AnalyzeDeps["queue"] = {
      createTask: async () => {
        throw new Error("bug");
      },
    };
    await expect(requestAnalysis("acme/shop", IP, { ...deps, queue: broken })).rejects.toThrow(
      "bug",
    );
    expect(await slotsUsed()).toBe(0);
    expect(await claimOf(SHOP.id)).toBeUndefined();
    expect((await requestAnalysis("acme/shop", "198.51.100.9", deps)).status).toBe(202);
  });

  it("refuses bad URLs and unknown repos before touching the database", async () => {
    expect(await requestAnalysis("https://gitlab.com/a/b", IP, deps)).toMatchObject({
      status: 400,
      body: { error: "INVALID_URL" },
    });
    expect(gh.requests).toEqual([]);
    expect(await requestAnalysis("acme/missing", IP, deps)).toMatchObject({
      status: 404,
      body: { error: "REPO_NOT_FOUND" },
    });
    expect(await requestAnalysis("acme/empty", IP, deps)).toMatchObject({
      status: 422,
      body: { error: "REPO_EMPTY" },
    });
    gh.failNext(new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    expect(await requestAnalysis("acme/shop", IP, deps)).toMatchObject({
      status: 503,
      body: { error: "GITHUB_RATE_LIMITED" },
    });
    expect(tasks.google.requests).toEqual([]);
    expect(await slotsUsed()).toBe(0);
  });
});

describe("requestAnalysis, the bot check (M5.18e, ADR-0157)", () => {
  // The bot check reads and counts this hour; the address's own slots are on the database
  // clock, so the address's count is set up in the fixed hour directly.
  const AT = new Date("2026-10-31T14:30:00.000Z");
  const HOUR_START = new Date("2026-10-31T14:00:00.000Z");
  let tokens: string[];
  let verdict: Verdict;

  beforeEach(() => {
    tokens = [];
    verdict = "passed";
    deps.rateLimitClock = () => AT;
    deps.botCheck = {
      siteKey: "0x4AAA",
      verify: async (token) => {
        tokens.push(token);
        return verdict;
      },
    };
  });

  async function busyAddress() {
    await t.db.insert(rateLimits).values({
      key: rateLimitKey(SECRET, IP),
      windowStart: HOUR_START,
      count: CHALLENGE_AFTER_PER_ADDRESS,
    });
  }

  it("asks a busy address for the check before using a slot, a claim, a row, or a task", async () => {
    await busyAddress();
    expect(await requestAnalysis("acme/shop", IP, deps)).toEqual({
      status: 403,
      body: {
        error: "CHALLENGE_REQUIRED",
        message: challengeMessage("address"),
        siteKey: "0x4AAA",
      },
    });
    expect(await analysisRows()).toEqual([]);
    expect(tasks.google.requests).toEqual([]);
    // Only the address's count set up above: no new slot, and no site-wide count.
    const counts = await t.db.select().from(rateLimits);
    expect(counts.map((r) => [r.key, r.count])).toEqual([
      [rateLimitKey(SECRET, IP), CHALLENGE_AFTER_PER_ADDRESS],
    ]);
    expect(await claimOf(SHOP.id)).toBeUndefined();
  });

  it("queues the analysis once the token passes", async () => {
    await busyAddress();
    expect(await requestAnalysis("acme/shop", IP, deps, "tok.en")).toMatchObject({
      status: 202,
      body: { status: "queued", jobId: JOB_ID },
    });
    expect(tokens).toEqual(["tok.en"]);
    expect(await claimOf(SHOP.id)).toBeDefined();
  });

  it("refuses a token that doesn't pass, using nothing", async () => {
    await busyAddress();
    verdict = "failed";
    expect(await requestAnalysis("acme/shop", IP, deps, "t")).toMatchObject({
      status: 403,
      body: { error: "CHALLENGE_FAILED", message: CHALLENGE_FAILED_MESSAGE },
    });
    verdict = "unavailable";
    expect(await requestAnalysis("acme/shop", IP, deps, "t")).toMatchObject({
      status: 503,
      body: { error: "CHALLENGE_UNAVAILABLE", message: CHALLENGE_UNAVAILABLE_MESSAGE },
    });
    expect(await analysisRows()).toEqual([]);
    expect(await claimOf(SHOP.id)).toBeUndefined();
  });

  it("turns on for everyone after a burst across many addresses", async () => {
    await t.db.insert(rateLimits).values({
      key: SITE_ANALYZE_KEY,
      windowStart: HOUR_START,
      count: CHALLENGE_AFTER_SITE - 1,
    });
    gh = fakeGitHub([SHOP, { id: 8, owner: "acme", name: "other", sha: "1".repeat(40) }]);
    deps.github = { fetch: gh.fetch };
    expect((await requestAnalysis("acme/shop", "198.51.100.1", deps)).status).toBe(202);
    expect(await requestAnalysis("acme/other", "198.51.100.2", deps)).toMatchObject({
      status: 403,
      body: { error: "CHALLENGE_REQUIRED", message: challengeMessage("site") },
    });
  });

  describe("a parallel burst is counted before it's let through (R6)", () => {
    const OTHERS = ["1", "2", "3"].map((c, i) => ({
      id: 300 + i,
      owner: "acme",
      name: `r${i}`,
      sha: c.repeat(40),
    }));
    const burst = (addresses: string[]) => {
      gh = fakeGitHub(OTHERS);
      deps.github = { fetch: gh.fetch };
      return Promise.all(addresses.map((a, i) => requestAnalysis(`acme/r${i}`, a, deps)));
    };

    it("from one address: only the requests under its threshold skip the check", async () => {
      await t.db.insert(rateLimits).values({
        key: rateLimitKey(SECRET, IP),
        windowStart: HOUR_START,
        count: CHALLENGE_AFTER_PER_ADDRESS - 1,
      });
      const answers = await burst([IP, IP, IP]);
      expect(answers.map((a) => a.status).sort()).toEqual([202, 403, 403]);
      expect(tasks.google.tasks).toHaveLength(1);
      // The refused two gave their slots back.
      expect(await slotsUsed()).toBe(CHALLENGE_AFTER_PER_ADDRESS);
    });

    it("across addresses: only the requests under the site's threshold skip the check", async () => {
      await t.db.insert(rateLimits).values({
        key: SITE_ANALYZE_KEY,
        windowStart: HOUR_START,
        count: CHALLENGE_AFTER_SITE - 1,
      });
      const answers = await burst(["198.51.100.1", "198.51.100.2", "198.51.100.3"]);
      expect(answers.map((a) => a.status).sort()).toEqual([202, 403, 403]);
      expect(tasks.google.tasks).toHaveLength(1);
    });
  });

  it("never asks for a finished diagram or a commit already in flight", async () => {
    await busyAddress();
    await doneAnalysis(); // running
    expect((await requestAnalysis("acme/shop", IP, deps)).status).toBe(202);
    expect(tokens).toEqual([]);
  });

  it("asks nobody without a configured widget", async () => {
    await busyAddress();
    delete deps.botCheck;
    expect((await requestAnalysis("acme/shop", IP, deps)).status).toBe(202);
  });

  describe("signed in (M8.2b)", () => {
    const USER = "0b6c1d7e-1111-4222-8333-444455556666";

    it("doesn't ask a user for starting several analyses: the account is who they are", async () => {
      await t.db.insert(rateLimits).values({
        key: userRateLimitKey(USER),
        windowStart: HOUR_START,
        count: CHALLENGE_AFTER_PER_ADDRESS + 3,
      });
      await busyAddress(); // the address they're on doesn't matter either
      expect((await requestAnalysis("acme/shop", { userId: USER }, deps)).status).toBe(202);
      expect(tokens).toEqual([]);
    });

    it("still asks a user when the whole site is busy", async () => {
      await t.db.insert(rateLimits).values({
        key: SITE_ANALYZE_KEY,
        windowStart: HOUR_START,
        count: CHALLENGE_AFTER_SITE,
      });
      expect(await requestAnalysis("acme/shop", { userId: USER }, deps)).toMatchObject({
        status: 403,
        body: { error: "CHALLENGE_REQUIRED", message: challengeMessage("site") },
      });
      // The refused request gave the user's slot back.
      const rows = await t.db.select().from(rateLimits);
      expect(rows.find((r) => r.key === userRateLimitKey(USER))?.count).toBe(0);
    });
  });
});
