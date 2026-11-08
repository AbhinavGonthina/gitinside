import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffGraphs, PR_COMMENT_MARKER } from "@gitinside/diff";
import { parseGraph, stringifyDiff } from "@gitinside/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAttempt } from "./attempt.js";
import {
  processDiffJob,
  type DiffRecorder,
  type DiffToStore,
  type PostingRecord,
} from "./diffJob.js";
import { JobFailure } from "./failure.js";
import { startFakeGitHub, tarballOf, type FakeGitHub } from "./github.testkit.js";
import type { TokenAsk } from "./installationToken.js";
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

const SITE = "https://gitinside.example";
const KEY = `private/${String(INSTALLATION)}/${REPO_ID}/diffs/${MERGE}-${HEAD}/0.1.0.json.gz`;

/** A write to GitHub's comment or Check Run API, as the fake received it. */
interface Write {
  method: string;
  path: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
}

let github: FakeGitHub;
let root: string;
let jobsRoot: string;
let tarballs: Record<string, Buffer>;
let mergeBaseStatus: number;
/** The writes to the comment and Check Run API, in order. */
let writes: Write[];
/** The pull requests' comments by ID, with their pull request's number, as the fake GitHub keeps them. */
let comments: Map<number, { number: number; body: string; user: { type: string } }>;
let lastId: number;
/** A status to answer a comment or Check Run request with instead, by method and path. */
let refuse: (method: string, path: string) => number | undefined;

const POST_PATH = /^\/repos\/acme\/shop\/(issues\/\d+\/comments|issues\/comments\/\d+|check-runs)$/;

/** GitHub's comment and Check Run API, keeping comments in {@link comments}. */
function postApi(req: IncomingMessage, res: ServerResponse, path: string): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const answer = (status: number, value: unknown = {}) => {
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(value));
    };
    const method = req.method ?? "";
    const text = Buffer.concat(chunks).toString();
    const body = (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
    if (method !== "GET") {
      writes.push({ method, path, body, authorization: req.headers.authorization });
    }
    const refused = refuse(method, path);
    if (refused !== undefined) return answer(refused, { message: "refused" });
    if (path.endsWith("/check-runs")) return answer(201, { id: ++lastId });
    const edited = /comments\/(\d+)$/.exec(path);
    if (method === "PATCH" && edited !== null) {
      const id = Number(edited[1]);
      const comment = comments.get(id);
      if (comment === undefined) return answer(404);
      comment.body = String(body.body);
      return answer(200, { id });
    }
    const number = Number(/issues\/(\d+)\/comments$/.exec(path)?.[1]);
    if (method === "GET") {
      const listed = [...comments].filter(([, c]) => c.number === number);
      return answer(
        200,
        listed.map(([id, c]) => ({ id, body: c.body, user: c.user })),
      );
    }
    const id = ++lastId;
    comments.set(id, { number, body: String(body.body), user: { type: "Bot" } });
    return answer(201, { id });
  });
}

beforeEach(async () => {
  github = await startFakeGitHub();
  tarballs = {
    [MERGE]: await tarballOf(TREES[MERGE] as string),
    [HEAD]: await tarballOf(TREES[HEAD] as string),
  };
  mergeBaseStatus = 200;
  writes = [];
  comments = new Map();
  lastId = 1000;
  refuse = () => undefined;
  const redirect = github.api;
  github.api = (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (POST_PATH.test(path)) {
      postApi(req, res, path);
      return;
    }
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

/**
 * A runner stand-in that writes the side's committed graph naming acme/shop at that commit, as
 * the child would, so most tests skip the child.
 */
const fakeRun = (
  hook: (job: ChildJob, options?: RunOptions) => RunResult | undefined = () => undefined,
) =>
  vi.fn(async (job: ChildJob, options?: RunOptions): Promise<RunResult> => {
    const answer = hook(job, options);
    if (answer !== undefined) return answer;
    await writeFile(job.out, storedText(job.sha ?? ""));
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
    // No record left to post to unless a test says so (`naming`).
    posts: async () => [],
    current: async () => undefined,
    storedDiff: async () => undefined,
    reopen: async () => 0,
    recordComment: async () => true,
    recordCheckRun: async () => true,
    ...overrides,
  };
  return { diffs, published, sides, calls };
}

/**
 * Pull request records `numbers` naming the job at (BASE, HEAD), kept in memory: `posts` lists
 * those with the diff (once published, or from the start when `diffed`) and no Check Run, and
 * the comment and Check Run writes land on them. `calls` records the writes in order.
 */
function naming(numbers: number[], options: { diffed?: boolean } = {}) {
  const records = new Map<number, PostingRecord>(
    numbers.map((number) => [
      number,
      { diffJobId: ID, baseSha: BASE, headSha: HEAD, commentId: null, checkRunId: null },
    ]),
  );
  const calls: string[] = [];
  const published: DiffToStore[] = [];
  let diffed = options.diffed ?? false;
  const overrides: Partial<DiffRecorder> = {
    find: async () => ({ repoId: REPO_ID, status: diffed ? "diffed" : "queued" }),
    publish: async (stored) => {
      calls.push("publish");
      published.push(stored);
      diffed = true;
      return numbers.map((number) => ({ repoId: REPO_ID, number, baseSha: BASE, headSha: HEAD }));
    },
    posts: async () =>
      diffed
        ? [...records]
            .filter(([, r]) => r.diffJobId === ID && r.checkRunId === null)
            .map(([number, r]) => ({
              repoId: REPO_ID,
              number,
              baseSha: r.baseSha,
              headSha: r.headSha,
              diffKey: KEY,
            }))
        : [],
    current: async ({ number }) => {
      const record = records.get(number);
      return record === undefined ? undefined : { ...record };
    },
    recordComment: async ({ number, commentId }) => {
      calls.push(`comment ${String(number)}`);
      const record = records.get(number);
      if (record === undefined) return false;
      record.commentId = commentId;
      return true;
    },
    recordCheckRun: async ({ number, baseSha, headSha, checkRunId }) => {
      calls.push(`checkRun ${String(number)}`);
      const record = records.get(number);
      if (record?.baseSha !== baseSha || record.headSha !== headSha) return false;
      record.checkRunId = checkRunId;
      return true;
    },
    reopen: async () => {
      calls.push("reopen");
      diffed = false;
      return numbers.length;
    },
  };
  return { records, calls, published, overrides };
}

/** `sha`'s committed graph as the bucket would hold it: acme/shop at commit `as`. */
const storedText = (sha: string, as: string = sha): string => {
  const graph = JSON.parse(readFileSync(join(TREES[sha] as string, "expected.json"), "utf8")) as {
    repo: Record<string, unknown>;
  };
  return JSON.stringify({
    ...graph,
    repo: { ...graph.repo, owner: "acme", name: "shop", sha: as },
  });
};

/** The diff of the two stored graphs, as `publish` would have stored it. */
const storedDiffText = (): string =>
  stringifyDiff(
    diffGraphs(
      parseGraph(JSON.parse(storedText(MERGE)) as unknown),
      parseGraph(JSON.parse(storedText(HEAD)) as unknown),
    ),
  );

/** The installation token for each ask: the read token, or the write token for `access: "post"`. */
const tokenFor = async (ask: TokenAsk): Promise<string> =>
  ask.access === "post" ? "post-token" : "installation-token";

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
    installationToken: tokenFor,
    siteOrigin: SITE,
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
  it("diffs the merge base against the head with both trees' text, stores the diff, and posts it", async () => {
    const { overrides, published, records } = naming([7]);
    const { diffs } = recorder(overrides);
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
      posted: 1,
      postMs: expect.any(Number) as number,
      resumed: false,
    });
    // The comment links the interactive diff of the merge base and the head, on the website.
    const [comment] = [...comments.values()];
    expect(comment?.body.startsWith(PR_COMMENT_MARKER)).toBe(true);
    expect(comment?.body).toContain(`(${SITE}/acme/shop/${HEAD}?base=${MERGE})`);
    expect(writes.find((w) => w.path.endsWith("/check-runs"))?.body).toMatchObject({
      head_sha: HEAD,
      conclusion: "success",
    });
    expect(records.get(7)).toMatchObject({ commentId: 1001, checkRunId: 1002 });
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
    const graph = storedText;
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

  it("when every record naming it is posted: already done", async () => {
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
  const noSite = ({ siteOrigin: _, ...d }: JobDeps): JobDeps => d;
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
    ["no website origin for the comment's link", REQUEST, noSite, "TOKEN_UNCONFIGURED"],
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

describe("processDiffJob posts (M8.6e2b)", () => {
  const storedGraph = async ({ sha }: { sha: string }) => storedText(sha);
  const said = () => writes.map((w) => `${w.method} ${w.path}`);

  it("posts each pull request's comment and Check Run after the diff is recorded, with the write token", async () => {
    const { overrides, records, calls } = naming([9, 7]);
    const { diffs } = recorder({ ...overrides, storedGraph });
    const installationToken = vi.fn(tokenFor);
    const outcome = await processDiffJob(context(), deps({ diffs, installationToken }));

    expect(installationToken.mock.calls.map(([ask]) => ask)).toEqual([
      { jobId: ID, installationId: INSTALLATION },
      { jobId: ID, installationId: INSTALLATION, access: "post" },
    ]);
    // The comment first (recorded at once), then the Check Run on the head, per pull request.
    expect(calls).toEqual(["publish", "comment 9", "checkRun 9", "comment 7", "checkRun 7"]);
    expect(said()).toEqual([
      "POST /repos/acme/shop/issues/9/comments",
      "POST /repos/acme/shop/check-runs",
      "POST /repos/acme/shop/issues/7/comments",
      "POST /repos/acme/shop/check-runs",
    ]);
    // Only the write token goes to the post API; the read token stays with the download.
    expect(new Set(writes.map((w) => w.authorization))).toEqual(new Set(["Bearer post-token"]));
    const api = github.requests.filter(
      (r) => r.server === "api" && !POST_PATH.test(r.url.split("?")[0] ?? ""),
    );
    expect(new Set(api.map((r) => r.authorization))).toEqual(
      new Set(["Bearer installation-token"]),
    );
    expect(writes[1]?.body).toMatchObject({
      name: "GitInside",
      head_sha: HEAD,
      status: "completed",
      conclusion: "success",
    });
    expect(records.get(9)).toMatchObject({ commentId: 1001, checkRunId: 1002 });
    expect(records.get(7)).toMatchObject({ commentId: 1003, checkRunId: 1004 });
    expect(outcome.diff).toMatchObject({ pullRequests: 2, posted: 2, resumed: false });
    expect(await jobFolders()).toEqual([]);
  });

  it("edits the pull request's stored comment in place", async () => {
    const { overrides, records } = naming([7]);
    comments.set(55, { number: 7, body: `${PR_COMMENT_MARKER}\nold`, user: { type: "Bot" } });
    (records.get(7) as PostingRecord).commentId = 55;
    const { diffs } = recorder({ ...overrides, storedGraph });
    await processDiffJob(context(), deps({ diffs }));
    expect(said()).toEqual([
      "PATCH /repos/acme/shop/issues/comments/55",
      "POST /repos/acme/shop/check-runs",
    ]);
    expect(comments.get(55)?.body).toContain(`${SITE}/acme/shop/${HEAD}?base=${MERGE}`);
    expect(records.get(7)).toMatchObject({ commentId: 55, checkRunId: 1001 });
  });

  it("re-reads each record just before posting, and skips one that moved on to a newer head", async () => {
    const { overrides, records, calls } = naming([7, 9]);
    const logs: Record<string, unknown>[] = [];
    // #9 was pushed to after the records were listed: its record names another head now.
    const current: DiffRecorder["current"] = async ({ number }) => {
      const record = records.get(number);
      if (record === undefined) return undefined;
      return number === 9 ? { ...record, headSha: "d".repeat(40), diffJobId: null } : { ...record };
    };
    const { diffs } = recorder({ ...overrides, storedGraph, current });
    const outcome = await processDiffJob(
      context(),
      deps({ diffs, log: (event) => void logs.push(event) }),
    );
    expect(calls).toEqual(["publish", "comment 7", "checkRun 7"]);
    expect(said().filter((w) => w.includes("/issues/9/"))).toEqual([]);
    expect(outcome.diff).toMatchObject({ pullRequests: 2, posted: 1 });
    expect(logs).toContainEqual({ event: "post_skipped", id: ID, number: 9, reason: "moved on" });
  });

  it.each([
    [
      "names another job for the same pair (a new analyzer version)",
      { diffJobId: `diff-${"f".repeat(32)}` },
    ],
    ["has another base under the same head", { baseSha: "e".repeat(40) }],
  ])("skips a record that now %s", async (_what, now) => {
    const { overrides, records } = naming([7]);
    const current: DiffRecorder["current"] = async ({ number }) => ({
      ...(records.get(number) as PostingRecord),
      ...now,
    });
    const { diffs } = recorder({ ...overrides, storedGraph, current });
    const outcome = await processDiffJob(context(), deps({ diffs }));
    expect(writes).toEqual([]);
    expect(outcome.diff?.posted).toBe(0);
  });

  it("skips a record whose Check Run was already stored, posting nothing to it", async () => {
    const { overrides, records } = naming([7]);
    const current: DiffRecorder["current"] = async ({ number }) => ({
      ...(records.get(number) as PostingRecord),
      checkRunId: 77,
    });
    const { diffs } = recorder({ ...overrides, storedGraph, current });
    const outcome = await processDiffJob(context(), deps({ diffs }));
    expect(writes).toEqual([]);
    expect(outcome.diff?.posted).toBe(0);
  });

  it("counts a pull request that moved on before its Check Run was stored as not posted", async () => {
    const { overrides } = naming([7]);
    const logs: Record<string, unknown>[] = [];
    const { diffs } = recorder({ ...overrides, storedGraph, recordCheckRun: async () => false });
    const outcome = await processDiffJob(
      context(),
      deps({ diffs, log: (event) => void logs.push(event) }),
    );
    expect(said()).toHaveLength(2);
    expect(outcome.diff?.posted).toBe(0);
    expect(logs).toContainEqual({
      event: "post_skipped",
      id: ID,
      number: 7,
      reason: "moved on before its Check Run was stored",
    });
  });

  it("asks for no write token when every record moved on before the diff was recorded", async () => {
    const { diffs } = recorder({ storedGraph, publish: async () => [] });
    const installationToken = vi.fn(tokenFor);
    const outcome = await processDiffJob(context(), deps({ diffs, installationToken }));
    expect(installationToken).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
    expect(outcome.diff).toMatchObject({ pullRequests: 0, posted: 0 });
  });

  it("logs a pull request it couldn't post to, still posts the others, then fails to be retried", async () => {
    const { overrides, records } = naming([7, 9]);
    refuse = (method, path) =>
      method === "POST" && path.endsWith("/issues/7/comments") ? 502 : undefined;
    const logs: Record<string, unknown>[] = [];
    const { diffs } = recorder({ ...overrides, storedGraph });
    const error = await failure(
      processDiffJob(context(), deps({ diffs, log: (event) => void logs.push(event) })),
    );
    expect([error.code, error.retriable]).toEqual(["POST_FAILED", true]);
    expect(records.get(7)).toMatchObject({ commentId: null, checkRunId: null });
    expect(records.get(9)).toMatchObject({ checkRunId: expect.any(Number) as number });
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "post_failed", id: ID, number: 7, code: "POST_FAILED" }),
    );
    expect(await jobFolders()).toEqual([]);
  });

  it("fails for good when GitHub refuses the post, preferring a retriable failure from another pull request", async () => {
    const { overrides } = naming([7, 9]);
    const { diffs } = recorder({ ...overrides, storedGraph });
    refuse = (method, path) =>
      method === "POST" && path.endsWith("/check-runs") ? 422 : undefined;
    const refused = await failure(processDiffJob(context(), deps({ diffs })));
    expect([refused.code, refused.retriable]).toEqual(["POST_REFUSED", false]);
    // A new pair of pull requests, with no comment of the bot's yet.
    comments.clear();

    const again = naming([7, 9]);
    const { diffs: other } = recorder({ ...again.overrides, storedGraph });
    refuse = (method, path) =>
      method !== "POST"
        ? undefined
        : path.endsWith("/issues/7/comments")
          ? 422
          : path.endsWith("/issues/9/comments")
            ? 503
            : undefined;
    const error = await failure(processDiffJob(context(), deps({ diffs: other })));
    expect([error.code, error.retriable]).toEqual(["POST_FAILED", true]);
  });

  it("fails as the write token's refusal (posted meanwhile), posting nothing", async () => {
    const { overrides } = naming([7]);
    const { diffs } = recorder({ ...overrides, storedGraph });
    const installationToken = async (ask: TokenAsk) => {
      if (ask.access === "post") throw new JobFailure("JOB_NOT_LIVE", "the website answered 404");
      return "installation-token";
    };
    const error = await failure(processDiffJob(context(), deps({ diffs, installationToken })));
    expect([error.code, error.retriable]).toEqual(["JOB_NOT_LIVE", false]);
    expect(writes).toEqual([]);
  });

  it("fails as the retriable POST_FAILED when no time is left to post", async () => {
    const { overrides } = naming([7]);
    let left = 280_000;
    const { diffs } = recorder({
      ...overrides,
      storedGraph,
      publish: async (stored) => {
        left = 0;
        return (overrides.publish as DiffRecorder["publish"])(stored);
      },
    });
    const error = await failure(processDiffJob(context({ timeLeft: () => left }), deps({ diffs })));
    expect([error.code, error.retriable]).toEqual(["POST_FAILED", true]);
    expect(writes).toEqual([]);
  });
});

describe("processDiffJob retried after its diff was recorded (M8.6e2b)", () => {
  const storedGraph = async ({ sha }: { sha: string }) => storedText(sha);

  it("posts from the stored diff and both stored graphs, downloading nothing", async () => {
    const { overrides, records, calls } = naming([7], { diffed: true });
    const storedDiff = vi.fn(async () => storedDiffText());
    const run = fakeRun();
    const installationToken = vi.fn(tokenFor);
    const { diffs } = recorder({ ...overrides, storedGraph, storedDiff });
    const stages: JobStage[] = [];
    const outcome = await processDiffJob(
      context({ onStage: (stage) => void stages.push(stage) }),
      deps({ diffs, run, installationToken }),
    );

    expect(storedDiff).toHaveBeenCalledWith(KEY);
    expect(installationToken.mock.calls.map(([ask]) => ask)).toEqual([
      { jobId: ID, installationId: INSTALLATION, access: "post" },
    ]);
    expect(github.requests.filter((r) => !POST_PATH.test(r.url.split("?")[0] ?? ""))).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual(["comment 7", "checkRun 7"]);
    expect(comments.get(1001)?.body).toContain(`${SITE}/acme/shop/${HEAD}?base=${MERGE}`);
    expect(records.get(7)?.checkRunId).toBe(1002);
    expect(stages).toEqual(["upload"]);
    expect(outcome.diff).toMatchObject({
      mergeBase: MERGE,
      broken: 0,
      pullRequests: 1,
      posted: 1,
      resumed: true,
    });
    expect(await jobFolders()).toEqual([]);
  });

  it.each<[string, Partial<DiffRecorder>]>([
    ["the diff's object is gone", { storedDiff: async () => undefined }],
    ["the stored diff isn't a diff", { storedDiff: async () => '{"nodes":[]}' }],
    [
      "the stored diff names another head",
      {
        storedDiff: async () => storedDiffText().replaceAll(HEAD, "d".repeat(40)),
      },
    ],
    [
      "the merge base's graph isn't stored",
      {
        storedDiff: async () => storedDiffText(),
        storedGraph: async ({ sha }: { sha: string }) =>
          sha === MERGE ? undefined : storedText(sha),
      },
    ],
    [
      "the head's graph isn't stored",
      {
        storedDiff: async () => storedDiffText(),
        storedGraph: async ({ sha }: { sha: string }) =>
          sha === HEAD ? undefined : storedText(sha),
      },
    ],
  ])("runs the job again when %s, then posts", async (_what, more) => {
    const { overrides, calls, records } = naming([7], { diffed: true });
    const { diffs } = recorder({ ...overrides, storedGraph, ...more });
    const installationToken = vi.fn(tokenFor);
    const logs: Record<string, unknown>[] = [];
    const outcome = await processDiffJob(
      context(),
      deps({ diffs, installationToken, log: (event) => void logs.push(event) }),
    );
    expect(calls).toEqual(["reopen", "publish", "comment 7", "checkRun 7"]);
    expect(installationToken.mock.calls.map(([ask]) => ask.access)).toEqual([undefined, "post"]);
    expect(asked()).toContain(`api /repos/acme/shop/compare/${BASE}...${HEAD}`);
    expect(logs).toContainEqual(expect.objectContaining({ event: "stored_diff_unread", id: ID }));
    expect(logs).toContainEqual({ event: "diff_reopened", id: ID, records: 1 });
    expect(records.get(7)?.checkRunId).toEqual(expect.any(Number));
    expect(outcome.diff).toMatchObject({ posted: 1, resumed: false });
  });

  it("is already done when no record is left to post to", async () => {
    const { diffs } = recorder({ find: async () => ({ repoId: REPO_ID, status: "diffed" }) });
    await expect(processDiffJob(context(), deps({ diffs }))).rejects.toBeInstanceOf(JobAlreadyDone);
    expect(github.requests).toEqual([]);
  });

  it("fails as the retriable RECORD_FAILED when the stored diff can't be read", async () => {
    const { overrides, calls } = naming([7], { diffed: true });
    const { diffs } = recorder({
      ...overrides,
      storedDiff: async () => {
        throw new Error("GET answered 503");
      },
    });
    const error = await failure(processDiffJob(context(), deps({ diffs })));
    expect([error.code, error.retriable]).toEqual(["RECORD_FAILED", true]);
    expect(calls).toEqual([]);
  });
});
