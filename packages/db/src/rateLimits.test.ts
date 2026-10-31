import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumeRateLimit, rateLimits, refundRateLimit } from "./index.js";
import { createTestDb, type TestDb } from "./testing.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(rateLimits);
});

const HOUR = 60 * 60 * 1000;

describe("consumeRateLimit", () => {
  it("allows up to the limit in one window, then refuses without counting", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await consumeRateLimit(t.db, "ip:a", 3));
    expect(results.map((r) => [r.allowed, r.count])).toEqual([
      [true, 1],
      [true, 2],
      [true, 3],
      [false, 3],
    ]);
    const [row] = await t.db.select().from(rateLimits);
    expect(row?.count).toBe(3);
  });

  it("windows start on the UTC hour and reset an hour later", async () => {
    const { windowStart, resetAt } = await consumeRateLimit(t.db, "ip:a", 5);
    expect(windowStart.getTime() % HOUR).toBe(0);
    expect(resetAt.getTime() - windowStart.getTime()).toBe(HOUR);
    expect(Date.now() - windowStart.getTime()).toBeLessThan(HOUR + 60_000);
  });

  it("counts each key on its own", async () => {
    await consumeRateLimit(t.db, "ip:a", 1);
    expect((await consumeRateLimit(t.db, "ip:a", 1)).allowed).toBe(false);
    expect((await consumeRateLimit(t.db, "ip:b", 1)).allowed).toBe(true);
  });

  it("a previous window's count doesn't carry over", async () => {
    await t.db.insert(rateLimits).values({
      key: "ip:a",
      windowStart: sql`date_trunc('hour', now(), 'UTC') - interval '1 hour'`,
      count: 5,
    });
    expect(await consumeRateLimit(t.db, "ip:a", 5)).toMatchObject({ allowed: true, count: 1 });
  });

  it("gives exactly `limit` slots to requests racing for them", async () => {
    // Pinned to one moment: on the database clock, a race at the top of the hour splits over
    // two windows (CI at 15:00:00 UTC got 10 of 12 allowed).
    const at = new Date("2026-10-31T14:59:59.999Z");
    const results = await Promise.all(
      Array.from({ length: 12 }, () => consumeRateLimit(t.db, "ip:race", 5, at)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const [row] = await t.db.select().from(rateLimits);
    expect(row?.count).toBe(5);
  });

  it("gives each window its own `limit` when a race straddles the hour", async () => {
    const before = new Date("2026-10-31T14:59:59.999Z");
    const after = new Date("2026-10-31T15:00:00.000Z");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        consumeRateLimit(t.db, "ip:race", 5, i % 2 === 0 ? before : after),
      ),
    );
    const allowedIn = (start: string) =>
      results.filter((r) => r.allowed && r.windowStart.toISOString() === start).length;
    expect(allowedIn("2026-10-31T14:00:00.000Z")).toBe(5);
    expect(allowedIn("2026-10-31T15:00:00.000Z")).toBe(5);
    const refused = results.filter((r) => !r.allowed);
    expect(refused.map((r) => r.count)).toEqual([5, 5]);
    const rows = await t.db.select().from(rateLimits);
    expect(rows.map((r) => r.count)).toEqual([5, 5]);
  });

  it("refuses on the full window's row when the clock passes the hour mid-call", async () => {
    await t.db.insert(rateLimits).values({
      key: "ip:edge",
      windowStart: new Date("2026-10-31T14:00:00.000Z"),
      count: 5,
    });
    const result = await t.db.transaction(async (tx) => {
      // A `now()` ahead of `pg_catalog`'s on the search path: 14:59:59.999 the first time it's
      // read, the next hour after that, like a database clock crossing the hour between two
      // statements.
      await tx.execute(sql`create sequence fake_clock_reads`);
      await tx.execute(sql`create function public.now() returns timestamptz language sql volatile
        as $$ select case when nextval('fake_clock_reads') = 1
          then '2026-10-31T14:59:59.999Z'::timestamptz
          else '2026-10-31T15:00:00.000Z'::timestamptz end $$`);
      await tx.execute(sql`set local search_path = public, pg_catalog`);
      const refused = await consumeRateLimit(tx, "ip:edge", 5);
      await tx.execute(sql`drop function public.now()`);
      await tx.execute(sql`drop sequence fake_clock_reads`);
      return refused;
    });
    expect(result).toEqual({
      allowed: false,
      count: 5,
      windowStart: new Date("2026-10-31T14:00:00.000Z"),
      resetAt: new Date("2026-10-31T15:00:00.000Z"),
    });
    const rows = await t.db.select().from(rateLimits);
    expect(rows.map((r) => [r.windowStart.toISOString(), r.count])).toEqual([
      ["2026-10-31T14:00:00.000Z", 5],
    ]);
  });

  it("refuses a limit that isn't a positive integer", async () => {
    await expect(consumeRateLimit(t.db, "ip:a", 0)).rejects.toThrow("positive integer");
    await expect(consumeRateLimit(t.db, "ip:a", 1.5)).rejects.toThrow("positive integer");
  });
});

describe("refundRateLimit", () => {
  it("gives a slot back, never below zero", async () => {
    await consumeRateLimit(t.db, "ip:a", 1);
    const { windowStart } = await consumeRateLimit(t.db, "ip:a", 1);
    await refundRateLimit(t.db, "ip:a", windowStart);
    expect(await consumeRateLimit(t.db, "ip:a", 1)).toMatchObject({ allowed: true, count: 1 });
    await refundRateLimit(t.db, "ip:a", windowStart);
    await refundRateLimit(t.db, "ip:a", windowStart);
    const [row] = await t.db.select().from(rateLimits);
    expect(row?.count).toBe(0);
  });
});
