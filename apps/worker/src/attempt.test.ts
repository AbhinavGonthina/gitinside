import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAttempt, type AttemptInput, type AttemptResult } from "./attempt.js";
import { BENCH_MODEL, MIN_SAMPLES, expectedMs } from "./estimate.js";
import { startFakeGitHub, tarballFrom, type FakeGitHub } from "./github.testkit.js";
import type { JobDeps, JobRecorder } from "./job.js";
import { dbDown } from "./log.testkit.js";
import type { StoredProgress } from "./progress.js";
import { jobIdFor, type JobRequest } from "./request.js";
import type { RunResult } from "./runner.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REQUEST: JobRequest = { kind: "analyze", owner: "acme", repo: "shop", sha: SHA };
const ID = jobIdFor(REQUEST, "0.1.0");
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

beforeAll(async () => {
  github = await startFakeGitHub(tarballFrom([{ name: "index.ts", body: "export {};\n" }]));
});

afterAll(async () => {
  await github.close();
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gitinside-attempt-"));
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

/** The first attempt at `data`, with every progress update collected in `progress`. */
function attempt(data: unknown = REQUEST, more: Partial<AttemptInput> = {}) {
  const progress: StoredProgress[] = [];
  const input: AttemptInput = {
    id: ID,
    data,
    attempt: 1,
    lastAttempt: false,
    report: async (value) => void progress.push(value),
    ...more,
  };
  return { input, progress };
}

/** The failure of a result that must have failed. */
function failureOf(result: AttemptResult) {
  if (result.ok) throw new Error("expected a failure");
  return result.failure;
}

const failingRun =
  (code: string, retriable = false): JobDeps["run"] =>
  async () => ({
    ok: false,
    code,
    message: `${code}: failed`,
    stderrTail: retriable ? "" : "stack",
    durationMs: 1,
  });

describe("runAttempt", () => {
  it("runs the job, reports each stage as progress, and logs the outcome", async () => {
    const logs: Record<string, unknown>[] = [];
    const { input, progress } = attempt(REQUEST, { attempt: 2 });
    const result = await runAttempt(input, deps(), (e) => void logs.push(e));
    expect(result.ok && result.outcome?.stats).toEqual(STATS);
    expect(progress).toEqual([
      { stage: "download", progress: 0 },
      { stage: "extract", progress: 10 },
      { stage: "analyze", progress: 30 },
      { stage: "upload", progress: 90 },
    ]);
    expect(logs).toEqual([expect.objectContaining({ event: "job_done", id: ID, attempt: 2 })]);
  });

  it("stores the analyzer's steps as progress between the analyze and upload stages", async () => {
    const { input, progress } = attempt();
    const run: JobDeps["run"] = async (child, options) => {
      options.onProgress?.({ step: "programs", count: 12 });
      options.onProgress?.({ step: "http", count: 4 });
      return writeGraph(child);
    };
    await runAttempt(input, deps(run), undefined, { now: () => 5_000 });
    // From `programs` on, with the benchmark's rates (no samples): what's left from each
    // step's start; no upload time was measured, so saving has none.
    const bench = (step: "programs" | "http") =>
      expectedMs(BENCH_MODEL, { stage: "analyze", step }, 12);
    expect(progress.slice(2)).toEqual([
      { stage: "analyze", progress: 30 },
      {
        stage: "analyze",
        progress: 38,
        step: "programs",
        count: 12,
        since: 5_000,
        expectMs: bench("programs"),
      },
      {
        stage: "analyze",
        progress: 74,
        step: "http",
        count: 4,
        since: 5_000,
        expectMs: bench("http"),
      },
      { stage: "upload", progress: 90 },
    ]);
  });

  it("estimates from past jobs once read, timing each step from its own start", async () => {
    const { input, progress } = attempt();
    // 2 ms per file parsing, 1 ms linking calls, 300 ms saving.
    const sample = { files: 10, stageMs: { programs: 20, calls: 10 }, jobMs: { upload: 300 } };
    let clock = 0;
    const run: JobDeps["run"] = async (child, options) => {
      options.onProgress?.({ step: "inventory" });
      options.onProgress?.({ step: "programs", count: 100 });
      options.onProgress?.({ step: "calls" });
      options.onProgress?.({ step: "http", count: 4 });
      return writeGraph(child);
    };
    await runAttempt(input, deps(run), undefined, {
      samples: async () => Array.from({ length: MIN_SAMPLES }, () => sample),
      now: () => (clock += 1_000),
    });
    expect(progress.slice(2)).toEqual([
      { stage: "analyze", progress: 30 },
      // Before the file count: nothing to estimate from.
      { stage: "analyze", progress: 30, step: "inventory" },
      {
        stage: "analyze",
        progress: 38,
        step: "programs",
        count: 100,
        since: expect.any(Number),
        expectMs: 200 + 100 + 300,
      },
      { stage: "analyze", progress: 70, step: "calls", since: expect.any(Number), expectMs: 400 },
      {
        stage: "analyze",
        progress: 74,
        step: "http",
        count: 4,
        since: expect.any(Number),
        expectMs: 300,
      },
      { stage: "upload", progress: 90, since: expect.any(Number), expectMs: 300 },
    ]);
    // Each step's own start: later steps started later.
    const starts = progress.slice(4).map((p) => (p as { since: number }).since);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
  });

  it("falls back to the benchmark when past jobs can't be read, and logs it", async () => {
    const logs: Record<string, unknown>[] = [];
    const { input, progress } = attempt();
    const run: JobDeps["run"] = async (child, options) => {
      options.onProgress?.({ step: "programs", count: 12 });
      return writeGraph(child);
    };
    await runAttempt(input, deps(run), (e) => void logs.push(e), {
      samples: () => Promise.reject(dbDown()),
      now: () => 7,
    });
    expect(progress[3]).toMatchObject({
      step: "programs",
      since: 7,
      expectMs: expectedMs(BENCH_MODEL, { stage: "analyze", step: "programs" }, 12),
    });
    // The error's name and code only: a driver's message names the database host (M8.10e2b).
    expect(logs).toContainEqual({
      event: "estimate_samples_failed",
      id: ID,
      error: "Error",
      errorCode: "ECONNREFUSED",
    });
  });

  it("keeps what was found in every later update, the upload stage's too (#8)", async () => {
    const { input, progress } = attempt();
    const services = { count: 2, names: ["api", "web"] };
    const run: JobDeps["run"] = async (child, options) => {
      options.onProgress?.({ step: "workspace" });
      options.onFound?.({ services });
      options.onProgress?.({ step: "programs", count: 12 });
      options.onFound?.({ services, routes: 3 });
      return writeGraph(child);
    };
    await runAttempt(input, deps(run), undefined, { now: () => 1 });
    const estimate = {
      since: 1,
      expectMs: expectedMs(BENCH_MODEL, { stage: "analyze", step: "programs" }, 12),
    };
    expect(progress.slice(2)).toEqual([
      { stage: "analyze", progress: 30 },
      { stage: "analyze", progress: 34, step: "workspace" },
      { stage: "analyze", progress: 34, step: "workspace", found: { services } },
      {
        stage: "analyze",
        progress: 38,
        step: "programs",
        count: 12,
        ...estimate,
        found: { services },
      },
      {
        stage: "analyze",
        progress: 38,
        step: "programs",
        count: 12,
        ...estimate,
        found: { services, routes: 3 },
      },
      { stage: "upload", progress: 90, found: { services, routes: 3 } },
    ]);
  });

  /** A recorder that keeps each progress write once `write` (if any) resolves for it. */
  function progressRecorder(write?: (progress: StoredProgress) => Promise<void>) {
    const written: { id: string; progress: StoredProgress }[] = [];
    const recorder: JobRecorder = {
      start: async (request) => ({
        analysisId: "row",
        repoId: "repo",
        visibility: "public",
        owner: request.owner,
        name: request.repo,
      }),
      failed: async () => undefined,
      progress: async (id, progress) => {
        await write?.(progress);
        written.push({ id, progress });
      },
    };
    return { recorder, written };
  }

  it("writes every progress update to the recorder too, in order, under the job's ID", async () => {
    const { input, progress } = attempt();
    let slow = 2;
    const { recorder, written } = progressRecorder(async () => {
      // The first writes take longest, so a write that didn't wait would overtake them.
      if (slow-- > 0) await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const services = { count: 1, names: ["api"] };
    const run: JobDeps["run"] = async (child, options) => {
      options.onProgress?.({ step: "workspace" });
      options.onFound?.({ services });
      return writeGraph(child);
    };
    await runAttempt(input, { ...deps(run), recorder }, undefined, { now: () => 1 });
    await vi.waitFor(() => expect(written).toHaveLength(progress.length));
    expect(written.map((w) => w.progress)).toEqual(progress);
    expect(new Set(written.map((w) => w.id))).toEqual(new Set([ID]));
  });

  it("logs a failed progress write and carries on, the job's outcome unchanged", async () => {
    const logs: Record<string, unknown>[] = [];
    const { recorder, written } = progressRecorder(async (progress) => {
      if (progress.stage === "extract") throw dbDown();
    });
    const result = await runAttempt(
      attempt().input,
      { ...deps(), recorder },
      (e) => void logs.push(e),
    );
    expect(result.ok && result.outcome?.stats).toEqual(STATS);
    await vi.waitFor(() => expect(written.map((w) => w.progress.stage)).toContain("upload"));
    expect(written.map((w) => w.progress.stage)).toEqual(["download", "analyze", "upload"]);
    expect(logs).toContainEqual({
      event: "progress_record_failed",
      id: ID,
      stage: "extract",
      error: "Error",
      errorCode: "ECONNREFUSED",
    });
  });

  it("succeeds with nothing to do when the start finds the row already done (R9)", async () => {
    const logs: Record<string, unknown>[] = [];
    const failed = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);
    const recorder: JobRecorder = { start: async () => "done", failed };
    const run = vi.fn(writeGraph);
    const result = await runAttempt(
      attempt(REQUEST, { attempt: 2 }).input,
      { ...deps(run), recorder, publish },
      (e) => void logs.push(e),
    );
    expect(result).toEqual({ ok: true, alreadyDone: true });
    expect([run, publish, failed].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    expect(logs).toEqual([{ event: "job_already_done", id: ID, attempt: 2 }]);
  });

  it("fails a permanent failure with its code, not retriable, and logs it", async () => {
    const logs: Record<string, unknown>[] = [];
    const result = await runAttempt(
      attempt().input,
      deps(failingRun("LIMIT_FILES")),
      (e) => void logs.push(e),
    );
    const failure = failureOf(result);
    expect(failure).toMatchObject({ code: "LIMIT_FILES", retriable: false });
    expect(logs).toEqual([
      expect.objectContaining({
        event: "job_failed",
        code: "LIMIT_FILES",
        retriable: false,
        detail: "stack",
      }),
    ]);
  });

  it("fails a retriable failure as retriable", async () => {
    const result = await runAttempt(attempt().input, deps(failingRun("CANCELLED", true)));
    expect(failureOf(result)).toMatchObject({ code: "CANCELLED", retriable: true });
  });

  it("refuses a body that isn't a valid request, permanently, before downloading", async () => {
    const run = vi.fn(writeGraph);
    const before = github.requests.length;
    const result = await runAttempt(attempt({ ...REQUEST, owner: "-bad" }).input, deps(run));
    expect(failureOf(result)).toMatchObject({ code: "INVALID_REQUEST", retriable: false });
    expect(run).not.toHaveBeenCalled();
    expect(github.requests).toHaveLength(before);
  });

  it("turns unexpected errors into the retriable WORKER_ERROR", async () => {
    const run = async (): Promise<RunResult> => {
      throw new TypeError("boom");
    };
    const logs: Record<string, unknown>[] = [];
    const result = await runAttempt(attempt().input, deps(run), (e) => void logs.push(e));
    expect(failureOf(result)).toMatchObject({ code: "WORKER_ERROR", retriable: true });
    expect(logs[0]).toMatchObject({ code: "WORKER_ERROR", detail: "boom" });
  });
});
