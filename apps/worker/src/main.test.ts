import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  analyses,
  computeUsage,
  computeUsageThisMonth,
  installations,
  maintenanceRuns,
  pullRequests,
  queueAnalysis,
  queuePullRequestDiff,
  recordPullRequestHead,
  repos,
  startAnalysis,
  upsertInstallation,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "./config.js";
import { startFakeGitHub, tarballFrom, type FakeGitHub } from "./github.testkit.js";
import {
  derivedSecret,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  TOKEN_REQUEST_PURPOSE,
  verifyRequest,
} from "./hmac.js";
import { jobIdFor } from "./request.js";
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

  it("logs the database's own reason under a wrapped failure, never the connection string", async () => {
    // Drizzle's error says only "Failed query: …"; the reason is on its `cause` (planning #17).
    const reason = Object.assign(new Error('relation "analyses" does not exist'), {
      code: "42P01",
    });
    const query = new Error('Failed query: update "analyses" set …', { cause: reason });
    const { io, main } = fakeIo({
      env: { ...ENV, DATABASE_URL_UNPOOLED: "postgres://user:pw-secret@direct.example/db" },
      start: async () => {
        throw new Error("migrations failed", { cause: query });
      },
    });
    await runMain(main);
    expect(io.exits).toEqual([1]);
    expect(parse(io.lines)).toEqual([
      {
        time: expect.any(String),
        event: "startup_failed",
        message: "migrations failed",
        causes: [
          { message: 'Failed query: update "analyses" set …' },
          { message: 'relation "analyses" does not exist', code: "42P01" },
        ],
      },
    ]);
    expect(io.lines.join("")).not.toContain("pw-secret");
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
    expect(seen?.migrationUrl).toBe(ENV.DATABASE_URL);
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
    migrated = [];
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
  // The test database is migrated already; this records where startup would migrate.
  let migrated: string[] = [];
  const migrate = async (url: string) => void migrated.push(url);
  const openDb = () => ({
    db: t.db,
    close: async () => {
      closes++;
    },
  });

  function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
    return {
      databaseUrl: "postgres://unused",
      migrationUrl: "postgres://direct-unused",
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
      migrate,
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

  it("deletes cached facts of repos the database no longer links before a job (M8.5b2)", async () => {
    // A repo removed from installation 41 while this instance held its facts.
    const stale = join(
      root,
      "cache",
      "installations",
      "41",
      "0b3c3f0e-7d6a-4a51-9c3e-2f1d8e5b6a01",
    );
    await mkdir(join(stale, "entries"), { recursive: true });
    const worker = await start();
    const deliveries = await pushTask(fakeTask(origin(worker), JOB, SECRET));
    expect(deliveries).toMatchObject([{ status: 200, body: { state: "done" } }]);
    expect(await readdir(join(root, "cache"))).toEqual(["installations", "public"]);
    expect(await readdir(join(root, "cache", "installations"))).toEqual([]);
  });

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
      "migrations_applied",
      "startup_sweep",
      "worker_ready",
      "job_done",
      "worker_stopping",
      "worker_stopped",
    ]);
  });

  it("counts its startup (with the shutdown's allowance) and each push in the month's compute", async () => {
    // Counted when the database opens (1,234 ms in) and the rest once listening (1,111 ms more).
    const ages = [1_234, 2_345];
    const worker = await start({ uptimeMs: () => ages.shift() ?? 9_999 });
    expect(ages).toEqual([]);
    expect(await computeUsageThisMonth(t.db)).toMatchObject({
      instanceMs: 1_300 + 10_000 + 1_200,
      runRequests: 0,
      taskOperations: 0,
      secretAccesses: 4,
    });
    await pushTask(fakeTask(origin(worker), JOB, SECRET));
    await fetch(`${origin(worker)}/health`);
    const usage = await computeUsageThisMonth(t.db);
    expect(usage).toMatchObject({ runRequests: 1, taskOperations: 1, secretAccesses: 4 });
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
      { event: "migrations_applied", ms: expect.any(Number) },
      { event: "startup_sweep", folders: 1, interrupted: 1 },
      { event: "worker_ready", host: "127.0.0.1" },
    ]);
  });

  it("reads a private job with the token the website mints for it, and never the worker's own", async () => {
    await t.db.delete(installations);
    await upsertInstallation(t.db, {
      githubInstallationId: 42,
      accountId: 9001,
      accountLogin: "acme",
      accountType: "Organization",
      suspendedAt: null,
    });
    const asks: { body: string; verified: boolean }[] = [];
    const website = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const verified = verifyRequest(
          [derivedSecret(SECRET, TOKEN_REQUEST_PURPOSE)],
          { method: req.method ?? "", path: req.url ?? "", body },
          { timestamp: req.headers[TIMESTAMP_HEADER], signature: req.headers[SIGNATURE_HEADER] },
        ).ok;
        asks.push({ body: body.toString(), verified });
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ token: "ghs_installation", expiresAt: "2026-11-07T13:00:00Z" }));
      });
    });
    await new Promise<void>((resolve) => website.listen(0, "127.0.0.1", resolve));
    const tarball = github.api;
    github.api = (req, res) => {
      if (req.url !== "/repos/acme/shop") return tarball(req, res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: 3_000_000_001,
          name: "shop",
          owner: { login: "acme" },
          private: true,
          default_branch: "main",
        }),
      );
    };
    const children: string[] = [];
    try {
      const port = (website.address() as AddressInfo).port;
      const worker = await start(
        {
          jobDeps: {
            run: async (job, options) => {
              children.push(JSON.stringify({ job, options }));
              return writeGraph(job, options);
            },
          },
        },
        { websiteOrigin: `http://127.0.0.1:${port}` },
      );
      const job = { ...JOB, kind: "analyze" as const, installationId: 42 };
      // What the website writes before the task: the repo linked, its row queued (M8.5b1).
      const { id: repoId } = await upsertRepo(t.db, {
        providerRepoId: 3_000_000_001,
        owner: "acme",
        name: "shop",
        visibility: "private",
        defaultBranch: "main",
        githubInstallationId: 42,
      });
      await queueAnalysis(
        t.db,
        { repoId, sha: SHA, analyzerVersion: VERSION },
        { jobId: jobIdFor(job, VERSION) },
      );
      const deliveries = await pushTask(fakeTask(origin(worker), job, SECRET));
      expect(deliveries).toMatchObject([{ status: 200, body: { state: "done" } }]);

      expect(asks).toHaveLength(1);
      expect(asks[0]?.verified).toBe(true);
      expect(JSON.parse(asks[0]!.body)).toEqual({
        jobId: expect.stringMatching(/^analyze-[0-9a-f]{32}$/) as string,
        installationId: 42,
      });
      // The facts and the tarball with the installation's token; codeload with none.
      expect(github.requests.map((r) => [r.server, r.authorization])).toEqual([
        ["api", "Bearer ghs_installation"],
        ["api", "Bearer ghs_installation"],
        ["codeload", undefined],
      ]);
      expect(children).toHaveLength(1);
      expect(children[0]).not.toContain("ghs_installation");
      expect(lines.join("\n")).not.toContain("ghs_installation");
      const [row] = await t.db.select().from(analyses);
      expect(row).toMatchObject({ status: "done" });
    } finally {
      website.closeAllConnections();
      await new Promise<void>((resolve) => website.close(() => resolve()));
    }
  });

  it("takes a pushed diff task to a stored diff on the pull request's record (ADR-0245)", async () => {
    await t.db.delete(installations);
    await upsertInstallation(t.db, {
      githubInstallationId: 42,
      accountId: 9001,
      accountLogin: "acme",
      accountType: "Organization",
      suspendedAt: null,
    });
    const website = createHttpServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ token: "ghs_installation", expiresAt: "2026-11-08T13:00:00Z" }));
      });
    });
    await new Promise<void>((resolve) => website.listen(0, "127.0.0.1", resolve));
    const base = "b".repeat(40);
    const mergeBase = "a".repeat(40);
    const tarball = github.api;
    github.api = (req, res) => {
      if (!(req.url ?? "").includes("/compare/")) return tarball(req, res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ merge_base_commit: { sha: mergeBase } }));
    };
    const graph = await readFile(
      fileURLToPath(new URL("../../../fixtures/express-basic/expected.json", import.meta.url)),
    );
    const shas: (string | undefined)[] = [];
    try {
      const port = (website.address() as AddressInfo).port;
      const worker = await start(
        {
          jobDeps: {
            run: async (job): Promise<RunResult> => {
              shas.push(job.sha);
              await writeFile(job.out, graph);
              return { ok: true, stats: STATS, durationMs: 1 };
            },
          },
        },
        { websiteOrigin: `http://127.0.0.1:${port}` },
      );
      const job = { kind: "diff" as const, owner: "acme", repo: "shop", sha: SHA, baseSha: base };
      const jobId = jobIdFor({ ...job, installationId: 42 }, VERSION);
      // What the website writes before the task (M8.6d2): the repo linked, the record naming the job.
      const { id: repoId } = await upsertRepo(t.db, {
        providerRepoId: 3_000_000_001,
        owner: "acme",
        name: "shop",
        visibility: "public",
        defaultBranch: "main",
        githubInstallationId: 42,
      });
      const pair = { repoId, number: 7, baseSha: base, headSha: SHA };
      await recordPullRequestHead(t.db, { ...pair, headAt: new Date("2026-11-08T10:00:00Z") });
      await queuePullRequestDiff(t.db, { ...pair, jobId });

      const task = fakeTask(origin(worker), { ...job, installationId: 42 }, SECRET);
      expect(await pushTask(task)).toMatchObject([
        { status: 200, body: { id: jobId, state: "done" } },
      ]);
      expect(shas).toEqual([mergeBase, SHA]);
      const key = `private/42/${repoId}/diffs/${mergeBase}-${SHA}/${VERSION}.json.gz`;
      expect([...s3.objects.keys()]).toEqual([key]);
      const [record] = await t.db.select().from(pullRequests);
      expect(record).toMatchObject({ diffKey: key, brokenCount: 0, diffJobId: jobId });
      expect(await t.db.select().from(analyses)).toEqual([]);
      expect(parse(lines).find((line) => line.event === "job_done")).toMatchObject({
        mergeBase,
        broken: 0,
        pullRequests: 1,
      });

      // A duplicate push finds every record diffed and does nothing.
      expect(await pushTask(task)).toMatchObject([{ status: 200, body: { state: "done" } }]);
      expect(shas).toHaveLength(2);
    } finally {
      website.closeAllConnections();
      await new Promise<void>((resolve) => website.close(() => resolve()));
    }
  });

  it("fails a private job for good, naming it on the row, when the installation is suspended", async () => {
    const website = createHttpServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(403, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "INSTALLATION_SUSPENDED" }));
      });
    });
    await new Promise<void>((resolve) => website.listen(0, "127.0.0.1", resolve));
    try {
      const port = (website.address() as AddressInfo).port;
      const worker = await start({}, { websiteOrigin: `http://127.0.0.1:${port}` });
      const job = { ...JOB, kind: "analyze" as const, installationId: 42 };
      const task = fakeTask(origin(worker), job, SECRET);
      const { id: repoId } = await upsertRepo(t.db, {
        providerRepoId: 3_000_000_001,
        owner: "acme",
        name: "shop",
        visibility: "private",
        defaultBranch: "main",
      });
      await queueAnalysis(
        t.db,
        { repoId, sha: SHA, analyzerVersion: VERSION },
        { jobId: jobIdFor(job, VERSION) },
      );
      const deliveries = await pushTask(task);
      // Permanent: answered so Cloud Tasks doesn't try again.
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.body).toMatchObject({
        state: "failed",
        errorCode: "INSTALLATION_SUSPENDED",
      });
      expect(github.requests).toEqual([]);
      const [row] = await t.db.select().from(analyses);
      expect(row).toMatchObject({ status: "failed", errorCode: "INSTALLATION_SUSPENDED" });
    } finally {
      website.closeAllConnections();
      await new Promise<void>((resolve) => website.close(() => resolve()));
    }
  });

  it("fails a private job as TOKEN_UNCONFIGURED without a website origin", async () => {
    const worker = await start();
    const deliveries = await pushTask(
      fakeTask(origin(worker), { ...JOB, installationId: 42 }, SECRET),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.body).toMatchObject({ state: "failed", errorCode: "TOKEN_UNCONFIGURED" });
    expect(github.requests).toEqual([]);
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
    const ages = [1_234, 2_345];
    await expect(
      startWorkerProcess(config(), { log, openDb, migrate, uptimeMs: () => ages.shift() ?? 0 }),
    ).rejects.toThrow();
    expect(closes).toBe(1);
    expect(events(lines)).toEqual(["worker_starting", "migrations_applied"]);
    // Cloud Run read the secrets before the process began, and bills a failed start's time
    // and shutdown too (R13, M5.14b4); it will start another instance, reading them again.
    expect(await computeUsageThisMonth(t.db)).toMatchObject({
      instanceMs: 1_300 + 10_000 + 1_200,
      secretAccesses: 4,
    });
  });

  it("migrates through the direct URL before anything else touches the database", async () => {
    const order: string[] = [];
    await start({
      migrate: async (url) => void order.push(`migrate ${url}`),
      openDb: (url) => {
        order.push(`open ${url}`);
        return openDb();
      },
    });
    expect(order).toEqual(["migrate postgres://direct-unused", "open postgres://unused"]);
  });

  it("fails before opening the pool when the migrations fail, keeping the database's reason", async () => {
    // What production's empty Neon database gave (planning #17), now one step earlier.
    const reason = Object.assign(new Error('relation "analyses" does not exist'), {
      code: "42P01",
    });
    const failure = await startWorkerProcess(config(), {
      log,
      openDb,
      migrate: async () => {
        throw new Error("Failed query: create table …", { cause: reason });
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ message: "migrations failed" });
    expect(closes).toBe(0);
    expect(events(lines)).toEqual(["worker_starting"]);
  });
  it("closes maintenance and the database when the port is taken", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = taken.address() as { port: number };
      await expect(
        startWorkerProcess(config({ port }), { log, openDb, migrate, maintenance: {} }),
      ).rejects.toThrow(/EADDRINUSE/);
      expect(closes).toBe(1);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  it("runs no maintenance at startup, only after a job, and then once an hour", async () => {
    s3.objects.set("public/x", { body: Buffer.alloc(9), headers: {}, lastModified: new Date() });
    const worker = await start({ maintenance: {} });
    expect(events(lines)).toEqual([
      "worker_starting",
      "migrations_applied",
      "startup_sweep",
      "worker_ready",
    ]);
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
    expect(events(lines).slice(4)).toEqual([
      "job_done",
      "maintenance_started",
      "stale_jobs_failed",
      "retention_run",
      "rate_limits_pruned",
      "sessions_swept",
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
        { resource: "secret_manager", used: 4 },
      ],
    });
    // The worker's store is counted: the job's upload, retention's and the quota's listings.
    const [, , requests] = (quota as { quotas: { used: number }[] }).quotas;
    expect(requests?.used).toBeGreaterThanOrEqual(3);

    // Within the hour, the next job's end (here or on another instance) runs nothing.
    const other = { ...JOB, sha: "d".repeat(40) };
    await pushTask(fakeTask(origin(worker), other, SECRET));
    await worker.stop();
    expect(events(lines).slice(11)).toEqual(["job_done", "worker_stopping", "worker_stopped"]);
    expect(await t.db.select().from(maintenanceRuns)).toMatchObject([{ name: "hourly" }]);
  });
});
