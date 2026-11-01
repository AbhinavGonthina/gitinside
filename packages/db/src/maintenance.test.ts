import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimMaintenance,
  consumeRateLimit,
  databaseSizeBytes,
  maintenanceRuns,
  pruneRateLimits,
  rateLimits,
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
  await t.db.delete(rateLimits);
  await t.db.delete(maintenanceRuns);
});

const HOUR = 60 * 60 * 1000;

describe("claimMaintenance", () => {
  const ageBy = (seconds: number) =>
    t.db.update(maintenanceRuns).set({ startedAt: sql`now() - ${seconds} * interval '1 second'` });

  it("claims a task never run, then not again until the period has passed", async () => {
    expect(await claimMaintenance(t.db, "hourly", 3600)).toBe(true);
    expect(await claimMaintenance(t.db, "hourly", 3600)).toBe(false);
    await ageBy(3599);
    expect(await claimMaintenance(t.db, "hourly", 3600)).toBe(false);
    await ageBy(3600);
    expect(await claimMaintenance(t.db, "hourly", 3600)).toBe(true);
    // The claim recorded a new start: the next one waits a whole period again.
    expect(await claimMaintenance(t.db, "hourly", 3600)).toBe(false);
    const [row] = await t.db.select().from(maintenanceRuns);
    expect(Date.now() - (row?.startedAt.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it("gives one claim to callers racing for the same period", async () => {
    await ageBy(7200);
    const wins = await Promise.all(
      Array.from({ length: 8 }, () => claimMaintenance(t.db, "hourly", 3600)),
    );
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("keeps each task's period apart", async () => {
    expect(await claimMaintenance(t.db, "hourly", 3600)).toBe(true);
    expect(await claimMaintenance(t.db, "daily", 86_400)).toBe(true);
    expect((await t.db.select().from(maintenanceRuns)).map((r) => r.name).sort()).toEqual([
      "daily",
      "hourly",
    ]);
  });

  it("refuses a negative or non-finite period", async () => {
    for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(claimMaintenance(t.db, "hourly", seconds)).rejects.toThrow(RangeError);
    }
  });
});

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
