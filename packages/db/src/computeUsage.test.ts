import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COMPUTE_ALLOWANCE,
  computeMeters,
  computeUsage,
  computeUsageThisMonth,
  countComputeUsage,
  findComputePause,
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
  await t.db.delete(computeUsage);
});

/** The first instant of the current UTC month, by this machine's clock, and of the next. */
function utcMonths(): { monthStart: Date; nextMonthStart: Date } {
  const now = new Date();
  return {
    monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    nextMonthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/** Instance time worth `share` of the GB-seconds allowance (the first one a 4 GiB worker uses up). */
const memoryShareMs = (share: number) =>
  Math.ceil(((COMPUTE_ALLOWANCE.memoryGbSeconds * share) / (4 * 1.073_741_824)) * 1000);

describe("compute usage counts", () => {
  it("are zero for a month nobody has counted yet", async () => {
    expect(await computeUsageThisMonth(t.db)).toEqual({
      ...utcMonths(),
      instanceMs: 0,
      runRequests: 0,
      taskOperations: 0,
    });
  });

  it("add up in one row for the current UTC month, concurrent counts included", async () => {
    await countComputeUsage(t.db, { instanceMs: 61_300, runRequests: 1, taskOperations: 1 });
    await countComputeUsage(t.db, { taskOperations: 1 });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        countComputeUsage(t.db, { instanceMs: 100, runRequests: 1, taskOperations: 1 }),
      ),
    );
    expect(await computeUsageThisMonth(t.db)).toMatchObject({
      instanceMs: 62_300,
      runRequests: 11,
      taskOperations: 12,
    });
    const rows = await t.db.select().from(computeUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.monthStart).toEqual(utcMonths().monthStart);
  });

  it("leave earlier months out of this month's", async () => {
    await t.db.insert(computeUsage).values({
      monthStart: new Date(Date.UTC(2020, 0, 1)),
      instanceMs: 90_000_000,
      runRequests: 1_900_000,
      taskOperations: 900_000,
    });
    await countComputeUsage(t.db, { instanceMs: 2_000 });
    expect(await computeUsageThisMonth(t.db)).toMatchObject({
      instanceMs: 2_000,
      runRequests: 0,
      taskOperations: 0,
    });
    expect(await findComputePause(t.db)).toBeUndefined();
  });

  it("refuse negative, fractional, or empty counts", async () => {
    for (const count of [
      { instanceMs: -1 },
      { runRequests: 1.5 },
      { taskOperations: Number.NaN },
      { instanceMs: 1, runRequests: -1 },
    ]) {
      await expect(countComputeUsage(t.db, count)).rejects.toThrow(/non-negative integers/);
    }
    await expect(countComputeUsage(t.db, {})).rejects.toThrow(/nothing to count/);
    await expect(countComputeUsage(t.db, { instanceMs: 0 })).rejects.toThrow(/nothing to count/);
    await expect(
      t.db.insert(computeUsage).values({ monthStart: new Date(), runRequests: -1 }),
    ).rejects.toThrow();
  });
});

describe("compute meters", () => {
  it("turn instance time into vCPU- and GB-seconds of a 1 vCPU / 4 GiB worker", () => {
    expect(computeMeters({ instanceMs: 3_600_000, runRequests: 60, taskOperations: 120 })).toEqual([
      {
        resource: "cloud_run_vcpu",
        unit: "vcpu_seconds",
        used: 3_600,
        limit: 180_000,
        percent: 2,
        alarm: false,
      },
      {
        resource: "cloud_run_memory",
        unit: "gb_seconds",
        used: 3_600 * 4 * 1.073_741_824,
        limit: 360_000,
        percent: 4.2,
        alarm: false,
      },
      {
        resource: "cloud_run_requests",
        unit: "requests",
        used: 60,
        limit: 2_000_000,
        percent: 0,
        alarm: false,
      },
      {
        resource: "cloud_tasks",
        unit: "operations",
        used: 120,
        limit: 1_000_000,
        percent: 0,
        alarm: false,
      },
    ]);
  });

  it("raise the alarm at exactly 80% of an allowance, not below", () => {
    type Usage = Partial<{ instanceMs: number; runRequests: number; taskOperations: number }>;
    const alarms = (usage: Usage, allowance = COMPUTE_ALLOWANCE) =>
      computeMeters({ instanceMs: 0, runRequests: 0, taskOperations: 0, ...usage }, allowance)
        .filter((meter) => meter.alarm)
        .map((meter) => meter.resource);
    const small = { vcpuSeconds: 1_000, memoryGbSeconds: 1e6, runRequests: 10, taskOperations: 5 };
    expect(alarms({ instanceMs: 799_999 }, small)).toEqual([]);
    expect(alarms({ instanceMs: 800_000 }, small)).toEqual(["cloud_run_vcpu"]);
    expect(alarms({ runRequests: 7 }, small)).toEqual([]);
    expect(alarms({ runRequests: 8 }, small)).toEqual(["cloud_run_requests"]);
    expect(alarms({ taskOperations: 4 }, small)).toEqual(["cloud_tasks"]);
    // With the real allowance, memory runs out first: 4.3 GB-seconds per vCPU-second.
    expect(alarms({ instanceMs: memoryShareMs(0.8) })).toEqual(["cloud_run_memory"]);
    expect(alarms({ instanceMs: memoryShareMs(0.8) - 1_000 })).toEqual([]);
  });
});

describe("findComputePause", () => {
  it("is undefined under 80%, and pauses until the next UTC month from 80%", async () => {
    await countComputeUsage(t.db, { instanceMs: memoryShareMs(0.79) });
    expect(await findComputePause(t.db)).toBeUndefined();

    await countComputeUsage(t.db, { instanceMs: memoryShareMs(0.01) + 1_000 });
    const pause = await findComputePause(t.db);
    expect(pause?.until).toEqual(utcMonths().nextMonthStart);
    expect(pause?.meters.map((meter) => meter.resource)).toEqual(["cloud_run_memory"]);
  });

  it("pauses on Cloud Tasks operations alone", async () => {
    await countComputeUsage(t.db, { taskOperations: 800_000 });
    expect((await findComputePause(t.db))?.meters.map((meter) => meter.resource)).toEqual([
      "cloud_tasks",
    ]);
  });

  it("checks against the allowance it's given", async () => {
    await countComputeUsage(t.db, { runRequests: 8 });
    expect(await findComputePause(t.db)).toBeUndefined();
    const limits = { ...COMPUTE_ALLOWANCE, runRequests: 10 };
    expect((await findComputePause(t.db, limits))?.meters).toMatchObject([
      { resource: "cloud_run_requests", used: 8, limit: 10, percent: 80, alarm: true },
    ]);
  });
});
