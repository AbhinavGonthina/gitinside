// @vitest-environment node
import {
  analyses,
  computeUsage,
  countComputeUsage,
  countStoreRequests,
  maintenanceRuns,
  rateLimits,
  repos,
  storeRequests,
  storeRequestsThisMonth,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  INTERRUPTED_AFTER_SECONDS,
  MAINTENANCE_EVERY_SECONDS,
  MAINTENANCE_MIN_TIME_LEFT_MS,
  MAINTENANCE_TASK,
  QUOTA_ALARM_RATIO,
  QUOTA_LIMITS,
  STALE_QUEUED_AFTER_SECONDS,
  checkQuotas,
  createCountedStore,
  createMaintenanceTrigger,
  measureQuotas,
  runMaintenance,
  type MaintenanceTriggerOptions,
} from "./maintenance.js";
import { RETENTION_POLICY } from "./retention.js";
import { MAX_TASK_AGE_SECONDS } from "./run.js";
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
    await t.db.delete(computeUsage);
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
      "stale_jobs_failed",
      "retention_run",
      "rate_limits_pruned",
      "quota",
    ]);
    expect(lines[0]).toEqual({ event: "stale_jobs_failed", interrupted: 0, stranded: 0 });
    expect(lines[2]).toEqual({ event: "rate_limits_pruned", rows: 1 });
  });

  it("first fails rows running past the request timeout and rows queued past every task's window", async () => {
    const [{ id: repoId } = { id: "" }] = await t.db.select({ id: repos.id }).from(repos);
    const row = (n: number, status: "queued" | "running", ageSeconds: number) => ({
      repoId,
      sha: sha(n),
      analyzerVersion: "0.1.0",
      status,
      startedAt: status === "running" ? new Date(Date.now() - ageSeconds * 1000) : null,
      queuedAt: new Date(Date.now() - ageSeconds * 1000),
    });
    await t.db
      .insert(analyses)
      .values([
        row(7, "running", INTERRUPTED_AFTER_SECONDS + 5),
        row(8, "running", INTERRUPTED_AFTER_SECONDS - 30),
        row(9, "queued", STALE_QUEUED_AFTER_SECONDS + 5),
        row(10, "queued", STALE_QUEUED_AFTER_SECONDS - 60),
      ]);

    const report = await runMaintenance({ db: t.db, store: store(), log });

    expect(report.staleJobs).toEqual({ interrupted: 1, stranded: 1 });
    const status = new Map(
      (await t.db.select().from(analyses)).map((r) => [r.sha, [r.status, r.errorCode]]),
    );
    expect(status.get(sha(7))).toEqual(["failed", "JOB_INTERRUPTED"]);
    expect(status.get(sha(8))).toEqual(["running", null]);
    expect(status.get(sha(9))).toEqual(["failed", "QUEUE_UNAVAILABLE"]);
    expect(status.get(sha(10))).toEqual(["queued", null]);
  });

  it("waits out a day of task signatures, plus a margin, before calling a queued row stranded", () => {
    expect(INTERRUPTED_AFTER_SECONDS).toBe(360);
    expect(STALE_QUEUED_AFTER_SECONDS).toBe(MAX_TASK_AGE_SECONDS + 600);
    expect(MAX_TASK_AGE_SECONDS).toBe(86_400);
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

  it("measures the month's Google compute after the stores, in alarm from 80% of the free allowance", async () => {
    // 2 hours of 1 vCPU / 4 GiB instance time; 80% of Cloud Tasks' free operations; 25 starts.
    await countComputeUsage(t.db, {
      instanceMs: 2 * HOUR,
      runRequests: 90,
      taskOperations: 800_000,
      secretAccesses: 100,
    });
    const readings = await measureQuotas({ db: t.db, store: store() });
    expect(readings.map((reading) => reading.resource)).toEqual([
      "bucket",
      "database",
      "requests",
      "cloud_run_vcpu",
      "cloud_run_memory",
      "cloud_run_requests",
      "cloud_tasks",
      "secret_manager",
    ]);
    expect(readings.slice(3)).toEqual([
      // Google's free tier less the kill switch's reserve (M5.14b4).
      expect.objectContaining({ used: 7_200, limit: 170_400, percent: 4.2, alarm: false }),
      expect.objectContaining({ unit: "gb_seconds", limit: 354_846, percent: 8.7, alarm: false }),
      expect.objectContaining({ used: 90, limit: 1_997_600, alarm: false }),
      expect.objectContaining({ used: 800_000, limit: 1_000_000, percent: 80, alarm: true }),
      expect.objectContaining({ used: 100, limit: 10_000, percent: 1, alarm: false }),
    ]);

    await runMaintenance({ db: t.db, store: store(), log });
    expect(lines.filter((line) => line.event === "quota_alarm")).toEqual([
      {
        event: "quota_alarm",
        resource: "cloud_tasks",
        unit: "operations",
        used: 800_000,
        limit: 1_000_000,
        percent: 80,
        alarm: true,
      },
    ]);
  });

  it("checks compute against the allowance it's given", async () => {
    await countComputeUsage(t.db, { runRequests: 4 });
    const readings = await measureQuotas({
      db: t.db,
      store: store(),
      compute: {
        vcpuSeconds: 1,
        memoryGbSeconds: 1,
        runRequests: 5,
        taskOperations: 1,
        secretAccesses: 1,
      },
    });
    expect(readings.find((reading) => reading.resource === "cloud_run_requests")).toMatchObject({
      used: 4,
      limit: 5,
      alarm: true,
    });
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
    expect(report).toEqual({
      failed: ["retention", "quota"],
      staleJobs: { interrupted: 0, stranded: 0 },
      rateLimitsPruned: 0,
    });
    expect(lines).toEqual([
      { event: "stale_jobs_failed", interrupted: 0, stranded: 0 },
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

  describe("createMaintenanceTrigger", () => {
    const PLENTY = { timeLeftMs: 200_000 };
    let runs: number;
    const counting = () => async () => void runs++;
    const trigger = (overrides: Partial<MaintenanceTriggerOptions> = {}) =>
      createMaintenanceTrigger({ db: t.db, run: counting(), log, ...overrides });
    /** Pretend the last claim started `seconds` ago. */
    const lastStarted = (seconds: number) =>
      t.db.update(maintenanceRuns).set({ startedAt: new Date(Date.now() - seconds * 1000) });

    beforeEach(async () => {
      await t.db.delete(maintenanceRuns);
      runs = 0;
    });

    it("runs after a job when never run, then not again within the hour", async () => {
      expect(MAINTENANCE_EVERY_SECONDS).toBe(HOUR / 1000);
      expect(MAINTENANCE_TASK).toBe("hourly");
      const maintenance = trigger();
      expect(await maintenance.afterJob(PLENTY)).toBe(true);
      expect(runs).toBe(1);
      expect(await maintenance.afterJob(PLENTY)).toBe(false);
      await lastStarted(3590);
      expect(await maintenance.afterJob(PLENTY)).toBe(false);
      await lastStarted(3605);
      expect(await maintenance.afterJob(PLENTY)).toBe(true);
      expect(runs).toBe(2);
      expect(lines.map((line) => line.event)).toEqual([
        "maintenance_started",
        "maintenance_started",
      ]);
    });

    it("lets one of two instances run it when both finish a job at once", async () => {
      const [a, b] = [trigger(), trigger()];
      const won = await Promise.all([a.afterJob(PLENTY), b.afterJob(PLENTY)]);
      expect(won.filter(Boolean)).toHaveLength(1);
      expect(runs).toBe(1);
    });

    it("leaves the claim alone when the job left too little time", async () => {
      expect(MAINTENANCE_MIN_TIME_LEFT_MS).toBe(60_000);
      const maintenance = trigger();
      expect(await maintenance.afterJob({ timeLeftMs: 59_999 })).toBe(false);
      expect(await t.db.select().from(maintenanceRuns)).toEqual([]);
      expect(await maintenance.afterJob({ timeLeftMs: 60_000 })).toBe(true);
      expect(runs).toBe(1);
    });

    it("waits for the run no longer than the job's time left; the run carries on and stop waits for it", async () => {
      let finish: () => void = () => undefined;
      const maintenance = trigger({
        run: () => new Promise<void>((resolve) => (finish = resolve)),
        minTimeLeftMs: 0,
      });
      expect(await maintenance.afterJob({ timeLeftMs: 20 })).toBe(true);
      expect(lines.at(-1)).toEqual({ event: "maintenance_unawaited", timeLeftMs: 20 });
      // No second run beside it on this instance, even once the period allows one.
      await lastStarted(2 * 3600);
      expect(await maintenance.afterJob(PLENTY)).toBe(false);

      let stopped = false;
      const stopping = maintenance.stop().then(() => (stopped = true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopped).toBe(false);
      finish();
      await stopping;
      expect(await maintenance.afterJob(PLENTY)).toBe(false);
    });

    it("stops waiting when the job's signal aborts, and starts nothing on an aborted one", async () => {
      const maintenance = trigger({ run: () => new Promise<void>(() => undefined) });
      const aborted = new AbortController();
      aborted.abort();
      expect(await maintenance.afterJob({ ...PLENTY, signal: aborted.signal })).toBe(false);
      expect(await t.db.select().from(maintenanceRuns)).toEqual([]);

      const shutdown = new AbortController();
      const waiting = maintenance.afterJob({ ...PLENTY, signal: shutdown.signal });
      await new Promise((resolve) => setTimeout(resolve, 20));
      shutdown.abort();
      expect(await waiting).toBe(true);
    });

    it("logs a failed claim or run and never rejects", async () => {
      const broken = {
        insert: () => {
          throw new Error("db down");
        },
      } as unknown as TestDb["db"];
      expect(await trigger({ db: broken }).afterJob(PLENTY)).toBe(false);
      expect(await trigger({ run: () => Promise.reject(new Error("boom")) }).afterJob(PLENTY)).toBe(
        true,
      );
      expect(lines).toEqual([
        { event: "maintenance_failed", step: "claim", message: "db down" },
        { event: "maintenance_started" },
        { event: "maintenance_failed", step: "run", message: "boom" },
      ]);
    });
  });
});
