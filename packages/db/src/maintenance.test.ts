import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumeRateLimit, databaseSizeBytes, pruneRateLimits, rateLimits } from "./index.js";
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

describe("databaseSizeBytes", () => {
  it("measures the database as a positive whole number of bytes", async () => {
    const bytes = await databaseSizeBytes(t.db);
    expect(Number.isSafeInteger(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
  });
});

describe("pruneRateLimits", () => {
  it("deletes windows that ended over an hour ago, keeping the current and previous ones", async () => {
    const { windowStart: current } = await consumeRateLimit(t.db, "ip:now", 5);
    const at = (hoursAgo: number) => new Date(current.getTime() - hoursAgo * HOUR);
    await t.db.insert(rateLimits).values([
      { key: "ip:a", windowStart: at(1), count: 2 },
      { key: "ip:a", windowStart: at(2), count: 5 },
      { key: "ip:b", windowStart: at(30), count: 1 },
    ]);

    expect(await pruneRateLimits(t.db)).toBe(2);
    const left = await t.db.select().from(rateLimits);
    expect(left.map((r) => [r.key, r.windowStart.getTime()]).sort()).toEqual(
      [
        ["ip:a", at(1).getTime()],
        ["ip:now", current.getTime()],
      ].sort(),
    );
    expect(await pruneRateLimits(t.db)).toBe(0);
  });
});
