import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAttempt } from "./attempt.js";
import { processDiffJob, type DiffRecorder, type DiffToStore } from "./diffJob.js";
import { JobFailure } from "./failure.js";
import { startFakeGitHub, tarballOf, type FakeGitHub } from "./github.testkit.js";
import { JobAlreadyDone, type JobContext, type JobDeps, type JobStage } from "./job.js";
import type { ChildJob } from "./protocol.js";
import type { JobRequest } from "./request.js";
import type { RunOptions, RunResult } from "./runner.js";

const WORKER = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(WORKER, "dist");
const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
/** The event's base (the base branch's tip), its merge base with the head, and the head. */
const BASE = "b".repeat(40);
const MERGE = "a".repeat(40);
const HEAD = "c".repeat(40);
const ID = "diff-0123456789abcdef0123456789abcdef";
const INSTALLATION = 42;
const REPO_ID = "0b6a1c1e-9a3e-4c55-8e0c-6c3f2a4b5d6e";
const REQUEST: JobRequest = {
  kind: "diff",
  owner: "acme",
  repo: "shop",
  sha: HEAD,
  baseSha: BASE,
  installationId: INSTALLATION,
};
const STATS = {
  files: 3,
  nodes: 9,
  edges: 6,
  unresolved: 1,
  warnings: 0,
  graphBytes: 2,
  stageMs: {},
};
/** Each side's tree and its committed graph (what the real analyzer makes of it). */
const TREES: Record<string, string> = {
  [MERGE]: join(FIXTURES, "diff-rename-base"),
  [HEAD]: join(FIXTURES, "diff-rename-head"),
};

let github: FakeGitHub;
let root: string;
let jobsRoot: string;
let tarballs: Record<string, Buffer>;
let mergeBaseStatus: number;

beforeEach(async () => {
  github = await startFakeGitHub();
  tarballs = {
    [MERGE]: await tarballOf(TREES[MERGE] as string),
    [HEAD]: await tarballOf(TREES[HEAD] as string),
  };
  mergeBaseStatus = 200;
  const redirect = github.api;
  github.api = (req, res) => {
    if (!(req.url ?? "").includes("/compare/")) {
      redirect(req, res);
      return;
    }
    res.writeHead(mergeBaseStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(mergeBaseStatus === 200 ? { merge_base_commit: { sha: MERGE } } : {}));
  };
  github.codeload = (req, res) => {
    const sha = Object.keys(tarballs).find((s) => (req.url ?? "").includes(`/tarball/${s}`));
    if (sha === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/x-gzip" });
    res.end(tarballs[sha]);
  };
  root = await mkdtemp(join(tmpdir(), "gitinside-diffjob-"));
  jobsRoot = join(root, "jobs");
});

afterEach(async () => {
  await github.close();
  await rm(root, { recursive: true, force: true });
});

/** A runner stand-in that writes the side's committed graph, so most tests skip the child. */
const fakeRun = (
  hook: (job: ChildJob, options?: RunOptions) => RunResult | undefined = () => undefined,
) =>
  vi.fn(async (job: ChildJob, options?: RunOptions): Promise<RunResult> => {
    const answer = hook(job, options);
    if (answer !== undefined) return answer;
    await copyFile(join(TREES[job.sha ?? ""] as string, "expected.json"), job.out);
    return { ok: true, stats: STATS, durationMs: 1 };
  });

/** A side as `storeSide` received it, with its graph file's text read at the call. */
type StoredSide = Omit<Parameters<DiffRecorder["storeSide"]>[0], "graphPath"> & { text: string };

/**
 * A recorder that finds the job queued, stores every analyzed side, and collects what's
 * stored and published (`calls` in order).
 */
function recorder(overrides: Partial<DiffRecorder> = {}) {
  const published: DiffToStore[] = [];
  const sides: StoredSide[] = [];
  const calls: string[] = [];
  const diffs: DiffRecorder = {
    find: async () => ({ repoId: REPO_ID, status: "queued" }),
    storedGraph: async () => undefined,
    storeSide: async ({ graphPath, ...side }) => {
      calls.push(`storeSide ${side.sha}`);
      sides.push({ ...side, text: readFileSync(graphPath, "utf8") });
      return true;
    },
    publish: async (stored) => {
      calls.push("publish");
      published.push(stored);
      return [{ repoId: REPO_ID, number: 7, baseSha: BASE, headSha: HEAD }];
    },
    ...overrides,
  };
  return { diffs, published, sides, calls };
}

function deps(overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    jobsRoot,
    publish: async () => {
      throw new Error("a diff job never publishes an analysis");
    },
    download: {
      apiBase: github.apiBase,
      downloadOrigins: [github.codeloadOrigin],
      token: "worker-token",
    },
    installationToken: async () => "installation-token",
    diffs: recorder().diffs,
    run: fakeRun(),
    ...overrides,
  };
}

const context = (more: Partial<JobContext> = {}): JobContext => ({
  id: ID,
  request: REQUEST,
  ...more,
});

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

const jobFolders = (): Promise<string[]> => readdir(jobsRoot).catch(() => []);
const asked = () => github.requests.map((r) => `${r.server} ${r.url.split("?")[0] ?? ""}`);

describe("processDiffJob with the real analyzer", () => {
  it("diffs the merge base against the head with both trees' text, and stores the diff", async () => {
    const { diffs, published } = recorder();
    const real = deps({ diffs, runOptions: { scriptsDir: DIST } });
    delete real.run;
    const stages: JobStage[] = [];
    const outcome = await processDiffJob(
      context({ onStage: (stage) => void stages.push(stage) }),
      real,
    );

    expect(stages).toEqual(["download", "extract", "analyze", "upload"]);
    const [stored] = published;
    expect(published).toHaveLength(1);
    expect(stored).toMatchObject({
      jobId: ID,
      installationId: INSTALLATION,
      repoId: REPO_ID,
      mergeBase: MERGE,
      headSha: HEAD,
    });
    // The moved and edited file is found only by comparing both trees' text (ADR-0086).
    expect(stored?.diff.nodes.renamed.map((r) => [r.from, r.node.id])).toContainEqual([
      "file:diff-rename/src/routes/orders.ts",
      "file:diff-rename/src/orders/routes.ts",
    ]);
    expect(stored?.diff.nodes.removed).toEqual([]);
    expect(outcome.diff).toEqual({
      mergeBase: MERGE,
      broken: 0,
      pullRequests: 1,
      reused: [],
      stored: ["mergeBase", "head"],
    });
    expect(outcome.stats.nodes).toBeGreaterThan(0);
    expect(outcome.extract.files).toBeGreaterThan(0);
    expect(await jobFolders()).toEqual([]);
  });
});

describe("processDiffJob", () => {
  it("reads through the installation: the compare, then the merge base's and the head's tarballs", async () => {
    await processDiffJob(context(), deps());
    expect(asked()).toEqual([
      `api /repos/acme/shop/compare/${BASE}...${HEAD}`,
      `api /repos/acme/shop/tarball/${MERGE}`,
      `codeload /download/repos/acme/shop/tarball/${MERGE}`,
      `api /repos/acme/shop/tarball/${HEAD}`,
      `codeload /download/repos/acme/shop/tarball/${HEAD}`,
    ]);
    // The event's base is never downloaded: diffing its tip would show later base changes as reverts.
    expect(asked().some((r) => r.endsWith(`/tarball/${BASE}`))).toBe(false);
    const api = github.requests.filter((r) => r.server === "api");
    expect(new Set(api.map((r) => r.authorization))).toEqual(
      new Set(["Bearer installation-token"]),
    );
  });

  it("asks for the token by the job's ID and installation", async () => {
    const installationToken = vi.fn(async () => "installation-token");
    await processDiffJob(context(), deps({ installationToken }));
    expect(installationToken).toHaveBeenCalledWith(
      { jobId: ID, installationId: INSTALLATION },
      expect.any(AbortSignal),
    );
  });

  it("analyzes the merge base, then the head, each in its own folder, with the repo's fact cache", async () => {
    const run = fakeRun();
    const linkedRepoIds = vi.fn(async (_id: number, repoIds: readonly string[]) => repoIds);
    const cacheRoot = join(root, "cache");
    await processDiffJob(context(), deps({ run, cacheRoot, linkedRepoIds }));
    const jobs = run.mock.calls.map(([job]) => job as unknown as Record<string, unknown>);
    expect(jobs.map((j) => j.sha)).toEqual([MERGE, HEAD]);
    expect(jobs.map((j) => [j.owner, j.name])).toEqual([
      ["acme", "shop"],
      ["acme", "shop"],
    ]);
    expect(jobs[0]?.src).not.toBe(jobs[1]?.src);
    const folder = join(cacheRoot, "installations", String(INSTALLATION), REPO_ID);
    expect(jobs.map((j) => (j.cache as { dir: string } | undefined)?.dir)).toEqual([
      folder,
      folder,
    ]);
  });

  it("runs both sides cold when the cache can't be checked", async () => {
    const run = fakeRun();
    await processDiffJob(context(), deps({ run, cacheRoot: join(root, "cache") }));
    expect(run.mock.calls.map(([job]) => "cache" in job)).toEqual([false, false]);
  });

  it("answers no pull requests when each record moved on, and keeps the diff for retention", async () => {
    const { diffs } = recorder({ publish: async () => [] });
    const outcome = await processDiffJob(context(), deps({ diffs }));
    expect(outcome.diff?.pullRequests).toBe(0);
  });

  it("is runAttempt's job for a diff request, logged with its result", async () => {
    const logs: Record<string, unknown>[] = [];
    const result = await runAttempt(
      { id: ID, data: REQUEST, attempt: 1, lastAttempt: false },
      deps(),
      (event) => void logs.push(event),
    );
    expect(result.ok).toBe(true);
    expect(logs).toEqual([
      expect.objectContaining({
        event: "job_done",
        id: ID,
        mergeBase: MERGE,
        broken: 0,
        pullRequests: 1,
      }),
    ]);
  });
});

describe("processDiffJob with stored graphs (M8.6d3c2)", () => {
  /** `sha`'s committed graph as the bucket would hold it: naming that commit. */
  const storedText = (sha: string, as: string = sha): string => {
    const graph = JSON.parse(readFileSync(join(TREES[sha] as string, "expected.json"), "utf8")) as {
      repo: Record<string, unknown>;
    };
    return JSON.stringify({ ...graph, repo: { ...graph.repo, sha: as } });
  };

  it("reads both sides' stored graphs instead of analyzing, still diffing both trees' text", async () => {
    const storedGraph = vi.fn(async ({ sha }: { sha: string }) => storedText(sha));
    const { diffs, published, sides } = recorder({ storedGraph });
    const run = fakeRun();
    const linkedRepoIds = vi.fn(async (_id: number, repoIds: readonly string[]) => repoIds);
    const cacheRoot = join(root, "cache");
    // A repo's cached facts, which preparing a cache would check against the database.
    await mkdir(join(cacheRoot, "installations", String(INSTALLATION), REPO_ID), {
      recursive: true,
    });
    const outcome = await processDiffJob(context(), deps({ diffs, run, cacheRoot, linkedRepoIds }));

    expect(run).not.toHaveBeenCalled();
    // Nothing analyzed, so no cache prepared (and no database read for it).
    expect(linkedRepoIds).not.toHaveBeenCalled();
    expect(storedGraph.mock.calls.map(([side]) => side)).toEqual([
      { installationId: INSTALLATION, repoId: REPO_ID, sha: MERGE },
      { installationId: INSTALLATION, repoId: REPO_ID, sha: HEAD },
    ]);
    // Both trees are still downloaded: rename detection reads their text.
    expect(asked().filter((r) => r.startsWith("codeload"))).toHaveLength(2);
    expect(published[0]?.diff.nodes.renamed.map((r) => [r.from, r.node.id])).toContainEqual([
      "file:diff-rename/src/routes/orders.ts",
      "file:diff-rename/src/orders/routes.ts",
    ]);
    expect(outcome.diff?.reused).toEqual(["mergeBase", "head"]);
    // Both are stored already: nothing to store again.
    expect(sides).toEqual([]);
    expect(outcome.diff?.stored).toEqual([]);
    const head = JSON.parse(storedText(HEAD)) as {
      nodes: { kind: string }[];
      edges: unknown[];
      warnings: unknown[];
    };
    expect(outcome.stats).toEqual({
      files: head.nodes.filter((n) => n.kind === "file").length,
      nodes: head.nodes.length,
      edges: head.edges.length,
      unresolved: head.nodes.filter((n) => n.kind === "unresolved").length,
      warnings: head.warnings.length,
      graphBytes: Buffer.byteLength(storedText(HEAD)),
      stageMs: {},
    });
    expect(await jobFolders()).toEqual([]);
  });

  it("analyzes only the side without a stored graph, with the fact cache", async () => {
    const storedGraph = async ({ sha }: { sha: string }) =>
      sha === MERGE ? storedText(MERGE) : undefined;
    const { diffs, sides } = recorder({ storedGraph });
    const run = fakeRun();
    const linkedRepoIds = vi.fn(async (_id: number, repoIds: readonly string[]) => repoIds);
    const cacheRoot = join(root, "cache");
    const outcome = await processDiffJob(context(), deps({ diffs, run, cacheRoot, linkedRepoIds }));
    expect(run.mock.calls.map(([job]) => job.sha)).toEqual([HEAD]);
    expect(run.mock.calls.map(([job]) => "cache" in job)).toEqual([true]);
    expect(outcome.diff?.reused).toEqual(["mergeBase"]);
    expect(sides.map((s) => s.sha)).toEqual([HEAD]);
    expect(outcome.diff?.stored).toEqual(["head"]);
    expect(outcome.stats).toEqual(STATS);
  });

  it.each([
    ["names another commit", async () => storedText(MERGE, "f".repeat(40))],
    ["isn't JSON", async () => "{"],
    ["isn't a graph", async () => JSON.stringify({ nodes: [] })],
    [
      "can't be read",
      async () => {
        throw new Error("GET answered 500");
      },
    ],
  ])("analyzes a side whose stored graph %s, and logs it", async (_, read) => {
    const storedGraph = async ({ sha }: { sha: string }) =>
      sha === MERGE ? read() : storedText(HEAD);
    const { diffs } = recorder({ storedGraph });
    const run = fakeRun();
    const logs: Record<string, unknown>[] = [];
    const outcome = await processDiffJob(
      context(),
      deps({ diffs, run, log: (event) => void logs.push(event) }),
    );
    expect(run.mock.calls.map(([job]) => job.sha)).toEqual([MERGE]);
    expect(outcome.diff?.reused).toEqual(["head"]);
    expect(logs).toEqual([
      expect.objectContaining({ event: "stored_graph_unread", id: ID, sha: MERGE }),
    ]);
  });
});

describe("processDiffJob stores the sides it analyzed (M8.6d4)", () => {
  it("stores each analyzed side's graph and stats under the job's installation and repo, before the diff", async () => {
    const { diffs, sides, calls } = recorder();
    const outcome = await processDiffJob(context(), deps({ diffs }));
    const graph = (sha: string) =>
      readFileSync(join(TREES[sha] as string, "expected.json"), "utf8");
    expect(sides).toEqual([
      {
        installationId: INSTALLATION,
        repoId: REPO_ID,
        sha: MERGE,
        stats: STATS,
        text: graph(MERGE),
      },
      { installationId: INSTALLATION, repoId: REPO_ID, sha: HEAD, stats: STATS, text: graph(HEAD) },
    ]);
    // Stored before the diff is recorded, so the pull request's link has both diagrams.
    expect(calls).toEqual([`storeSide ${MERGE}`, `storeSide ${HEAD}`, "publish"]);
    expect(outcome.diff?.stored).toEqual(["mergeBase", "head"]);
  });

  it("leaves out a side the recorder didn't write (another job holds its row)", async () => {
    const { diffs } = recorder({ storeSide: async ({ sha }) => sha === HEAD });
    const outcome = await processDiffJob(context(), deps({ diffs }));
    expect(outcome.diff?.stored).toEqual(["head"]);
  });

  it("logs a side it couldn't store and still publishes the diff", async () => {
    const { diffs, published } = recorder({
      storeSide: async ({ sha }) => {
        if (sha === MERGE) throw new Error("PUT answered 503");
        return true;
      },
    });
    const logs: Record<string, unknown>[] = [];
    const outcome = await processDiffJob(
      context(),
      deps({ diffs, log: (event) => void logs.push(event) }),
    );
    expect(logs).toEqual([
      { event: "side_store_failed", id: ID, sha: MERGE, message: "PUT answered 503" },
    ]);
    expect(published).toHaveLength(1);
    expect(outcome.diff?.stored).toEqual(["head"]);
  });

  it("stores the merge base as soon as it's analyzed, so a retry after the head ran out of time reads it", async () => {
    const { diffs, sides } = recorder();
    const run = fakeRun((job) =>
      job.sha === HEAD
        ? { ok: false, code: "LIMIT_TIME", message: "", stderrTail: "", durationMs: 1 }
        : undefined,
    );
    await failure(processDiffJob(context(), deps({ diffs, run })));
    expect(sides.map((s) => s.sha)).toEqual([MERGE]);
  });
});

describe("processDiffJob stops before downloading", () => {
  it("when no record names the job (its pull requests moved on): permanent JOB_NOT_LIVE", async () => {
    const installationToken = vi.fn(async () => "installation-token");
    const { diffs } = recorder({ find: async () => undefined });
    const error = await failure(processDiffJob(context(), deps({ diffs, installationToken })));
    expect([error.code, error.retriable]).toEqual(["JOB_NOT_LIVE", false]);
    expect(installationToken).not.toHaveBeenCalled();
    expect(github.requests).toEqual([]);
    expect(await jobFolders()).toEqual([]);
  });

  it("when every record naming it has its diff: already done", async () => {
    const { diffs } = recorder({ find: async () => ({ repoId: REPO_ID, status: "done" }) });
    await expect(processDiffJob(context(), deps({ diffs }))).rejects.toBeInstanceOf(JobAlreadyDone);
    expect(github.requests).toEqual([]);
  });

  it("when the records can't be read: the retriable RECORD_FAILED", async () => {
    const { diffs } = recorder({
      find: async () => {
        throw new Error("connection reset");
      },
    });
    const error = await failure(processDiffJob(context(), deps({ diffs })));
    expect([error.code, error.retriable]).toEqual(["RECORD_FAILED", true]);
  });

  const all = (d: JobDeps): JobDeps => d;
  const noDiffs = ({ diffs: _, ...d }: JobDeps): JobDeps => d;
  const noTokens = ({ installationToken: _, ...d }: JobDeps): JobDeps => d;
  it.each([
    ["no installation", { ...REQUEST, installationId: undefined }, all, "INVALID_REQUEST"],
    [
      "an analysis",
      { kind: "analyze", owner: "acme", repo: "shop", sha: HEAD },
      all,
      "UNSUPPORTED_JOB",
    ],
    ["no diff recorder", REQUEST, noDiffs, "UNSUPPORTED_JOB"],
    ["no token source", REQUEST, noTokens, "TOKEN_UNCONFIGURED"],
  ] as const)("with %s", async (_what, request, pick, code) => {
    const error = await failure(
      processDiffJob(context({ request: request as JobRequest }), pick(deps())),
    );
    expect([error.code, error.retriable]).toEqual([code, false]);
    expect(github.requests).toEqual([]);
  });

  it("when GitHub has no merge base: permanent MERGE_BASE_NOT_FOUND, nothing downloaded", async () => {
    mergeBaseStatus = 404;
    const run = fakeRun();
    const error = await failure(processDiffJob(context(), deps({ run })));
    expect([error.code, error.retriable]).toEqual(["MERGE_BASE_NOT_FOUND", false]);
    expect(asked()).toEqual([`api /repos/acme/shop/compare/${BASE}...${HEAD}`]);
    expect(run).not.toHaveBeenCalled();
  });

  it("when a side's tarball is gone: its failure, nothing analyzed", async () => {
    tarballs = { [MERGE]: tarballs[MERGE] as Buffer };
    const run = fakeRun();
    const error = await failure(processDiffJob(context(), deps({ run })));
    expect(error.code).toBe("REPO_NOT_FOUND");
    expect(run).not.toHaveBeenCalled();
    expect(await jobFolders()).toEqual([]);
  });
});

describe("processDiffJob under the attempt's deadline", () => {
  const limitTime: RunResult = {
    ok: false,
    code: "LIMIT_TIME",
    message: "LIMIT_TIME",
    stderrTail: "",
    durationMs: 1,
  };

  it("fails as the permanent LIMIT_TIME when the merge base outruns its whole share", async () => {
    const run = fakeRun((job) => (job.sha === MERGE ? limitTime : undefined));
    const error = await failure(
      processDiffJob(context({ timeLeft: () => 280_000 }), deps({ run })),
    );
    expect([error.code, error.retriable]).toEqual(["LIMIT_TIME", false]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails as the retriable ANALYSIS_TIME_CUT when the head runs out of what the merge base left", async () => {
    let left = 280_000;
    const timeouts: (number | undefined)[] = [];
    const run = fakeRun((job, options) => {
      timeouts.push(options?.limits?.timeoutMs);
      if (job.sha === MERGE) {
        left -= 200_000;
        return undefined;
      }
      return limitTime;
    });
    const error = await failure(processDiffJob(context({ timeLeft: () => left }), deps({ run })));
    expect([error.code, error.retriable]).toEqual(["ANALYSIS_TIME_CUT", true]);
    // 280 s less the publish reserve, then what the merge base left less it.
    expect(timeouts).toEqual([260_000, 60_000]);
    expect(await jobFolders()).toEqual([]);
  });

  it("doesn't start the head when no time is left for it", async () => {
    let left = 280_000;
    const run = fakeRun((job) => {
      if (job.sha === MERGE) left = 10_000;
      return undefined;
    });
    const error = await failure(processDiffJob(context({ timeLeft: () => left }), deps({ run })));
    expect(error.code).toBe("ANALYSIS_TIME_CUT");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("processDiffJob's publish", () => {
  it("fails as the retriable PUBLISH_FAILED when storing fails, and removes the job folder", async () => {
    const { diffs } = recorder({
      publish: async () => {
        throw new Error("bucket unavailable");
      },
    });
    const error = await failure(processDiffJob(context(), deps({ diffs })));
    expect([error.code, error.retriable]).toEqual(["PUBLISH_FAILED", true]);
    expect(await jobFolders()).toEqual([]);
  });

  it("keeps a failure the recorder named itself", async () => {
    const { diffs } = recorder({
      publish: async () => {
        throw new JobFailure("REPO_NOT_INSTALLED");
      },
    });
    const error = await failure(processDiffJob(context(), deps({ diffs })));
    expect(error.code).toBe("REPO_NOT_INSTALLED");
  });
});
