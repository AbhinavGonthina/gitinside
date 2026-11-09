import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRequest } from "./request.js";
import { JobFailure } from "./failure.js";
import { startFakeGitHub, tarballFrom, tarballOf, type FakeGitHub } from "./github.testkit.js";
import {
  DOWNLOAD_ALLOWANCE_MS,
  PUBLISH_RESERVE_MS,
  SKIPPED_SAMPLE_SIZE,
  guaranteedAnalysisMs,
  processJob,
  sweepJobsRoot,
  type JobArtifact,
  type JobDeps,
  type JobRecorder,
  type JobStage,
  type RecordedJob,
} from "./job.js";
import type { RunOptions, RunResult } from "./runner.js";

const WORKER = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WORKER, "dist");
const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ID = "analyze-0123456789abcdef0123456789abcdef";

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

let github: FakeGitHub;
let root: string;
let jobsRoot: string;

beforeEach(async () => {
  github = await startFakeGitHub(
    tarballFrom([{ name: "index.ts", body: "export const a = 1;\n" }]),
  );
  root = await mkdtemp(join(tmpdir(), "gitinside-job-"));
  jobsRoot = join(root, "jobs");
  fakeRun.mockClear();
});

afterEach(async () => {
  await github.close();
  await rm(root, { recursive: true, force: true });
});

/** A runner stand-in that writes a tiny graph, so most tests skip the real child. */
const fakeRun = vi.fn(async (job: { out: string }, options?: RunOptions): Promise<RunResult> => {
  void options;
  await writeFile(job.out, "{}");
  return { ok: true, stats: STATS, durationMs: 1 };
});

function deps(overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    jobsRoot,
    publish: async () => undefined,
    download: {
      apiBase: github.apiBase,
      downloadOrigins: [github.codeloadOrigin],
      token: "test-token",
    },
    run: fakeRun,
    ...overrides,
  };
}

/** Run a job that must fail, returning its failure. */
async function failure(promise: Promise<unknown>): Promise<JobFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JobFailure) return error;
    throw error;
  }
  throw new Error("expected the job to fail");
}

async function jobFolders(): Promise<string[]> {
  return readdir(jobsRoot).catch(() => []);
}

describe("processJob with the real analyzer", () => {
  it("downloads, extracts, analyzes, publishes, and removes the job folder", async () => {
    github.tarball = await tarballOf(join(FIXTURES, "express-basic"));
    const stages: string[] = [];
    let published: { artifact: JobArtifact; graph: string } | undefined;
    const real = deps({
      runOptions: { scriptsDir: DIST },
      publish: async (artifact) => {
        published = { artifact, graph: await readFile(artifact.graphPath, "utf8") };
      },
    });
    delete real.run;
    const outcome = await processJob(
      {
        id: ID,
        request: REQUEST,
        onStage: (stage: JobStage) => void stages.push(stage),
        onStep: ({ step, count }) => void stages.push(count === undefined ? step : `${step}:n`),
      },
      real,
    );

    // The analyzer's steps stream in between the analyze and upload stages.
    expect(stages.slice(0, 4)).toEqual(["download", "extract", "analyze", "inventory"]);
    expect(stages).toContain("programs:n");
    expect(stages).toContain("http:n");
    expect(stages.slice(-2)).toEqual(["assemble", "upload"]);
    expect(published?.artifact).toMatchObject({ id: ID, request: REQUEST, stats: outcome.stats });
    const graph = JSON.parse(published?.graph ?? "") as {
      repo: Record<string, unknown>;
      nodes: unknown[];
    };
    expect(graph.repo).toMatchObject({ owner: "acme", name: "shop", sha: SHA });
    expect(outcome.stats.nodes).toBe(graph.nodes.length);
    expect(outcome.stats.graphBytes).toBe(Buffer.byteLength(published?.graph ?? ""));
    expect(outcome.extract.files).toBeGreaterThan(0);
    expect(outcome.extract.skipped).toBe(0);
    expect(Object.keys(outcome.timings)).toEqual(["downloadMs", "analyzeMs", "publishMs"]);
    expect(await jobFolders()).toEqual([]);
    expect(outcome.stats).not.toHaveProperty("cache");
  });

  it("reuses the sandboxed child's cached facts in the next job, with the same graph", async () => {
    github.tarball = await tarballOf(join(FIXTURES, "pnpm-monorepo"));
    const cacheRoot = join(root, "cache");
    const graphs: string[] = [];
    const real = deps({
      cacheRoot,
      runOptions: { scriptsDir: DIST },
      publish: async (artifact) => void graphs.push(await readFile(artifact.graphPath, "utf8")),
    });
    delete real.run;
    const cold = await processJob({ id: ID, request: REQUEST }, real);
    const warm = await processJob({ id: ID, request: REQUEST }, real);

    const services = (JSON.parse(graphs[0] ?? "") as { nodes: { kind: string }[] }).nodes.filter(
      (node) => node.kind === "service",
    ).length;
    expect(services).toBeGreaterThan(1);
    expect(cold.stats.cache).toEqual({
      hits: 0,
      misses: services,
      writes: services,
      evictions: 0,
      errors: 0,
    });
    expect(warm.stats.cache).toEqual({
      hits: services,
      misses: 0,
      writes: 0,
      evictions: 0,
      errors: 0,
    });
    expect(graphs[1]).toBe(graphs[0]);
    expect(await readdir(cacheRoot)).toEqual(["public"]);
    expect(await jobFolders()).toEqual([]);
  }, 60_000);
});

describe("processJob fact cache folders", () => {
  const REPO = "0b3c3f0e-7d6a-4a51-9c3e-2f1d8e5b6a01";
  const REMOVED = "5e2a9c1d-3b4f-4e6a-8d7c-9a0b1c2d3e02";
  const record = (visibility: "public" | "private"): JobRecorder => ({
    start: async () => ({
      analysisId: "a1",
      repoId: REPO,
      visibility,
      owner: "acme",
      name: "shop",
    }),
    failed: async () => undefined,
  });
  const cacheOf = () => (fakeRun.mock.calls[0]?.[0] as { cache?: unknown }).cache;
  /** Installation 77 links only `REPO` (db's `findLinkedRepoIds` stand-in). */
  const linkedRepoIds = vi.fn(async (id: number, repoIds: readonly string[]) =>
    id === 77 ? repoIds.filter((repo) => repo === REPO) : [],
  );
  const installationJob = { id: ID, request: { ...REQUEST, installationId: 77 } };
  const installationToken = async () => ({ token: "ghs_installation" });

  it("gives no cache without a cache root", async () => {
    await processJob({ id: ID, request: REQUEST }, deps());
    expect(cacheOf()).toBeUndefined();
  });

  it("gives a public repo the public folder, with the whole cap", async () => {
    const cacheRoot = join(root, "cache");
    await processJob(
      { id: ID, request: REQUEST },
      deps({ cacheRoot, cacheBytes: 1 << 20, recorder: record("public") }),
    );
    expect(cacheOf()).toEqual({ dir: join(cacheRoot, "public"), maxBytes: 1 << 20 });
  });

  it("gives an installation's repo its own folder under its installation", async () => {
    const cacheRoot = join(root, "cache");
    await processJob(
      installationJob,
      deps({ cacheRoot, linkedRepoIds, recorder: record("private"), installationToken }),
    );
    expect(cacheOf()).toMatchObject({ dir: join(cacheRoot, "installations", "77", REPO) });
  });

  it("deletes the facts of repos no longer installed before the analysis (M8.5b2)", async () => {
    const cacheRoot = join(root, "cache");
    const kept = join(cacheRoot, "installations", "77", REPO, "entries");
    const removed = join(cacheRoot, "installations", "77", REMOVED, "entries");
    const uninstalled = join(cacheRoot, "installations", "78", REPO, "entries");
    for (const dir of [kept, removed, uninstalled]) await mkdir(dir, { recursive: true });
    let seen: string[] = [];
    const run: JobDeps["run"] = async (job, options) => {
      seen = await readdir(cacheRoot, { recursive: true });
      return fakeRun(job, options);
    };
    // A public job purges too: any job is the instance's chance to.
    await processJob(
      { id: ID, request: REQUEST },
      deps({ cacheRoot, linkedRepoIds, recorder: record("public"), run }),
    );
    expect(seen.map((name) => name.replaceAll("\\", "/")).sort()).toEqual([
      "installations",
      "installations/77",
      `installations/77/${REPO}`,
      `installations/77/${REPO}/entries`,
      "public",
    ]);
  });

  it("runs an installation's job without a cache when nothing can confirm its links", async () => {
    await processJob(
      installationJob,
      deps({ cacheRoot: join(root, "cache"), recorder: record("private"), installationToken }),
    );
    expect(fakeRun).toHaveBeenCalledOnce();
    expect(cacheOf()).toBeUndefined();
  });

  it("runs without a cache, logging it, when the purge fails", async () => {
    const cacheRoot = join(root, "cache");
    await mkdir(join(cacheRoot, "installations", "77", REMOVED), { recursive: true });
    const events: Record<string, unknown>[] = [];
    await processJob(
      installationJob,
      deps({
        cacheRoot,
        linkedRepoIds: async () =>
          Promise.reject(new TypeError("connect to db.internal.example:5432 failed")),
        recorder: record("private"),
        installationToken,
        log: (event) => void events.push(event),
      }),
    );
    expect(fakeRun).toHaveBeenCalledOnce();
    expect(cacheOf()).toBeUndefined();
    // The error's name only: a database error's message can name its host (M8.10e, F11).
    expect(events).toEqual([{ event: "cache_purge_failed", id: ID, error: "TypeError" }]);
  });

  it("gives a private repo without an installation no cache", async () => {
    await processJob(
      { id: ID, request: REQUEST },
      deps({ cacheRoot: join(root, "cache"), recorder: record("private") }),
    );
    expect(cacheOf()).toBeUndefined();
  });

  it("runs the analysis without a cache when the cache root can't be used", async () => {
    const cacheRoot = join(root, "in-the-way");
    await writeFile(cacheRoot, "a file");
    await processJob({ id: ID, request: REQUEST }, deps({ cacheRoot }));
    expect(fakeRun).toHaveBeenCalledOnce();
    expect(cacheOf()).toBeUndefined();
  });
});

describe("processJob analyzer steps", () => {
  /** A runner stand-in that reports two steps through `onProgress`, then succeeds. */
  const steppingRun: JobDeps["run"] = async (job, options) => {
    options.onProgress?.({ step: "inventory" });
    options.onProgress?.({ step: "programs", count: 3 });
    return fakeRun(job);
  };

  it("asks the runner for progress only when someone listens", async () => {
    await processJob({ id: ID, request: REQUEST }, deps());
    expect(fakeRun.mock.calls[0]?.[1]).not.toHaveProperty("onProgress");
  });

  it("hands each step to onStep at once, in order", async () => {
    const steps: unknown[] = [];
    await processJob(
      { id: ID, request: REQUEST, onStep: (step) => void steps.push(step) },
      deps({ run: steppingRun }),
    );
    expect(steps).toEqual([{ step: "inventory" }, { step: "programs", count: 3 }]);
  });

  it("logs a failing progress update and still finishes the job", async () => {
    const log = vi.fn();
    const outcome = await processJob(
      {
        id: ID,
        request: REQUEST,
        onStep: ({ step }) => {
          if (step === "inventory") throw new Error("redis down");
          return Promise.reject("still down");
        },
      },
      deps({ run: steppingRun, log }),
    );
    expect(outcome.stats).toEqual(STATS);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(log.mock.calls.map(([event]) => event as unknown)).toEqual([
      { event: "progress_failed", id: ID, step: "inventory", message: "redis down" },
      { event: "progress_failed", id: ID, step: "programs", message: "still down" },
    ]);
  });

  const findingRun: JobDeps["run"] = async (job, options) => {
    options.onFound?.({ services: { count: 1, names: ["app"] } });
    options.onFound?.({ services: { count: 1, names: ["app"] }, routes: 2 });
    return fakeRun(job);
  };

  it("hands what was found to onFound in order, asking only when someone listens", async () => {
    await processJob({ id: ID, request: REQUEST }, deps());
    expect(fakeRun.mock.calls[0]?.[1]).not.toHaveProperty("onFound");
    const found: unknown[] = [];
    await processJob(
      { id: ID, request: REQUEST, onFound: (facts) => void found.push(facts) },
      deps({ run: findingRun }),
    );
    expect(found).toEqual([
      { services: { count: 1, names: ["app"] } },
      { services: { count: 1, names: ["app"] }, routes: 2 },
    ]);
  });

  it("logs a failing found update by its keys (never the repo's names)", async () => {
    const log = vi.fn();
    const outcome = await processJob(
      { id: ID, request: REQUEST, onFound: () => Promise.reject(new Error("redis down")) },
      deps({ run: findingRun, log }),
    );
    expect(outcome.stats).toEqual(STATS);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(log.mock.calls[1]?.[0]).toEqual({
      event: "progress_failed",
      id: ID,
      found: ["services", "routes"],
      message: "redis down",
    });
  });
});

describe("processJob downloads", () => {
  it("sends the token to the API only, never to the download host", async () => {
    await processJob({ id: ID, request: REQUEST }, deps());
    expect(github.requests).toEqual([
      {
        server: "api",
        url: `/repos/acme/shop/tarball/${SHA}`,
        authorization: "Bearer test-token",
      },
      {
        server: "codeload",
        url: `/download/repos/acme/shop/tarball/${SHA}?token=grant`,
        authorization: undefined,
      },
    ]);
  });

  it("follows a renamed repo's redirect inside the API, with the token", async () => {
    const original = github.api;
    github.api = (req, res) => {
      if (req.url?.startsWith("/repos/")) {
        res.writeHead(301, { location: `/repositories/42/tarball/${SHA}` });
        res.end();
      } else original(req, res);
    };
    await processJob({ id: ID, request: REQUEST }, deps());
    expect(github.requests.map((r) => [r.server, r.authorization])).toEqual([
      ["api", "Bearer test-token"],
      ["api", "Bearer test-token"],
      ["codeload", undefined],
    ]);
  });

  it.each([
    [404, {}, "REPO_NOT_FOUND", false],
    [451, {}, "REPO_UNAVAILABLE", false],
    [403, { "x-ratelimit-remaining": "0" }, "GITHUB_RATE_LIMITED", true],
    [429, { "retry-after": "60" }, "GITHUB_RATE_LIMITED", true],
    [403, {}, "DOWNLOAD_REFUSED", false],
    [502, {}, "DOWNLOAD_FAILED", true],
  ])("maps GitHub's %i %j to %s (retriable: %s)", async (status, headers, code, retriable) => {
    github.api = (_req, res) => {
      res.writeHead(status, headers);
      res.end("{}");
    };
    const error = await failure(processJob({ id: ID, request: REQUEST }, deps()));
    expect([error.code, error.retriable]).toEqual([code, retriable]);
    expect(fakeRun).not.toHaveBeenCalled();
    expect(await jobFolders()).toEqual([]);
  });

  it("refuses a redirect to any host but the download origins, without fetching it", async () => {
    const error = await failure(
      processJob(
        { id: ID, request: REQUEST },
        deps({
          download: { apiBase: github.apiBase, downloadOrigins: ["https://codeload.github.com"] },
        }),
      ),
    );
    expect(error.code).toBe("DOWNLOAD_REFUSED");
    expect(error.retriable).toBe(false);
    expect(github.requests.map((r) => r.server)).toEqual(["api"]);
  });

  it("fails a network error as retriable", async () => {
    // A `fetch` that fails as a refused connection does: a closed server's port can be taken
    // by another test file's server meanwhile, which then answers.
    const refused = async (): Promise<Response> => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    };
    const error = await failure(
      processJob(
        { id: ID, request: REQUEST },
        deps({ download: { apiBase: github.apiBase, fetch: refused } }),
      ),
    );
    expect([error.code, error.retriable]).toEqual(["DOWNLOAD_FAILED", true]);
    expect(github.requests).toEqual([]);
  });

  it("fails a body cut off mid-stream as retriable", async () => {
    github.codeload = (_req, res) => {
      res.writeHead(200, { "content-length": String(github.tarball.length * 2) });
      res.write(github.tarball.subarray(0, 20));
      setTimeout(() => res.destroy(), 20);
    };
    const error = await failure(processJob({ id: ID, request: REQUEST }, deps()));
    expect([error.code, error.retriable]).toEqual(["DOWNLOAD_FAILED", true]);
    expect(await jobFolders()).toEqual([]);
  });

  it("stops a download that outlasts its budget", async () => {
    github.codeload = (_req, res) => {
      res.writeHead(200);
      res.write(github.tarball.subarray(0, 10));
    };
    const error = await failure(
      processJob({ id: ID, request: REQUEST }, deps({ downloadTimeoutMs: 300 })),
    );
    expect([error.code, error.retriable]).toEqual(["DOWNLOAD_TIMEOUT", true]);
    expect(await jobFolders()).toEqual([]);
  });

  it("is cancelled by its signal while downloading", async () => {
    const controller = new AbortController();
    github.codeload = (_req, res) => {
      res.writeHead(200);
      res.write(github.tarball.subarray(0, 10));
      controller.abort();
    };
    const error = await failure(
      processJob({ id: ID, request: REQUEST, signal: controller.signal }, deps()),
    );
    expect([error.code, error.retriable]).toEqual(["CANCELLED", true]);
    expect(await jobFolders()).toEqual([]);
  });
});

describe("processJob extraction", () => {
  it("fails a path-traversal archive without writing outside the job folder", async () => {
    github.tarball = tarballFrom([{ name: "../../escaped.txt", body: "x" }]);
    const error = await failure(processJob({ id: ID, request: REQUEST }, deps()));
    expect([error.code, error.retriable]).toEqual(["TAR_UNSAFE_PATH", false]);
    expect(await readdir(root)).toEqual(["jobs"]);
    expect(await jobFolders()).toEqual([]);
  });

  it("fails a truncated archive as invalid", async () => {
    github.tarball = github.tarball.subarray(0, github.tarball.length - 8);
    const error = await failure(processJob({ id: ID, request: REQUEST }, deps()));
    expect(error.code).toBe("TAR_INVALID");
  });

  it("counts skipped links and lists a bounded, sorted sample", async () => {
    const links = Array.from({ length: SKIPPED_SAMPLE_SIZE + 5 }, (_, i) => ({
      name: `links/l${String(i).padStart(3, "0")}`,
      type: "2",
      linkname: "/etc/passwd",
    }));
    github.tarball = tarballFrom([{ name: "index.ts", body: "x" }, ...links]);
    const outcome = await processJob({ id: ID, request: REQUEST }, deps());
    expect(outcome.extract.skipped).toBe(SKIPPED_SAMPLE_SIZE + 5);
    expect(outcome.extract.skippedSample).toHaveLength(SKIPPED_SAMPLE_SIZE);
    expect(outcome.extract.skippedSample[0]).toEqual({ path: "links/l000", reason: "SYMLINK" });
  });

  it("passes the extraction limits through", async () => {
    const error = await failure(
      processJob({ id: ID, request: REQUEST }, deps({ extractLimits: { maxEntries: 1 } })),
    );
    expect(error.code).toBe("LIMIT_ENTRIES");
  });
});

describe("processJob analysis and publishing", () => {
  it("hands the runner the extracted source, the repo, and the signal", async () => {
    const controller = new AbortController();
    await processJob(
      { id: ID, request: REQUEST, signal: controller.signal },
      deps({ runOptions: { limits: { timeoutMs: 1000 } } }),
    );
    const [job, options] = fakeRun.mock.calls.at(-1) as unknown as [
      Record<string, string>,
      Record<string, unknown>,
    ];
    expect(job).toMatchObject({ owner: "acme", name: "shop", sha: SHA });
    expect(job.src).toMatch(/[\\/]src$/);
    expect(job.out).toMatch(/[\\/]architecture\.json$/);
    expect(options).toEqual({ limits: { timeoutMs: 1000 }, signal: controller.signal });
  });

  it("fails with the runner's code, keeping its stderr for logs only", async () => {
    const error = await failure(
      processJob(
        { id: ID, request: REQUEST },
        deps({
          run: async () => ({
            ok: false,
            code: "LIMIT_TIME",
            message: "LIMIT_TIME: analysis took longer than 5 minutes.",
            stderrTail: "/tmp/jobs/x/src trace",
            durationMs: 1,
          }),
        }),
      ),
    );
    expect([error.code, error.message, error.retriable]).toEqual([
      "LIMIT_TIME",
      "LIMIT_TIME",
      false,
    ]);
    expect(error.detail).toBe("/tmp/jobs/x/src trace");
    expect(await jobFolders()).toEqual([]);
  });

  it("retries a failed publish and still removes the folder", async () => {
    const error = await failure(
      processJob(
        { id: ID, request: REQUEST },
        deps({
          publish: async () => {
            throw new Error("R2 down");
          },
        }),
      ),
    );
    expect([error.code, error.retriable]).toEqual(["PUBLISH_FAILED", true]);
    expect((error.cause as Error).message).toBe("R2 down");
    expect(await jobFolders()).toEqual([]);
  });

  it("gives each attempt its own folder, so a stalled attempt never shares one", async () => {
    const seen: string[] = [];
    const run = async (job: { out: string }): Promise<RunResult> => {
      seen.push(job.out);
      return fakeRun(job);
    };
    await processJob({ id: ID, request: REQUEST }, deps({ run }));
    await processJob({ id: ID, request: REQUEST }, deps({ run }));
    expect(new Set(seen).size).toBe(2);
    expect(seen.every((out) => out.includes(`${ID}-`))).toBe(true);
  });
});

describe("processJob time budget (R4, second M5 review)", () => {
  const BUDGET = 280_000;
  /** What the analysis is guaranteed in a 280 s attempt: 280 s − 20 s reserve − 30 s download. */
  const GUARANTEE = BUDGET - PUBLISH_RESERVE_MS - DOWNLOAD_ALLOWANCE_MS;

  /** An attempt whose earlier stages (start, download) take `usedMs` of its budget. */
  function slowStart(usedMs: number) {
    const clock = { left: BUDGET };
    const calls: unknown[][] = [];
    const recorder: JobRecorder = {
      start: async () => {
        clock.left -= usedMs;
        return { analysisId: "a1", repoId: "r1", visibility: "public", owner: "a", name: "s" };
      },
      failed: async (_record, code, final) => void calls.push([code, final]),
    };
    return { timeLeft: () => clock.left, recorder, calls };
  }

  it("guaranteedAnalysisMs is that share, never more than the analysis's own limit", () => {
    expect(guaranteedAnalysisMs(BUDGET)).toBe(GUARANTEE);
    expect(GUARANTEE).toBe(230_000);
    expect(guaranteedAnalysisMs(BUDGET, 60_000)).toBe(60_000);
    expect(guaranteedAnalysisMs(10 * 60_000)).toBe(5 * 60_000);
  });

  const timedOut = vi.fn(
    async (): Promise<RunResult> => ({
      ok: false,
      code: "LIMIT_TIME",
      message: "LIMIT_TIME",
      stderrTail: "",
      durationMs: 1,
    }),
  );

  it("fails LIMIT_TIME (permanent) when the analysis had at least its guaranteed share", async () => {
    const { timeLeft, recorder, calls } = slowStart(DOWNLOAD_ALLOWANCE_MS);
    const error = await failure(
      processJob({ id: ID, request: REQUEST, timeLeft }, deps({ recorder, run: timedOut })),
    );
    expect([error.code, error.retriable]).toEqual(["LIMIT_TIME", false]);
    expect(calls).toEqual([["LIMIT_TIME", true]]);
    const options = timedOut.mock.calls.at(-1) as unknown as [unknown, RunOptions];
    expect(options[1].limits?.timeoutMs).toBe(GUARANTEE);
  });

  it("fails retriably, not LIMIT_TIME, when earlier stages cut the analysis below its share", async () => {
    const { timeLeft, recorder, calls } = slowStart(DOWNLOAD_ALLOWANCE_MS + 1000);
    const error = await failure(
      processJob({ id: ID, request: REQUEST, timeLeft }, deps({ recorder, run: timedOut })),
    );
    expect([error.code, error.retriable]).toEqual(["ANALYSIS_TIME_CUT", true]);
    expect(calls).toEqual([["ANALYSIS_TIME_CUT", false]]);
  });

  it("on the last attempt, a cut timeout fails for good, still without a LIMIT_* code", async () => {
    const { timeLeft, recorder, calls } = slowStart(200_000);
    const error = await failure(
      processJob(
        { id: ID, request: REQUEST, timeLeft, lastAttempt: true },
        deps({ recorder, run: timedOut }),
      ),
    );
    expect(error.code).toBe("ANALYSIS_TIME_CUT");
    expect(calls).toEqual([["ANALYSIS_TIME_CUT", true]]);
  });

  it("fails retriably without starting the child when nothing is left for it", async () => {
    const { timeLeft, recorder, calls } = slowStart(BUDGET - PUBLISH_RESERVE_MS - 500);
    timedOut.mockClear();
    const error = await failure(
      processJob({ id: ID, request: REQUEST, timeLeft }, deps({ recorder, run: timedOut })),
    );
    expect([error.code, error.retriable]).toEqual(["ANALYSIS_TIME_CUT", true]);
    expect(timedOut).not.toHaveBeenCalled();
    expect(calls).toEqual([["ANALYSIS_TIME_CUT", false]]);
  });

  it("keeps the runner's other failures as they are under a cut budget", async () => {
    const { timeLeft, recorder } = slowStart(200_000);
    const run = async (): Promise<RunResult> => ({
      ok: false,
      code: "LIMIT_MEMORY",
      message: "LIMIT_MEMORY",
      stderrTail: "",
      durationMs: 1,
    });
    const error = await failure(
      processJob({ id: ID, request: REQUEST, timeLeft }, deps({ recorder, run })),
    );
    expect(error.code).toBe("LIMIT_MEMORY");
  });

  it("keeps LIMIT_TIME when the runner's own, shorter limit was not cut", async () => {
    const { timeLeft, recorder } = slowStart(200_000);
    const error = await failure(
      processJob(
        { id: ID, request: REQUEST, timeLeft },
        deps({ recorder, run: timedOut, runOptions: { limits: { timeoutMs: 10_000 } } }),
      ),
    );
    expect(error.code).toBe("LIMIT_TIME");
  });
});

describe("processJob recording", () => {
  const RECORD: RecordedJob = {
    analysisId: "a1",
    repoId: "r1",
    visibility: "public",
    owner: "Acme",
    name: "Shop",
  };

  function recorder(overrides: Partial<JobRecorder> = {}) {
    const calls: unknown[][] = [];
    const value: JobRecorder = {
      start: async (request) => {
        calls.push(["start", request.sha, github.requests.length]);
        return RECORD;
      },
      failed: async (record, code, final) => void calls.push(["failed", record, code, final]),
      ...overrides,
    };
    return { calls, recorder: value };
  }

  it("records the start before downloading and hands the record and timings to publish", async () => {
    const { calls, recorder: r } = recorder();
    let artifact: JobArtifact | undefined;
    await processJob(
      { id: ID, request: REQUEST },
      deps({ recorder: r, publish: async (a) => void (artifact = a) }),
    );
    expect(calls).toEqual([["start", SHA, 0]]);
    expect(artifact?.record).toEqual(RECORD);
    expect(Object.keys(artifact?.timings ?? {})).toEqual(["downloadMs", "analyzeMs"]);
  });

  it.each([
    ["a permanent failure", "LIMIT_TIME", false, true],
    ["a retriable failure", "CANCELLED", false, false],
    ["a retriable failure on the last attempt", "CANCELLED", true, true],
  ])("records %s as final: %s", async (_, code, lastAttempt, final) => {
    const { calls, recorder: r } = recorder();
    const run = async (): Promise<RunResult> => ({
      ok: false,
      code,
      message: code,
      stderrTail: "",
      durationMs: 1,
    });
    const error = await failure(
      processJob({ id: ID, request: REQUEST, lastAttempt }, deps({ recorder: r, run })),
    );
    expect(error.code).toBe(code);
    expect(calls.at(-1)).toEqual(["failed", RECORD, code, final]);
  });

  it("records an unexpected error as the processor's WORKER_ERROR", async () => {
    const { calls, recorder: r } = recorder();
    const run = async (): Promise<RunResult> => {
      throw new TypeError("boom");
    };
    await expect(
      processJob({ id: ID, request: REQUEST }, deps({ recorder: r, run })),
    ).rejects.toThrow("boom");
    expect(calls.at(-1)).toEqual(["failed", RECORD, "WORKER_ERROR", false]);
  });

  it("logs a failure to record a failure, and still fails with the job's own code", async () => {
    const logs: Record<string, unknown>[] = [];
    const { recorder: r } = recorder({
      failed: async () => {
        throw new Error("db down");
      },
    });
    const error = await failure(
      processJob(
        { id: ID, request: REQUEST },
        deps({
          recorder: r,
          log: (e) => void logs.push(e),
          publish: async () => {
            throw new Error("R2 down");
          },
        }),
      ),
    );
    expect(error.code).toBe("PUBLISH_FAILED");
    expect(logs).toEqual([
      { event: "record_failed", id: ID, code: "PUBLISH_FAILED", message: "db down" },
    ]);
  });

  it("records nothing when the start itself fails, and never downloads", async () => {
    const { calls, recorder: r } = recorder({
      start: async () => {
        throw new JobFailure("REPO_NOT_PUBLIC");
      },
    });
    const error = await failure(processJob({ id: ID, request: REQUEST }, deps({ recorder: r })));
    expect([error.code, error.retriable]).toEqual(["REPO_NOT_PUBLIC", false]);
    expect(calls).toEqual([]);
    expect(github.requests).toEqual([]);
    expect(await jobFolders()).toEqual([]);
  });

  it("tells the recorder of a final failure before the start, and logs if that fails", async () => {
    const early: unknown[] = [];
    const logs: Record<string, unknown>[] = [];
    const { recorder: r } = recorder({
      start: async () => {
        throw new JobFailure("REPO_NOT_PUBLIC");
      },
    });
    r.failedBeforeStart = async (jobId, code) => {
      early.push([jobId, code]);
      throw new Error("db down");
    };
    const error = await failure(
      processJob(
        { id: ID, request: REQUEST },
        deps({ recorder: r, log: (e) => void logs.push(e) }),
      ),
    );
    expect(error.code).toBe("REPO_NOT_PUBLIC");
    expect(early).toEqual([[ID, "REPO_NOT_PUBLIC"]]);
    expect(logs).toEqual([
      { event: "record_failed", id: ID, code: "REPO_NOT_PUBLIC", message: "db down" },
    ]);
  });

  it("asks for an installation's token before the start, and gives it to the start", async () => {
    const order: unknown[] = [];
    const { recorder: r } = recorder({
      start: async (_request, _signal, _jobId, token) => {
        order.push(["start", token]);
        throw new JobFailure("REPO_NOT_FOUND");
      },
    });
    await failure(
      processJob(
        { id: ID, request: { ...REQUEST, installationId: 77 } },
        deps({
          recorder: r,
          installationToken: async (ask, signal) => {
            order.push(["token", ask, signal.aborted]);
            return { token: "ghs_installation" };
          },
        }),
      ),
    );
    expect(order).toEqual([
      ["token", { jobId: ID, installationId: 77 }, false],
      ["start", "ghs_installation"],
    ]);
  });

  it("gives the start the download's cancellation", async () => {
    const controller = new AbortController();
    const { recorder: r } = recorder({
      start: async (_request, signal) => {
        controller.abort();
        expect(signal.aborted).toBe(true);
        throw signal.reason;
      },
    });
    const error = await failure(
      processJob({ id: ID, request: REQUEST, signal: controller.signal }, deps({ recorder: r })),
    );
    expect(error.code).toBe("CANCELLED");
  });
});

describe("processJob refuses", () => {
  it("diff jobs, which run through processDiffJob (diffJob.test.ts)", async () => {
    const error = await failure(
      processJob({ id: ID, request: { ...REQUEST, kind: "diff", baseSha: SHA } }, deps()),
    );
    expect([error.code, error.retriable]).toEqual(["UNSUPPORTED_JOB", false]);
    expect(github.requests).toEqual([]);
  });

  it.each(["../x", "a/b", "", "x".repeat(101)])("the job ID %j", async (id) => {
    const error = await failure(processJob({ id, request: REQUEST }, deps()));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("sweepJobsRoot", () => {
  it("removes leftover job folders and files", async () => {
    await mkdir(join(jobsRoot, `${ID}-abc`, "src"), { recursive: true });
    await writeFile(join(jobsRoot, `${ID}-abc`, "src", "a.ts"), "x");
    await writeFile(join(jobsRoot, "stray"), "x");
    expect(await sweepJobsRoot(jobsRoot)).toBe(2);
    expect(await readdir(jobsRoot)).toEqual([]);
  });

  it("treats a missing root as empty", async () => {
    expect(await sweepJobsRoot(join(root, "missing"))).toBe(0);
  });
});
