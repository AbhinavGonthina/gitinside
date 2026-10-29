// @vitest-environment node
import { analyses, pullRequests, repos, type StoredSnapshotRow } from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobIdFor } from "./api.js";
import {
  RETENTION_POLICY,
  planRetention,
  runRetention,
  type RetentionInput,
  type RetentionPolicy,
} from "./retention.js";
import { s3Error, startFakeS3, type FakeS3 } from "./s3.testkit.js";
import { createObjectStore, type ListedObject } from "./storage.js";

const NOW = new Date("2026-10-29T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const sha = (n: number) => n.toString(16).padStart(40, "0");
const key = (repo: string, n: number, version = "0.1.0") =>
  `public/acme/${repo}/${sha(n)}/${version}.json.gz`;

/** Row `id` of `repoId` at commit `n`, finished `n` days after the epoch of the test. */
function row(
  id: string,
  repoId: string,
  n: number,
  more: Partial<StoredSnapshotRow> = {},
): StoredSnapshotRow {
  const finishedAt = new Date(Date.UTC(2026, 0, 1) + n * DAY);
  return {
    id,
    repoId,
    owner: "acme",
    name: repoId,
    visibility: "public",
    sha: sha(n),
    analyzerVersion: "0.1.0",
    snapshotKey: key(repoId, n),
    createdAt: finishedAt,
    finishedAt,
    ...more,
  };
}

/** The listed objects of `rows`, each `size` bytes, stored long ago. */
const objectsOf = (rows: readonly StoredSnapshotRow[], size = 100): ListedObject[] =>
  rows.map((r) => ({ key: r.snapshotKey, size, lastModified: new Date(0) }));

const plan = (input: Partial<RetentionInput> & Pick<RetentionInput, "rows">) =>
  planRetention({ objects: objectsOf(input.rows), pinned: [], now: NOW, ...input });

describe("planRetention", () => {
  it("keeps a public repo's latest 5 commits and evicts the older ones", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => row(`r${n}`, "shop", n));
    const result = plan({ rows });
    expect(result.evict).toEqual([
      { id: "r1", snapshotKey: key("shop", 1), reason: "beyond-latest" },
      { id: "r2", snapshotKey: key("shop", 2), reason: "beyond-latest" },
    ]);
    expect(result.deleteKeys).toEqual([key("shop", 1), key("shop", 2)]);
    expect(result).toMatchObject({ objects: 7, storedBytes: 700, retainedBytes: 500 });
    expect(result.orphans).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("keeps only the analysis a commit's permalink serves, the newest finished", () => {
    const old = row("old", "shop", 3, {
      analyzerVersion: "0.0.9",
      snapshotKey: key("shop", 3, "0.0.9"),
    });
    const current = row("new", "shop", 3, {
      finishedAt: new Date(old.finishedAt.getTime() + HOUR),
    });
    const result = plan({ rows: [current, old] });
    expect(result.evict).toEqual([
      { id: "old", snapshotKey: key("shop", 3, "0.0.9"), reason: "superseded" },
    ]);
  });

  it("keeps commits a recent pull request names, beyond the latest 5 too", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => row(`r${n}`, "shop", n));
    const result = plan({
      rows,
      pinned: [
        { repoId: "shop", sha: sha(1) },
        { repoId: "other", sha: sha(2) },
      ],
    });
    expect(result.evict.map((e) => e.id)).toEqual(["r2"]);
  });

  it("applies the per-repo rule to each public repo separately, and not to private ones", () => {
    const rows = [
      ...[1, 2, 3, 4, 5, 6].map((n) => row(`a${n}`, "a", n)),
      ...[1, 2, 3, 4, 5].map((n) => row(`b${n}`, "b", n)),
      ...[1, 2, 3, 4, 5, 6, 7].map((n) =>
        row(`p${n}`, "p", n, {
          visibility: "private",
          snapshotKey: `private/9/p/${sha(n)}/0.1.0.json.gz`,
        }),
      ),
    ];
    expect(plan({ rows }).evict.map((e) => e.id)).toEqual(["a1"]);
  });

  it("deletes old objects no done row names, but not young ones or keys of another shape", () => {
    const rows = [row("r1", "shop", 1)];
    const objects: ListedObject[] = [
      ...objectsOf(rows),
      { key: key("gone", 1), size: 7, lastModified: new Date(NOW.getTime() - HOUR) },
      { key: key("young", 1), size: 7, lastModified: new Date(NOW.getTime() - HOUR + 1) },
      { key: `private/9/x/${sha(1)}/0.1.0.json.gz`, size: 7, lastModified: new Date(0) },
      { key: "diffs/acme/shop/1.json.gz", size: 7, lastModified: new Date(0) },
      { key: `public/acme/${sha(1)}/0.1.0.json.gz`, size: 7, lastModified: new Date(0) },
    ];
    const result = plan({ rows, objects });
    expect(result.orphans).toEqual([`private/9/x/${sha(1)}/0.1.0.json.gz`, key("gone", 1)]);
    expect(result.deleteKeys).toEqual(result.orphans);
    expect(result).toMatchObject({ objects: 6, storedBytes: 135, retainedBytes: 121 });
  });

  it("evicts the oldest snapshots globally, private and latest ones too, until under budget", () => {
    const policy: RetentionPolicy = { ...RETENTION_POLICY, budgetBytes: 450 };
    const rows = [
      row("a1", "a", 1),
      row("p2", "p", 2, {
        visibility: "private",
        snapshotKey: `private/9/p/${sha(2)}/0.1.0.json.gz`,
      }),
      row("b3", "b", 3),
      row("a4", "a", 4),
      row("b5", "b", 5),
      row("a6", "a", 6),
      row("a7", "a", 7),
    ];
    const result = plan({ rows, policy, pinned: [{ repoId: "b", sha: sha(3) }] });
    expect(result.evict).toEqual([
      { id: "a1", snapshotKey: key("a", 1), reason: "over-budget" },
      { id: "a4", snapshotKey: key("a", 4), reason: "over-budget" },
      { id: "p2", snapshotKey: `private/9/p/${sha(2)}/0.1.0.json.gz`, reason: "over-budget" },
    ]);
    expect(result.retainedBytes).toBe(400);
  });

  it("counts the per-repo evictions and orphans before evicting for the budget", () => {
    const policy: RetentionPolicy = { ...RETENTION_POLICY, budgetBytes: 500 };
    const rows = [1, 2, 3, 4, 5, 6].map((n) => row(`r${n}`, "shop", n));
    const objects = [
      ...objectsOf(rows),
      { key: key("gone", 1), size: 100, lastModified: new Date(0) },
    ];
    const result = plan({ rows, objects, policy });
    expect(result.evict).toEqual([
      { id: "r1", snapshotKey: key("shop", 1), reason: "beyond-latest" },
    ]);
    expect(result.retainedBytes).toBe(500);
  });

  it("keeps an object a kept row still names, even when another row naming it is evicted", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => row(`r${n}`, "shop", n));
    // After a rename, another repo's row can name the same key.
    const twin = row("twin", "renamed", 9, { snapshotKey: key("shop", 1) });
    const result = plan({ rows: [...rows, twin], objects: objectsOf(rows) });
    expect(result.evict.map((e) => e.id)).toEqual(["r1"]);
    expect(result.deleteKeys).toEqual([]);
    expect(result.retainedBytes).toBe(600);
  });

  it("reports kept rows whose object is missing, without evicting them", () => {
    const rows = [row("r1", "shop", 1), row("r2", "shop", 2)];
    const result = plan({ rows, objects: objectsOf([rows[0] as StoredSnapshotRow]) });
    expect(result.missing).toEqual(["r2"]);
    expect(result.evict).toEqual([]);
  });

  it("gives the same plan for the same input in any order", () => {
    const rows = [
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => row(`a${n}`, "a", n)),
      row("t1", "b", 1),
      row("t2", "b", 1, { analyzerVersion: "0.2.0", snapshotKey: key("b", 1, "0.2.0") }),
    ];
    const policy = { ...RETENTION_POLICY, budgetBytes: 300 };
    const forward = plan({ rows, policy });
    const backward = plan({
      rows: [...rows].reverse(),
      objects: objectsOf(rows).reverse(),
      policy,
    });
    expect(backward).toEqual(forward);
    // Same finish and creation times: the tie goes by ID.
    expect(forward.evict.find((e) => e.id === "t2")?.reason).toBe("superseded");
  });
});

describe("runRetention", () => {
  let t: TestDb;
  let s3: FakeS3;
  let shopId: string;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.db.delete(pullRequests);
    await t.db.delete(analyses);
    await t.db.delete(repos);
    s3 = await startFakeS3();
    const [shop] = await t.db
      .insert(repos)
      .values({
        providerRepoId: 1,
        owner: "acme",
        name: "shop",
        visibility: "public",
        defaultBranch: "main",
      })
      .returning({ id: repos.id });
    shopId = (shop as { id: string }).id;
    // Commits 1–7, each analyzed and stored.
    for (let n = 1; n <= 7; n++) {
      await t.db.insert(analyses).values({
        repoId: shopId,
        sha: sha(n),
        analyzerVersion: "0.1.0",
        status: "done",
        snapshotKey: key("shop", n),
        finishedAt: new Date(Date.UTC(2026, 0, 1) + n * DAY),
      });
      stored(key("shop", n), 100);
    }
  });
  afterEach(() => s3.close());

  function stored(objectKey: string, bytes: number, lastModified = new Date(0)) {
    s3.objects.set(objectKey, { body: Buffer.alloc(bytes), headers: {}, lastModified });
  }

  const store = () =>
    createObjectStore(
      { endpoint: s3.endpoint, bucket: s3.bucket, credentials: s3.credentials },
      { listPageSize: 3 },
    );

  async function commitsLeft(): Promise<string[]> {
    const rows = await t.db.select({ sha: analyses.sha }).from(analyses);
    return rows.map((r) => r.sha).sort();
  }

  it("deletes evicted rows and their objects, and old orphans, keeping pinned commits", async () => {
    await t.db
      .insert(pullRequests)
      .values({ repoId: shopId, number: 4, baseSha: sha(1), headSha: sha(9) });
    stored(key("gone", 1), 50);
    stored(key("young", 1), 50, new Date());

    const report = await runRetention({ db: t.db, store: store() });

    expect(report).toEqual({
      objects: 9,
      storedBytes: 800,
      retainedBytes: 650,
      evicted: { superseded: 0, "beyond-latest": 1, "over-budget": 0 },
      orphans: 1,
      missing: 0,
      deletedObjects: 2,
      failedDeletes: 0,
      removedJobs: 0,
      failedJobRemovals: 0,
    });
    expect(await commitsLeft()).toEqual([1, 3, 4, 5, 6, 7].map(sha));
    expect([...s3.objects.keys()].sort()).toEqual(
      [...[1, 3, 4, 5, 6, 7].map((n) => key("shop", n)), key("young", 1)].sort(),
    );
  });

  it("evicts for the budget given", async () => {
    const report = await runRetention({
      db: t.db,
      store: store(),
      policy: { ...RETENTION_POLICY, budgetBytes: 250 },
    });
    expect(report.evicted).toEqual({ superseded: 0, "beyond-latest": 2, "over-budget": 3 });
    expect(report.retainedBytes).toBe(200);
    expect(await commitsLeft()).toEqual([6, 7].map(sha));
    expect(s3.objects.size).toBe(2);
  });

  it("counts a failed object delete and leaves it to the next run as an orphan", async () => {
    const handler = s3.handler;
    s3.handler = (req, body, res) =>
      req.method === "DELETE" && (req.url ?? "").includes(sha(1))
        ? s3Error(res, 500, "InternalError")
        : handler(req, body, res);

    const first = await runRetention({ db: t.db, store: store() });
    expect(first).toMatchObject({ deletedObjects: 1, failedDeletes: 1 });
    expect(await commitsLeft()).toEqual([3, 4, 5, 6, 7].map(sha));
    expect(s3.objects.has(key("shop", 1))).toBe(true);

    s3.handler = handler;
    const second = await runRetention({ db: t.db, store: store() });
    expect(second).toMatchObject({ orphans: 1, deletedObjects: 1, failedDeletes: 0 });
    expect(s3.objects.has(key("shop", 1))).toBe(false);
  });

  it("touches nothing when the bucket can't be listed", async () => {
    const handler = s3.handler;
    s3.handler = (req, body, res) =>
      req.method === "GET" && (req.url ?? "").includes("continuation-token")
        ? s3Error(res, 500, "InternalError")
        : handler(req, body, res);
    await expect(runRetention({ db: t.db, store: store() })).rejects.toMatchObject({
      message: "LIST answered 500 InternalError",
    });
    expect(await commitsLeft()).toHaveLength(7);
    expect(s3.objects.size).toBe(7);
    expect(s3.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  /** A queue that records which IDs it was asked to remove, answering `answer`. */
  function fakeJobs(
    answer: (ids: readonly string[]) => Promise<{ removed: number; failed: number }>,
  ) {
    const asked: string[][] = [];
    return {
      asked,
      jobs: {
        removeCompleted: (ids: readonly string[]) => {
          asked.push([...ids]);
          return answer(ids);
        },
      },
    };
  }
  const shopJob = (n: number, version = "0.1.0") =>
    jobIdFor({ kind: "analyze", owner: "acme", repo: "shop", sha: sha(n) }, version);

  it("removes the completed jobs of the rows it deleted, by the repo's current name", async () => {
    // Renamed on GitHub since: the web app now enqueues it as Acme/Store.
    await t.db.update(repos).set({ owner: "Acme", name: "Store" });
    const { asked, jobs } = fakeJobs(async (ids) => ({ removed: ids.length, failed: 0 }));
    const report = await runRetention({ db: t.db, store: store(), jobs });
    const storeJob = (n: number) =>
      jobIdFor({ kind: "analyze", owner: "acme", repo: "store", sha: sha(n) }, "0.1.0");
    expect(asked).toEqual([[storeJob(1), storeJob(2)].sort()]);
    expect(report).toMatchObject({ removedJobs: 2, failedJobRemovals: 0, deletedObjects: 2 });
  });

  it("derives each job ID from the evicted row's analyzer version", async () => {
    await t.db.insert(analyses).values({
      repoId: shopId,
      sha: sha(7),
      analyzerVersion: "0.0.9",
      status: "done",
      snapshotKey: key("shop", 7, "0.0.9"),
      finishedAt: new Date(Date.UTC(2026, 0, 1)),
    });
    stored(key("shop", 7, "0.0.9"), 100);
    const { asked, jobs } = fakeJobs(async () => ({ removed: 0, failed: 0 }));
    await runRetention({ db: t.db, store: store(), jobs });
    expect(asked).toEqual([[shopJob(1), shopJob(2), shopJob(7, "0.0.9")].sort()]);
  });

  it("asks for no jobs when it deleted no rows", async () => {
    const { asked, jobs } = fakeJobs(async () => ({ removed: 0, failed: 0 }));
    const report = await runRetention({
      db: t.db,
      store: store(),
      jobs,
      policy: { ...RETENTION_POLICY, keepPerRepo: 10 },
    });
    expect(asked).toEqual([]);
    expect(report).toMatchObject({ removedJobs: 0, failedJobRemovals: 0 });
  });

  it("counts failed job removals and still deletes the objects", async () => {
    const partly = fakeJobs(async () => ({ removed: 1, failed: 1 }));
    expect(await runRetention({ db: t.db, store: store(), jobs: partly.jobs })).toMatchObject({
      removedJobs: 1,
      failedJobRemovals: 1,
      deletedObjects: 2,
    });

    const report = await runRetention({
      db: t.db,
      store: store(),
      jobs: fakeJobs(() => Promise.reject(new Error("redis down"))).jobs,
      policy: { ...RETENTION_POLICY, keepPerRepo: 3 },
    });
    expect(report).toMatchObject({ removedJobs: 0, failedJobRemovals: 2, deletedObjects: 2 });
    expect(await commitsLeft()).toEqual([5, 6, 7].map(sha));
    expect(s3.objects.size).toBe(3);
  });

  it("reports a done row whose object is gone, and keeps it", async () => {
    s3.objects.delete(key("shop", 7));
    const report = await runRetention({ db: t.db, store: store() });
    expect(report.missing).toBe(1);
    expect(await commitsLeft()).toContain(sha(7));
  });
});
