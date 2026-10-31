import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnrecoverableError, type Job, type Worker } from "bullmq";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEnqueueHandler, jobIdFor, type JobRequest } from "./api.js";
import { startFakeGitHub, tarballFrom, type FakeGitHub } from "./github.testkit.js";
import { signRequest } from "./hmac.js";
import type { JobDeps, JobOutcome } from "./job.js";
import {
  JOB_OPTIONS,
  MAX_STALLED_COUNT,
  WORKER_CONCURRENCY,
  createAnalysisWorker,
  createBullJobQueue,
  createProcessor,
  errorCodeFor,
  progressForStep,
  statusFromJob,
  stopWorker,
  type BullJobQueue,
} from "./queue.js";
import type { RunResult } from "./runner.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REQUEST: JobRequest = { kind: "analyze", owner: "acme", repo: "shop", sha: SHA };
const STATS = {
  files: 1,
  nodes: 3,
  edges: 2,
  unresolved: 0,
  warnings: 0,
  graphBytes: 2,
  stageMs: {},
};
const REDIS_URL = process.env.TEST_REDIS_URL;

let github: FakeGitHub;
let root: string;

beforeAll(async () => {
  github = await startFakeGitHub(tarballFrom([{ name: "index.ts", body: "export {};\n" }]));
});

afterAll(async () => {
  await github.close();
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gitinside-queue-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeGraph = async (job: { out: string }): Promise<RunResult> => {
  await writeFile(job.out, "{}");
  return { ok: true, stats: STATS, durationMs: 1 };
};

/** Job deps against the fake GitHub; `run` defaults to writing a tiny graph. */
function deps(run: JobDeps["run"] = writeGraph): JobDeps {
  return {
    jobsRoot: join(root, "jobs"),
    publish: async () => undefined,
    download: { apiBase: github.apiBase, downloadOrigins: [github.codeloadOrigin] },
    run,
  };
}

const sha = (n: number): string => n.toString(16).padStart(40, "0");

describe("statusFromJob", () => {
  const job = { id: "analyze-1", kind: "analyze" as const, progress: 0 };

  it("shows waiting jobs as queued with their position", () => {
    expect(statusFromJob({ ...job, state: "waiting", position: 3 })).toEqual({
      id: "analyze-1",
      kind: "analyze",
      state: "queued",
      position: 3,
    });
  });

  it.each(["delayed", "prioritized", "waiting-children"])(
    "shows %s jobs as queued without a position",
    (state) => {
      expect(statusFromJob({ ...job, state, position: 3 })).toEqual({
        id: "analyze-1",
        kind: "analyze",
        state: "queued",
      });
    },
  );

  it("shows an active job's stage and progress", () => {
    expect(
      statusFromJob({ ...job, state: "active", progress: { stage: "analyze", progress: 30 } }),
    ).toEqual({
      id: "analyze-1",
      kind: "analyze",
      state: "running",
      stage: "analyze",
      progress: 30,
    });
  });

  it("shows the analyzer's step and count, and nothing else stored with them", () => {
    const progress = { ...progressForStep({ step: "programs", count: 1204 }), extra: "x" };
    expect(statusFromJob({ ...job, state: "active", progress })).toEqual({
      id: "analyze-1",
      kind: "analyze",
      state: "running",
      stage: "analyze",
      progress: 38,
      step: "programs",
      count: 1204,
    });
    expect(
      statusFromJob({ ...job, state: "active", progress: progressForStep({ step: "calls" }) }),
    ).toEqual({
      id: "analyze-1",
      kind: "analyze",
      state: "running",
      stage: "analyze",
      progress: 70,
      step: "calls",
    });
  });

  it("shows what was found, while saving the diagram too", () => {
    const found = { services: { count: 1, names: ["app"] }, routes: 4, pages: 0 };
    expect(
      statusFromJob({
        ...job,
        state: "active",
        progress: { stage: "upload", progress: 90, found },
      }),
    ).toEqual({
      id: "analyze-1",
      kind: "analyze",
      state: "running",
      stage: "upload",
      progress: 90,
      found,
    });
  });

  it.each([
    0,
    { stage: "hacking", progress: 30 },
    { stage: "analyze", progress: 101 },
    { stage: "analyze", progress: 1.5 },
    { stage: "analyze", progress: -1 },
    { stage: "toString", progress: 1 },
    { stage: "analyze", progress: 40, step: "hacking" },
    { stage: "upload", progress: 90, step: "programs" },
    { stage: "analyze", progress: 40, step: "programs", count: -1 },
    { stage: "analyze", progress: 40, step: "programs", count: "1" },
    { stage: "analyze", progress: 40, count: 3 },
    { stage: "analyze", progress: 40, found: { routes: -1 } },
    { stage: "analyze", progress: 40, found: { services: { count: 1, names: ["a‮b"] } } },
    null,
  ])("ignores progress that isn't ours: %j", (progress) => {
    expect(statusFromJob({ ...job, state: "active", progress })).toEqual({
      id: "analyze-1",
      kind: "analyze",
      state: "running",
    });
  });

  it("shows done and failed jobs", () => {
    expect(statusFromJob({ ...job, state: "completed" })?.state).toBe("done");
    expect(statusFromJob({ ...job, state: "failed", failedReason: "LIMIT_FILES" })).toEqual({
      id: "analyze-1",
      kind: "analyze",
      state: "failed",
      errorCode: "LIMIT_FILES",
    });
  });

  it("has nothing to say about unknown jobs", () => {
    expect(statusFromJob({ ...job, state: "unknown" })).toBeUndefined();
  });
});

describe("errorCodeFor", () => {
  it.each([
    ["LIMIT_TIME", "LIMIT_TIME"],
    ["job stalled more than allowable limit", "JOB_STALLED"],
    ["Cannot read properties of undefined", "WORKER_ERROR"],
    ["", "WORKER_ERROR"],
    [undefined, "WORKER_ERROR"],
  ])("%j ⇒ %s", (reason, code) => {
    expect(errorCodeFor(reason)).toBe(code);
  });
});

/** A stand-in for the parts of a BullMQ job the processor touches. */
function fakeJob(data: unknown, attemptsMade = 0) {
  const progress: unknown[] = [];
  const job = {
    id: jobIdFor(REQUEST, "0.1.0"),
    data,
    attemptsMade,
    opts: { attempts: JOB_OPTIONS.attempts },
    updateProgress: async (value: unknown) => void progress.push(value),
  };
  return { job: job as unknown as Job<JobRequest, JobOutcome>, progress };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("createProcessor", () => {
  it("takes the abort signal (BullMQ passes it only to 3-parameter processors)", () => {
    expect(createProcessor(deps()).length).toBe(3);
  });

  it("runs the job, reports each stage as progress, and logs the outcome", async () => {
    const logs: Record<string, unknown>[] = [];
    const { job, progress } = fakeJob(REQUEST, 1);
    const outcome = await createProcessor(deps(), (e) => void logs.push(e))(job, "t", undefined);
    expect(outcome.stats).toEqual(STATS);
    expect(progress).toEqual([
      { stage: "download", progress: 0 },
      { stage: "extract", progress: 10 },
      { stage: "analyze", progress: 30 },
      { stage: "upload", progress: 90 },
    ]);
    expect(logs).toEqual([expect.objectContaining({ event: "job_done", id: job.id, attempt: 2 })]);
  });

  it("stores the analyzer's steps as progress between the analyze and upload stages", async () => {
    const { job, progress } = fakeJob(REQUEST);
    const run: JobDeps["run"] = async (child, options) => {
      options.onProgress?.({ step: "programs", count: 12 });
      options.onProgress?.({ step: "http", count: 4 });
      return writeGraph(child);
    };
    await createProcessor(deps(run))(job, "t", undefined);
    expect(progress.slice(2)).toEqual([
      { stage: "analyze", progress: 30 },
      { stage: "analyze", progress: 38, step: "programs", count: 12 },
      { stage: "analyze", progress: 74, step: "http", count: 4 },
      { stage: "upload", progress: 90 },
    ]);
  });

  it("keeps what was found in every later update, the upload stage's too (#8)", async () => {
    const { job, progress } = fakeJob(REQUEST);
    const services = { count: 2, names: ["api", "web"] };
    const run: JobDeps["run"] = async (child, options) => {
      options.onProgress?.({ step: "workspace" });
      options.onFound?.({ services });
      options.onProgress?.({ step: "programs", count: 12 });
      options.onFound?.({ services, routes: 3 });
      return writeGraph(child);
    };
    await createProcessor(deps(run))(job, "t", undefined);
    expect(progress.slice(2)).toEqual([
      { stage: "analyze", progress: 30 },
      { stage: "analyze", progress: 34, step: "workspace" },
      { stage: "analyze", progress: 34, step: "workspace", found: { services } },
      { stage: "analyze", progress: 38, step: "programs", count: 12, found: { services } },
      {
        stage: "analyze",
        progress: 38,
        step: "programs",
        count: 12,
        found: { services, routes: 3 },
      },
      { stage: "upload", progress: 90, found: { services, routes: 3 } },
    ]);
  });

  it("fails permanent failures with UnrecoverableError carrying only the code", async () => {
    const logs: Record<string, unknown>[] = [];
    const run = async (): Promise<RunResult> => ({
      ok: false,
      code: "LIMIT_FILES",
      message: "LIMIT_FILES: too many",
      stderrTail: "stack",
      durationMs: 1,
    });
    const error = await rejection(
      createProcessor(deps(run), (e) => void logs.push(e))(fakeJob(REQUEST).job, "t", undefined),
    );
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe("LIMIT_FILES");
    expect(logs).toEqual([
      expect.objectContaining({
        event: "job_failed",
        code: "LIMIT_FILES",
        retriable: false,
        detail: "stack",
      }),
    ]);
  });

  it("fails retriable failures with a plain Error, so BullMQ retries them", async () => {
    const run = async (): Promise<RunResult> => ({
      ok: false,
      code: "CANCELLED",
      message: "cancelled",
      stderrTail: "",
      durationMs: 1,
    });
    const error = await rejection(createProcessor(deps(run))(fakeJob(REQUEST).job, "t", undefined));
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe("CANCELLED");
  });

  it("refuses stored data that isn't a valid request", async () => {
    const error = await rejection(
      createProcessor(deps())(fakeJob({ ...REQUEST, owner: "-bad" }).job, "t", undefined),
    );
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe("INVALID_REQUEST");
  });

  it("turns unexpected errors into the retriable WORKER_ERROR", async () => {
    const run = async (): Promise<RunResult> => {
      throw new TypeError("boom");
    };
    const logs: Record<string, unknown>[] = [];
    const error = await rejection(
      createProcessor(deps(run), (e) => void logs.push(e))(fakeJob(REQUEST).job, "t", undefined),
    );
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe("WORKER_ERROR");
    expect(logs[0]).toMatchObject({ code: "WORKER_ERROR", detail: "boom" });
  });
});

describe("createBullJobQueue without Redis", () => {
  it("fails calls within its timeout when Redis can't be reached", async () => {
    const queue = createBullJobQueue({
      connection: { host: "127.0.0.1", port: 1, retryStrategy: () => 50 },
      callTimeoutMs: 200,
    });
    try {
      await expect(queue.ping()).rejects.toThrow(/200 ms/);
      await expect(queue.get("analyze-x")).rejects.toThrow(/200 ms/);
      await expect(queue.add("analyze-x", REQUEST)).rejects.toThrow(/200 ms/);
      // One timeout, not one per ID (20 × 200 ms): the rest count as failed at once.
      const ids = Array.from({ length: 20 }, (_, n) => `analyze-${n}`);
      const started = Date.now();
      expect(await queue.removeCompleted(ids)).toEqual({ removed: 0, failed: 20 });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await queue.close();
    }
  });
});

describe("Redis on CI", () => {
  it("is configured, so the BullMQ tests below don't silently skip", () => {
    if (process.env.CI === "true") expect(REDIS_URL).toBeDefined();
  });
});

/** Resolves when `check` returns true, polling every 25 ms; fails after `ms`. */
async function until(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.runIf(REDIS_URL !== undefined)("BullMQ on Redis", () => {
  const connection = { url: REDIS_URL ?? "" };
  let prefix: string;
  let queue: BullJobQueue;
  const workers: Worker[] = [];

  beforeEach(() => {
    prefix = `gi-test-${randomBytes(6).toString("hex")}`;
    queue = createBullJobQueue({
      connection,
      prefix,
      jobOptions: { backoff: { type: "fixed", delay: 10 } },
    });
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close(true);
    await queue.queue.obliterate({ force: true });
    await queue.close();
  });

  function worker(options: Partial<Parameters<typeof createAnalysisWorker>[0]> = {}): Worker {
    const created = createAnalysisWorker({ connection, prefix, deps: deps(), ...options });
    workers.push(created);
    return created;
  }

  const idFor = (n: number): string => jobIdFor({ ...REQUEST, sha: sha(n) }, "0.1.0");
  const add = (n: number) => queue.add(idFor(n), { ...REQUEST, sha: sha(n) });

  it("answers ping", async () => {
    await expect(queue.ping()).resolves.toBeUndefined();
  });

  it("dedupes by job ID and reports queue positions oldest first", async () => {
    expect(await add(1)).toEqual({ created: true });
    expect(await add(1)).toEqual({ created: false });
    expect(await add(2)).toEqual({ created: true });
    expect(await queue.get(idFor(1))).toEqual({
      id: idFor(1),
      kind: "analyze",
      state: "queued",
      position: 0,
    });
    expect((await queue.get(idFor(2)))?.position).toBe(1);
    expect(await queue.get(idFor(3))).toBeUndefined();
    const stored = await queue.queue.getJob(idFor(1));
    expect(stored?.opts).toMatchObject({ attempts: JOB_OPTIONS.attempts });
  });

  it("runs a job to done and keeps its outcome", async () => {
    worker();
    await add(1);
    await until(async () => (await queue.get(idFor(1)))?.state === "done");
    const job = await queue.queue.getJob(idFor(1));
    expect(job?.returnvalue.stats).toEqual(STATS);
    expect(await readdir(join(root, "jobs"))).toEqual([]);
  });

  it("shows the stage, then the analyzer's step, of a running job", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let step = (): void => undefined;
    const stepGate = new Promise<void>((resolve) => (step = resolve));
    worker({
      deps: deps(async (job, options) => {
        await stepGate;
        options.onProgress?.({ step: "programs", count: 1204 });
        await gate;
        return writeGraph(job);
      }),
    });
    await add(1);
    await until(async () => (await queue.get(idFor(1)))?.stage === "analyze");
    expect(await queue.get(idFor(1))).toMatchObject({ state: "running", progress: 30 });
    step();
    await until(async () => (await queue.get(idFor(1)))?.step === "programs");
    expect(await queue.get(idFor(1))).toEqual({
      id: idFor(1),
      kind: "analyze",
      state: "running",
      stage: "analyze",
      progress: 38,
      step: "programs",
      count: 1204,
    });
    release();
    await until(async () => (await queue.get(idFor(1)))?.state === "done");
  });

  it("removes completed jobs only, so their commit can be added again", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    worker({
      deps: deps(async (job) => {
        if (job.out.includes(idFor(2))) await gate;
        if (job.out.includes(idFor(3))) {
          return { ok: false, code: "LIMIT_FILES", message: "", stderrTail: "", durationMs: 1 };
        }
        return writeGraph(job);
      }),
    });
    await add(1);
    await add(2);
    await add(3);
    await until(async () => (await queue.get(idFor(1)))?.state === "done");
    await until(async () => (await queue.get(idFor(3)))?.state === "failed");
    await until(async () => (await queue.get(idFor(2)))?.state === "running");

    expect(await queue.removeCompleted([idFor(1), idFor(2), idFor(3), idFor(4)])).toEqual({
      removed: 1,
      failed: 0,
    });
    expect(await queue.get(idFor(1))).toBeUndefined();
    expect((await queue.get(idFor(2)))?.state).toBe("running");
    expect((await queue.get(idFor(3)))?.state).toBe("failed");
    expect(await add(1)).toEqual({ created: true });
    release();
    await until(async () => (await queue.get(idFor(1)))?.state === "done");
  });

  it("fails a permanent failure on the first attempt and doesn't re-run it on add", async () => {
    worker({
      deps: deps(async () => ({
        ok: false,
        code: "LIMIT_FILES",
        message: "LIMIT_FILES",
        stderrTail: "",
        durationMs: 1,
      })),
    });
    await add(1);
    await until(async () => (await queue.get(idFor(1)))?.state === "failed");
    expect((await queue.get(idFor(1)))?.errorCode).toBe("LIMIT_FILES");
    expect((await queue.queue.getJob(idFor(1)))?.attemptsMade).toBe(1);
    expect(await add(1)).toEqual({ created: false });
  });

  it("retries a retriable failure 3 times, then runs it again when re-added", async () => {
    let calls = 0;
    let healthy = false;
    worker({
      deps: deps(async (job) => {
        calls += 1;
        if (healthy) return writeGraph(job);
        throw new Error("disk full");
      }),
    });
    await add(1);
    await until(async () => (await queue.get(idFor(1)))?.state === "failed");
    expect(calls).toBe(3);
    expect((await queue.get(idFor(1)))?.errorCode).toBe("WORKER_ERROR");

    healthy = true;
    expect(await add(1)).toEqual({ created: true });
    await until(async () => (await queue.get(idFor(1)))?.state === "done");
    expect(calls).toBe(4);
  });

  it(`runs at most ${WORKER_CONCURRENCY} jobs at once`, async () => {
    let running = 0;
    let most = 0;
    worker({
      deps: deps(async (job) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 150));
        running -= 1;
        return writeGraph(job);
      }),
    });
    for (const n of [1, 2, 3, 4, 5]) await add(n);
    await until(async () => (await queue.queue.getCompletedCount()) === 5);
    expect(most).toBe(WORKER_CONCURRENCY);
  });

  it("re-queues a job whose worker died, and another worker finishes it", async () => {
    // Worker A takes the job and hangs; force-closing it stops its lock renewals, as a
    // crash would. Worker B's stalled check then puts the job back and B runs it.
    let started = false;
    const a = worker({
      lockDuration: 1_000,
      stalledInterval: 500,
      deps: deps(async () => {
        started = true;
        return new Promise<RunResult>(() => undefined);
      }),
    });
    await add(1);
    await until(() => started);
    await a.close(true);

    const stalled: string[] = [];
    const b = worker({ lockDuration: 1_000, stalledInterval: 500 });
    b.on("stalled", (id) => void stalled.push(id));
    await until(async () => (await queue.get(idFor(1)))?.state === "done", 15_000);
    expect(stalled).toEqual([idFor(1)]);
    expect(MAX_STALLED_COUNT).toBe(2);
  }, 20_000);

  it("stopWorker cancels running jobs so they run again after the restart", async () => {
    let started = false;
    const first = worker({
      deps: deps(async (job, options) => {
        started = true;
        await new Promise((resolve) => options.signal?.addEventListener("abort", resolve));
        return { ok: false, code: "CANCELLED", message: "", stderrTail: "", durationMs: 1 };
      }),
    });
    await add(1);
    await until(() => started);
    await stopWorker(first);
    const job = await queue.queue.getJob(idFor(1));
    expect(job?.failedReason).toBe("CANCELLED");
    expect(["delayed", "waiting"]).toContain(await job?.getState());

    worker();
    await until(async () => (await queue.get(idFor(1)))?.state === "done");
  });

  it("serves the enqueue API end to end", async () => {
    const secret = "s".repeat(32);
    const handler = createEnqueueHandler({ queue, secrets: [secret], analyzerVersion: "0.1.0" });
    const body = JSON.stringify(REQUEST);
    const path = "/enqueue";
    const headers = signRequest(secret, { method: "POST", path, body: Buffer.from(body) });
    const enqueued = await request(handler)
      .post(path)
      .set(headers)
      .set("content-type", "application/json")
      .send(body);
    expect(enqueued.status).toBe(202);
    expect(enqueued.body).toEqual({ id: jobIdFor(REQUEST, "0.1.0"), created: true });

    const jobPath = `/jobs/${enqueued.body.id as string}`;
    const status = await request(handler)
      .get(jobPath)
      .set(signRequest(secret, { method: "GET", path: jobPath, body: Buffer.alloc(0) }));
    expect(status.body).toEqual({
      id: enqueued.body.id,
      kind: "analyze",
      state: "queued",
      position: 0,
    });
  });
});
