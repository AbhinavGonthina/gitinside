import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  analyses,
  completeAnalysis,
  deleteDoneAnalyses,
  failAnalysis,
  listDemoShas,
  listDiffKeys,
  listPinnedShas,
  listStoredSnapshots,
  pullRequests,
  repos,
  startAnalysis,
  upsertRepo,
} from "./index.js";
import { createTestDb, type TestDb } from "./testing.js";

const VERSION = "0.1.0";
const sha = (c: string) => c.repeat(40);
const STATS = { files: 1, nodes: 1, edges: 0, unresolved: 0 };

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(pullRequests);
  await t.db.delete(analyses);
  await t.db.delete(repos);
});

async function repo(providerRepoId: number, visibility: "public" | "private" = "public") {
  const { id } = await upsertRepo(t.db, {
    providerRepoId,
    owner: "acme",
    name: `r${providerRepoId}`,
    visibility,
    defaultBranch: "main",
  });
  return id;
}

async function done(repoId: string, commit: string, key: string) {
  const { id } = await startAnalysis(t.db, { repoId, sha: commit, analyzerVersion: VERSION });
  await completeAnalysis(t.db, id, { snapshotKey: key, stats: STATS });
  return id;
}

describe("listStoredSnapshots", () => {
  it("lists done analyses with their repo's name and visibility, and nothing else", async () => {
    const pub = await repo(1);
    const priv = await repo(2, "private");
    const a = await done(pub, sha("a"), "public/acme/r1/a.json.gz");
    const b = await done(priv, sha("b"), "private/9/x/b.json.gz");
    await startAnalysis(t.db, { repoId: pub, sha: sha("c"), analyzerVersion: VERSION });
    const failed = await startAnalysis(t.db, {
      repoId: pub,
      sha: sha("d"),
      analyzerVersion: VERSION,
    });
    await failAnalysis(t.db, failed.id, "LIMIT_TIME");

    const rows = await listStoredSnapshots(t.db);
    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    const row = rows.find((r) => r.id === a);
    expect(row).toMatchObject({
      repoId: pub,
      owner: "acme",
      name: "r1",
      visibility: "public",
      sha: sha("a"),
      analyzerVersion: VERSION,
      snapshotKey: "public/acme/r1/a.json.gz",
    });
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(rows.find((r) => r.id === b)?.visibility).toBe("private");
  });
});

describe("listPinnedShas", () => {
  it("pins base and head of pull requests updated within the window", async () => {
    const id = await repo(1);
    await t.db.insert(pullRequests).values([
      { repoId: id, number: 1, baseSha: sha("1"), headSha: sha("2"), headAt: new Date() },
      {
        repoId: id,
        number: 2,
        baseSha: sha("3"),
        headSha: sha("4"),
        headAt: new Date(),
        updatedAt: sql`now() - interval '29 days'`,
      },
      {
        repoId: id,
        number: 3,
        baseSha: sha("5"),
        headSha: sha("6"),
        headAt: new Date(),
        updatedAt: sql`now() - interval '31 days'`,
      },
    ]);
    const pinned = await listPinnedShas(t.db);
    expect(pinned.map((p) => p.sha).sort()).toEqual([sha("1"), sha("2"), sha("3"), sha("4")]);
    expect(pinned.every((p) => p.repoId === id)).toBe(true);
    expect((await listPinnedShas(t.db, 0)).map((p) => p.sha)).toEqual([]);
  });

  it("pins the merge base a record's diff names, within the same window", async () => {
    const id = await repo(1);
    const diffOf = (merge: string, head: string) =>
      `private/9/${id}/diffs/${sha(merge)}-${sha(head)}/${VERSION}.json.gz`;
    const pr = { repoId: id, headAt: new Date(), brokenCount: 0 };
    await t.db.insert(pullRequests).values([
      // The event's base is the branch's tip; the diff was taken from the merge base `7`.
      { ...pr, number: 1, baseSha: sha("1"), headSha: sha("2"), diffKey: diffOf("7", "2") },
      // Merge base = event base: pinned once.
      { ...pr, number: 2, baseSha: sha("3"), headSha: sha("4"), diffKey: diffOf("3", "4") },
      // A key of another shape names no commit.
      { ...pr, number: 3, baseSha: sha("5"), headSha: sha("6"), diffKey: "diffs/x.json.gz" },
      // Nor does one naming another head or repo than the record.
      { ...pr, number: 5, baseSha: sha("b"), headSha: sha("c"), diffKey: diffOf("d", "e") },
      {
        ...pr,
        number: 6,
        baseSha: sha("b"),
        headSha: sha("c"),
        diffKey: `private/9/other/diffs/${sha("f")}-${sha("c")}/${VERSION}.json.gz`,
      },
      {
        ...pr,
        number: 4,
        baseSha: sha("8"),
        headSha: sha("9"),
        diffKey: diffOf("a", "9"),
        updatedAt: sql`now() - interval '31 days'`,
      },
    ]);
    const pinned = await listPinnedShas(t.db);
    expect(pinned.map((p) => p.sha).sort()).toEqual(
      ["1", "2", "3", "4", "5", "6", "7", "b", "b", "c", "c"].map(sha),
    );
    expect(pinned.every((p) => p.repoId === id)).toBe(true);
  });

  it("refuses a window that isn't a whole number of days", async () => {
    await expect(listPinnedShas(t.db, -1)).rejects.toThrow("days");
    await expect(listPinnedShas(t.db, 1.5)).rejects.toThrow("days");
  });
});

describe("listDemoShas", () => {
  it("pins each demo commit of a repo with a row, by GitHub's ID", async () => {
    const one = await repo(1);
    const two = await repo(2, "private");
    const pins = [
      { providerRepoId: 1, owner: "old", name: "name", sha: sha("1") },
      { providerRepoId: 2, owner: "acme", name: "r2", sha: sha("2") },
      { providerRepoId: 3, owner: "acme", name: "r3", sha: sha("3") },
    ];
    const pinned = await listDemoShas(t.db, pins);
    expect(pinned).toEqual([
      { repoId: one, sha: sha("1") },
      { repoId: two, sha: sha("2") },
    ]);
    expect(await listDemoShas(t.db, [])).toEqual([]);
    // The real pins: no such repo here.
    expect(await listDemoShas(t.db)).toEqual([]);
  });
});

describe("listDiffKeys", () => {
  it("lists each diff key a pull request record names once, whatever the record's age", async () => {
    const a = await repo(1);
    const b = await repo(2, "private");
    const pr = { baseSha: sha("1"), headSha: sha("2"), headAt: new Date() };
    await t.db.insert(pullRequests).values([
      { ...pr, repoId: a, number: 1, diffKey: "private/9/a/diffs/x/0.1.0.json.gz", brokenCount: 0 },
      // Two records with the same pair and installation share a job, so a key.
      { ...pr, repoId: a, number: 2, diffKey: "private/9/a/diffs/x/0.1.0.json.gz", brokenCount: 0 },
      {
        ...pr,
        repoId: b,
        number: 1,
        diffKey: "private/9/b/diffs/y/0.1.0.json.gz",
        brokenCount: 3,
        updatedAt: sql`now() - interval '400 days'`,
      },
      { ...pr, repoId: b, number: 2 },
    ]);
    expect((await listDiffKeys(t.db)).sort()).toEqual([
      "private/9/a/diffs/x/0.1.0.json.gz",
      "private/9/b/diffs/y/0.1.0.json.gz",
    ]);
  });

  it("answers an empty list when no record has a diff", async () => {
    expect(await listDiffKeys(t.db)).toEqual([]);
  });
});

describe("deleteDoneAnalyses", () => {
  it("deletes listed rows still done with the listed key, and reports exactly those", async () => {
    const id = await repo(1);
    const a = await done(id, sha("a"), "k/a");
    const b = await done(id, sha("b"), "k/b");
    const c = await done(id, sha("c"), "k/c");
    const running = await startAnalysis(t.db, {
      repoId: id,
      sha: sha("d"),
      analyzerVersion: VERSION,
    });

    const deleted = await deleteDoneAnalyses(t.db, [
      { id: a, snapshotKey: "k/a" },
      { id: b, snapshotKey: "k/other" }, // listed with another key: kept
      { id: running.id, snapshotKey: "k/d" }, // not done: kept
    ]);

    expect(deleted).toEqual([{ id: a, snapshotKey: "k/a" }]);
    const left = await t.db.select({ id: analyses.id }).from(analyses);
    expect(left.map((r) => r.id).sort()).toEqual([b, c, running.id].sort());
  });

  it("deletes in batches and accepts an empty list", async () => {
    expect(await deleteDoneAnalyses(t.db, [])).toEqual([]);
    const repoId = await repo(1);
    const rows = await t.db
      .insert(analyses)
      .values(
        Array.from({ length: 501 }, (_, i) => ({
          repoId,
          sha: i.toString(16).padStart(40, "0"),
          analyzerVersion: VERSION,
          status: "done" as const,
          snapshotKey: `k/${i}`,
          finishedAt: sql`now()`,
        })),
      )
      .returning({ id: analyses.id, snapshotKey: analyses.snapshotKey });
    const deleted = await deleteDoneAnalyses(
      t.db,
      rows.map((r) => ({ id: r.id, snapshotKey: r.snapshotKey as string })),
    );
    expect(deleted).toHaveLength(501);
    expect(await t.db.select().from(analyses)).toEqual([]);
  });
});
