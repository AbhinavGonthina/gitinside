// @vitest-environment node
import {
  analyses,
  completeAnalysis,
  failAnalysis,
  hideRepo,
  rateLimits,
  repos,
  startAnalysis,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { jobIdFor } from "@gitinside/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requestAnalysis, UNAVAILABLE_MESSAGE, type AnalyzeDeps } from "./analyze";
import { rateLimitKey } from "./clientIp";
import { QUEUE_UNAVAILABLE } from "./enqueue";
import { fakeGitHub, type FakeGitHub } from "./github.testkit";
import { fakeTaskQueue } from "./google.testkit";
import { MAX_GITHUB_CODE_BYTES } from "./codeSize";
import { sizeHoldMessage, tooMuchCodeMessage } from "./jobs";

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
  gh = fakeGitHub([SHOP, { id: 7, owner: "acme", name: "empty", sha: null }]);
  tasks = fakeTaskQueue(SECRET);
  deps = {
    db: t.db,
    queue: tasks.queue,
    github: { fetch: gh.fetch },
    analyzerVersion: VERSION,
    rateLimitSecret: SECRET,
    hourlyLimit: 5,
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

  it("racing requests for a new commit: one task, one slot kept between them", async () => {
    const addresses = ["198.51.100.1", "198.51.100.2", "198.51.100.3"];
    const answers = await Promise.all(addresses.map((a) => requestAnalysis("acme/shop", a, deps)));
    expect(answers.map((a) => a.status)).toEqual([202, 202, 202]);
    expect(tasks.google.tasks).toHaveLength(1);
    const used = await Promise.all(addresses.map((a) => slotsUsed(a)));
    expect(used.reduce((sum, n) => sum + n, 0)).toBe(1);
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
    for (let i = 0; i < 5; i++) {
      gh = fakeGitHub([{ ...SHOP, sha: String(i).repeat(40) }]);
      const answer = await requestAnalysis("acme/shop", IP, {
        ...deps,
        github: { fetch: gh.fetch },
      });
      expect(answer.status).toBe(202);
    }
    gh = fakeGitHub([{ ...SHOP, sha: "9".repeat(40) }]);
    const now = Date.now();
    const limited = await requestAnalysis("acme/shop", IP, {
      ...deps,
      github: { fetch: gh.fetch },
      now: () => now,
    });
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
    // Another address still has its own five.
    expect(
      (await requestAnalysis("acme/shop", "198.51.100.1", { ...deps, github: { fetch: gh.fetch } }))
        .status,
    ).toBe(202);
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

  it("rethrows errors that aren't the queue being unavailable", async () => {
    const broken: AnalyzeDeps["queue"] = {
      createTask: async () => {
        throw new Error("bug");
      },
    };
    await expect(requestAnalysis("acme/shop", IP, { ...deps, queue: broken })).rejects.toThrow(
      "bug",
    );
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
