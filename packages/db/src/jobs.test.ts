import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  analyses,
  completeAnalysis,
  failAnalysis,
  failInterruptedAnalyses,
  findJob,
  queueAnalysis,
  recordJobProgress,
  repos,
  requeueAnalysis,
  startAnalysis,
  upsertRepo,
  type JobProgress,
  type RepoFacts,
} from "./index.js";
import { createTestDb, pgErrorCode, type TestDb } from "./testing.js";

const VERSION = "0.1.0";
const CHECK = "23514";
const FACTS: RepoFacts = {
  providerRepoId: 3_000_000_001,
  owner: "acme",
  name: "shop",
  visibility: "public",
  defaultBranch: "main",
};
const PARSING: JobProgress = { stage: "analyze", progress: 34, step: "programs", count: 1204 };

/** A job ID for commit `c` (one hex digit). */
const jobOf = (c: string) => `analyze-${c.repeat(32)}`;
const shaOf = (c: string) => c.repeat(40);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(analyses);
  await t.db.delete(repos);
});

async function repoId(facts: RepoFacts = FACTS): Promise<string> {
  return (await upsertRepo(t.db, facts)).id;
}

/** Queue commit `c` as job `jobOf(c)`, entering the queue at `at` (so the order is fixed). */
async function queued(c: string, at: string, repo?: string): Promise<string> {
  const key = { repoId: repo ?? (await repoId()), sha: shaOf(c), analyzerVersion: VERSION };
  const { id } = await queueAnalysis(t.db, key, { jobId: jobOf(c) });
  await t.db
    .update(analyses)
    .set({ queuedAt: new Date(at) })
    .where(eq(analyses.id, id));
  return id;
}

async function row(id: string) {
  const [found] = await t.db.select().from(analyses).where(eq(analyses.id, id));
  return found!;
}

describe("findJob", () => {
  it("finds a queued job by its ID, with its place in the queue", async () => {
    const id = await queued("1", "2026-10-31T10:00:00Z");
    expect(await findJob(t.db, jobOf("1"))).toEqual({
      analysisId: id,
      status: "queued",
      errorCode: null,
      attempts: 0,
      progress: null,
      visibility: "public",
      position: 0,
    });
  });

  it("counts the queued rows that entered the queue first, not running or finished ones", async () => {
    await queued("1", "2026-10-31T10:00:00Z");
    await queued("2", "2026-10-31T10:00:01Z");
    await queued("3", "2026-10-31T10:00:02Z");
    await queued("4", "2026-10-31T09:00:00Z");
    const repo = await repoId();
    await startAnalysis(t.db, { repoId: repo, sha: shaOf("4"), analyzerVersion: VERSION });
    const done = await queued("5", "2026-10-31T09:00:00Z");
    await completeAnalysis(t.db, done, {
      snapshotKey: "k",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    expect((await findJob(t.db, jobOf("1")))?.position).toBe(0);
    expect((await findJob(t.db, jobOf("2")))?.position).toBe(1);
    expect((await findJob(t.db, jobOf("3")))?.position).toBe(2);
    expect(await findJob(t.db, jobOf("4"))).not.toHaveProperty("position");
    expect(await findJob(t.db, jobOf("5"))).not.toHaveProperty("position");
  });

  it("orders rows that entered the queue at the same moment by ID", async () => {
    const a = await queued("1", "2026-10-31T10:00:00Z");
    const b = await queued("2", "2026-10-31T10:00:00Z");
    const [first, second] = a < b ? ["1", "2"] : ["2", "1"];
    expect((await findJob(t.db, jobOf(first!)))?.position).toBe(0);
    expect((await findJob(t.db, jobOf(second!)))?.position).toBe(1);
  });

  it("is undefined for an ID no row has", async () => {
    await queued("1", "2026-10-31T10:00:00Z");
    expect(await findJob(t.db, jobOf("2"))).toBeUndefined();
  });

  it("takes the newest row when two share the ID (a repo deleted and created again)", async () => {
    const old = await queued("1", "2026-10-31T09:00:00Z");
    await completeAnalysis(t.db, old, {
      snapshotKey: "k",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    await t.db
      .update(analyses)
      .set({ createdAt: new Date("2026-10-31T09:00:00Z") })
      .where(eq(analyses.id, old));
    // upsertRepo renames the old row out of the way; the commit and so the job ID are the same.
    const again = await repoId({ ...FACTS, providerRepoId: 3_000_000_002 });
    const fresh = await queued("1", "2026-10-31T10:00:00Z", again);
    expect(await findJob(t.db, jobOf("1"))).toMatchObject({ analysisId: fresh, status: "queued" });
  });

  it("says when the repo is private", async () => {
    await queued("1", "2026-10-31T10:00:00Z", await repoId({ ...FACTS, visibility: "private" }));
    expect((await findJob(t.db, jobOf("1")))?.visibility).toBe("private");
  });

  it("reads a failed job's code", async () => {
    const id = await queued("1", "2026-10-31T10:00:00Z");
    await failAnalysis(t.db, id, "LIMIT_FILES");
    expect(await findJob(t.db, jobOf("1"))).toMatchObject({
      status: "failed",
      errorCode: "LIMIT_FILES",
    });
  });
});

describe("job IDs and attempts", () => {
  it("are stored by the worker's start when the web app never queued the row", async () => {
    const key = { repoId: await repoId(), sha: shaOf("1"), analyzerVersion: VERSION };
    const { id } = await startAnalysis(t.db, key, { jobId: jobOf("1") });
    expect(await findJob(t.db, jobOf("1"))).toMatchObject({
      analysisId: id,
      status: "running",
      attempts: 1,
    });
  });

  it("count each start, keep counting across retries, and start over when queued again", async () => {
    const id = await queued("1", "2026-10-31T10:00:00Z");
    const key = { repoId: (await row(id)).repoId, sha: shaOf("1"), analyzerVersion: VERSION };
    await startAnalysis(t.db, key, { jobId: jobOf("1") });
    expect((await row(id)).attempts).toBe(1);
    await requeueAnalysis(t.db, id);
    await startAnalysis(t.db, key, { jobId: jobOf("1") });
    expect((await row(id)).attempts).toBe(2);
    await failAnalysis(t.db, id, "DOWNLOAD_FAILED");
    expect((await row(id)).attempts).toBe(2);
    await queueAnalysis(t.db, key, { jobId: jobOf("1") });
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("leave a start without a job ID keeping the row's", async () => {
    const id = await queued("1", "2026-10-31T10:00:00Z");
    const key = { repoId: (await row(id)).repoId, sha: shaOf("1"), analyzerVersion: VERSION };
    await startAnalysis(t.db, key);
    expect((await row(id)).jobId).toBe(jobOf("1"));
  });

  it("put a retried attempt at the back of the queue", async () => {
    const first = await queued("1", "2026-10-31T10:00:00Z");
    await queued("2", "2026-10-31T10:00:01Z");
    const key = { repoId: (await row(first)).repoId, sha: shaOf("1"), analyzerVersion: VERSION };
    await startAnalysis(t.db, key);
    await requeueAnalysis(t.db, first);
    expect((await findJob(t.db, jobOf("1")))?.position).toBe(1);
    expect((await findJob(t.db, jobOf("2")))?.position).toBe(0);
  });

  it("put a failed row queued again at the back of the queue", async () => {
    const first = await queued("1", "2026-10-31T10:00:00Z");
    await queued("2", "2026-10-31T10:00:01Z");
    await failAnalysis(t.db, first, "DOWNLOAD_FAILED");
    const key = { repoId: (await row(first)).repoId, sha: shaOf("1"), analyzerVersion: VERSION };
    await queueAnalysis(t.db, key, { jobId: jobOf("1") });
    expect((await findJob(t.db, jobOf("1")))?.position).toBe(1);
  });
});

describe("recordJobProgress", () => {
  async function running(): Promise<string> {
    const key = { repoId: await repoId(), sha: shaOf("1"), analyzerVersion: VERSION };
    return (await startAnalysis(t.db, key, { jobId: jobOf("1") })).id;
  }

  it("stores a running job's progress for findJob, replacing the last", async () => {
    await running();
    expect(await recordJobProgress(t.db, jobOf("1"), { stage: "extract", progress: 10 })).toBe(
      true,
    );
    const latest: JobProgress = {
      ...PARSING,
      found: { services: { count: 1, names: ["@shop/api"] }, routes: 3 },
      since: 1_793_000_000_000,
      expectMs: 40_000,
    };
    expect(await recordJobProgress(t.db, jobOf("1"), latest)).toBe(true);
    expect((await findJob(t.db, jobOf("1")))?.progress).toEqual(latest);
  });

  it("writes nothing unless the job is running", async () => {
    const id = await queued("1", "2026-10-31T10:00:00Z");
    expect(await recordJobProgress(t.db, jobOf("1"), PARSING)).toBe(false);
    await failAnalysis(t.db, id, "LIMIT_FILES");
    expect(await recordJobProgress(t.db, jobOf("1"), PARSING)).toBe(false);
    expect(await recordJobProgress(t.db, jobOf("2"), PARSING)).toBe(false);
    expect((await row(id)).progress).toBeNull();
  });

  it.each([
    [
      "done",
      (id: string) =>
        completeAnalysis(t.db, id, {
          snapshotKey: "k",
          stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
        }),
    ],
    ["failed", (id: string) => failAnalysis(t.db, id, "LIMIT_TIME")],
    ["queued for a retry", (id: string) => requeueAnalysis(t.db, id)],
    ["interrupted", () => failInterruptedAnalyses(t.db, new Date("2999-01-01T00:00:00Z"))],
  ])("is cleared when the attempt ends: %s", async (_, end) => {
    const id = await running();
    await recordJobProgress(t.db, jobOf("1"), PARSING);
    await end(id);
    expect((await row(id)).progress).toBeNull();
  });

  it("is cleared when a new attempt starts", async () => {
    const id = await running();
    await recordJobProgress(t.db, jobOf("1"), PARSING);
    const key = { repoId: (await row(id)).repoId, sha: shaOf("1"), analyzerVersion: VERSION };
    await startAnalysis(t.db, key);
    expect((await row(id)).progress).toBeNull();
  });
});

describe("the database refuses", () => {
  it("progress on a row that isn't running", async () => {
    const id = await queued("1", "2026-10-31T10:00:00Z");
    expect(
      await pgErrorCode(
        t.db.update(analyses).set({ progress: PARSING }).where(eq(analyses.id, id)),
      ),
    ).toBe(CHECK);
  });

  it.each(["analyze-123", "diff-" + "a".repeat(32), "analyze-" + "A".repeat(32)])(
    "a job ID that isn't an analysis job's: %s",
    async (jobId) => {
      const id = await queued("1", "2026-10-31T10:00:00Z");
      expect(
        await pgErrorCode(t.db.update(analyses).set({ jobId }).where(eq(analyses.id, id))),
      ).toBe(CHECK);
    },
  );

  it("negative attempts", async () => {
    const id = await queued("1", "2026-10-31T10:00:00Z");
    expect(
      await pgErrorCode(t.db.update(analyses).set({ attempts: -1 }).where(eq(analyses.id, id))),
    ).toBe(CHECK);
  });
});
