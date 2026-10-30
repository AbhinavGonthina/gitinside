// @vitest-environment node
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUOTA_ALARM_EXIT, runQuota, type QuotaIo } from "./quota.js";
import { s3Error, startFakeS3, type FakeS3 } from "./s3.testkit.js";
import { createObjectStore } from "./storage.js";

const ENV = {
  DATABASE_URL: "postgres://127.0.0.1/gitinside",
  SNAPSHOTS_NAMESPACE: "axq1ns2example",
  SNAPSHOTS_REGION: "us-ashburn-1",
  SNAPSHOTS_ACCESS_KEY_ID: "key-id",
  SNAPSHOTS_SECRET_ACCESS_KEY: "key-secret",
  SNAPSHOTS_BUCKET: "gitinside-snapshots",
};

const parse = (lines: string[]): Record<string, unknown>[] =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("runQuota", () => {
  let t: TestDb;
  let s3: FakeS3;
  let lines: string[];
  let closes: number;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    s3 = await startFakeS3();
    s3.objects.set("public/a", { body: Buffer.alloc(40), headers: {}, lastModified: new Date(0) });
    lines = [];
    closes = 0;
  });
  afterEach(() => s3.close());

  const io = (overrides: Partial<QuotaIo> = {}): QuotaIo => ({
    env: ENV,
    write: (line) => void lines.push(line),
    openDb: () => ({
      db: t.db,
      close: async () => {
        closes++;
      },
    }),
    openStore: (config) => {
      expect(config).toMatchObject({ bucket: ENV.SNAPSHOTS_BUCKET, region: "us-ashburn-1" });
      // The fake's own endpoint, bucket, and keys stand in for Oracle's.
      return createObjectStore({
        endpoint: s3.endpoint,
        bucket: s3.bucket,
        credentials: s3.credentials,
      });
    },
    ...overrides,
  });

  it("prints the quota line and exits 0 under 80%", async () => {
    expect(await runQuota(io())).toBe(0);
    const [line, ...rest] = parse(lines);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      time: expect.any(String),
      event: "quota",
      quotas: [
        { resource: "bucket", usedBytes: 40, limitBytes: 20_000_000_000, alarm: false },
        { resource: "database", limitBytes: 1_000_000_000, alarm: false },
      ],
    });
    expect(closes).toBe(1);
  });

  it("exits 2 with a quota_alarm line when a resource is at 80% or more", async () => {
    const code = await runQuota(
      io({ limits: { bucketBytes: 50, databaseBytes: Number.MAX_SAFE_INTEGER } }),
    );
    expect(code).toBe(QUOTA_ALARM_EXIT);
    expect(QUOTA_ALARM_EXIT).toBe(2);
    expect(parse(lines).map((line) => line.event)).toEqual(["quota", "quota_alarm"]);
    expect(parse(lines)[1]).toMatchObject({ resource: "bucket", percent: 80 });
  });

  it("exits 1 when the bucket can't be measured, and still closes the database", async () => {
    s3.handler = (_req, _body, res) => s3Error(res, 403, "AccessDenied");
    expect(await runQuota(io())).toBe(1);
    expect(parse(lines)).toMatchObject([
      { event: "quota_failed", message: "LIST answered 403 AccessDenied" },
    ]);
    expect(closes).toBe(1);
  });

  it("exits 1 listing every problem variable, without opening anything", async () => {
    let opened = false;
    const code = await runQuota(
      io({
        env: { ...ENV, DATABASE_URL: "mysql://x", SNAPSHOTS_BUCKET: "" },
        openDb: () => {
          opened = true;
          throw new Error("unreachable");
        },
      }),
    );
    expect(code).toBe(1);
    expect(opened).toBe(false);
    expect(parse(lines)).toMatchObject([
      {
        event: "config_invalid",
        problems: [
          "DATABASE_URL must start with postgres:// or postgresql://",
          "SNAPSHOTS_BUCKET is not set",
        ],
      },
    ]);
    expect(lines.join("")).not.toContain("key-secret");
  });
});

describe("quota-bin.js", () => {
  it("exits 1 naming the missing variables, and reads nothing else", async () => {
    const bin = fileURLToPath(new URL("../dist/quota-bin.js", import.meta.url));
    const run = promisify(execFile)(process.execPath, [bin], { env: {}, timeout: 20_000 });
    const error = await run.then(
      () => undefined,
      (failure: { code: number; stdout: string }) => failure,
    );
    expect(error?.code).toBe(1);
    expect(parse((error?.stdout ?? "").trimEnd().split("\n"))).toMatchObject([
      {
        event: "config_invalid",
        problems: ["DATABASE_URL is not set", "SNAPSHOTS_NAMESPACE is not set"],
      },
    ]);
  });
});
