import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accessCache,
  analyses,
  installations,
  migrationsFolder,
  pullRequests,
  rateLimits,
  repos,
  schema,
  users,
} from "./index.js";
import { createTestDb, pgErrorCode, type TestDb } from "./testing.js";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const UNIQUE = "23505";
const FOREIGN_KEY = "23503";
const CHECK = "23514";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  // Children first; cascades would do it too, but this doesn't rely on them.
  await t.db.delete(accessCache);
  await t.db.delete(pullRequests);
  await t.db.delete(analyses);
  await t.db.delete(rateLimits);
  await t.db.delete(repos);
  await t.db.delete(users);
  await t.db.delete(installations);
});

let nextGithubId = 3_000_000_000; // above 2^31: GitHub IDs outgrew int4
async function insertRepo(overrides: Partial<typeof repos.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(repos)
    .values({
      providerRepoId: nextGithubId++,
      owner: "acme",
      name: "shop",
      visibility: "public",
      defaultBranch: "main",
      ...overrides,
    })
    .returning();
  return row!;
}

describe("migrations", () => {
  it("match src/schema.ts (run `pnpm --filter @gitinside/db generate` after a schema change)", async () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as {
      entries: { idx: number }[];
    };
    const last = journal.entries.at(-1)!;
    const snapshotFile = join(
      migrationsFolder,
      "meta",
      `${String(last.idx).padStart(4, "0")}_snapshot.json`,
    );
    const committed = JSON.parse(readFileSync(snapshotFile, "utf8")) as Parameters<
      typeof generateMigration
    >[0];
    const current = generateDrizzleJson(schema, committed.id);
    expect(await generateMigration(committed, current)).toEqual([]);
  });

  it("create exactly the tables in DESIGN.md §10", async () => {
    // postgres.js returns an array of rows, PGlite an object with `rows`.
    const result: unknown = await t.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      table_name: string;
    }[];
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual([
      "access_cache",
      "analyses",
      "installations",
      "pull_requests",
      "rate_limits",
      "repos",
      "users",
    ]);
  });

  it("are a no-op when applied again", async () => {
    await insertRepo();
    await t.migrateAgain();
    expect(await t.db.select().from(repos)).toHaveLength(1);
  });
});

describe("repos", () => {
  it("are unique by owner/name ignoring case, like GitHub", async () => {
    await insertRepo({ owner: "Acme", name: "Shop" });
    expect(await pgErrorCode(insertRepo({ owner: "acme", name: "SHOP" }))).toBe(UNIQUE);
    await insertRepo({ owner: "acme", name: "shop-2" });
  });

  it("are unique by GitHub's repo ID", async () => {
    const repo = await insertRepo();
    expect(
      await pgErrorCode(insertRepo({ providerRepoId: repo.providerRepoId, name: "renamed" })),
    ).toBe(UNIQUE);
  });

  it("read GitHub IDs above 2^31 back as exact numbers", async () => {
    const repo = await insertRepo({ providerRepoId: 9_007_199_254_740_991 });
    const [read] = await t.db.select().from(repos).where(eq(repos.id, repo.id));
    expect(read!.providerRepoId).toBe(9_007_199_254_740_991);
  });

  it("are unlinked, not deleted, when their installation is deleted", async () => {
    const [inst] = await t.db
      .insert(installations)
      .values({ githubInstallationId: 42, accountLogin: "acme" })
      .returning();
    const repo = await insertRepo({ visibility: "private", installationId: inst!.id });
    await t.db.delete(installations).where(eq(installations.id, inst!.id));
    const [read] = await t.db.select().from(repos).where(eq(repos.id, repo.id));
    expect(read!.installationId).toBeNull();
  });

  it("reject an unknown visibility", async () => {
    await expect(
      t.db.execute(
        sql`insert into repos (provider_repo_id, owner, name, visibility, default_branch) values (1, 'a', 'b', 'internal', 'main')`,
      ),
    ).rejects.toThrow();
  });
});

describe("analyses", () => {
  it("start queued with the cache key repo + sha + analyzer version", async () => {
    const repo = await insertRepo();
    const [row] = await t.db
      .insert(analyses)
      .values({ repoId: repo.id, sha: SHA, analyzerVersion: "0.1.0" })
      .returning();
    expect(row!.status).toBe("queued");
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await pgErrorCode(
        t.db.insert(analyses).values({ repoId: repo.id, sha: SHA, analyzerVersion: "0.1.0" }),
      ),
    ).toBe(UNIQUE);
    // A new analyzer version re-analyzes the same commit.
    await t.db.insert(analyses).values({ repoId: repo.id, sha: SHA, analyzerVersion: "0.2.0" });
  });

  it("only accept full lowercase commit SHAs", async () => {
    const repo = await insertRepo();
    for (const sha of ["abc123", SHA.toUpperCase(), `${SHA}0`, `${"g".repeat(40)}`]) {
      expect(
        await pgErrorCode(
          t.db.insert(analyses).values({ repoId: repo.id, sha, analyzerVersion: "0.1.0" }),
        ),
      ).toBe(CHECK);
    }
  });

  it("walk queued → running → done with a snapshot and stats", async () => {
    const repo = await insertRepo();
    const [row] = await t.db
      .insert(analyses)
      .values({ repoId: repo.id, sha: SHA, analyzerVersion: "0.1.0" })
      .returning();
    const started = new Date("2026-10-28T12:00:00Z");
    await t.db
      .update(analyses)
      .set({ status: "running", startedAt: started })
      .where(eq(analyses.id, row!.id));
    const stats = { files: 12, nodes: 40, edges: 51, unresolved: 2, stageMs: { parse: 120 } };
    await t.db
      .update(analyses)
      .set({
        status: "done",
        snapshotKey: `public/acme/shop/${SHA}.json.gz`,
        finishedAt: new Date(),
        stats,
      })
      .where(eq(analyses.id, row!.id));
    const [read] = await t.db.select().from(analyses).where(eq(analyses.id, row!.id));
    expect(read!.status).toBe("done");
    expect(read!.stats).toEqual(stats);
    expect(read!.startedAt!.toISOString()).toBe(started.toISOString());
  });

  it.each([
    ["running without a start time", { status: "running" as const }],
    ["queued with a snapshot", { snapshotKey: "k" }],
    ["done without a snapshot", { status: "done" as const, finishedAt: new Date() }],
    ["done without a finish time", { status: "done" as const, snapshotKey: "k" }],
    [
      "done with an error code",
      { status: "done" as const, snapshotKey: "k", finishedAt: new Date(), errorCode: "X" },
    ],
    ["failed without an error code", { status: "failed" as const, finishedAt: new Date() }],
    [
      "failed with a snapshot",
      {
        status: "failed" as const,
        errorCode: "LIMIT_FILES",
        snapshotKey: "k",
        finishedAt: new Date(),
      },
    ],
  ])("reject a row %s", async (_, fields) => {
    const repo = await insertRepo();
    expect(
      await pgErrorCode(
        t.db
          .insert(analyses)
          .values({ repoId: repo.id, sha: SHA, analyzerVersion: "0.1.0", ...fields }),
      ),
    ).toBe(CHECK);
  });

  it("record a failure with its error code", async () => {
    const repo = await insertRepo();
    const [row] = await t.db
      .insert(analyses)
      .values({
        repoId: repo.id,
        sha: SHA,
        analyzerVersion: "0.1.0",
        status: "failed",
        errorCode: "LIMIT_FILES",
        finishedAt: new Date(),
      })
      .returning();
    expect(row!.errorCode).toBe("LIMIT_FILES");
  });

  it("need an existing repo", async () => {
    expect(
      await pgErrorCode(
        t.db.insert(analyses).values({
          repoId: "00000000-0000-0000-0000-000000000000",
          sha: SHA,
          analyzerVersion: "0.1.0",
        }),
      ),
    ).toBe(FOREIGN_KEY);
  });
});

describe("deleting a repo", () => {
  it("deletes its analyses, pull requests, and access cache entries", async () => {
    const repo = await insertRepo({ visibility: "private" });
    const other = await insertRepo({ name: "other" });
    const [user] = await t.db
      .insert(users)
      .values({ githubUserId: 7, login: "octocat" })
      .returning();
    for (const r of [repo, other]) {
      await t.db.insert(analyses).values({ repoId: r.id, sha: SHA, analyzerVersion: "0.1.0" });
      await t.db
        .insert(pullRequests)
        .values({ repoId: r.id, number: 1, baseSha: SHA, headSha: SHA2 });
      await t.db
        .insert(accessCache)
        .values({ userId: user!.id, repoId: r.id, allowed: true, checkedAt: new Date() });
    }
    await t.db.delete(repos).where(eq(repos.id, repo.id));
    for (const table of [analyses, pullRequests, accessCache]) {
      const rows = await t.db.select({ repoId: table.repoId }).from(table);
      expect(rows).toEqual([{ repoId: other.id }]);
    }
  });
});

describe("access_cache", () => {
  it("keeps one answer per user and repo, refreshed by upsert", async () => {
    const repo = await insertRepo({ visibility: "private" });
    const [user] = await t.db
      .insert(users)
      .values({ githubUserId: 7, login: "octocat" })
      .returning();
    const upsert = (allowed: boolean, checkedAt: Date) =>
      t.db
        .insert(accessCache)
        .values({ userId: user!.id, repoId: repo.id, allowed, checkedAt })
        .onConflictDoUpdate({
          target: [accessCache.userId, accessCache.repoId],
          set: { allowed, checkedAt },
        });
    await upsert(true, new Date("2026-10-28T12:00:00Z"));
    await upsert(false, new Date("2026-10-28T12:01:00Z"));
    const rows = await t.db.select().from(accessCache);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.allowed).toBe(false);
    expect(rows[0]!.checkedAt.toISOString()).toBe("2026-10-28T12:01:00.000Z");
  });

  it("is deleted with its user", async () => {
    const repo = await insertRepo({ visibility: "private" });
    const [user] = await t.db
      .insert(users)
      .values({ githubUserId: 7, login: "octocat" })
      .returning();
    await t.db
      .insert(accessCache)
      .values({ userId: user!.id, repoId: repo.id, allowed: true, checkedAt: new Date() });
    await t.db.delete(users).where(eq(users.id, user!.id));
    expect(await t.db.select().from(accessCache)).toEqual([]);
  });
});

describe("pull_requests", () => {
  it("are unique per repo and number, with positive numbers and real SHAs", async () => {
    const repo = await insertRepo();
    await t.db
      .insert(pullRequests)
      .values({ repoId: repo.id, number: 5, baseSha: SHA, headSha: SHA2 });
    expect(
      await pgErrorCode(
        t.db
          .insert(pullRequests)
          .values({ repoId: repo.id, number: 5, baseSha: SHA, headSha: SHA }),
      ),
    ).toBe(UNIQUE);
    expect(
      await pgErrorCode(
        t.db
          .insert(pullRequests)
          .values({ repoId: repo.id, number: 0, baseSha: SHA, headSha: SHA2 }),
      ),
    ).toBe(CHECK);
    expect(
      await pgErrorCode(
        t.db
          .insert(pullRequests)
          .values({ repoId: repo.id, number: 6, baseSha: "main", headSha: SHA2 }),
      ),
    ).toBe(CHECK);
    expect(
      await pgErrorCode(
        t.db
          .insert(pullRequests)
          .values({ repoId: repo.id, number: 7, baseSha: SHA, headSha: SHA2, brokenCount: -1 }),
      ),
    ).toBe(CHECK);
  });
});

describe("rate_limits", () => {
  it("count per key and window with an atomic upsert", async () => {
    const window = new Date("2026-10-28T12:00:00Z");
    const hit = async () => {
      const [row] = await t.db
        .insert(rateLimits)
        .values({ key: "ip:hash", windowStart: window, count: 1 })
        .onConflictDoUpdate({
          target: [rateLimits.key, rateLimits.windowStart],
          set: { count: sql`${rateLimits.count} + 1` },
        })
        .returning({ count: rateLimits.count });
      return row!.count;
    };
    expect([await hit(), await hit(), await hit()]).toEqual([1, 2, 3]);
    await t.db
      .insert(rateLimits)
      .values({ key: "ip:hash", windowStart: new Date("2026-10-28T13:00:00Z"), count: 1 });
    expect(await t.db.select().from(rateLimits)).toHaveLength(2);
  });

  it("never go negative", async () => {
    expect(
      await pgErrorCode(
        t.db.insert(rateLimits).values({ key: "k", windowStart: new Date(), count: -1 }),
      ),
    ).toBe(CHECK);
  });
});
