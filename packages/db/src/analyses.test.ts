import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  INTERRUPTED_CODE,
  analyses,
  completeAnalysis,
  failAnalysis,
  failInterruptedAnalyses,
  findAnalysis,
  findPublishedAnalysis,
  hideRepo,
  queueAnalysis,
  recentAnalysisStats,
  repos,
  requeueAnalysis,
  startAnalysis,
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

  it("never returns a private repo's analysis", async () => {
    const { id: repoId } = await upsertRepo(t.db, { ...FACTS, visibility: "private" });
    await done(repoId, SHA, VERSION, "2026-10-01T00:00:00Z");
    expect(await findPublishedAnalysis(t.db, { owner: "acme", name: "shop" })).toBeUndefined();
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

  it("leaves running and done rows alone", async () => {
    const id = await started();
    const { queuedAt } = await analysis(id);
    expect(await queueAnalysis(t.db, await key())).toEqual({
      id,
      status: "running",
      entered: false,
      queuedAt,
    });
    await completeAnalysis(t.db, id, { snapshotKey: "k", stats: STATS });
    expect(await queueAnalysis(t.db, await key())).toMatchObject({
      id,
      status: "done",
      entered: false,
    });
    expect((await analysis(id)).snapshotKey).toBe("k");
  });
});
