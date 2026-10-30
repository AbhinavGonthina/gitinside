// @vitest-environment node
import {
  analyses,
  countStoreRequests,
  rateLimits,
  repos,
  storeRequests,
  storeRequestsThisMonth,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAINTENANCE_FIRST_DELAY_MS,
  MAINTENANCE_INTERVAL_MS,
  QUOTA_ALARM_RATIO,
  QUOTA_LIMITS,
  checkQuotas,
  createCountedStore,
  measureQuotas,
  runMaintenance,
  scheduleMaintenance,
} from "./maintenance.js";
import { RETENTION_POLICY } from "./retention.js";
import { s3Error, startFakeS3, type FakeS3 } from "./s3.testkit.js";
import { createObjectStore } from "./storage.js";

const HOUR = 60 * 60 * 1000;
const sha = (n: number) => n.toString(16).padStart(40, "0");
const key = (n: number) => `public/acme/shop/${sha(n)}/0.1.0.json.gz`;

const NO_REQUESTS = { worker: 0, web: 0 };
const UNLIMITED = {
  bucketBytes: Number.MAX_SAFE_INTEGER,
  databaseBytes: Number.MAX_SAFE_INTEGER,
  monthlyRequests: Number.MAX_SAFE_INTEGER,
};

describe("checkQuotas", () => {
  it("reports each resource against its limit, in alarm from 80%", () => {
    expect(
      checkQuotas(
        {
          bucketBytes: 7_999_999_999,
          databaseBytes: 800,
          requests: { worker: 30_000, web: 9_999 },
        },
        { bucketBytes: 10_000_000_000, databaseBytes: 1000, monthlyRequests: 50_000 },
      ),
    ).toEqual([
      {
        resource: "bucket",
        unit: "bytes",
        used: 7_999_999_999,
        limit: 10_000_000_000,
        percent: 79.9,
        alarm: false,
      },
      { resource: "database", unit: "bytes", used: 800, limit: 1000, percent: 80, alarm: true },
      {
        resource: "requests",
        unit: "requests",
        used: 39_999,
        limit: 50_000,
        percent: 79.9,
        alarm: false,
        bySource: { worker: 30_000, web: 9_999 },
      },
    ]);
  });

  it("counts worker and web requests together against the month's limit", () => {
    const [, , requests] = checkQuotas({
      bucketBytes: 0,
      databaseBytes: 0,
      requests: { worker: 1, web: 39_999 },
    });
    expect(requests).toMatchObject({ used: 40_000, limit: 50_000, percent: 80, alarm: true });
  });

  it("uses the free tiers' limits by default, and reports past 100%", () => {
    const [bucket, database] = checkQuotas({
      bucketBytes: 0,
      databaseBytes: 1_500_000_000,
      requests: NO_REQUESTS,
    });
    expect(bucket).toMatchObject({
      limit: QUOTA_LIMITS.bucketBytes,
      percent: 0,
      alarm: false,
    });
    expect(database).toMatchObject({ limit: 1_000_000_000, percent: 150, alarm: true });
    expect(QUOTA_LIMITS).toEqual({
      bucketBytes: 20_000_000_000,
      databaseBytes: 1_000_000_000,
      monthlyRequests: 50_000,
    });
  });

  it("has retention keep the bucket at or under the alarm point", () => {
    expect(RETENTION_POLICY.budgetBytes).toBe(16_000_000_000);
    expect(RETENTION_POLICY.budgetBytes).toBeLessThanOrEqual(
      QUOTA_LIMITS.bucketBytes * QUOTA_ALARM_RATIO,
    );
  });
});

describe("with a database and a bucket", () => {
  let t: TestDb;
  let s3: FakeS3;
  let lines: Record<string, unknown>[];
  const log = (event: Record<string, unknown>) => void lines.push(event);

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.db.delete(rateLimits);
    await t.db.delete(storeRequests);
    await t.db.delete(analyses);
    await t.db.delete(repos);
    s3 = await startFakeS3();
    lines = [];
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
    // Commits 1–6, each stored as 100 bytes: retention evicts commit 1.
    for (let n = 1; n <= 6; n++) {
      await t.db.insert(analyses).values({
        repoId: (shop as { id: string }).id,
        sha: sha(n),
        analyzerVersion: "0.1.0",
        status: "done",
        snapshotKey: key(n),
        finishedAt: new Date(Date.UTC(2026, 0, n)),
      });
      s3.objects.set(key(n), { body: Buffer.alloc(100), headers: {}, lastModified: new Date(0) });
    }
  });
  afterEach(() => s3.close());

  const store = () =>
    createObjectStore({ endpoint: s3.endpoint, bucket: s3.bucket, credentials: s3.credentials });

  it("measureQuotas sums the whole listing and measures the database and the month's requests", async () => {
    s3.objects.set("other/file", { body: Buffer.alloc(7), headers: {}, lastModified: new Date(0) });
    await countStoreRequests(t.db, "web", 41);
    const [bucket, database, requests] = await measureQuotas({ db: t.db, store: store() });
    expect(bucket).toMatchObject({ resource: "bucket", used: 607, alarm: false });
    expect(database?.resource).toBe("database");
    expect(database?.used).toBeGreaterThan(0);
    expect(requests).toMatchObject({
      resource: "requests",
      used: 41,
      limit: 50_000,
      bySource: { worker: 0, web: 41 },
    });
  });

  it("a counted store records every request as the worker's, its own listing included", async () => {
    s3.objects.set("other/file", { body: Buffer.alloc(7), headers: {}, lastModified: new Date(0) });
    const counted = createCountedStore(
      { endpoint: s3.endpoint, bucket: s3.bucket, credentials: s3.credentials },
      t.db,
      log,
      { listPageSize: 3 },
    );
    await counted.put("public/x", Buffer.from("{}"), {
      contentType: "application/json",
      cacheControl: "no-store",
    });
    expect(await counted.get("public/x")).toBeDefined();
    expect(await counted.get("public/missing")).toBeUndefined(); // refused, still a request
    await counted.delete("public/x");
    expect(await storeRequestsThisMonth(t.db)).toMatchObject({ worker: 4, web: 0 });

    // 7 objects in pages of 3: 3 listing requests, counted before the total is read.
    const [, , requests] = await measureQuotas({ db: t.db, store: counted });
    expect(requests).toMatchObject({ used: 7, bySource: { worker: 7, web: 0 } });
    expect(lines).toEqual([]);
  });

  it("a request goes on when its count fails, and the failure is logged", async () => {
    const down = () => {
      throw new Error("db down");
    };
    const broken = { insert: down } as unknown as TestDb["db"];
    const counted = createCountedStore(
      { endpoint: s3.endpoint, bucket: s3.bucket, credentials: s3.credentials },
      broken,
      log,
    );
    expect(await counted.get(key(1))).toBeDefined();
    expect(lines).toEqual([{ event: "store_request_count_failed", message: "db down" }]);
  });

  it("runs retention, prunes old rate-limit windows, then measures what is left", async () => {
    await t.db.insert(rateLimits).values({
      key: "ip:old",
      windowStart: new Date(Date.now() - 5 * HOUR),
      count: 3,
    });

    const report = await runMaintenance({ db: t.db, store: store(), log });

    expect(report.failed).toEqual([]);
    expect(report.retention).toMatchObject({
      storedBytes: 600,
      evicted: { "beyond-latest": 1 },
      deletedObjects: 1,
    });
    expect(report.rateLimitsPruned).toBe(1);
    expect(report.quotas?.[0]).toMatchObject({ resource: "bucket", used: 500 });
    expect(lines.map((line) => line.event)).toEqual([
      "retention_run",
      "rate_limits_pruned",
      "quota",
    ]);
    expect(lines[1]).toEqual({ event: "rate_limits_pruned", rows: 1 });
  });

  it("logs a quota_alarm line per resource at 80% or more", async () => {
    await runMaintenance({
      db: t.db,
      store: store(),
      log,
      limits: { ...UNLIMITED, bucketBytes: 600 },
    });
    const alarms = lines.filter((line) => line.event === "quota_alarm");
    expect(alarms).toEqual([
      {
        event: "quota_alarm",
        resource: "bucket",
        unit: "bytes",
        used: 500,
        limit: 600,
        percent: 83.3,
        alarm: true,
      },
    ]);
  });

  it("logs a quota_alarm for requests once the month's count reaches 80%", async () => {
    await countStoreRequests(t.db, "worker", 30_000);
    await countStoreRequests(t.db, "web", 10_000);
    await runMaintenance({ db: t.db, store: store(), log });
    const alarms = lines.filter((line) => line.event === "quota_alarm");
    expect(alarms).toEqual([
      {
        event: "quota_alarm",
        resource: "requests",
        unit: "requests",
        used: 40_000,
        limit: 50_000,
        percent: 80,
        alarm: true,
        bySource: { worker: 30_000, web: 10_000 },
      },
    ]);
  });

  it("passes the retention policy through", async () => {
    const report = await runMaintenance({
      db: t.db,
      store: store(),
      log,
      policy: { ...RETENTION_POLICY, keepPerRepo: 2 },
      now: () => new Date("2026-10-29T12:00:00Z"),
    });
    expect(report.retention?.evicted["beyond-latest"]).toBe(4);
  });

  it("runs every step even when the bucket can't be listed, and never rejects", async () => {
    s3.handler = (_req, _body, res) => s3Error(res, 500, "InternalError");
    const report = await runMaintenance({ db: t.db, store: store(), log });
    expect(report).toEqual({ failed: ["retention", "quota"], rateLimitsPruned: 0 });
    expect(lines).toEqual([
      {
        event: "maintenance_failed",
        step: "retention",
        message: "LIST answered 500 InternalError",
      },
      { event: "rate_limits_pruned", rows: 0 },
      { event: "maintenance_failed", step: "quota", message: "LIST answered 500 InternalError" },
    ]);
    expect(await t.db.select().from(analyses)).toHaveLength(6);
  });
});

describe("scheduleMaintenance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a minute after start, then an hour after each run ends", async () => {
    let runs = 0;
    const schedule = scheduleMaintenance({ run: async () => void runs++, log: () => undefined });
    expect(MAINTENANCE_FIRST_DELAY_MS).toBe(60_000);
    expect(MAINTENANCE_INTERVAL_MS).toBe(HOUR);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(2);
    await schedule.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(runs).toBe(2);
  });

  it("never overlaps runs: the interval starts when a run ends", async () => {
    const starts: number[] = [];
    const schedule = scheduleMaintenance({
      run: () => {
        starts.push(Date.now());
        return new Promise((resolve) => setTimeout(resolve, 30));
      },
      log: () => undefined,
      firstDelayMs: 10,
      intervalMs: 20,
    });
    await vi.advanceTimersByTimeAsync(200);
    await schedule.stop();
    const gaps = starts.slice(1).map((start, i) => start - (starts[i] as number));
    expect(gaps.length).toBeGreaterThan(1);
    expect(new Set(gaps)).toEqual(new Set([50]));
  });

  it("logs a rejected run and keeps going", async () => {
    const lines: Record<string, unknown>[] = [];
    let runs = 0;
    const schedule = scheduleMaintenance({
      run: async () => {
        runs++;
        throw new Error("boom");
      },
      log: (event) => void lines.push(event),
      firstDelayMs: 1,
      intervalMs: 1,
    });
    await vi.advanceTimersByTimeAsync(2);
    await schedule.stop();
    expect(runs).toBe(2);
    expect(lines[0]).toEqual({ event: "maintenance_failed", step: "run", message: "boom" });
  });

  it("stop waits for a run in progress and schedules nothing after it", async () => {
    let finish: () => void = () => undefined;
    let runs = 0;
    const schedule = scheduleMaintenance({
      run: () => {
        runs++;
        return new Promise<void>((resolve) => (finish = resolve));
      },
      log: () => undefined,
      firstDelayMs: 1,
      intervalMs: 1,
    });
    await vi.advanceTimersByTimeAsync(1);
    let stopped = false;
    const stopping = schedule.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(5);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    await schedule.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toBe(1);
  });
});
