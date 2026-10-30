import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { countStoreRequests, storeRequests, storeRequestsThisMonth } from "./index.js";
import { createTestDb, type TestDb } from "./testing.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(storeRequests);
});

/** The first instant of the current UTC month, by this machine's clock. */
function utcMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

describe("store request counts", () => {
  it("are zero for a month nobody has counted yet", async () => {
    expect(await storeRequestsThisMonth(t.db)).toEqual({
      monthStart: utcMonthStart(),
      worker: 0,
      web: 0,
      total: 0,
    });
  });

  it("add up per source in the current UTC month", async () => {
    await countStoreRequests(t.db, "worker");
    await countStoreRequests(t.db, "web");
    await countStoreRequests(t.db, "worker", 3);
    await Promise.all(Array.from({ length: 10 }, () => countStoreRequests(t.db, "web")));

    expect(await storeRequestsThisMonth(t.db)).toMatchObject({ worker: 4, web: 11, total: 15 });
    const rows = await t.db.select().from(storeRequests);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.monthStart).toEqual(utcMonthStart());
  });

  it("leave earlier months out of this month's count", async () => {
    await t.db.insert(storeRequests).values([
      { monthStart: new Date(Date.UTC(2020, 0, 1)), source: "web", count: 49_000 },
      { monthStart: new Date(Date.UTC(2020, 1, 1)), source: "worker", count: 7 },
    ]);
    await countStoreRequests(t.db, "web", 2);
    expect(await storeRequestsThisMonth(t.db)).toMatchObject({ worker: 0, web: 2, total: 2 });
  });

  it("refuse a count that isn't a positive integer, and an unknown source", async () => {
    for (const requests of [0, -1, 1.5, Number.NaN]) {
      await expect(countStoreRequests(t.db, "web", requests)).rejects.toThrow(/positive integer/);
    }
    await expect(
      t.db
        .insert(storeRequests)
        .values({ monthStart: utcMonthStart(), source: "browser", count: 1 }),
    ).rejects.toThrow();
    expect((await storeRequestsThisMonth(t.db)).total).toBe(0);
  });
});
