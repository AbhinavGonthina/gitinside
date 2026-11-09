import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_TTL_SECONDS,
  accessCache,
  findAccess,
  recordAccess,
  repos,
  upsertRepo,
  upsertUser,
  users,
} from "./index.js";
import { createTestDb, type TestDb } from "./testing.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(accessCache);
  await t.db.delete(users);
  await t.db.delete(repos);
});

async function setup() {
  const userId = await upsertUser(t.db, { githubUserId: 7, login: "octo" });
  const otherUserId = await upsertUser(t.db, { githubUserId: 8, login: "hubot" });
  const repo = await upsertRepo(t.db, {
    providerRepoId: 501,
    owner: "acme",
    name: "web",
    visibility: "private",
    defaultBranch: "main",
  });
  const otherRepo = await upsertRepo(t.db, {
    providerRepoId: 502,
    owner: "acme",
    name: "api",
    visibility: "private",
    defaultBranch: "main",
  });
  return { userId, otherUserId, repoId: repo.id, otherRepoId: otherRepo.id };
}

/** Move one answer's `checked_at` back by `seconds`, on the database's clock. */
async function age(userId: string, repoId: string, seconds: number) {
  await t.db
    .update(accessCache)
    .set({ checkedAt: sql`now() - ${seconds} * interval '1 second'` })
    .where(and(eq(accessCache.userId, userId), eq(accessCache.repoId, repoId)));
}

describe("access cache", () => {
  it("is 60 seconds", () => {
    expect(ACCESS_TTL_SECONDS).toBe(60);
  });

  it("knows nothing until an answer is recorded, then only for that user and repo", async () => {
    const { userId, otherUserId, repoId, otherRepoId } = await setup();
    expect(await findAccess(t.db, userId, repoId)).toBeUndefined();
    await recordAccess(t.db, userId, repoId, true);
    expect(await findAccess(t.db, userId, repoId)).toBe(true);
    expect(await findAccess(t.db, otherUserId, repoId)).toBeUndefined();
    expect(await findAccess(t.db, userId, otherRepoId)).toBeUndefined();
  });

  it("keeps a refusal as well as a grant", async () => {
    const { userId, repoId } = await setup();
    await recordAccess(t.db, userId, repoId, false);
    expect(await findAccess(t.db, userId, repoId)).toBe(false);
  });

  it("forgets an answer once it's 60 seconds old, by the database's clock", async () => {
    const { userId, repoId } = await setup();
    await recordAccess(t.db, userId, repoId, true);
    await age(userId, repoId, ACCESS_TTL_SECONDS - 2);
    expect(await findAccess(t.db, userId, repoId)).toBe(true);
    await age(userId, repoId, ACCESS_TTL_SECONDS);
    expect(await findAccess(t.db, userId, repoId)).toBeUndefined();
  });

  it("replaces the last answer and restarts its 60 seconds", async () => {
    const { userId, repoId } = await setup();
    await recordAccess(t.db, userId, repoId, true);
    await age(userId, repoId, ACCESS_TTL_SECONDS - 1);
    await recordAccess(t.db, userId, repoId, false);
    expect(await findAccess(t.db, userId, repoId)).toBe(false);
    const rows = await t.db.select().from(accessCache);
    expect(rows).toHaveLength(1);
    expect(Math.abs((rows[0]?.checkedAt.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
    await age(userId, repoId, 1);
    expect(await findAccess(t.db, userId, repoId)).toBe(false);
  });

  it("dates an answer from when GitHub was asked, not when it was written (F13)", async () => {
    const { userId, otherUserId, repoId } = await setup();
    await recordAccess(t.db, userId, repoId, true, { askedMsAgo: (ACCESS_TTL_SECONDS - 2) * 1000 });
    expect(await findAccess(t.db, userId, repoId)).toBe(true);
    // Asked a minute ago: stale the moment it's written.
    await recordAccess(t.db, otherUserId, repoId, true, {
      askedMsAgo: (ACCESS_TTL_SECONDS + 1) * 1000,
    });
    expect(await findAccess(t.db, otherUserId, repoId)).toBeUndefined();
    const [row] = await t.db.select().from(accessCache).where(eq(accessCache.userId, userId));
    const ago = Date.now() - (row?.checkedAt.getTime() ?? 0);
    expect(ago).toBeGreaterThan((ACCESS_TTL_SECONDS - 12) * 1000);
    expect(ago).toBeLessThan((ACCESS_TTL_SECONDS + 8) * 1000);
  });

  it("never replaces an answer GitHub gave later (F13)", async () => {
    const { userId, repoId } = await setup();
    // A refusal asked now lands first; a grant asked 5 s ago lands after it.
    await recordAccess(t.db, userId, repoId, false);
    await recordAccess(t.db, userId, repoId, true, { askedMsAgo: 5_000 });
    expect(await findAccess(t.db, userId, repoId)).toBe(false);
    // The other way round, the later answer wins.
    await recordAccess(t.db, userId, repoId, true);
    expect(await findAccess(t.db, userId, repoId)).toBe(true);
  });

  it("goes with its user or repo", async () => {
    const { userId, otherUserId, repoId, otherRepoId } = await setup();
    await recordAccess(t.db, userId, repoId, true);
    await recordAccess(t.db, otherUserId, otherRepoId, true);
    await t.db.delete(users).where(eq(users.id, userId));
    await t.db.delete(repos).where(eq(repos.id, otherRepoId));
    expect(await t.db.select().from(accessCache)).toEqual([]);
  });
});
