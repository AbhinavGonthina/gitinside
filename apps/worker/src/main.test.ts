import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  analyses,
  computeUsage,
  computeUsageThisMonth,
  maintenanceRuns,
  queueAnalysis,
  repos,
  startAnalysis,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "./config.js";
import { startFakeGitHub, tarballFrom, type FakeGitHub } from "./github.testkit.js";
import type { JobDeps } from "./job.js";
import { INTERRUPTED_AFTER_SECONDS, STALE_QUEUED_AFTER_SECONDS } from "./maintenance.js";
import {
  SHUTDOWN_SIGNALS,
  SHUTDOWN_TIMEOUT_MS,
  runMain,
  startWorkerProcess,
  type MainIo,
  type RunningWorker,
  type StartOptions,
} from "./main.js";
import type { RunResult } from "./runner.js";
import { startFakeS3, type FakeS3 } from "./s3.testkit.js";
import { fakeTask, pushTask } from "./tasks.testkit.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "s".repeat(43);
const VERSION = "0.1.0";
const GRAPH = '{"nodes":[]}\n';
const JOB = { kind: "analyze", owner: "acme", repo: "shop", sha: SHA };
const STATS = {
  files: 1,
  nodes: 3,
  edges: 2,
  unresolved: 0,
  warnings: 0,
  graphBytes: GRAPH.length,
  stageMs: {},
};
const ENV = {
  DATABASE_URL: "postgres://127.0.0.1/gitinside",
  SNAPSHOTS_NAMESPACE: "axq1ns2example",
  SNAPSHOTS_REGION: "us-ashburn-1",
  SNAPSHOTS_ACCESS_KEY_ID: "key-id",
  SNAPSHOTS_SECRET_ACCESS_KEY: "key-secret",
  SNAPSHOTS_BUCKET: "gitinside-snapshots",
  ENQUEUE_HMAC_SECRET: SECRET,
};

const parse = (lines: string[]): Record<string, unknown>[] =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const events = (lines: string[]): unknown[] => parse(lines).map((line) => line.event);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A fake process for {@link runMain}: lines, exit codes, and the signal handler it set. */
function fakeIo(overrides: Partial<MainIo> = {}) {
  const io = {
    lines: [] as string[],
    exits: [] as number[],
    signals: [] as readonly NodeJS.Signals[],
    handler: undefined as ((signal: NodeJS.Signals) => void) | undefined,
  };
  const main: MainIo = {
    env: ENV,
    write: (line) => void io.lines.push(line),
    onSignal: (signals, handler) => {
      io.signals = signals;
      io.handler = handler;
    },
    exit: (code) => void io.exits.push(code),
    ...overrides,
  };
  return { io, main };
}

function fakeWorker(stop: () => Promise<void> = async () => undefined) {
  let stops = 0;
  const worker: RunningWorker = {
    address: { address: "127.0.0.1", family: "IPv4", port: 8080 },
    stop: () => {
      stops++;
      return stop();
    },
  };
  return { worker, stops: () => stops };
}

describe("runMain", () => {
  it("exits 1 and lists the problems when the config is invalid", async () => {
    const { io, main } = fakeIo({ env: { ...ENV, DATABASE_URL: "", PORT: "x" } });
    expect(await runMain(main)).toBeUndefined();
    expect(io.exits).toEqual([1]);
    expect(parse(io.lines)).toEqual([
      {
        time: expect.any(String),
        event: "config_invalid",
        problems: ["DATABASE_URL is not set", "PORT must be 1–65535"],
      },
    ]);
    expect(io.handler).toBeUndefined();
  });

  it("exits 1 when the start fails", async () => {
    const { io, main } = fakeIo({
      start: async () => {
        throw new Error("listen EADDRINUSE");
      },
    });
    expect(await runMain(main)).toBeUndefined();
    expect(io.exits).toEqual([1]);
    expect(parse(io.lines)).toMatchObject([
      { event: "startup_failed", message: "listen EADDRINUSE" },
    ]);
  });

  it("passes the config (no Redis needed) and a JSON log to the start", async () => {
    let seen: WorkerConfig | undefined;
    const { worker } = fakeWorker();
    const { io, main } = fakeIo({
      start: async (config, options) => {
        seen = config;
        options.log?.({ event: "worker_ready", port: 8080 });
        return worker;
      },
    });
    expect(await runMain(main)).toBe(worker);
    expect(seen?.databaseUrl).toBe(ENV.DATABASE_URL);
    expect(parse(io.lines)).toMatchObject([{ event: "worker_ready", port: 8080 }]);
    expect(io.exits).toEqual([]);
    expect(io.signals).toEqual(SHUTDOWN_SIGNALS);
    expect(SHUTDOWN_SIGNALS).toEqual(["SIGTERM", "SIGINT"]);
  });

  it("stops on a signal and exits 0, ignoring a second signal", async () => {
    const fake = fakeWorker();
    const { io, main } = fakeIo({ start: async () => fake.worker });
    await runMain(main);
    io.handler?.("SIGTERM");
    io.handler?.("SIGINT");
    await tick();
    expect(fake.stops()).toBe(1);
    expect(io.exits).toEqual([0]);
    expect(parse(io.lines)).toMatchObject([{ event: "signal", signal: "SIGTERM" }]);
  });

  it("exits 1 when stopping fails", async () => {
    const fake = fakeWorker(async () => {
      throw new Error("shutdown did not complete cleanly");
    });
    const { io, main } = fakeIo({ start: async () => fake.worker });
    await runMain(main);
    io.handler?.("SIGTERM");
    await tick();
    expect(io.exits).toEqual([1]);
  });

  it("exits 1 when stopping takes too long", async () => {
    const fake = fakeWorker(() => new Promise(() => undefined));
    const { io, main } = fakeIo({ start: async () => fake.worker, shutdownTimeoutMs: 5 });
    await runMain(main);
    io.handler?.("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(io.exits).toEqual([1]);
    expect(events(io.lines)).toEqual(["signal", "shutdown_timeout"]);
  });

  it("gives up on a shutdown before Cloud Run's SIGKILL, 10 s after SIGTERM", () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBeLessThan(10_000);
  });
});

describe("bin.js", () => {
  it("logs the missing variables as JSON and exits 1, without starting anything", async () => {
    const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
    const run = promisify(execFile)(process.execPath, [bin], { env: {}, timeout: 20_000 });
    const error = await run.then(
      () => undefined,
      (failure: { code: number; stdout: string }) => failure,
    );
    expect(error?.code).toBe(1);
    const lines = (error?.stdout ?? "").trimEnd().split("\n");
    expect(parse(lines)).toMatchObject([
      { event: "config_invalid", problems: expect.arrayContaining(["DATABASE_URL is not set"]) },
    ]);
    expect(error?.stdout).not.toContain("REDIS_URL");
  });
});

describe("startWorkerProcess", () => {
  let t: TestDb;
  let root: string;
  let lines: string[];
  let closes: number;
  let github: FakeGitHub;
  let s3: FakeS3;
  const running: RunningWorker[] = [];

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    await t.db.delete(analyses);
    await t.db.delete(repos);
    await t.db.delete(maintenanceRuns);
    await t.db.delete(computeUsage);
    root = await mkdtemp(join(tmpdir(), "gitinside-main-"));
    lines = [];
    closes = 0;
    github = await startFakeGitHub(tarballFrom([{ name: "index.ts", body: "export {};\n" }]));
    const tarball = github.api;
    github.api = (req, res) => {
      if (req.url === "/repos/acme/shop") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: 3_000_000_001,
            name: "shop",
            owner: { login: "acme" },
            private: false,
            default_branch: "main",
          }),
        );
      } else tarball(req, res);
    };
    s3 = await startFakeS3();
  });

  afterEach(async () => {
    for (const worker of running.splice(0)) await worker.stop().catch(() => undefined);
    await github.close();
    await s3.close();
    await rm(root, { recursive: true, force: true });
  });

  const log = (event: Record<string, unknown>) => void lines.push(JSON.stringify(event));
  const openDb = () => ({
    db: t.db,
    close: async () => {
      closes++;
    },
  });

  function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
    return {
      databaseUrl: "postgres://unused",
      store: { endpoint: s3.endpoint, bucket: s3.bucket, credentials: s3.credentials },
      secrets: [SECRET],
      jobsRoot: join(root, "jobs"),
      cacheRoot: join(root, "cache"),
      host: "127.0.0.1",
      port: 0,
      githubToken: "test-token",
      ...overrides,
    };
  }

  const writeGraph: NonNullable<JobDeps["run"]> = async (job): Promise<RunResult> => {
    await writeFile(job.out, GRAPH);
    return { ok: true, stats: STATS, durationMs: 1 };
  };

  async function start(
    options: Partial<StartOptions> = {},
    overrides: Partial<WorkerConfig> = {},
  ): Promise<RunningWorker> {
    const worker = await startWorkerProcess(config(overrides), {
      log,
      openDb,
      analyzerVersion: VERSION,
      github: { apiBase: github.apiBase, downloadOrigins: [github.codeloadOrigin] },
      jobDeps: { run: writeGraph },
      maintenance: false,
      ...options,
    });
    running.push(worker);
    return worker;
  }

  const origin = (worker: RunningWorker) => `http://127.0.0.1:${worker.address.port}`;

  async function runningRow(sha = SHA): Promise<string> {
    const { id: repoId } = await upsertRepo(t.db, {
      providerRepoId: 42,
      owner: "acme",
      name: "shop",
      visibility: "public",
      defaultBranch: "main",
    });
    const { id } = await startAnalysis(t.db, { repoId, sha, analyzerVersion: VERSION });
    return id;
  }

  it("takes a pushed task to the bucket and Postgres, then stops cleanly", async () => {
    const worker = await start();
    const health = await fetch(`${origin(worker)}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const deliveries = await pushTask(fakeTask(origin(worker), JOB, SECRET));
    expect(deliveries).toMatchObject([{ status: 200, body: { state: "done" } }]);

    expect([...s3.objects.keys()]).toEqual([`public/acme/shop/${SHA}/${VERSION}.json.gz`]);
    const [row] = await t.db.select().from(analyses);
    expect(row).toMatchObject({ status: "done", sha: SHA, analyzerVersion: VERSION });
    expect(github.requests.filter((r) => r.server === "api")[0]?.authorization).toBe(
      "Bearer test-token",
    );

    await worker.stop();
    await worker.stop();
    expect(closes).toBe(1);
    await expect(fetch(`${origin(worker)}/health`)).rejects.toThrow();
    expect(events(lines)).toEqual([
      "worker_starting",
      "startup_sweep",
      "worker_ready",
      "job_done",
      "worker_stopping",
      "worker_stopped",
    ]);
  });

  it("counts its startup (with the shutdown's allowance) and each push in the month's compute", async () => {
    const worker = await start({ uptimeMs: () => 2_345 });
    expect(await computeUsageThisMonth(t.db)).toMatchObject({
      instanceMs: 2_400 + 10_000,
      runRequests: 0,
      taskOperations: 0,
    });
    await pushTask(fakeTask(origin(worker), JOB, SECRET));
    await fetch(`${origin(worker)}/health`);
    const usage = await computeUsageThisMonth(t.db);
    expect(usage).toMatchObject({ runRequests: 1, taskOperations: 1 });
    expect(usage.instanceMs).toBeGreaterThanOrEqual(12_500);
  });

  it("cancels the running job on shutdown: its push gets 503 and its row is queued again", async () => {
    let started: () => void = () => undefined;
    const jobRunning = new Promise<void>((resolve) => (started = resolve));
    const run: NonNullable<JobDeps["run"]> = async (_job, options) => {
      started();
      await new Promise((resolve) => options.signal?.addEventListener("abort", resolve));
      return { ok: false, code: "CANCELLED", message: "", stderrTail: "", durationMs: 1 };
    };
    const worker = await start({ jobDeps: { run } });
    const deliveries = pushTask(fakeTask(origin(worker), JOB, SECRET), 1);
    await jobRunning;

    await worker.stop();
    expect(await deliveries).toEqual([{ status: 503, body: { error: "CANCELLED" } }]);
    expect(await t.db.select().from(analyses)).toMatchObject([{ status: "queued" }]);
    expect(closes).toBe(1);
    expect(s3.objects.size).toBe(0);
  });

  it("sweeps leftover folders and long-running rows, but not another instance's live job", async () => {
    const stale = await runningRow();
    await t.db
      .update(analyses)
      .set({ startedAt: new Date(Date.now() - (INTERRUPTED_AFTER_SECONDS + 5) * 1000) });
    const live = await runningRow("f".repeat(40));
    await mkdir(join(root, "jobs", "analyze-x-abc", "src"), { recursive: true });
    await writeFile(join(root, "jobs", "analyze-x-abc", "src", "a.ts"), "x");

    await start();

    expect(await readdir(join(root, "jobs"))).toEqual([]);
    const rows = await t.db.select().from(analyses);
    expect(rows.find((row) => row.id === stale)).toMatchObject({
      status: "failed",
      errorCode: "JOB_INTERRUPTED",
    });
    expect(rows.find((row) => row.id === live)).toMatchObject({ status: "running" });
    expect(parse(lines)).toMatchObject([
      { event: "worker_starting", analyzerVersion: VERSION, githubToken: true },
      { event: "startup_sweep", folders: 1, interrupted: 1 },
      { event: "worker_ready", host: "127.0.0.1" },
    ]);
  });

  it("never logs a secret or connection string", async () => {
    const worker = await start({}, { githubToken: "gh-secret-token" });
    await pushTask(fakeTask(origin(worker), JOB, SECRET));
    await worker.stop();
    const text = lines.join("\n");
    for (const secret of [SECRET, "gh-secret-token", "postgres://", "secretAccessKey"]) {
      expect(text).not.toContain(secret);
    }
    expect(parse(lines)[0]).toMatchObject({ githubToken: true });
  });

  it("fails and closes the database when the sweep fails", async () => {
    await writeFile(join(root, "jobs"), "a file, not a folder");
    await expect(startWorkerProcess(config(), { log, openDb })).rejects.toThrow();
    expect(closes).toBe(1);
    expect(events(lines)).toEqual(["worker_starting"]);
  });

  it("closes maintenance and the database when the port is taken", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = taken.address() as { port: number };
      await expect(
        startWorkerProcess(config({ port }), { log, openDb, maintenance: {} }),
      ).rejects.toThrow(/EADDRINUSE/);
      expect(closes).toBe(1);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  it("runs no maintenance at startup, only after a job, and then once an hour", async () => {
    s3.objects.set("public/x", { body: Buffer.alloc(9), headers: {}, lastModified: new Date() });
    const worker = await start({ maintenance: {} });
    expect(events(lines)).toEqual(["worker_starting", "startup_sweep", "worker_ready"]);
    // Since the start: a row whose instance died, and one no task will ever run.
    const dead = await runningRow("e".repeat(40));
    await t.db
      .update(analyses)
      .set({ startedAt: new Date(Date.now() - (INTERRUPTED_AFTER_SECONDS + 5) * 1000) });
    const { id: repoId } = await upsertRepo(t.db, {
      providerRepoId: 43,
      owner: "acme",
      name: "other",
      visibility: "public",
      defaultBranch: "main",
    });
    const { id: stranded } = await queueAnalysis(t.db, {
      repoId,
      sha: "c".repeat(40),
      analyzerVersion: VERSION,
    });
    await t.db
      .update(analyses)
      .set({ queuedAt: new Date(Date.now() - (STALE_QUEUED_AFTER_SECONDS + 5) * 1000) });

    const deliveries = await pushTask(fakeTask(origin(worker), JOB, SECRET));
    expect(deliveries).toMatchObject([{ status: 200, body: { state: "done" } }]);
    // Answered only after the run: its lines are all in by now.
    expect(events(lines).slice(3)).toEqual([
      "job_done",
      "maintenance_started",
      "stale_jobs_failed",
      "retention_run",
      "rate_limits_pruned",
      "quota",
    ]);
    expect(parse(lines).find((line) => line.event === "stale_jobs_failed")).toMatchObject({
      interrupted: 1,
      stranded: 1,
    });
    const rows = await t.db.select().from(analyses);
    expect(rows.find((row) => row.id === dead)).toMatchObject({
      status: "failed",
      errorCode: "JOB_INTERRUPTED",
    });
    expect(rows.find((row) => row.id === stranded)).toMatchObject({
      status: "failed",
      errorCode: "QUEUE_UNAVAILABLE",
    });
    expect(rows.find((row) => row.sha === SHA)).toMatchObject({ status: "done" });
    const quota = parse(lines).find((line) => line.event === "quota");
    expect(quota).toMatchObject({
      quotas: [
        { resource: "bucket" },
        { resource: "database" },
        { resource: "requests", bySource: { web: 0 } },
        { resource: "cloud_run_vcpu" },
        { resource: "cloud_run_memory" },
        { resource: "cloud_run_requests" },
        { resource: "cloud_tasks" },
      ],
    });
    // The worker's store is counted: the job's upload, retention's and the quota's listings.
    const [, , requests] = (quota as { quotas: { used: number }[] }).quotas;
    expect(requests?.used).toBeGreaterThanOrEqual(3);

    // Within the hour, the next job's end (here or on another instance) runs nothing.
    const other = { ...JOB, sha: "d".repeat(40) };
    await pushTask(fakeTask(origin(worker), other, SECRET));
    await worker.stop();
    expect(events(lines).slice(9)).toEqual(["job_done", "worker_stopping", "worker_stopped"]);
    expect(await t.db.select().from(maintenanceRuns)).toMatchObject([{ name: "hourly" }]);
  });
});
