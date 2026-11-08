import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  INTERRUPTED_CODE,
  QUEUE_UNAVAILABLE_CODE,
  analyses,
  completeAnalysis,
  failAnalysis,
  failInterruptedAnalyses,
  failStaleQueuedAnalyses,
  failStrandedAnalysis,
  findAnalysis,
  findLimitFailure,
  findPublishedAnalysis,
  findStoredAnalysis,
  hideRepo,
  installations,
  isPrivateSnapshot,
  queueAnalysis,
  recentAnalysisStats,
  repos,
  requeueAnalysis,
  servedPrivately,
  startAnalysis,
  upsertInstallation,
  upsertRepo,
  type AnalysisStats,
  type RepoFacts,
} from "./index.js";
import { createTestDb, type TestDb } from "./testing.js";

const SHA = "a".repeat(40);
const VERSION = "0.1.0";
const STATS: AnalysisStats = { files: 4, nodes: 10, edges: 7, unresolved: 1, stageMs: { walk: 3 } };
const FACTS: RepoFacts = {
  providerRepoId: 3_000_000_001,
  owner: "acme",
  name: "shop",
  visibility: "public",
  defaultBranch: "main",
};

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
  await t.db.delete(installations);
});

async function repoRows() {
  return t.db
    .select({ id: repos.id, owner: repos.owner, name: repos.name, branch: repos.defaultBranch })
    .from(repos)
    .orderBy(repos.providerRepoId);
}

async function analysis(id: string) {
  const [row] = await t.db.select().from(analyses).where(eq(analyses.id, id));
  return row!;
}

async function started(): Promise<string> {
  const { id: repoId } = await upsertRepo(t.db, FACTS);
  return (await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: VERSION })).id;
}

describe("upsertRepo", () => {
  it("inserts a repo, then updates it in place by GitHub's ID", async () => {
    const first = await upsertRepo(t.db, FACTS);
    const second = await upsertRepo(t.db, {
      ...FACTS,
      owner: "Acme",
      name: "Storefront",
      visibility: "private",
      defaultBranch: "trunk",
    });
    expect(second.id).toBe(first.id);
    const [row] = await t.db.select().from(repos);
    expect(row).toMatchObject({
      owner: "Acme",
      name: "Storefront",
      visibility: "private",
      defaultBranch: "trunk",
    });
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(row!.createdAt.getTime());
  });

  it("moves a stale holder of the name aside, keeping its analyses, until it's seen again", async () => {
    const old = await upsertRepo(t.db, FACTS);
    await startAnalysis(t.db, { repoId: old.id, sha: SHA, analyzerVersion: VERSION });
    // acme/shop was renamed to acme/shop-v1, and a new acme/SHOP was created.
    const fresh = await upsertRepo(t.db, { ...FACTS, providerRepoId: 3_000_000_002, name: "SHOP" });
    expect(fresh.id).not.toBe(old.id);
    expect(await repoRows()).toEqual([
      { id: old.id, owner: "acme", name: "~3000000001", branch: "main" },
      { id: fresh.id, owner: "acme", name: "SHOP", branch: "main" },
    ]);
    expect(await t.db.select().from(analyses).where(eq(analyses.repoId, old.id))).toHaveLength(1);

    await upsertRepo(t.db, { ...FACTS, name: "shop-v1" });
    expect((await repoRows()).map((r) => r.name)).toEqual(["shop-v1", "SHOP"]);
  });

  it("leaves other owners' repos of the same name alone", async () => {
    await upsertRepo(t.db, FACTS);
    await upsertRepo(t.db, { ...FACTS, providerRepoId: 3_000_000_002, owner: "other" });
    expect((await repoRows()).map((r) => `${r.owner}/${r.name}`)).toEqual([
      "acme/shop",
      "other/shop",
    ]);
  });

  it("runs once more after a unique violation (another request's insert won the race)", async () => {
    const violation = Object.assign(new Error("duplicate key value"), { code: "23505" });
    let calls = 0;
    const racing = new Proxy(t.db, {
      get(target, key, receiver) {
        if (key !== "transaction") return Reflect.get(target, key, receiver);
        return (...args: Parameters<typeof target.transaction>) => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error("Failed query", { cause: violation }));
          return target.transaction(...args);
        };
      },
    });
    const { id } = await upsertRepo(racing, FACTS);
    expect(calls).toBe(2);
    expect(await repoRows()).toEqual([{ id, owner: "acme", name: "shop", branch: "main" }]);
  });

  it("gives up after a second unique violation, and passes other errors through", async () => {
    const violation = Object.assign(new Error("duplicate key value"), { code: "23505" });
    let calls = 0;
    const failing = (error: Error) =>
      new Proxy(t.db, {
        get(target, key, receiver) {
          if (key !== "transaction") return Reflect.get(target, key, receiver);
          return () => {
            calls += 1;
            return Promise.reject(error);
          };
        },
      });
    await expect(upsertRepo(failing(violation), FACTS)).rejects.toBe(violation);
    expect(calls).toBe(2);
    calls = 0;
    const other = Object.assign(new Error("foreign key"), { code: "23503" });
    await expect(upsertRepo(failing(other), FACTS)).rejects.toBe(other);
    expect(calls).toBe(1);
  });

  // Real Postgres only: PGlite has one connection, so two transactions can't interleave.
  it.skipIf(process.env.TEST_DATABASE_URL === undefined)(
    "survives another request's uncommitted insert of the same name (real Postgres)",
    async () => {
      // acme/shop was deleted and recreated on GitHub (a new ID); one request still upserts
      // the old repo while another upserts the new one. The new one's insert waits on the
      // old one's uncommitted row in the name index, then sees it committed.
      let second: Promise<{ id: string }> | undefined;
      const old = await t.db.transaction(async (tx) => {
        const [row] = await tx.insert(repos).values(FACTS).returning({ id: repos.id });
        second = upsertRepo(t.db, { ...FACTS, providerRepoId: 3_000_000_002 });
        for (let waited = 0; ; waited += 20) {
          // A transaction reads `pg_stat_activity` once and caches it; poll fresh each time.
          await tx.execute(sql`select pg_stat_clear_snapshot()`);
          const result: unknown = await tx.execute(
            sql`select count(*)::int as n from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'`,
          );
          // postgres.js answers a bare array, PGlite `{ rows }` (as `rowsOf` in maintenance.ts).
          const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
            n: number;
          }[];
          if (rows[0]!.n > 0) break;
          if (waited > 10_000) throw new Error("The second upsert never waited on the first.");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return row!;
      });
      const fresh = await second!;
      expect(await repoRows()).toEqual([
        { id: old.id, owner: "acme", name: "~3000000001", branch: "main" },
        { id: fresh.id, owner: "acme", name: "shop", branch: "main" },
      ]);
    },
    20_000,
  );
});

describe("startAnalysis", () => {
  it("inserts a running row with its start time", async () => {
    const id = await started();
    expect(await analysis(id)).toMatchObject({
      status: "running",
      sha: SHA,
      analyzerVersion: VERSION,
      errorCode: null,
      finishedAt: null,
    });
    expect((await analysis(id)).startedAt).toBeInstanceOf(Date);
  });

  it("restarts a queued or failed row under the same ID, clearing the failure", async () => {
    const id = await started();
    await failAnalysis(t.db, id, "DOWNLOAD_FAILED");
    const again = await startAnalysis(t.db, {
      repoId: (await analysis(id)).repoId,
      sha: SHA,
      analyzerVersion: VERSION,
    });
    expect(again).toEqual({ id, status: "running" });
    expect(await analysis(id)).toMatchObject({
      status: "running",
      errorCode: null,
      finishedAt: null,
    });
  });

  it("returns a done row unchanged", async () => {
    const id = await started();
    await completeAnalysis(t.db, id, { snapshotKey: "public/k", stats: STATS });
    const before = await analysis(id);
    const again = await startAnalysis(t.db, {
      repoId: before.repoId,
      sha: SHA,
      analyzerVersion: VERSION,
    });
    expect(again).toEqual({ id, status: "done" });
    expect(await analysis(id)).toEqual(before);
  });

  it("keeps one row per analyzer version", async () => {
    const id = await started();
    const repoId = (await analysis(id)).repoId;
    const next = await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: "0.2.0" });
    expect(next.id).not.toBe(id);
  });
});

describe("completeAnalysis", () => {
  it("stores the snapshot key, stats, and finish time", async () => {
    const id = await started();
    expect(await completeAnalysis(t.db, id, { snapshotKey: "public/k", stats: STATS })).toBe(true);
    const row = await analysis(id);
    expect(row).toMatchObject({ status: "done", snapshotKey: "public/k", stats: STATS });
    expect(row.finishedAt!.getTime()).toBeGreaterThanOrEqual(row.startedAt!.getTime());
  });

  it("completes a row the interrupted sweep failed, but never rewrites a done one", async () => {
    const id = await started();
    await failInterruptedAnalyses(t.db, 0);
    expect(await completeAnalysis(t.db, id, { snapshotKey: "public/k", stats: STATS })).toBe(true);
    expect(await analysis(id)).toMatchObject({ status: "done", errorCode: null });
    expect(await completeAnalysis(t.db, id, { snapshotKey: "public/x", stats: STATS })).toBe(false);
    expect((await analysis(id)).snapshotKey).toBe("public/k");
  });
});

describe("recentAnalysisStats", () => {
  it("returns done analyses' stats, newest finish first, up to the limit", async () => {
    const { id: repoId } = await upsertRepo(t.db, FACTS);
    const start = (n: number) =>
      startAnalysis(t.db, { repoId, sha: String(n).repeat(40), analyzerVersion: VERSION });
    for (const n of [1, 2, 3]) {
      const { id } = await start(n);
      await completeAnalysis(t.db, id, { snapshotKey: `k${n}`, stats: { ...STATS, files: n } });
      // Finished on days 1, 3, 2: the order comes from the finish time, not the insert.
      const day = [1, 3, 2][n - 1]!;
      await t.db
        .update(analyses)
        .set({ finishedAt: new Date(Date.UTC(2026, 9, day)) })
        .where(eq(analyses.id, id));
    }
    await failAnalysis(t.db, (await start(4)).id, "LIMIT_TIME");
    await start(5);

    expect((await recentAnalysisStats(t.db, 10)).map((s) => s.files)).toEqual([2, 3, 1]);
    expect(await recentAnalysisStats(t.db, 2)).toEqual([
      { ...STATS, files: 2 },
      { ...STATS, files: 3 },
    ]);
  });

  it("is empty with no finished analyses", async () => {
    await started();
    expect(await recentAnalysisStats(t.db, 10)).toEqual([]);
  });
});

describe("requeueAnalysis and failAnalysis", () => {
  it("requeue moves a running row back to queued, keeping its start time", async () => {
    const id = await started();
    expect(await requeueAnalysis(t.db, id)).toBe(true);
    const row = await analysis(id);
    expect(row.status).toBe("queued");
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(await requeueAnalysis(t.db, id)).toBe(false);
  });

  it("fail records the code and finish time on a queued or running row", async () => {
    const id = await started();
    await requeueAnalysis(t.db, id);
    expect(await failAnalysis(t.db, id, "LIMIT_FILES")).toBe(true);
    expect(await analysis(id)).toMatchObject({ status: "failed", errorCode: "LIMIT_FILES" });
    expect((await analysis(id)).finishedAt).toBeInstanceOf(Date);
    expect(await failAnalysis(t.db, id, "OTHER")).toBe(false);
  });

  it("neither touches a done row", async () => {
    const id = await started();
    await completeAnalysis(t.db, id, { snapshotKey: "public/k", stats: STATS });
    expect(await requeueAnalysis(t.db, id)).toBe(false);
    expect(await failAnalysis(t.db, id, "LIMIT_FILES")).toBe(false);
    expect((await analysis(id)).status).toBe("done");
  });
});

describe("failInterruptedAnalyses", () => {
  it("fails only running rows that started at least the given seconds ago", async () => {
    const stale = await started();
    const repoId = (await analysis(stale)).repoId;
    const start = (sha: string) =>
      startAnalysis(t.db, { repoId, sha: sha.repeat(40), analyzerVersion: VERSION });
    const queued = (await start("b")).id;
    await requeueAnalysis(t.db, queued);
    // Another instance's live job, started just now.
    const live = (await start("c")).id;
    await t.db
      .update(analyses)
      .set({ startedAt: sql`now() - interval '361 seconds'` })
      .where(inArray(analyses.id, [stale, queued]));

    expect(await failInterruptedAnalyses(t.db, 362)).toBe(0);
    expect(await failInterruptedAnalyses(t.db, 360)).toBe(1);
    expect(await analysis(stale)).toMatchObject({
      status: "failed",
      errorCode: INTERRUPTED_CODE,
    });
    expect((await analysis(queued)).status).toBe("queued");
    expect((await analysis(live)).status).toBe("running");
  });

  it("refuses a negative or non-finite age", async () => {
    for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(failInterruptedAnalyses(t.db, seconds)).rejects.toThrow(RangeError);
    }
  });
});

describe("failStaleQueuedAnalyses", () => {
  it("fails only queued rows that entered the queue at least the given seconds ago", async () => {
    const { id: repoId } = await upsertRepo(t.db, FACTS);
    const queue = async (sha: string) =>
      (await queueAnalysis(t.db, { repoId, sha: sha.repeat(40), analyzerVersion: VERSION })).id;
    const stranded = await queue("a");
    const fresh = await queue("b");
    // Running for as long, but not queued: the interrupted sweep's business.
    const running = (
      await startAnalysis(t.db, { repoId, sha: "c".repeat(40), analyzerVersion: VERSION })
    ).id;
    await t.db
      .update(analyses)
      .set({ queuedAt: sql`now() - interval '1000 seconds'` })
      .where(inArray(analyses.id, [stranded, running]));

    expect(await failStaleQueuedAnalyses(t.db, 1002)).toBe(0);
    expect(await failStaleQueuedAnalyses(t.db, 999)).toBe(1);
    expect(await analysis(stranded)).toMatchObject({
      status: "failed",
      errorCode: QUEUE_UNAVAILABLE_CODE,
      progress: null,
    });
    expect((await analysis(stranded)).finishedAt).toBeInstanceOf(Date);
    expect((await analysis(fresh)).status).toBe("queued");
    expect((await analysis(running)).status).toBe("running");
  });

  it("leaves a failed row the next request can queue again, and a late task can still start", async () => {
    const { id: repoId } = await upsertRepo(t.db, FACTS);
    const key = { repoId, sha: SHA, analyzerVersion: VERSION };
    const { id } = await queueAnalysis(t.db, key);
    await failStaleQueuedAnalyses(t.db, 0);
    expect(await startAnalysis(t.db, key)).toEqual({ id, status: "running" });
    await failAnalysis(t.db, id, "DOWNLOAD_FAILED");
    expect(await queueAnalysis(t.db, key)).toMatchObject({ id, status: "queued", entered: true });
  });

  it("refuses a negative or non-finite age", async () => {
    for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(failStaleQueuedAnalyses(t.db, seconds)).rejects.toThrow(RangeError);
    }
  });
});

describe("failStrandedAnalysis", () => {
  const WAIT = { queuedForSeconds: 1000, runningForSeconds: 300, slots: 2 };

  async function setUp() {
    const { id: repoId } = await upsertRepo(t.db, FACTS);
    const key = (sha: string) => ({ repoId, sha: sha.repeat(40), analyzerVersion: VERSION });
    const { id } = await queueAnalysis(t.db, key("a"));
    const queuedFor = (seconds: number) =>
      t.db
        .update(analyses)
        .set({ queuedAt: sql`now() - ${seconds} * interval '1 second'` })
        .where(eq(analyses.id, id));
    const running = async (sha: string, seconds: number) => {
      const row = await startAnalysis(t.db, key(sha));
      await t.db
        .update(analyses)
        .set({ startedAt: sql`now() - ${seconds} * interval '1 second'` })
        .where(eq(analyses.id, row.id));
    };
    return { id, queuedFor, running };
  }

  it("fails a row queued past the wait while a dispatch slot is free", async () => {
    const { id, queuedFor, running } = await setUp();
    await queuedFor(1001);
    // One job running: the queue's other slot would have pushed a live task long ago.
    await running("b", 10);
    expect(await failStrandedAnalysis(t.db, id, WAIT)).toBe(true);
    expect(await analysis(id)).toMatchObject({
      status: "failed",
      errorCode: QUEUE_UNAVAILABLE_CODE,
    });
    expect((await analysis(id)).finishedAt).toBeInstanceOf(Date);
  });

  it("leaves a row that hasn't waited that long", async () => {
    const { id, queuedFor } = await setUp();
    await queuedFor(990);
    expect(await failStrandedAnalysis(t.db, id, WAIT)).toBe(false);
    expect((await analysis(id)).status).toBe("queued");
  });

  it("leaves it while every slot is busy: its task may be waiting behind those jobs", async () => {
    const { id, queuedFor, running } = await setUp();
    await queuedFor(5000);
    await running("b", 10);
    await running("c", 299);
    expect(await failStrandedAnalysis(t.db, id, WAIT)).toBe(false);
    expect((await analysis(id)).status).toBe("queued");
  });

  it("doesn't count a row running longer than a dispatch lasts (Cloud Tasks let it go)", async () => {
    const { id, queuedFor, running } = await setUp();
    await queuedFor(5000);
    await running("b", 10);
    await running("c", 301);
    expect(await failStrandedAnalysis(t.db, id, WAIT)).toBe(true);
  });

  it("fails a row waiting for a retry that never came, and the next queue entry is fresh", async () => {
    const { id, queuedFor } = await setUp();
    const { repoId } = await analysis(id);
    const key = { repoId, sha: SHA, analyzerVersion: VERSION };
    await startAnalysis(t.db, key);
    await requeueAnalysis(t.db, id);
    await queuedFor(1001);
    const before = (await analysis(id)).queuedAt;
    expect(await failStrandedAnalysis(t.db, id, WAIT)).toBe(true);
    const again = await queueAnalysis(t.db, key);
    expect(again).toMatchObject({ id, status: "queued", entered: true, retrying: false });
    expect(again.queuedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("touches only a queued row", async () => {
    const id = await started();
    await t.db
      .update(analyses)
      .set({ queuedAt: sql`now() - interval '5000 seconds'` })
      .where(eq(analyses.id, id));
    expect(await failStrandedAnalysis(t.db, id, WAIT)).toBe(false);
    expect((await analysis(id)).status).toBe("running");
  });

  it("refuses a negative or non-finite wait, or no slots", async () => {
    const { id } = await setUp();
    for (const bad of [
      { queuedForSeconds: -1 },
      { runningForSeconds: Number.NaN },
      { slots: 0 },
      { slots: 1.5 },
    ]) {
      await expect(failStrandedAnalysis(t.db, id, { ...WAIT, ...bad })).rejects.toThrow(RangeError);
    }
  });
});

describe("findPublishedAnalysis", () => {
  const OTHER = "b".repeat(40);

  async function done(repoId: string, sha: string, version: string, finishedAt: string) {
    const { id } = await startAnalysis(t.db, { repoId, sha, analyzerVersion: version });
    await completeAnalysis(t.db, id, { snapshotKey: `k/${sha}/${version}`, stats: STATS });
    await t.db
      .update(analyses)
      .set({ finishedAt: new Date(finishedAt) })
      .where(eq(analyses.id, id));
  }

  it("finds the latest finished analysis of a public repo, ignoring case", async () => {
    const { id: repoId } = await upsertRepo(t.db, { ...FACTS, owner: "Acme", name: "Shop" });
    await done(repoId, SHA, VERSION, "2026-10-01T00:00:00Z");
    await done(repoId, OTHER, VERSION, "2026-10-02T00:00:00Z");
    await done(repoId, SHA, "0.2.0", "2026-10-03T00:00:00Z");
    // Still running: never served.
    await startAnalysis(t.db, { repoId, sha: "c".repeat(40), analyzerVersion: VERSION });

    expect(await findPublishedAnalysis(t.db, { owner: "ACME", name: "shop" })).toEqual({
      repo: { id: repoId, providerRepoId: FACTS.providerRepoId, owner: "Acme", name: "Shop" },
      analysis: {
        sha: SHA,
        analyzerVersion: "0.2.0",
        snapshotKey: `k/${SHA}/0.2.0`,
        finishedAt: new Date("2026-10-03T00:00:00Z"),
      },
    });
    const pinned = await findPublishedAnalysis(t.db, { owner: "acme", name: "shop", sha: OTHER });
    expect(pinned?.analysis).toMatchObject({ sha: OTHER, analyzerVersion: VERSION });
    expect(
      await findPublishedAnalysis(t.db, { owner: "acme", name: "shop", sha: "c".repeat(40) }),
    ).toBeUndefined();
    expect(await findPublishedAnalysis(t.db, { owner: "acme", name: "other" })).toBeUndefined();
  });

  it("finds a repo by GitHub's ID, whatever its stored name (a rename, M5.13b3)", async () => {
    const { id: repoId } = await upsertRepo(t.db, { ...FACTS, owner: "Acme", name: "Shop" });
    await done(repoId, SHA, VERSION, "2026-10-01T00:00:00Z");
    await done(repoId, OTHER, VERSION, "2026-10-02T00:00:00Z");
    const other = await upsertRepo(t.db, { ...FACTS, providerRepoId: 99, name: "other" });
    await done(other.id, SHA, VERSION, "2026-10-03T00:00:00Z");
    const { providerRepoId } = FACTS;

    expect(await findPublishedAnalysis(t.db, { providerRepoId })).toMatchObject({
      repo: { id: repoId, providerRepoId, owner: "Acme", name: "Shop" },
      analysis: { sha: OTHER },
    });
    expect((await findPublishedAnalysis(t.db, { providerRepoId, sha: SHA }))?.repo.id).toBe(repoId);
    expect(await findPublishedAnalysis(t.db, { providerRepoId: 7 })).toBeUndefined();
  });

  it("never returns a private repo's analysis", async () => {
    const { id: repoId } = await upsertRepo(t.db, { ...FACTS, visibility: "private" });
    await done(repoId, SHA, VERSION, "2026-10-01T00:00:00Z");
    expect(await findPublishedAnalysis(t.db, { owner: "acme", name: "shop" })).toBeUndefined();
    const { providerRepoId } = FACTS;
    expect(await findPublishedAnalysis(t.db, { providerRepoId })).toBeUndefined();
  });

  it("finds a private repo's analysis only through findStoredAnalysis, with its visibility", async () => {
    const { id: repoId } = await upsertRepo(t.db, {
      ...FACTS,
      owner: "Acme",
      name: "Shop",
      visibility: "private",
    });
    await done(repoId, SHA, VERSION, "2026-10-01T00:00:00Z");
    await done(repoId, SHA, "0.2.0", "2026-10-02T00:00:00Z");
    await done(repoId, OTHER, VERSION, "2026-10-03T00:00:00Z");
    const pinned = { owner: "ACME", name: "shop", sha: SHA };

    expect(await findPublishedAnalysis(t.db, pinned)).toBeUndefined();
    expect(await findStoredAnalysis(t.db, pinned)).toEqual({
      repo: {
        id: repoId,
        providerRepoId: FACTS.providerRepoId,
        owner: "Acme",
        name: "Shop",
        visibility: "private",
        githubInstallationId: null,
      },
      analysis: {
        sha: SHA,
        analyzerVersion: "0.2.0",
        snapshotKey: `k/${SHA}/0.2.0`,
        finishedAt: new Date("2026-10-02T00:00:00Z"),
      },
    });
    const { providerRepoId } = FACTS;
    expect((await findStoredAnalysis(t.db, { providerRepoId }))?.analysis.sha).toBe(OTHER);
    expect(await findStoredAnalysis(t.db, { ...pinned, sha: "c".repeat(40) })).toBeUndefined();

    await upsertRepo(t.db, { ...FACTS, owner: "Acme", name: "Shop" });
    expect((await findStoredAnalysis(t.db, pinned))?.repo.visibility).toBe("public");
    expect((await findPublishedAnalysis(t.db, pinned))?.repo).toEqual({
      id: repoId,
      providerRepoId,
      owner: "Acme",
      name: "Shop",
    });
  });

  it("names the installation a stored repo is linked to, by GitHub's ID", async () => {
    await upsertInstallation(t.db, {
      githubInstallationId: 41,
      accountId: 9001,
      accountLogin: "acme",
      accountType: "Organization",
      suspendedAt: null,
    });
    const private_ = { ...FACTS, visibility: "private" as const };
    const { id: repoId } = await upsertRepo(t.db, { ...private_, githubInstallationId: 41 });
    await done(repoId, SHA, VERSION, "2026-10-01T00:00:00Z");
    const found = await findStoredAnalysis(t.db, { owner: "acme", name: "shop" });
    expect(found?.repo.githubInstallationId).toBe(41);
    // Never on what public pages read.
    await upsertRepo(t.db, FACTS);
    expect(await findPublishedAnalysis(t.db, { owner: "acme", name: "shop" })).not.toHaveProperty(
      "repo.githubInstallationId",
    );
  });

  it("serves an analysis stored under private/ only through findStoredAnalysis, a public one first (M8.4d2)", async () => {
    const { id: repoId } = await upsertRepo(t.db, { ...FACTS, visibility: "private" });
    const privately = async (sha: string, version: string, finishedAt: string) => {
      const { id } = await startAnalysis(t.db, { repoId, sha, analyzerVersion: version });
      const snapshotKey = `private/41/${repoId}/${sha}/${version}.json.gz`;
      await completeAnalysis(t.db, id, { snapshotKey, stats: STATS });
      await t.db
        .update(analyses)
        .set({ finishedAt: new Date(finishedAt) })
        .where(eq(analyses.id, id));
    };
    await privately(SHA, VERSION, "2026-10-01T00:00:00Z");
    // The repo turned public: GitHub's facts restore its row.
    await upsertRepo(t.db, FACTS);
    const pinned = { owner: "acme", name: "shop", sha: SHA };
    const { providerRepoId } = FACTS;

    expect(await findPublishedAnalysis(t.db, pinned)).toBeUndefined();
    expect(await findPublishedAnalysis(t.db, { providerRepoId })).toBeUndefined();
    const stored = await findStoredAnalysis(t.db, pinned);
    expect(stored?.repo.visibility).toBe("public");
    expect(stored && servedPrivately(stored)).toBe(true);

    // A public analysis of the commit wins over a newer private one, in both lookups.
    await done(repoId, SHA, "0.2.0", "2026-10-02T00:00:00Z");
    await privately(SHA, "0.3.0", "2026-10-03T00:00:00Z");
    expect((await findPublishedAnalysis(t.db, pinned))?.analysis.analyzerVersion).toBe("0.2.0");
    const first = await findStoredAnalysis(t.db, pinned);
    expect(first?.analysis.analyzerVersion).toBe("0.2.0");
    expect(first && servedPrivately(first)).toBe(false);
    // Of a private repo, the newest whatever its key.
    await hideRepo(t.db, repoId);
    const hidden = await findStoredAnalysis(t.db, pinned);
    expect(hidden?.analysis.analyzerVersion).toBe("0.3.0");
    expect(hidden && servedPrivately(hidden)).toBe(true);
  });

  it("isPrivateSnapshot reads the key's prefix only", () => {
    expect(isPrivateSnapshot("private/41/r/s/v.json.gz")).toBe(true);
    expect(isPrivateSnapshot("public/acme/private/s/v.json.gz")).toBe(false);
    expect(isPrivateSnapshot("privately")).toBe(false);
    expect(isPrivateSnapshot(null)).toBe(false);
  });

  it("stops serving a hidden repo, permalinks included, until GitHub's facts restore it", async () => {
    const { id: repoId } = await upsertRepo(t.db, FACTS);
    await done(repoId, SHA, VERSION, "2026-10-01T00:00:00Z");
    const pinned = { owner: "acme", name: "shop", sha: SHA };

    expect(await hideRepo(t.db, repoId)).toBe(true);
    expect(await hideRepo(t.db, repoId)).toBe(false);
    expect(await findPublishedAnalysis(t.db, { owner: "acme", name: "shop" })).toBeUndefined();
    expect(await findPublishedAnalysis(t.db, pinned)).toBeUndefined();

    await upsertRepo(t.db, FACTS);
    expect((await findPublishedAnalysis(t.db, pinned))?.analysis.sha).toBe(SHA);
  });
});

describe("findLimitFailure", () => {
  /** A row of `sha` that ended `status` (`errorCode` if failed) `hoursAgo` hours ago. */
  async function ended(
    repoId: string,
    sha: string,
    end: { errorCode?: string; hoursAgo: number; repoSizeKb?: number },
  ) {
    const key = { repoId, sha: sha.repeat(40), analyzerVersion: VERSION };
    await queueAnalysis(
      t.db,
      key,
      end.repoSizeKb === undefined ? {} : { repoSizeKb: end.repoSizeKb },
    );
    const { id } = await startAnalysis(t.db, key);
    if (end.errorCode === undefined) {
      await completeAnalysis(t.db, id, { snapshotKey: `k/${sha}`, stats: STATS });
    } else {
      await failAnalysis(t.db, id, end.errorCode);
    }
    await t.db
      .update(analyses)
      .set({ finishedAt: sql`now() - ${end.hoursAgo} * interval '1 hour'` })
      .where(eq(analyses.id, id));
    return id;
  }

  it("finds the newest LIMIT_* failure in the window, with until = failure + days", async () => {
    const { id: repoId } = await upsertRepo(t.db, FACTS);
    await ended(repoId, "a", { errorCode: "LIMIT_TIME", hoursAgo: 30, repoSizeKb: 1 });
    await ended(repoId, "b", { errorCode: "LIMIT_FILES", hoursAgo: 20, repoSizeKb: 900_000 });
    // Not a limit: the next commit may pass.
    await ended(repoId, "c", { errorCode: "DOWNLOAD_FAILED", hoursAgo: 10 });

    const found = await findLimitFailure(t.db, FACTS.providerRepoId, 7);
    expect(found).toMatchObject({ errorCode: "LIMIT_FILES", repoSizeKb: 900_000 });
    expect(found!.until.getTime() - found!.failedAt.getTime()).toBe(7 * 86_400_000);
    // By the database's clock: about 20 hours ago.
    expect(Math.abs(Date.now() - found!.failedAt.getTime() - 20 * 3_600_000)).toBeLessThan(60_000);
    expect(await findLimitFailure(t.db, 7, 7)).toBeUndefined();
  });

  it("forgets a failure older than the window", async () => {
    const { id: repoId } = await upsertRepo(t.db, FACTS);
    await ended(repoId, "a", { errorCode: "LIMIT_SIZE", hoursAgo: 7 * 24 + 1 });
    expect(await findLimitFailure(t.db, FACTS.providerRepoId, 7)).toBeUndefined();
    expect(await findLimitFailure(t.db, FACTS.providerRepoId, 8)).toMatchObject({
      errorCode: "LIMIT_SIZE",
      repoSizeKb: null,
    });
  });

  it("ignores a failure followed by a finished analysis: the repo fits again", async () => {
    const { id: repoId } = await upsertRepo(t.db, FACTS);
    await ended(repoId, "a", { errorCode: "LIMIT_MEMORY", hoursAgo: 5 });
    await ended(repoId, "b", { hoursAgo: 4 });
    expect(await findLimitFailure(t.db, FACTS.providerRepoId, 7)).toBeUndefined();
    // A later failure counts again.
    await ended(repoId, "c", { errorCode: "LIMIT_MEMORY", hoursAgo: 3 });
    expect(await findLimitFailure(t.db, FACTS.providerRepoId, 7)).toMatchObject({
      errorCode: "LIMIT_MEMORY",
    });
  });

  it("follows the repo across a rename, and keeps repos apart", async () => {
    const { id: repoId } = await upsertRepo(t.db, FACTS);
    const { id: otherId } = await upsertRepo(t.db, { ...FACTS, providerRepoId: 7, name: "x" });
    await ended(otherId, "a", { errorCode: "LIMIT_FILES", hoursAgo: 1 });
    expect(await findLimitFailure(t.db, FACTS.providerRepoId, 7)).toBeUndefined();
    await ended(repoId, "a", { errorCode: "LIMIT_ENTRIES", hoursAgo: 1 });
    await upsertRepo(t.db, { ...FACTS, name: "storefront" });
    expect((await findLimitFailure(t.db, FACTS.providerRepoId, 7))?.errorCode).toBe(
      "LIMIT_ENTRIES",
    );
  });

  it("refuses a window that isn't a positive finite number", async () => {
    for (const days of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(findLimitFailure(t.db, 1, days)).rejects.toThrow(RangeError);
    }
  });
});

describe("findAnalysis", () => {
  const key = { providerRepoId: FACTS.providerRepoId, sha: SHA, analyzerVersion: VERSION };

  it("finds nothing before the first job", async () => {
    expect(await findAnalysis(t.db, key)).toBeUndefined();
    await upsertRepo(t.db, FACTS);
    expect(await findAnalysis(t.db, key)).toBeUndefined();
  });

  it("finds a commit's row by GitHub's repo ID, after a rename too", async () => {
    const id = await started();
    await completeAnalysis(t.db, id, { snapshotKey: "public/acme/shop/x.json.gz", stats: STATS });
    await upsertRepo(t.db, { ...FACTS, owner: "acme-inc", name: "storefront" });
    expect(await findAnalysis(t.db, key)).toEqual({
      id,
      status: "done",
      errorCode: null,
      snapshotKey: "public/acme/shop/x.json.gz",
    });
  });

  it("keeps commits, analyzer versions, and repos apart", async () => {
    await started();
    expect(await findAnalysis(t.db, { ...key, sha: "b".repeat(40) })).toBeUndefined();
    expect(await findAnalysis(t.db, { ...key, analyzerVersion: "0.2.0" })).toBeUndefined();
    expect(await findAnalysis(t.db, { ...key, providerRepoId: 7 })).toBeUndefined();
    expect((await findAnalysis(t.db, key))?.status).toBe("running");
  });
});

describe("queueAnalysis", () => {
  async function key() {
    const { id: repoId } = await upsertRepo(t.db, FACTS);
    return { repoId, sha: SHA, analyzerVersion: VERSION };
  }

  it("inserts a queued row, entered by this call, with its queue entry time", async () => {
    const queued = await queueAnalysis(t.db, await key());
    expect(queued).toMatchObject({ status: "queued", entered: true });
    const row = await analysis(queued.id);
    expect(row).toMatchObject({ status: "queued", startedAt: null, finishedAt: null });
    expect(queued.queuedAt).toEqual(row.queuedAt);
  });

  it("gives a second call the same entry, not entered by it", async () => {
    const [one, two] = [`analyze-${"1".repeat(32)}`, `analyze-${"2".repeat(32)}`];
    const first = await queueAnalysis(t.db, await key(), { jobId: one });
    const second = await queueAnalysis(t.db, await key(), { jobId: two });
    expect(second).toEqual({ ...first, entered: false });
    // The entry's own job, which a caller asking under another job ID follows (ADR-0227).
    expect(second.jobId).toBe(one);
    expect((await analysis(first.id)).jobId).toBe(one);
  });

  it("moves a failed row back to queued, clearing the failure, with a new entry time", async () => {
    const id = await started();
    const before = new Date("2026-01-01T00:00:00Z");
    await t.db.update(analyses).set({ queuedAt: before }).where(eq(analyses.id, id));
    await failAnalysis(t.db, id, "DOWNLOAD_FAILED");
    const queued = await queueAnalysis(t.db, await key());
    expect(queued).toMatchObject({ id, status: "queued", entered: true });
    expect(queued.queuedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(await analysis(id)).toMatchObject({
      status: "queued",
      errorCode: null,
      startedAt: null,
      finishedAt: null,
    });
    // The worker can pick it up again.
    expect((await startAnalysis(t.db, await key())).status).toBe("running");
  });

  it("keeps GitHub's repo size, replaced when a failed row is queued again", async () => {
    const queued = await queueAnalysis(t.db, await key(), { repoSizeKb: 900_000 });
    expect((await analysis(queued.id)).repoSizeKb).toBe(900_000);
    await startAnalysis(t.db, await key());
    await failAnalysis(t.db, queued.id, "LIMIT_FILES");
    await queueAnalysis(t.db, await key(), { repoSizeKb: 400_000 });
    expect((await analysis(queued.id)).repoSizeKb).toBe(400_000);
    await t.db.update(analyses).set({ status: "failed", errorCode: "X", finishedAt: new Date() });
    await queueAnalysis(t.db, await key());
    expect((await analysis(queued.id)).repoSizeKb).toBeNull();
    await expect(
      t.db.update(analyses).set({ repoSizeKb: -1 }).where(eq(analyses.id, queued.id)),
    ).rejects.toThrow();
  });

  it("says a queued row is waiting for a retry once an attempt ran (R1)", async () => {
    const queued = await queueAnalysis(t.db, await key());
    expect(queued.retrying).toBe(false);
    expect((await queueAnalysis(t.db, await key())).retrying).toBe(false);
    await startAnalysis(t.db, await key());
    await requeueAnalysis(t.db, queued.id);
    expect(await queueAnalysis(t.db, await key())).toMatchObject({
      id: queued.id,
      status: "queued",
      entered: false,
      retrying: true,
    });
    // Queued again after failing for good, attempts start over.
    await startAnalysis(t.db, await key());
    await failAnalysis(t.db, queued.id, "DOWNLOAD_FAILED");
    expect(await queueAnalysis(t.db, await key())).toMatchObject({
      entered: true,
      retrying: false,
    });
  });

  it("leaves running and done rows alone", async () => {
    const id = await started();
    const { queuedAt } = await analysis(id);
    expect(await queueAnalysis(t.db, await key())).toEqual({
      id,
      status: "running",
      entered: false,
      retrying: false,
      queuedAt,
      jobId: null,
    });
    await completeAnalysis(t.db, id, { snapshotKey: "k", stats: STATS });
    expect(await queueAnalysis(t.db, await key())).toMatchObject({
      id,
      status: "done",
      entered: false,
    });
    expect((await analysis(id)).snapshotKey).toBe("k");
  });

  it("with replacePrivate, queues a done row stored under private/ again, and only such a row (M8.4d2)", async () => {
    const id = await started();
    const snapshotKey = "private/41/r/x.json.gz";
    await completeAnalysis(t.db, id, { snapshotKey, stats: STATS });
    // A private job (no replacePrivate) leaves it.
    expect(await queueAnalysis(t.db, await key())).toMatchObject({
      status: "done",
      entered: false,
    });

    const jobId = `analyze-${"3".repeat(32)}`;
    const queued = await queueAnalysis(t.db, await key(), { jobId, replacePrivate: true });
    expect(queued).toMatchObject({ id, status: "queued", entered: true, retrying: false, jobId });
    expect(await analysis(id)).toMatchObject({
      status: "queued",
      snapshotKey: null,
      stats: null,
      finishedAt: null,
      attempts: 0,
    });
    // The worker can run it, and its public snapshot is then left alone.
    expect((await startAnalysis(t.db, await key())).status).toBe("running");
    await completeAnalysis(t.db, id, { snapshotKey: "public/acme/shop/x.json.gz", stats: STATS });
    expect(await queueAnalysis(t.db, await key(), { jobId, replacePrivate: true })).toMatchObject({
      status: "done",
      entered: false,
    });
    expect((await analysis(id)).snapshotKey).toBe("public/acme/shop/x.json.gz");
  });
});
