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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requestAnalysis, UNAVAILABLE_MESSAGE, type AnalyzeDeps } from "./analyze";
import { rateLimitKey } from "./clientIp";
import { fakeGitHub, type FakeGitHub } from "./github.testkit";
import { WorkerUnavailableError, type AnalyzeJob } from "./worker";

const SHA = "e".repeat(40);
const VERSION = "0.1.0";
const SECRET = "r".repeat(43);
const IP = "203.0.113.7";
const SHOP = { id: 4242, owner: "Acme", name: "Shop", sha: SHA };

/** A worker that dedupes by commit like the real one, and can be switched off. */
function fakeWorker() {
  const jobs = new Map<string, AnalyzeJob>();
  const calls: AnalyzeJob[] = [];
  let down = false;
  const client: AnalyzeDeps["worker"] = {
    async enqueue(job) {
      calls.push(job);
      if (down) throw new WorkerUnavailableError("status 503");
      const id = `analyze-${job.sha.slice(0, 32)}`;
      const created = !jobs.has(id);
      jobs.set(id, job);
      return { id, created };
    },
  };
  return {
    client,
    calls,
    jobs,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

let t: TestDb;
let gh: FakeGitHub;
let worker: ReturnType<typeof fakeWorker>;
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
  worker = fakeWorker();
  deps = {
    db: t.db,
    worker: worker.client,
    github: { fetch: gh.fetch },
    analyzerVersion: VERSION,
    rateLimitSecret: SECRET,
    hourlyLimit: 5,
  };
});

async function analysisRows() {
  return t.db.select({ status: analyses.status, sha: analyses.sha }).from(analyses);
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
  it("queues a new commit: one job, the repo and a queued row recorded, one slot used", async () => {
    const answer = await requestAnalysis("https://github.com/acme/shop/tree/main/src", IP, deps);
    expect(answer).toEqual({
      status: 202,
      body: {
        status: "queued",
        jobId: `analyze-${SHA.slice(0, 32)}`,
        owner: "Acme",
        repo: "Shop",
        sha: SHA,
      },
    });
    expect(worker.calls).toEqual([{ owner: "Acme", repo: "Shop", sha: SHA }]);
    expect(await analysisRows()).toEqual([{ status: "queued", sha: SHA }]);
    // The progress page finds the row by the job's ID (ADR-0139).
    expect(await jobIds()).toEqual([`analyze-${SHA.slice(0, 32)}`]);
    const [repo] = await t.db.select().from(repos);
    expect(repo).toMatchObject({ providerRepoId: SHOP.id, owner: "Acme", name: "Shop" });
    expect(await slotsUsed()).toBe(1);
  });

  it("serves a done analysis from the cache without the worker or the rate limit", async () => {
    const { id } = await doneAnalysis();
    await completeAnalysis(t.db, id, {
      snapshotKey: "public/acme/shop/x.json.gz",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    // Even with this address's limit used up and the worker down.
    await t.db.insert(rateLimits).values({
      key: rateLimitKey(SECRET, IP),
      windowStart: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000),
      count: 5,
    });
    worker.setDown(true);
    const answer = await requestAnalysis("acme/shop", IP, deps);
    expect(answer).toEqual({
      status: 200,
      body: { status: "done", owner: "Acme", repo: "Shop", sha: SHA },
    });
    expect(worker.calls).toEqual([]);
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

  it("still answers 202 when recording the new job's rows fails (M5 review)", async () => {
    let enqueued = false;
    const db = new Proxy(t.db, {
      get(target, key, receiver) {
        if (enqueued && key === "transaction") {
          return () => Promise.reject(new Error("connection lost"));
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const client: AnalyzeDeps["worker"] = {
      enqueue: async (job) => {
        enqueued = true;
        return worker.client.enqueue(job);
      },
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const answer = await requestAnalysis("acme/shop", IP, { ...deps, db, worker: client });
      expect(answer).toMatchObject({ status: 202, body: { status: "queued" } });
      expect(errors.mock.calls).toEqual([
        [JSON.stringify({ event: "queue_record_failed", error: "Error" })],
      ]);
    } finally {
      errors.mockRestore();
    }
    expect(await analysisRows()).toEqual([]);
    expect(await slotsUsed()).toBe(1);
  });

  it("a different analyzer version's result isn't a cache hit", async () => {
    const { id } = await doneAnalysis();
    await completeAnalysis(t.db, id, {
      snapshotKey: "k",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    const answer = await requestAnalysis("acme/shop", IP, { ...deps, analyzerVersion: "0.2.0" });
    expect(answer.status).toBe(202);
  });

  it("dedupes a commit in flight: the same job, no slot used", async () => {
    await requestAnalysis("acme/shop", IP, deps);
    const again = await requestAnalysis("ACME/SHOP", "198.51.100.1", deps);
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ jobId: `analyze-${SHA.slice(0, 32)}` });
    expect(await slotsUsed("198.51.100.1")).toBe(0);
    expect(worker.jobs.size).toBe(1);
    // A running row counts as in flight too.
    await t.db.update(analyses).set({ status: "running", startedAt: new Date() });
    expect((await requestAnalysis("acme/shop", "198.51.100.1", deps)).status).toBe(202);
    expect(await slotsUsed("198.51.100.1")).toBe(0);
  });

  it("refunds the slot when the job already existed", async () => {
    // Someone's job covers the commit, but no row records it yet (the web app's insert
    // hadn't happened): this request is charged, then refunded.
    worker.jobs.set(`analyze-${SHA.slice(0, 32)}`, { owner: "acme", repo: "shop", sha: SHA });
    const answer = await requestAnalysis("acme/shop", IP, deps);
    expect(answer.status).toBe(202);
    expect(await slotsUsed()).toBe(0);
    expect(await analysisRows()).toEqual([]);
  });

  it("re-queues a failed commit, counting it as a new analysis", async () => {
    const { id } = await doneAnalysis();
    await failAnalysis(t.db, id, "DOWNLOAD_FAILED");
    worker.jobs.clear();
    const answer = await requestAnalysis("acme/shop", IP, deps);
    expect(answer.status).toBe(202);
    expect(await analysisRows()).toEqual([{ status: "queued", sha: SHA }]);
    expect(await slotsUsed()).toBe(1);
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
    expect(worker.calls).toHaveLength(5);
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

  it("worker down: 503 in UX.md's words, slot refunded, no rows", async () => {
    worker.setDown(true);
    const answer = await requestAnalysis("acme/shop", IP, deps);
    expect(answer).toEqual({
      status: 503,
      body: { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE },
    });
    expect(await slotsUsed()).toBe(0);
    expect(await analysisRows()).toEqual([]);
  });

  it("rethrows errors that aren't the worker being unavailable", async () => {
    const broken: AnalyzeDeps["worker"] = {
      enqueue: async () => {
        throw new Error("bug");
      },
    };
    await expect(requestAnalysis("acme/shop", IP, { ...deps, worker: broken })).rejects.toThrow(
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
    expect(worker.calls).toEqual([]);
    expect(await slotsUsed()).toBe(0);
  });
});
