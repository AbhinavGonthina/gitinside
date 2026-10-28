import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRequest } from "./api.js";
import { JobFailure } from "./failure.js";
import { startFakeGitHub, tarballFrom, tarballOf, type FakeGitHub } from "./github.testkit.js";
import {
  SKIPPED_SAMPLE_SIZE,
  processJob,
  sweepJobsRoot,
  type JobArtifact,
  type JobDeps,
  type JobStage,
} from "./job.js";
import type { RunResult } from "./runner.js";

const WORKER = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WORKER, "dist");
const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ID = "analyze-0123456789abcdef0123456789abcdef";

const REQUEST: JobRequest = { kind: "analyze", owner: "acme", repo: "shop", sha: SHA };
const STATS = { nodes: 3, edges: 2, unresolved: 0, warnings: 0, graphBytes: 2, stageMs: {} };

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
const fakeRun = vi.fn(async (job: { out: string }): Promise<RunResult> => {
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
    const stages: JobStage[] = [];
    let published: { artifact: JobArtifact; graph: string } | undefined;
    const real = deps({
      runOptions: { scriptsDir: DIST },
      publish: async (artifact) => {
        published = { artifact, graph: await readFile(artifact.graphPath, "utf8") };
      },
    });
    delete real.run;
    const outcome = await processJob(
      { id: ID, request: REQUEST, onStage: (stage) => void stages.push(stage) },
      real,
    );

    expect(stages).toEqual(["download", "extract", "analyze", "upload"]);
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
    const closed = github.apiBase;
    await github.close();
    const error = await failure(
      processJob({ id: ID, request: REQUEST }, deps({ download: { apiBase: closed } })),
    );
    expect([error.code, error.retriable]).toEqual(["DOWNLOAD_FAILED", true]);
    github = await startFakeGitHub();
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

describe("processJob refuses", () => {
  it("diff jobs until M6", async () => {
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
