import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { analyses, repos, startAnalysis, upsertRepo } from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "./config.js";
import { startFakeGitHub, tarballFrom, type FakeGitHub } from "./github.testkit.js";
import { signRequest } from "./hmac.js";
import {
  SHUTDOWN_SIGNALS,
  runMain,
  startWorkerProcess,
  type MainIo,
  type RunningWorker,
  type StartOptions,
} from "./main.js";
import { QUEUE_NAME, createBullJobQueue } from "./queue.js";
import { RETENTION_POLICY, runRetention } from "./retention.js";
import type { RunResult } from "./runner.js";
import { startFakeS3, type FakeS3 } from "./s3.testkit.js";
import { createObjectStore } from "./storage.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "s".repeat(43);
const VERSION = "0.1.0";
const REDIS_URL = process.env.TEST_REDIS_URL;
const GRAPH = '{"nodes":[]}\n';
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
  REDIS_URL: "redis://127.0.0.1:6379",
  DATABASE_URL: "postgres://127.0.0.1/gitinside",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "key-id",
  R2_SECRET_ACCESS_KEY: "key-secret",
  R2_BUCKET: "gitinside-snapshots",
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
    const { io, main } = fakeIo({ env: { ...ENV, REDIS_URL: "", PORT: "x" } });
    expect(await runMain(main)).toBeUndefined();
    expect(io.exits).toEqual([1]);
    expect(parse(io.lines)).toEqual([
      {
        time: expect.any(String),
        event: "config_invalid",
        problems: ["REDIS_URL is not set", "PORT must be 1–65535"],
      },
    ]);
    expect(io.handler).toBeUndefined();
  });

  it("exits 1 when the start fails", async () => {
    const { io, main } = fakeIo({
      start: async () => {
        throw new Error("queue call took over 5000 ms");
      },
    });
    expect(await runMain(main)).toBeUndefined();
    expect(io.exits).toEqual([1]);
    expect(parse(io.lines)).toMatchObject([
      { event: "startup_failed", message: "queue call took over 5000 ms" },
    ]);
  });

  it("passes the config and a JSON log to the start", async () => {
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
    expect(seen?.redisUrl).toBe(ENV.REDIS_URL);
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
      { event: "config_invalid", problems: expect.arrayContaining(["REDIS_URL is not set"]) },
    ]);
  });
});

describe("startWorkerProcess", () => {
  let t: TestDb;
  let root: string;
  let lines: string[];
  let closes: number;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    await t.db.delete(analyses);
    await t.db.delete(repos);
    root = await mkdtemp(join(tmpdir(), "gitinside-main-"));
    lines = [];
    closes = 0;
  });
  afterEach(async () => {
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
      redisUrl: "redis://127.0.0.1:1",
      databaseUrl: "postgres://unused",
      store: {
        endpoint: "http://127.0.0.1:1",
        bucket: "gitinside-snapshots",
        credentials: { accessKeyId: "a", secretAccessKey: "b" },
      },
      secrets: [SECRET],
      jobsRoot: join(root, "jobs"),
      host: "127.0.0.1",
      port: 0,
      ...overrides,
    };
  }

  async function runningRow(): Promise<string> {
    const { id: repoId } = await upsertRepo(t.db, {
      providerRepoId: 42,
      owner: "acme",
      name: "shop",
      visibility: "public",
      defaultBranch: "main",
    });
    const { id } = await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: VERSION });
    return id;
  }

  it("sweeps first, then fails and closes everything when Redis doesn't answer", async () => {
    const id = await runningRow();
    await mkdir(join(root, "jobs", "analyze-x-abc", "src"), { recursive: true });
    await writeFile(join(root, "jobs", "analyze-x-abc", "src", "a.ts"), "x");

    await expect(
      startWorkerProcess(config(), { log, openDb, queueCallTimeoutMs: 300 }),
    ).rejects.toThrow(/300 ms/);

    expect(await readdir(join(root, "jobs"))).toEqual([]);
    expect(await t.db.select().from(analyses)).toMatchObject([
      { id, status: "failed", errorCode: "JOB_INTERRUPTED" },
    ]);
    expect(closes).toBe(1);
    expect(parse(lines)).toMatchObject([
      { event: "worker_starting", analyzerVersion: VERSION, concurrency: 2, githubToken: false },
      { event: "startup_sweep", folders: 1, interrupted: 1 },
    ]);
  });

  it("never logs a secret or connection string", async () => {
    await expect(
      startWorkerProcess(config({ githubToken: "gh-secret-token" }), {
        log,
        openDb,
        queueCallTimeoutMs: 300,
      }),
    ).rejects.toThrow();
    const text = lines.join("\n");
    for (const secret of [
      SECRET,
      "gh-secret-token",
      "redis://",
      "postgres://",
      "secretAccessKey",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(parse(lines)[0]).toMatchObject({ githubToken: true });
  });

  it("fails before touching Redis when the sweep fails", async () => {
    await writeFile(join(root, "jobs"), "a file, not a folder");
    await expect(startWorkerProcess(config(), { log, openDb })).rejects.toThrow();
    expect(closes).toBe(1);
    expect(events(lines)).toEqual(["worker_starting"]);
  });

  describe.runIf(REDIS_URL !== undefined)("with Redis", () => {
    let github: FakeGitHub;
    let s3: FakeS3;
    let prefix: string;
    const running: RunningWorker[] = [];

    beforeEach(async () => {
      prefix = `gi-test-${randomBytes(6).toString("hex")}`;
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
      const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL ?? "" }, prefix });
      await queue.obliterate({ force: true });
      await queue.close();
      await github.close();
      await s3.close();
    });

    async function start(maintenance?: StartOptions["maintenance"]): Promise<RunningWorker> {
      const worker = await startWorkerProcess(
        config({
          redisUrl: REDIS_URL ?? "",
          store: { endpoint: s3.endpoint, bucket: s3.bucket, credentials: s3.credentials },
          githubToken: "test-token",
        }),
        {
          log,
          openDb,
          prefix,
          analyzerVersion: VERSION,
          github: { apiBase: github.apiBase, downloadOrigins: [github.codeloadOrigin] },
          jobDeps: {
            run: async (job): Promise<RunResult> => {
              await writeFile(job.out, GRAPH);
              return { ok: true, stats: STATS, durationMs: 1 };
            },
          },
          ...(maintenance === undefined ? {} : { maintenance }),
        },
      );
      running.push(worker);
      return worker;
    }

    async function api(worker: RunningWorker, method: "GET" | "POST", path: string, body = "") {
      const headers = signRequest(SECRET, { method, path, body: Buffer.from(body) });
      const response = await fetch(`http://127.0.0.1:${worker.address.port}${path}`, {
        method,
        headers: { ...headers, ...(body === "" ? {} : { "content-type": "application/json" }) },
        ...(body === "" ? {} : { body }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }

    it("takes a signed job through the queue to R2 and Postgres, then stops cleanly", async () => {
      const worker = await start();
      expect((await fetch(`http://127.0.0.1:${worker.address.port}/health`)).status).toBe(200);

      const body = JSON.stringify({ kind: "analyze", owner: "acme", repo: "shop", sha: SHA });
      const enqueued = await api(worker, "POST", "/enqueue", body);
      expect(enqueued).toMatchObject({ status: 202, body: { created: true } });
      const jobPath = `/jobs/${enqueued.body.id as string}`;

      const end = Date.now() + 15_000;
      let state: unknown;
      while ((state = (await api(worker, "GET", jobPath)).body.state) !== "done") {
        if (state === "failed" || Date.now() > end) throw new Error(`job ended ${String(state)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect([...s3.objects.keys()]).toEqual([`public/acme/shop/${SHA}/${VERSION}.json.gz`]);
      const [row] = await t.db.select().from(analyses);
      expect(row).toMatchObject({ status: "done", sha: SHA, analyzerVersion: VERSION });
      expect(github.requests.filter((r) => r.server === "api")[0]?.authorization).toBe(
        "Bearer test-token",
      );

      await worker.stop();
      await worker.stop();
      expect(closes).toBe(1);
      await expect(fetch(`http://127.0.0.1:${worker.address.port}/health`)).rejects.toThrow();
      expect(events(lines)).toEqual([
        "worker_starting",
        "startup_sweep",
        "worker_ready",
        "job_done",
        "worker_stopping",
        "worker_stopped",
      ]);
    });

    it("analyzes a commit again once retention evicted it, instead of answering its old job", async () => {
      const worker = await start();
      const body = JSON.stringify({ kind: "analyze", owner: "acme", repo: "shop", sha: SHA });
      const waitForDone = async (path: string) => {
        const end = Date.now() + 15_000;
        let state: unknown;
        while ((state = (await api(worker, "GET", path)).body.state) !== "done") {
          if (state === "failed" || Date.now() > end) throw new Error(`job ended ${String(state)}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      const first = await api(worker, "POST", "/enqueue", body);
      await waitForDone(`/jobs/${first.body.id as string}`);

      const queue = createBullJobQueue({ connection: { url: REDIS_URL ?? "" }, prefix });
      try {
        const report = await runRetention({
          db: t.db,
          store: createObjectStore({
            endpoint: s3.endpoint,
            bucket: s3.bucket,
            credentials: s3.credentials,
          }),
          jobs: queue,
          policy: { ...RETENTION_POLICY, keepPerRepo: 0 },
        });
        expect(report).toMatchObject({ deletedObjects: 1, removedJobs: 1, failedJobRemovals: 0 });
      } finally {
        await queue.close();
      }
      expect(await t.db.select().from(analyses)).toEqual([]);

      const again = await api(worker, "POST", "/enqueue", body);
      expect(again).toMatchObject({ status: 202, body: { id: first.body.id, created: true } });
      await waitForDone(`/jobs/${first.body.id as string}`);
      expect(await t.db.select().from(analyses)).toHaveLength(1);
      expect(s3.objects.size).toBe(1);
    });

    it("runs maintenance on its schedule against the same database and bucket", async () => {
      s3.objects.set("public/x", { body: Buffer.alloc(9), headers: {}, lastModified: new Date() });
      const worker = await start({ firstDelayMs: 1, intervalMs: 60_000 });
      const end = Date.now() + 10_000;
      while (!events(lines).includes("quota")) {
        if (Date.now() > end) throw new Error("no maintenance run");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await worker.stop();
      expect(events(lines)).toEqual([
        "worker_starting",
        "startup_sweep",
        "worker_ready",
        "retention_run",
        "rate_limits_pruned",
        "quota",
        "worker_stopping",
        "worker_stopped",
      ]);
      expect(parse(lines).find((line) => line.event === "quota")).toMatchObject({
        quotas: [{ resource: "bucket", usedBytes: 9 }, { resource: "database" }],
      });
    });

    it("closes the worker and queue when the port is taken", async () => {
      const first = await start();
      await expect(
        startWorkerProcess(config({ redisUrl: REDIS_URL ?? "", port: first.address.port }), {
          log,
          openDb,
          prefix,
        }),
      ).rejects.toThrow(/EADDRINUSE/);
      expect(closes).toBe(1);
    });
  });
});
