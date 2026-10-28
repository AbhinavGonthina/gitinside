import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  INTERRUPTED_CODE,
  analyses,
  completeAnalysis,
  failAnalysis,
  failInterruptedAnalyses,
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
    await failInterruptedAnalyses(t.db, new Date(Date.now() + 60_000));
    expect(await completeAnalysis(t.db, id, { snapshotKey: "public/k", stats: STATS })).toBe(true);
    expect(await analysis(id)).toMatchObject({ status: "done", errorCode: null });
    expect(await completeAnalysis(t.db, id, { snapshotKey: "public/x", stats: STATS })).toBe(false);
    expect((await analysis(id)).snapshotKey).toBe("public/k");
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
  it("fails only running rows that started before the cutoff", async () => {
    const running = await started();
    const repoId = (await analysis(running)).repoId;
    const queued = (
      await startAnalysis(t.db, { repoId, sha: "b".repeat(40), analyzerVersion: VERSION })
    ).id;
    await requeueAnalysis(t.db, queued);

    expect(await failInterruptedAnalyses(t.db, new Date(0))).toBe(0);
    expect(await failInterruptedAnalyses(t.db, new Date(Date.now() + 60_000))).toBe(1);
    expect(await analysis(running)).toMatchObject({
      status: "failed",
      errorCode: INTERRUPTED_CODE,
    });
    expect((await analysis(queued)).status).toBe("queued");
  });
});
