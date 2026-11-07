import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  findSession,
  replaceSessionTokens,
  sessions,
  upsertUser,
  users,
} from "./index.js";
import { createTestDb, pgErrorCode, type TestDb } from "./testing.js";

const CHECK = "23514";
const UNIQUE = "23505";
const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(sessions);
  await t.db.delete(users);
});

describe("upsertUser", () => {
  it("inserts once per GitHub ID and follows a renamed login", async () => {
    const id = await upsertUser(t.db, { githubUserId: 3_000_000_001, login: "octo" });
    expect(await upsertUser(t.db, { githubUserId: 3_000_000_001, login: "octo-renamed" })).toBe(id);
    expect(await t.db.select({ id: users.id, login: users.login }).from(users)).toEqual([
      { id, login: "octo-renamed" },
    ]);
  });
});

describe("sessions", () => {
  it("are found by token hash until they end, with their user", async () => {
    const userId = await upsertUser(t.db, { githubUserId: 7, login: "octo" });
    const expiresAt = await createSession(t.db, {
      userId,
      tokenHash: HASH,
      githubTokens: "sealed",
      lifetimeSeconds: 3600,
    });
    expect(Math.abs(expiresAt.getTime() - Date.now() - 3_600_000)).toBeLessThan(60_000);
    expect(await findSession(t.db, HASH)).toEqual({
      sessionId: expect.any(String),
      userId,
      githubUserId: 7,
      login: "octo",
      githubTokens: "sealed",
      expiresAt,
    });
    expect(await findSession(t.db, HASH2)).toBeUndefined();

    // Ended by the database's clock: moved into the past, it's no longer found.
    await t.db
      .update(sessions)
      .set({
        createdAt: sql`now() - interval '2 hours'`,
        expiresAt: sql`now() - interval '1 second'`,
      })
      .where(eq(sessions.tokenHash, HASH));
    expect(await findSession(t.db, HASH)).toBeUndefined();
  });

  it("are deleted by sign-out and with their user", async () => {
    const userId = await upsertUser(t.db, { githubUserId: 7, login: "octo" });
    const base = { userId, githubTokens: "sealed", lifetimeSeconds: 60 };
    await createSession(t.db, { ...base, tokenHash: HASH });
    await createSession(t.db, { ...base, tokenHash: HASH2 });
    await deleteSession(t.db, HASH);
    await deleteSession(t.db, HASH); // twice is fine
    expect(await findSession(t.db, HASH)).toBeUndefined();
    expect(await findSession(t.db, HASH2)).toBeDefined();

    await t.db.delete(users).where(eq(users.id, userId));
    expect(await t.db.select().from(sessions)).toEqual([]);
  });

  it("that ended are swept by the database's clock, live ones kept", async () => {
    const userId = await upsertUser(t.db, { githubUserId: 7, login: "octo" });
    const base = { userId, githubTokens: "sealed", lifetimeSeconds: 3600 };
    await createSession(t.db, { ...base, tokenHash: HASH });
    await createSession(t.db, { ...base, tokenHash: HASH2 });
    expect(await deleteExpiredSessions(t.db)).toBe(0);
    await t.db
      .update(sessions)
      .set({
        createdAt: sql`now() - interval '2 hours'`,
        expiresAt: sql`now() - interval '1 second'`,
      })
      .where(eq(sessions.tokenHash, HASH));
    expect(await deleteExpiredSessions(t.db)).toBe(1);
    expect((await t.db.select().from(sessions)).map((s) => s.tokenHash)).toEqual([HASH2]);
    expect(await t.db.select().from(users)).toHaveLength(1); // the user stays
  });

  it("swap their sealed tokens only from the value the caller read (M8.2c)", async () => {
    const userId = await upsertUser(t.db, { githubUserId: 7, login: "octo" });
    await createSession(t.db, { userId, tokenHash: HASH, githubTokens: "v1", lifetimeSeconds: 60 });
    await createSession(t.db, {
      userId,
      tokenHash: HASH2,
      githubTokens: "v1",
      lifetimeSeconds: 60,
    });
    expect(await replaceSessionTokens(t.db, HASH, "v1", "v2")).toBe(true);
    // A second refresh that read the old value loses: the row already moved on.
    expect(await replaceSessionTokens(t.db, HASH, "v1", "v3")).toBe(false);
    expect((await findSession(t.db, HASH))?.githubTokens).toBe("v2");
    expect((await findSession(t.db, HASH2))?.githubTokens).toBe("v1"); // only that session
    expect(await replaceSessionTokens(t.db, "c".repeat(64), "v1", "v2")).toBe(false);

    // An ended session isn't refreshed back to life.
    await t.db
      .update(sessions)
      .set({
        createdAt: sql`now() - interval '2 hours'`,
        expiresAt: sql`now() - interval '1 second'`,
      })
      .where(eq(sessions.tokenHash, HASH2));
    expect(await replaceSessionTokens(t.db, HASH2, "v1", "v2")).toBe(false);
  });

  it("refuse a token hash that isn't 64 hex characters, a reused hash, and a bad lifetime", async () => {
    const userId = await upsertUser(t.db, { githubUserId: 7, login: "octo" });
    const base = { userId, githubTokens: "sealed", lifetimeSeconds: 60 };
    for (const tokenHash of ["raw-token", "A".repeat(64), "a".repeat(63)]) {
      expect(await pgErrorCode(createSession(t.db, { ...base, tokenHash })), tokenHash).toBe(CHECK);
    }
    await createSession(t.db, { ...base, tokenHash: HASH });
    expect(await pgErrorCode(createSession(t.db, { ...base, tokenHash: HASH }))).toBe(UNIQUE);
    for (const lifetimeSeconds of [0, -1, 1.5, Number.NaN]) {
      await expect(
        createSession(t.db, { ...base, tokenHash: HASH2, lifetimeSeconds }),
      ).rejects.toThrow(RangeError);
    }
  });
});
