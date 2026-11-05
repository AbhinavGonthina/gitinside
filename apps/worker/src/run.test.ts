import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeGitHub, tarballFrom, type FakeGitHub } from "./github.testkit.js";
import { signRequest } from "./hmac.js";
import { PUBLISH_RESERVE_MS, type JobDeps, type JobRecorder } from "./job.js";
import type { StoredProgress } from "./progress.js";
import { jobIdFor, type JobRequest } from "./request.js";
import {
  HEALTH_PATH,
  JOB_BUDGET_MS,
  MAX_ATTEMPTS,
  MAX_TASK_AGE_SECONDS,
  RETRY_COUNT_HEADER,
  RUN_PATH,
  attemptFrom,
  createRunServer,
  type RunHandlerOptions,
} from "./run.js";
import type { RunResult } from "./runner.js";
import { fakeTask, pushTask } from "./tasks.testkit.js";

const SECRET = "s".repeat(43);
const VERSION = "0.1.0";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REQUEST: JobRequest = { kind: "analyze", owner: "acme", repo: "shop", sha: SHA };
const ID = jobIdFor(REQUEST, VERSION);
const STATS = {
  files: 1,
  nodes: 3,
  edges: 2,
  unresolved: 0,
  warnings: 0,
  graphBytes: 2,
  stageMs: {},
};

let github: FakeGitHub;
let root: string;
let server: Server | undefined;

beforeAll(async () => {
  github = await startFakeGitHub(tarballFrom([{ name: "index.ts", body: "export {};\n" }]));
});

afterAll(async () => {
  await github.close();
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gitinside-run-"));
});

afterEach(async () => {
  await new Promise((resolve) =>
    server === undefined ? resolve(undefined) : server.close(resolve),
  );
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

const writeGraph = async (job: { out: string }): Promise<RunResult> => {
  await writeFile(job.out, "{}");
  return { ok: true, stats: STATS, durationMs: 1 };
};

const failWith = (code: string) => async (): Promise<RunResult> => ({
  ok: false,
  code,
  message: code,
  stderrTail: "",
  durationMs: 1,
});

/** A recorder that keeps every call. */
function fakeRecorder() {
  const calls = {
    started: [] as string[],
    failed: [] as { code: string; final: boolean }[],
    progress: [] as { id: string; progress: StoredProgress }[],
  };
  const recorder: JobRecorder = {
    start: async (request, _signal, jobId) => {
      calls.started.push(jobId);
      return {
        analysisId: "row",
        repoId: "repo",
        visibility: "public",
        owner: request.owner,
        name: request.repo,
      };
    },
    failed: async (_job, code, final) => void calls.failed.push({ code, final }),
    progress: async (id, progress) => void calls.progress.push({ id, progress }),
  };
  return { recorder, calls };
}

/** Job deps against the fake GitHub; `run` defaults to writing a tiny graph. */
function deps(run: JobDeps["run"] = writeGraph, recorder?: JobRecorder): JobDeps {
  return {
    jobsRoot: join(root, "jobs"),
    publish: async () => undefined,
    download: { apiBase: github.apiBase, downloadOrigins: [github.codeloadOrigin] },
    run,
    ...(recorder === undefined ? {} : { recorder }),
  };
}

/** Start the run server on a free port; returns its origin. */
async function start(
  options: Partial<RunHandlerOptions> & Pick<RunHandlerOptions, "deps">,
): Promise<string> {
  server = createRunServer({ secrets: [SECRET], analyzerVersion: VERSION, ...options });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** One signed POST to `path` with `body`, as attempt `retry + 1`. */
async function post(
  origin: string,
  body: string,
  { path = RUN_PATH, retry = 0, signedAt = Date.now(), method = "POST" } = {},
): Promise<{ status: number; body: unknown }> {
  const bytes = new TextEncoder().encode(body);
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      "content-type": "application/json",
      [RETRY_COUNT_HEADER]: String(retry),
      ...signRequest(SECRET, { method, path, body: bytes }, signedAt),
    },
    ...(method === "GET" ? {} : { body: bytes }),
  });
  return { status: response.status, body: await response.json() };
}

describe("attemptFrom", () => {
  it("reads Cloud Tasks' retry count as the attempt number", () => {
    expect(attemptFrom("0")).toBe(1);
    expect(attemptFrom("2")).toBe(3);
  });

  it("takes anything unusable as the first attempt", () => {
    for (const header of [undefined, "", "-1", "1.5", "x", ["1", "2"], "1234567"]) {
      expect(attemptFrom(header)).toBe(1);
    }
  });
});

describe("POST /run through a fake Cloud Tasks push", () => {
  it("runs the job, writes its progress to the row, and answers 200 done", async () => {
    const { recorder, calls } = fakeRecorder();
    const origin = await start({ deps: deps(writeGraph, recorder) });
    const deliveries = await pushTask(fakeTask(origin, REQUEST, SECRET));
    expect(deliveries).toEqual([{ status: 200, body: { id: ID, state: "done" } }]);
    expect(calls.started).toEqual([ID]);
    await vi.waitFor(() =>
      expect(calls.progress.map((p) => p.progress.stage)).toEqual([
        "download",
        "extract",
        "analyze",
        "upload",
      ]),
    );
    expect(new Set(calls.progress.map((p) => p.id))).toEqual(new Set([ID]));
  });

  it("answers 200 for a permanent failure, so Cloud Tasks doesn't retry it", async () => {
    const { recorder, calls } = fakeRecorder();
    const origin = await start({ deps: deps(failWith("LIMIT_FILES"), recorder) });
    const deliveries = await pushTask(fakeTask(origin, REQUEST, SECRET));
    expect(deliveries).toEqual([
      { status: 200, body: { id: ID, state: "failed", errorCode: "LIMIT_FILES" } },
    ]);
    expect(calls.failed).toEqual([{ code: "LIMIT_FILES", final: true }]);
  });

  it("answers 503 for a retriable failure, and 200 failed on the last attempt", async () => {
    const { recorder, calls } = fakeRecorder();
    const origin = await start({ deps: deps(failWith("CANCELLED"), recorder) });
    const deliveries = await pushTask(fakeTask(origin, REQUEST, SECRET), MAX_ATTEMPTS);
    expect(deliveries).toEqual([
      { status: 503, body: { error: "CANCELLED" } },
      { status: 503, body: { error: "CANCELLED" } },
      { status: 200, body: { id: ID, state: "failed", errorCode: "CANCELLED" } },
    ]);
    // Queued again after each of the first two; failed for good after the third.
    expect(calls.failed).toEqual([
      { code: "CANCELLED", final: false },
      { code: "CANCELLED", final: false },
      { code: "CANCELLED", final: true },
    ]);
  });

  it("succeeds on a retry after a retriable failure", async () => {
    let runs = 0;
    const run: JobDeps["run"] = async (job) =>
      ++runs === 1 ? failWith("WORKER_ERROR")() : writeGraph(job);
    const origin = await start({ deps: deps(run) });
    const deliveries = await pushTask(fakeTask(origin, REQUEST, SECRET));
    expect(deliveries.map((d) => d.status)).toEqual([503, 200]);
    expect(deliveries[1]?.body).toEqual({ id: ID, state: "done" });
  });
});

describe("POST /run refuses before running anything", () => {
  const body = JSON.stringify(REQUEST);
  let runs: number;
  const counting: JobDeps["run"] = async (job) => {
    runs++;
    return writeGraph(job);
  };

  beforeEach(() => {
    runs = 0;
  });

  it("an unsigned request", async () => {
    const origin = await start({ deps: deps(counting) });
    const response = await fetch(new URL(RUN_PATH, origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "MISSING_SIGNATURE" });
    expect(runs).toBe(0);
  });

  it("a body signed with another secret", async () => {
    const origin = await start({ deps: deps(counting) });
    const task = fakeTask(origin, REQUEST, "t".repeat(43));
    expect(await pushTask(task, 1)).toEqual([{ status: 401, body: { error: "BAD_SIGNATURE" } }]);
    expect(runs).toBe(0);
  });

  it("a task signed more than a day ago, but not one signed just under a day ago", async () => {
    const now = 1_800_000_000_000;
    const origin = await start({ deps: deps(counting), now: () => now });
    const old = await post(origin, body, { signedAt: now - (MAX_TASK_AGE_SECONDS + 1) * 1000 });
    expect(old).toEqual({ status: 401, body: { error: "STALE_TIMESTAMP" } });
    expect(runs).toBe(0);
    const waited = await post(origin, body, { signedAt: now - (MAX_TASK_AGE_SECONDS - 1) * 1000 });
    expect(waited.status).toBe(200);
    expect(runs).toBe(1);
  });

  it("a signature dated more than 5 minutes ahead", async () => {
    const now = 1_800_000_000_000;
    const origin = await start({ deps: deps(counting), now: () => now });
    const ahead = await post(origin, body, { signedAt: now + 6 * 60 * 1000 });
    expect(ahead).toEqual({ status: 401, body: { error: "STALE_TIMESTAMP" } });
  });

  it("but answers GET and HEAD /health without a signature, saying only ok", async () => {
    const origin = await start({ deps: deps(counting) });
    const health = await fetch(new URL(HEALTH_PATH, origin));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect((await fetch(new URL(HEALTH_PATH, origin), { method: "HEAD" })).status).toBe(200);
    const post = await fetch(new URL(HEALTH_PATH, origin), { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    const unsigned = await fetch(new URL("/health/x", origin));
    expect(unsigned.status).toBe(401);
    expect(runs).toBe(0);
  });

  it("other paths and methods, once signed", async () => {
    const origin = await start({ deps: deps(counting) });
    expect(await post(origin, body, { path: "/enqueue" })).toEqual({
      status: 404,
      body: { error: "NOT_FOUND" },
    });
    expect(await post(origin, "", { method: "GET" })).toEqual({
      status: 405,
      body: { error: "METHOD_NOT_ALLOWED" },
    });
    expect(runs).toBe(0);
  });

  it("a body that isn't a job", async () => {
    const origin = await start({ deps: deps(counting) });
    expect(await post(origin, "{")).toEqual({ status: 400, body: { error: "INVALID_JSON" } });
    expect(await post(origin, JSON.stringify({ ...REQUEST, owner: "-bad" }))).toEqual({
      status: 400,
      body: { error: "INVALID_REQUEST", message: "owner is not a GitHub owner name" },
    });
    expect(runs).toBe(0);
  });

  it("a body that isn't JSON by its content type", async () => {
    const origin = await start({ deps: deps(counting) });
    const bytes = new TextEncoder().encode(body);
    const response = await fetch(new URL(RUN_PATH, origin), {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        ...signRequest(SECRET, { method: "POST", path: RUN_PATH, body: bytes }),
      },
      body: bytes,
    });
    expect(response.status).toBe(415);
    expect(runs).toBe(0);
  });

  it("a body over the size limit, unread", async () => {
    const origin = await start({ deps: deps(counting), maxBodyBytes: 64 });
    const response = await post(origin, JSON.stringify({ ...REQUEST, pad: "x".repeat(100) }));
    expect(response).toEqual({ status: 413, body: { error: "BODY_TOO_LARGE" } });
  });
});

describe("POST /run, one job at a time", () => {
  it("answers 429 BUSY to a second push while a job runs (Cloud Tasks retries it)", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const run: JobDeps["run"] = async (job) => {
      started();
      await held;
      return writeGraph(job);
    };
    const origin = await start({ deps: deps(run) });
    const first = post(origin, JSON.stringify(REQUEST));
    await running;
    const other = { ...REQUEST, sha: "f".repeat(40) };
    expect(await post(origin, JSON.stringify(other))).toEqual({
      status: 429,
      body: { error: "BUSY" },
    });
    release();
    expect((await first).status).toBe(200);
    // Free again once the first answered.
    expect((await post(origin, JSON.stringify(other))).status).toBe(200);
  });
});

describe("POST /run, a job already done (M5.17c2b)", () => {
  /** A recorder whose `done` answers with `isDone` and counts its lookups. */
  function doneRecorder(isDone: (id: string) => Promise<boolean>) {
    const { recorder, calls } = fakeRecorder();
    const looked: string[] = [];
    const done: JobRecorder = {
      ...recorder,
      done: async (id) => {
        looked.push(id);
        return isDone(id);
      },
    };
    return { recorder: done, calls, looked };
  }

  it("answers 200 done without downloading, recording, or running anything", async () => {
    const { recorder, calls, looked } = doneRecorder(async (id) => id === ID);
    let runs = 0;
    const run: JobDeps["run"] = async (job) => {
      runs++;
      return writeGraph(job);
    };
    const events: Record<string, unknown>[] = [];
    const before = github.requests.length;
    const origin = await start({ deps: deps(run, recorder), log: (e) => void events.push(e) });
    // A redelivery on a later attempt is answered the same way.
    expect(await pushTask(fakeTask(origin, REQUEST, SECRET))).toEqual([
      { status: 200, body: { id: ID, state: "done" } },
    ]);
    expect(await post(origin, JSON.stringify(REQUEST), { retry: 2 })).toEqual({
      status: 200,
      body: { id: ID, state: "done" },
    });
    expect(looked).toEqual([ID, ID]);
    expect([runs, calls.started, calls.progress, calls.failed]).toEqual([0, [], [], []]);
    expect(github.requests.length).toBe(before);
    expect(events).toEqual([
      { event: "job_already_done", id: ID, attempt: 1 },
      { event: "job_already_done", id: ID, attempt: 3 },
    ]);
    // Another commit isn't done, so it runs.
    const other = { ...REQUEST, sha: "f".repeat(40) };
    expect((await post(origin, JSON.stringify(other))).body).toEqual({
      id: jobIdFor(other, VERSION),
      state: "done",
    });
    expect(runs).toBe(1);
  });

  it("runs the job as usual when the lookup fails, logging why", async () => {
    const { recorder, calls } = doneRecorder(() => Promise.reject(new Error("db down")));
    const events: Record<string, unknown>[] = [];
    const origin = await start({
      deps: deps(writeGraph, recorder),
      log: (e) => void events.push(e),
    });
    expect(await post(origin, JSON.stringify(REQUEST))).toEqual({
      status: 200,
      body: { id: ID, state: "done" },
    });
    expect(calls.started).toEqual([ID]);
    expect(events[0]).toEqual({ event: "done_check_failed", id: ID, message: "db down" });
  });

  it("answers 200 done with no work when the check missed it and the start finds it (R9)", async () => {
    const { recorder, calls } = doneRecorder(() => Promise.reject(new Error("db down")));
    let runs = 0;
    const run: JobDeps["run"] = async (job) => {
      runs++;
      return writeGraph(job);
    };
    const before = github.requests.length;
    const events: Record<string, unknown>[] = [];
    const origin = await start({
      deps: deps(run, { ...recorder, start: async () => "done" }),
      log: (e) => void events.push(e),
    });
    expect(await post(origin, JSON.stringify(REQUEST))).toEqual({
      status: 200,
      body: { id: ID, state: "done" },
    });
    expect([runs, calls.failed, github.requests.length - before]).toEqual([0, [], 0]);
    expect(events).toContainEqual({ event: "job_already_done", id: ID, attempt: 1 });
  });

  it("checks only once a job may start: a busy worker still answers 429", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const run: JobDeps["run"] = async (job) => {
      started();
      await held;
      return writeGraph(job);
    };
    const { recorder, looked } = doneRecorder(async (id) => id !== ID);
    const origin = await start({ deps: deps(run, recorder) });
    const first = post(origin, JSON.stringify(REQUEST));
    await running;
    const other = { ...REQUEST, sha: "f".repeat(40) };
    expect((await post(origin, JSON.stringify(other))).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect(looked).toEqual([ID]);
  });
});

describe("POST /run, after the job (M5.17c2d)", () => {
  /** An `afterJob` that records the time left at each call, and waits for `hold`. */
  function afterJobSpy(hold?: Promise<void>) {
    const calls: number[] = [];
    const afterJob: NonNullable<RunHandlerOptions["afterJob"]> = async ({ timeLeftMs }) => {
      calls.push(timeLeftMs);
      await hold;
    };
    return { afterJob, calls };
  }

  it("calls it with what's left of the budget, whatever the outcome", async () => {
    let at = 0;
    const read = () => at;
    const { afterJob, calls } = afterJobSpy();
    const runs = [writeGraph, failWith("LIMIT_FILES"), failWith("WORKER_ERROR")];
    const run: JobDeps["run"] = async (job) => {
      at += 30_000;
      return (runs.shift() ?? writeGraph)(job);
    };
    const origin = await start({ deps: deps(run), afterJob, clock: read });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      at = 0;
      statuses.push((await post(origin, JSON.stringify(REQUEST))).status);
    }
    expect(statuses).toEqual([200, 200, 503]);
    expect(calls).toEqual(Array.from({ length: 3 }, () => JOB_BUDGET_MS - 30_000));
  });

  it("holds the answer until it ends, and a push meanwhile is still busy", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { afterJob, calls } = afterJobSpy(hold);
    const origin = await start({ deps: deps(), afterJob });
    let settled = false;
    const first = post(origin, JSON.stringify(REQUEST)).then((answer) => {
      settled = true;
      return answer;
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const other = { ...REQUEST, sha: "f".repeat(40) };
    expect((await post(origin, JSON.stringify(other))).status).toBe(429);
    expect(settled).toBe(false);
    release();
    expect(await first).toEqual({ status: 200, body: { id: ID, state: "done" } });
  });

  it("calls it after a push answered from an already-done row too", async () => {
    const { recorder } = fakeRecorder();
    const { afterJob, calls } = afterJobSpy();
    const done: JobRecorder = { ...recorder, done: async () => true };
    const origin = await start({ deps: deps(writeGraph, done), afterJob });
    expect((await post(origin, JSON.stringify(REQUEST))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("answers as usual when it rejects, logging why", async () => {
    const events: Record<string, unknown>[] = [];
    const origin = await start({
      deps: deps(),
      afterJob: () => Promise.reject(new Error("boom")),
      log: (e) => void events.push(e),
    });
    expect(await post(origin, JSON.stringify(REQUEST))).toEqual({
      status: 200,
      body: { id: ID, state: "done" },
    });
    expect(events.filter((e) => e.event === "after_job_failed")).toEqual([
      { event: "after_job_failed", id: ID, message: "boom" },
    ]);
  });

  it("skips it for a job cancelled by shutdown", async () => {
    const shutdown = new AbortController();
    const { afterJob, calls } = afterJobSpy();
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const run: JobDeps["run"] = async (_job, options) => {
      started();
      await new Promise((resolve) => options.signal?.addEventListener("abort", resolve));
      return failWith("CANCELLED")();
    };
    const origin = await start({ deps: deps(run), signal: shutdown.signal, afterJob });
    const answer = post(origin, JSON.stringify(REQUEST));
    await running;
    shutdown.abort();
    expect((await answer).status).toBe(503);
    expect(calls).toEqual([]);
  });
});

describe("POST /run, the compute count (M5.18d)", () => {
  it("meters each answer with the request's time, after the job and its afterJob, before the answer", async () => {
    let at = 0;
    const order: string[] = [];
    const metered: number[] = [];
    const run: JobDeps["run"] = async (job) => {
      at += 42_000;
      return writeGraph(job);
    };
    const origin = await start({
      deps: deps(run),
      clock: () => at,
      afterJob: async () => {
        at += 3_000;
        order.push("afterJob");
      },
      meter: async (ms) => {
        metered.push(ms);
        order.push("meter");
      },
    });
    expect((await post(origin, JSON.stringify(REQUEST))).status).toBe(200);
    expect(metered).toEqual([45_000]);
    expect(order).toEqual(["afterJob", "meter"]);
  });

  it("meters refused pushes and busy answers too, but not /health", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const metered: number[] = [];
    const origin = await start({
      deps: deps(async (job) => {
        started();
        await hold;
        return writeGraph(job);
      }),
      meter: async (ms) => void metered.push(ms),
    });
    expect((await fetch(new URL("/health", origin))).status).toBe(200);
    expect(metered).toEqual([]);
    expect((await post(origin, "{")).status).toBe(400);
    expect((await post(origin, JSON.stringify(REQUEST), { path: "/other" })).status).toBe(404);
    expect(metered).toHaveLength(2);
    const first = post(origin, JSON.stringify(REQUEST));
    await running;
    expect((await post(origin, JSON.stringify(REQUEST))).status).toBe(429);
    expect(metered).toHaveLength(3);
    release();
    expect((await first).status).toBe(200);
    expect(metered).toHaveLength(4);
    for (const ms of metered) expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("answers as usual when metering rejects, logging why", async () => {
    const events: Record<string, unknown>[] = [];
    const origin = await start({
      deps: deps(),
      meter: () => Promise.reject(new Error("db down")),
      log: (e) => void events.push(e),
    });
    expect(await post(origin, JSON.stringify(REQUEST))).toEqual({
      status: 200,
      body: { id: ID, state: "done" },
    });
    expect(events.filter((e) => e.event === "meter_failed")).toEqual([
      { event: "meter_failed", message: "db down" },
    ]);
  });
});

describe("POST /run, one deadline", () => {
  /** A clock the test moves: `at` ms since the request arrived. */
  function steppedClock() {
    const clock = { at: 0 };
    return { clock, read: () => clock.at };
  }

  it("gives the child what's left of the budget, less the publish reserve, in whole seconds", async () => {
    const { clock, read } = steppedClock();
    const { recorder } = fakeRecorder();
    // Recording the start happens just before the download: a slow GitHub took 100.5 s.
    const slowStart: JobRecorder = {
      ...recorder,
      start: async (...args) => {
        clock.at += 100_500;
        return recorder.start(...args);
      },
    };
    const limits: unknown[] = [];
    const run: JobDeps["run"] = async (job, options) => {
      limits.push(options.limits);
      return writeGraph(job);
    };
    const origin = await start({ deps: deps(run, slowStart), clock: read });
    expect((await post(origin, JSON.stringify(REQUEST))).status).toBe(200);
    const left = JOB_BUDGET_MS - 100_500 - PUBLISH_RESERVE_MS;
    expect(limits).toEqual([{ timeoutMs: Math.floor(left / 1000) * 1000 }]);
  });

  it("keeps the child's own limit when more time is left, and its heap cap", async () => {
    const limits: unknown[] = [];
    const run: JobDeps["run"] = async (job, options) => {
      limits.push(options.limits);
      return writeGraph(job);
    };
    const own = { timeoutMs: 60_000, maxHeapMb: 2048 };
    const origin = await start({ deps: { ...deps(run), runOptions: { limits: own } } });
    expect((await post(origin, JSON.stringify(REQUEST))).status).toBe(200);
    expect(limits).toEqual([own]);
  });

  it("fails LIMIT_TIME without starting the child when nothing is left for it", async () => {
    const { clock, read } = steppedClock();
    const { recorder, calls } = fakeRecorder();
    const late: JobRecorder = {
      ...recorder,
      start: async (...args) => {
        clock.at += JOB_BUDGET_MS - PUBLISH_RESERVE_MS;
        return recorder.start(...args);
      },
    };
    let runs = 0;
    const run: JobDeps["run"] = async (job) => {
      runs++;
      return writeGraph(job);
    };
    const origin = await start({ deps: deps(run, late), clock: read });
    expect(await post(origin, JSON.stringify(REQUEST))).toEqual({
      status: 200,
      body: { id: ID, state: "failed", errorCode: "LIMIT_TIME" },
    });
    expect(runs).toBe(0);
    expect(calls.failed).toEqual([{ code: "LIMIT_TIME", final: true }]);
  });

  it("cuts the download to what's left: a retriable DOWNLOAD_TIMEOUT", async () => {
    let calls = 0;
    // 280 s budget, 20 s reserve: 1 ms after 260 s nothing is left for the download.
    const read = () => (calls++ === 0 ? 0 : JOB_BUDGET_MS - PUBLISH_RESERVE_MS + 1);
    const before = github.requests.length;
    const origin = await start({ deps: deps(), clock: read });
    expect(await post(origin, JSON.stringify(REQUEST))).toEqual({
      status: 503,
      body: { error: "DOWNLOAD_TIMEOUT" },
    });
    expect(github.requests.length).toBe(before);
  });
});

describe("POST /run, cancelled", () => {
  it("kills the job when the caller hangs up", async () => {
    let aborted: (() => void) | undefined;
    const gone = new Promise<void>((resolve) => (aborted = resolve));
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const run: JobDeps["run"] = async (_job, options) => {
      options.signal?.addEventListener("abort", () => aborted?.());
      started();
      await gone;
      return failWith("CANCELLED")();
    };
    const origin = await start({ deps: deps(run) });
    const caller = new AbortController();
    const bytes = new TextEncoder().encode(JSON.stringify(REQUEST));
    const request = fetch(new URL(RUN_PATH, origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signRequest(SECRET, { method: "POST", path: RUN_PATH, body: bytes }),
      },
      body: bytes,
      signal: caller.signal,
    }).catch(() => undefined);
    await running;
    caller.abort();
    await request;
    await gone;
  });

  it("cancels the running job on shutdown, answering 503 so it runs again", async () => {
    const shutdown = new AbortController();
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const run: JobDeps["run"] = async (_job, options) => {
      started();
      await new Promise((resolve) => options.signal?.addEventListener("abort", resolve));
      return failWith("CANCELLED")();
    };
    const origin = await start({ deps: deps(run), signal: shutdown.signal });
    const answer = post(origin, JSON.stringify(REQUEST));
    await running;
    shutdown.abort();
    expect(await answer).toEqual({ status: 503, body: { error: "CANCELLED" } });
  });

  it("closes the connection with its answer once shutting down, so the server can close at once", async () => {
    const shutdown = new AbortController();
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const run: JobDeps["run"] = async (_job, options) => {
      started();
      await new Promise((resolve) => options.signal?.addEventListener("abort", resolve));
      return failWith("CANCELLED")();
    };
    const origin = await start({ deps: deps(run), signal: shutdown.signal });
    const bytes = new TextEncoder().encode(JSON.stringify(REQUEST));
    const answer = fetch(new URL(RUN_PATH, origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signRequest(SECRET, { method: "POST", path: RUN_PATH, body: bytes }),
      },
      body: bytes,
    });
    await running;
    shutdown.abort();
    const response = await answer;
    expect(response.status).toBe(503);
    expect(response.headers.get("connection")).toBe("close");
    await response.arrayBuffer();
  });

  it("keeps the connection open with an ordinary answer", async () => {
    const origin = await start({ deps: deps() });
    const bytes = new TextEncoder().encode(JSON.stringify(REQUEST));
    const response = await fetch(new URL(RUN_PATH, origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signRequest(SECRET, { method: "POST", path: RUN_PATH, body: bytes }),
      },
      body: bytes,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("connection")).not.toBe("close");
    await response.arrayBuffer();
  });
});
