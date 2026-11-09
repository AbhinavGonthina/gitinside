import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { DiffedPullRequest, DiffJobPost } from "@gitinside/db";
import { diffGraphs, renderCheckRun, renderPrComment } from "@gitinside/diff";
import {
  parseGraph,
  parseGraphDiff,
  type ArchitectureGraph,
  type GraphDiff,
} from "@gitinside/schema";
import { ExtractError, extractTarball } from "./extract.js";
import { JobFailure } from "./failure.js";
import { fetchMergeBase, openTarball } from "./github.js";
import type { InstallationTokenSource } from "./installationToken.js";
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  JOB_FOLDER_ID,
  JobAlreadyDone,
  SKIPPED_SAMPLE_SIZE,
  analysisBudget,
  jobCache,
  stageBudget,
  type JobContext,
  type JobDeps,
  type JobOutcome,
} from "./job.js";
import type { JobCache } from "./factcache.js";
import { createCheckRun, postComment, type PostOptions } from "./post.js";
import type { AnalysisStats } from "./protocol.js";
import { DEFAULT_RUNNER_LIMITS, runAnalysis } from "./runner.js";

/**
 * A pull request's diff job (ADR-0245), start to finish:
 * 1. **the record:** the pull request records naming the job give its repo row
 *    (`DiffRecorder.find`); none ⇒ the permanent `JOB_NOT_LIVE` (every pull request it was
 *    queued for moved on), all posted ⇒ {@link JobAlreadyDone}, all diffed but some not posted
 *    ⇒ the retry of step 7 below, from what's stored.
 * 2. **download:** the installation's read token, the merge base of the event's base and head
 *    (GitHub's compare, `fetchMergeBase`), then both tarballs, merge base first, each streamed
 *    into its own `<side>/src`. All of it shares the download budget, as an analysis's does.
 * 3. **analyze:** each side's stored graph when it has one (`DiffRecorder.storedGraph`: a
 *    `done` analysis of that commit by this analyzer version, under a key this installation may
 *    read, parsed and naming that commit, M8.6d3c2); otherwise the sandboxed child on it, in
 *    turn, merge base first, both with the repo's fact cache folder (factcache.ts), so the head
 *    side reuses the facts of every file the pull request didn't touch. A stored graph that
 *    can't be read or doesn't parse is logged (`stored_graph_unread`) and that side analyzed: it
 *    only ever saves time. A side it analyzed is stored right away as that commit's analysis
 *    (`DiffRecorder.storeSide`, M8.6d4) when no other job holds its row: the pull request's
 *    link then has both diagrams, and a retry after the head ran out of time reads the merge
 *    base instead of analyzing it again. A side that can't be stored is logged
 *    (`side_store_failed`) and the job goes on. Each side's timeout is cut to the attempt's deadline as an
 *    analysis's is: running out of a guaranteed share is `LIMIT_TIME`, running out of less (the
 *    head side, once the merge base took its time) is the retriable `ANALYSIS_TIME_CUT`.
 *    Both trees are still downloaded: the diff needs their text.
 * 4. **diff:** `diffGraphs(mergeBase, head)` with both trees' file text (rename detection of
 *    edited files, ADR-0086), read while the job folder exists.
 * 5. **publish:** `DiffRecorder.publish` stores the diff and records it on every pull request
 *    record naming the job (record.ts).
 * 6. **clean up:** the job folder is deleted whatever happened.
 * 7. **post** (M8.6e2b, {@link postAll}): to each record naming the job that has its diff and
 *    no Check Run (`DiffRecorder.posts`), with the job's write token (`access: "post"`, which
 *    the website mints only in that window) and the texts `renderPrComment`/`renderCheckRun`
 *    make with the website's origin. Each record is read again just before its post
 *    (`DiffRecorder.current`) and skipped (`post_skipped`) unless it still names the job, with
 *    the same pair and no Check Run: a newer push since must not get this head's comment. Then
 *    `postComment` (post.ts) ⇒ `recordComment` ⇒ `createCheckRun` on the head ⇒
 *    `recordCheckRun` (only for the current pair). A comment GitHub refuses (`POST_REFUSED`, a
 *    locked conversation) still gets its Check Run, then the record fails with the refusal
 *    (M8.10d). The stored Check Run is what makes a record
 *    posted, so the job is "done" only once every record has one. A record's failure is logged
 *    (`post_failed`, the code and detail) and the others still posted; then the attempt fails
 *    with it (a retriable one first), and the queue retries.
 *
 * **A retry after the diff was recorded** (status `diffed`) posts without downloading: the
 * diff's object (`DiffRecorder.storedDiff`, named by the records) and both sides' stored graphs
 * (step 3's `storedGraph`, by the commits the diff names). When any of them is missing or
 * unreadable (logged), the records' diff is cleared (`DiffRecorder.reopen`, which reopens the
 * read token's window) and the job runs again from step 2 in the same attempt.
 *
 * A diff job has no `analyses` row: a failure is only logged (and answered to the queue), and
 * the record keeps naming the job until the next push (ADR-0245). It reports stages, never the
 * analyzer's steps: no page shows a diff job's progress.
 */

/** A diff job as the pull request records naming it describe it (db's `findDiffJob`). */
export interface LiveDiffJob {
  /** Our repo row's ID: part of the diff's key and the fact cache folder. */
  repoId: string;
  /**
   * `queued` while some record naming the job has no diff yet; `diffed` once all have it and
   * some has no Check Run; `done` once every one is posted.
   */
  status: "queued" | "diffed" | "done";
}

/** A finished diff, for {@link DiffRecorder.publish}. */
export interface DiffToStore {
  jobId: string;
  installationId: number;
  repoId: string;
  /** The diff's base side: the merge base of the event's base and head. */
  mergeBase: string;
  headSha: string;
  diff: GraphDiff;
}

/** A pull request record as read just before posting to it (db's `findPullRequest`). */
export interface PostingRecord {
  diffJobId: string | null;
  baseSha: string;
  headSha: string;
  commentId: number | null;
  checkRunId: number | null;
}

/** Which pull request record a write is about. */
interface RecordRef {
  repoId: string;
  number: number;
}

/** Where a diff job's records and results live (record.ts's `createDiffRecorder`). */
export interface DiffRecorder {
  /** The job as the records naming it describe it, or `undefined` when none does. */
  find(jobId: string): Promise<LiveDiffJob | undefined>;
  /**
   * The text of `side.sha`'s stored graph: its `done` analysis by this analyzer version, under
   * a key this installation may read (record.ts's `readableBy`), or `undefined` when there's
   * none, and that side is analyzed (M8.6d3c2).
   */
  storedGraph(side: {
    installationId: number;
    repoId: string;
    sha: string;
  }): Promise<string | undefined>;
  /**
   * Store a side the job analyzed as that commit's analysis, when no other job holds that
   * commit's row and the repo is still linked to the installation (M8.6d4): its snapshot under
   * the key an analysis job would use, then a `done` row. Answers whether the row was written;
   * throws `REPO_NOT_INSTALLED` when the repo was unlinked during the upload (M8.10e).
   */
  storeSide(side: {
    installationId: number;
    repoId: string;
    sha: string;
    /** The side's graph file, as the analysis child wrote it. */
    graphPath: string;
    stats: AnalysisStats;
  }): Promise<boolean>;
  /**
   * Store the diff and record it on every pull request record naming the job; answers those
   * records (empty: each moved on to another pair, and nothing is posted). Throws
   * `REPO_NOT_INSTALLED` when none is left because the repo was unlinked (M8.10e).
   */
  publish(diff: DiffToStore): Promise<DiffedPullRequest[]>;
  /** The records naming the job with its diff and no Check Run (db's `findDiffJobPosts`). */
  posts(jobId: string): Promise<DiffJobPost[]>;
  /** A pull request's record as stored now, or `undefined` when it's gone. */
  current(ref: RecordRef): Promise<PostingRecord | undefined>;
  /** The text of the diff stored under `key`, or `undefined` when the object is gone. */
  storedDiff(key: string): Promise<string | undefined>;
  /** Clear the diff of the job's unposted records, so it runs again (db's `reopenDiffJob`). */
  reopen(jobId: string): Promise<number>;
  /** Store the pull request's comment ID (db's `recordPullRequestComment`). */
  recordComment(ref: RecordRef & { commentId: number }): Promise<boolean>;
  /** Store the pair's Check Run ID, only for the current pair (db's `recordPullRequestCheckRun`). */
  recordCheckRun(
    ref: RecordRef & { baseSha: string; headSha: string; checkRunId: number },
  ): Promise<boolean>;
}

/** Milliseconds for getting the write token and posting to every record, at most. */
export const DEFAULT_POST_TIMEOUT_MS = 15_000;

/** One side of the diff in the job folder. */
interface Side {
  sha: string;
  src: string;
  out: string;
}

/** A diff and the two graphs it was made from: what the comment and Check Run are made of. */
interface MadeDiff {
  diff: GraphDiff;
  base: ArchitectureGraph;
  head: ArchitectureGraph;
}

/** What posting needs besides the diff. */
interface Poster {
  tokens: InstallationTokenSource;
  siteOrigin: string;
  installationId: number;
}

type Deps = JobDeps & { diffs: DiffRecorder };

const elapsed = (start: number): number => Math.round(performance.now() - start);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Text of a repo-relative `path` under `root`, or `undefined` if it's missing or escapes it. */
function treeReader(root: string): (path: string) => string | undefined {
  const top = resolve(root);
  return (path) => {
    const full = resolve(top, path);
    if (!full.startsWith(top + sep)) return undefined;
    try {
      return readFileSync(full, "utf8");
    } catch {
      return undefined;
    }
  };
}

/** A recorder read, its error the retriable `RECORD_FAILED`. */
async function fromRecords<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new JobFailure("RECORD_FAILED", `${what} failed`, { cause: error });
  }
}

/** The job as its records describe it; stops the job when none names it or all are posted. */
async function findLive(context: JobContext, diffs: DiffRecorder): Promise<LiveDiffJob> {
  const live = await fromRecords("reading the job's records", () => diffs.find(context.id));
  if (live === undefined) throw new JobFailure("JOB_NOT_LIVE", "no record names the job");
  if (live.status === "done") throw new JobAlreadyDone();
  return live;
}

/**
 * Get the read token and the merge base, and download and extract both sides, mapping every
 * error to a {@link JobFailure} as an analysis's download does.
 */
async function fetchSides(
  context: JobContext,
  deps: Deps,
  tokens: InstallationTokenSource,
  installationId: number,
  dir: string,
): Promise<{ sides: [Side, Side]; head: ExtractedHead }> {
  const budget = stageBudget(context, deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  if (budget <= 0) throw new JobFailure("DOWNLOAD_TIMEOUT", "no time left for the download");
  const timeout = AbortSignal.timeout(budget);
  const signal =
    context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  const { owner, repo, sha, baseSha } = context.request;
  if (baseSha === undefined) throw new JobFailure("INVALID_REQUEST", "a diff job needs its base");
  try {
    const { token } = await tokens({ jobId: context.id, installationId }, signal);
    const github = { ...deps.download, token, signal };
    const mergeBase = await fetchMergeBase({ owner, repo, base: baseSha, head: sha }, github);
    const sides: Side[] = [];
    let head: ExtractedHead | undefined;
    for (const [name, commit] of [
      ["base", mergeBase],
      ["head", sha],
    ] as const) {
      const side = { sha: commit, src: join(dir, name, "src"), out: join(dir, name, "graph.json") };
      await mkdir(join(dir, name));
      const body = await openTarball({ owner, repo, sha: commit }, github);
      if (name === "base") await context.onStage?.("extract");
      const extracted = await extractTarball(body, side.src, { limits: deps.extractLimits ?? {} });
      if (name === "head") head = extracted;
      sides.push(side);
    }
    if (head === undefined) throw new Error("the head side wasn't extracted");
    return { sides: sides as [Side, Side], head };
  } catch (error) {
    if (context.signal?.aborted) throw new JobFailure("CANCELLED", "cancelled while downloading");
    if (timeout.aborted) throw new JobFailure("DOWNLOAD_TIMEOUT", "download budget exceeded");
    if (error instanceof JobFailure) throw error;
    if (error instanceof ExtractError) throw new JobFailure(error.code, error.message);
    throw new JobFailure("DOWNLOAD_FAILED", "the download stopped", { cause: error });
  }
}

type ExtractedHead = Awaited<ReturnType<typeof extractTarball>>;

/**
 * Analyze one side in the sandboxed child and read its graph, under the attempt's deadline as
 * an analysis job is (`atStart` is the time left when the job began).
 */
async function analyzeSide(
  context: JobContext,
  deps: JobDeps,
  side: Side,
  cache: JobCache | undefined,
  atStart: number | undefined,
): Promise<{ graph: ArchitectureGraph; stats: JobOutcome["stats"] }> {
  const run = deps.run ?? runAnalysis;
  const limits = deps.runOptions?.limits;
  let timeoutMs: number | undefined;
  let cut = false;
  if (atStart !== undefined) {
    const own = limits?.timeoutMs ?? DEFAULT_RUNNER_LIMITS.timeoutMs;
    ({ timeoutMs, cut } = analysisBudget(own, atStart, context));
    if (timeoutMs <= 0) throw new JobFailure("ANALYSIS_TIME_CUT", "no time left for the analysis");
  }
  const { owner, repo } = context.request;
  const result = await run(
    {
      src: side.src,
      out: side.out,
      owner,
      name: repo,
      sha: side.sha,
      ...(cache === undefined ? {} : { cache }),
    },
    {
      ...deps.runOptions,
      ...(timeoutMs === undefined ? {} : { limits: { ...limits, timeoutMs } }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
  );
  if (!result.ok && result.code === "LIMIT_TIME" && cut) {
    const detail = `analysis cut to ${String(timeoutMs)} ms by the stages before it`;
    throw new JobFailure("ANALYSIS_TIME_CUT", detail);
  }
  if (!result.ok) throw new JobFailure(result.code, result.stderrTail);
  // The child validated the graph before writing it; this checks the file is that graph.
  const graph = parseGraph(JSON.parse(await readFile(side.out, "utf8")) as unknown);
  return { graph, stats: result.stats };
}

/**
 * Commit `side.sha`'s stored graph, with the counts the child would report for it (no stage
 * times), or `undefined` when it has none or it can't be used (logged).
 */
async function storedSide(
  context: JobContext,
  deps: Deps,
  side: { sha: string },
  owner: { installationId: number; repoId: string },
): Promise<{ graph: ArchitectureGraph; stats: JobOutcome["stats"] } | undefined> {
  try {
    const text = await deps.diffs.storedGraph({ ...owner, sha: side.sha });
    if (text === undefined) return undefined;
    const graph = parseGraph(JSON.parse(text) as unknown);
    if (graph.repo.sha !== side.sha) throw new Error("the stored graph names another commit");
    const stats = {
      files: graph.nodes.filter((node) => node.kind === "file").length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      unresolved: graph.nodes.filter((node) => node.kind === "unresolved").length,
      warnings: graph.warnings.length,
      graphBytes: Buffer.byteLength(text),
      stageMs: {},
    };
    return { graph, stats };
  } catch (error) {
    deps.log?.({
      event: "stored_graph_unread",
      id: context.id,
      sha: side.sha,
      message: messageOf(error),
    });
    return undefined;
  }
}

/**
 * Store a side the job just analyzed as that commit's analysis (`DiffRecorder.storeSide`,
 * M8.6d4); answers whether its row was written. A failure is logged (`side_store_failed`, the
 * error's message only) and the job goes on: the diff doesn't depend on it. A failure the
 * recorder named itself (`REPO_NOT_INSTALLED`: the repo was unlinked meanwhile, M8.10e) stops
 * the job.
 */
async function storeSide(
  context: JobContext,
  deps: Deps,
  side: Side,
  owner: { installationId: number; repoId: string },
  stats: AnalysisStats,
): Promise<boolean> {
  try {
    return await deps.diffs.storeSide({ ...owner, sha: side.sha, graphPath: side.out, stats });
  } catch (error) {
    if (error instanceof JobFailure) throw error;
    deps.log?.({
      event: "side_store_failed",
      id: context.id,
      sha: side.sha,
      message: messageOf(error),
    });
    return false;
  }
}

/**
 * Post the comment and Check Run to one record (see the module comment's step 7). Answers
 * whether its Check Run was stored: `false` when the record moved on, before posting (nothing
 * posted) or before the Check Run was stored (logged as `post_skipped`).
 */
async function postOne(
  context: JobContext,
  deps: Deps,
  record: DiffJobPost,
  texts: { comment: string; checkRun: ReturnType<typeof renderCheckRun> },
  options: PostOptions,
): Promise<boolean> {
  const { owner, repo } = context.request;
  const { repoId, number, baseSha, headSha } = record;
  const skipped = (reason: string): false => {
    deps.log?.({ event: "post_skipped", id: context.id, number, reason });
    return false;
  };
  const now = await fromRecords("reading the pull request", () =>
    deps.diffs.current({ repoId, number }),
  );
  if (
    now?.diffJobId !== context.id ||
    now.baseSha !== baseSha ||
    now.headSha !== headSha ||
    now.checkRunId !== null
  ) {
    return skipped("moved on");
  }
  const target = { owner, repo, number };
  let refused: JobFailure | undefined;
  try {
    const commentId = await postComment(target, texts.comment, now.commentId ?? undefined, options);
    await fromRecords("recording the comment", () =>
      deps.diffs.recordComment({ repoId, number, commentId }),
    );
  } catch (error) {
    // A refused comment (a locked conversation) still gets its Check Run, so the pull request
    // shows the result somewhere; the record then fails with the refusal (M8.10d, F7).
    if (!(error instanceof JobFailure) || error.code !== "POST_REFUSED") throw error;
    refused = error;
  }
  const checkRunId = await createCheckRun({ owner, repo }, headSha, texts.checkRun, options);
  const stored = await fromRecords("recording the Check Run", () =>
    deps.diffs.recordCheckRun({ repoId, number, baseSha, headSha, checkRunId }),
  );
  if (refused !== undefined) throw refused;
  return stored || skipped("moved on before its Check Run was stored");
}

/**
 * Post `made` to every record the job still has to post to (see the module comment's step 7).
 * Answers how many were posted; throws the first retriable failure, else the first failure,
 * after trying every record.
 */
async function postAll(
  context: JobContext,
  deps: Deps,
  made: MadeDiff,
  poster: Poster,
): Promise<number> {
  const records = await fromRecords("reading the records to post to", () =>
    deps.diffs.posts(context.id),
  );
  if (records.length === 0) return 0;
  const link = { siteOrigin: poster.siteOrigin };
  const texts = {
    comment: renderPrComment(made.diff, made.base, made.head, link),
    checkRun: renderCheckRun(made.diff, made.base, made.head, link),
  };
  const own = deps.postTimeoutMs ?? DEFAULT_POST_TIMEOUT_MS;
  const budget = context.timeLeft === undefined ? own : Math.min(own, context.timeLeft());
  if (budget <= 0) throw new JobFailure("POST_FAILED", "no time left to post");
  const timeout = AbortSignal.timeout(budget);
  const signal =
    context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  const failures: JobFailure[] = [];
  let posted = 0;
  try {
    const { token, appId } = await poster.tokens(
      { jobId: context.id, installationId: poster.installationId, access: "post" },
      signal,
    );
    const options: PostOptions = {
      token,
      signal,
      ...(appId === undefined ? {} : { appId }),
      ...(deps.download?.apiBase === undefined ? {} : { apiBase: deps.download.apiBase }),
      ...(deps.download?.fetch === undefined ? {} : { fetch: deps.download.fetch }),
    };
    for (const record of records) {
      try {
        if (await postOne(context, deps, record, texts, options)) posted++;
      } catch (error) {
        if (signal.aborted) throw error;
        const failure =
          error instanceof JobFailure
            ? error
            : new JobFailure("POST_FAILED", messageOf(error), { cause: error });
        deps.log?.({
          event: "post_failed",
          id: context.id,
          number: record.number,
          code: failure.code,
          detail: failure.detail,
        });
        failures.push(failure);
      }
    }
  } catch (error) {
    if (context.signal?.aborted) throw new JobFailure("CANCELLED", "cancelled while posting");
    if (timeout.aborted) throw new JobFailure("POST_FAILED", "posting budget exceeded");
    if (error instanceof JobFailure) throw error;
    throw new JobFailure("POST_FAILED", "posting stopped", { cause: error });
  }
  const failure = failures.find((f) => f.retriable) ?? failures[0];
  if (failure !== undefined) throw failure;
  return posted;
}

/**
 * For a `diffed` job: the stored diff and both sides' stored graphs, with the head's counts, or
 * `undefined` when any is missing or unusable (logged), and the job must run again. Throws
 * {@link JobAlreadyDone} when no record is left to post to, and `RECORD_FAILED` when the records
 * or the bucket can't be read.
 */
async function storedResult(
  context: JobContext,
  deps: Deps,
  owner: { installationId: number; repoId: string },
): Promise<{ made: MadeDiff; stats: AnalysisStats; records: number } | undefined> {
  const records = await fromRecords("reading the records to post to", () =>
    deps.diffs.posts(context.id),
  );
  const [first] = records;
  // Posted meanwhile (another attempt) or moved on: nothing left for this job.
  if (first === undefined) throw new JobAlreadyDone();
  const text = await fromRecords("reading the stored diff", () =>
    deps.diffs.storedDiff(first.diffKey),
  );
  const unread = (message: string): undefined => {
    deps.log?.({ event: "stored_diff_unread", id: context.id, message });
    return undefined;
  };
  if (text === undefined) return unread("the diff's object is gone");
  let diff: GraphDiff;
  try {
    diff = parseGraphDiff(JSON.parse(text) as unknown);
  } catch (error) {
    return unread(messageOf(error));
  }
  const mergeBase = diff.base.repo.sha;
  if (mergeBase === undefined || diff.head.repo.sha !== context.request.sha) {
    return unread("the stored diff names other commits");
  }
  const base = await storedSide(context, deps, { sha: mergeBase }, owner);
  if (base === undefined) return unread("the merge base's graph isn't stored");
  const head = await storedSide(context, deps, { sha: context.request.sha }, owner);
  if (head === undefined) return unread("the head's graph isn't stored");
  return {
    made: { diff, base: base.graph, head: head.graph },
    stats: head.stats,
    records: records.length,
  };
}

/**
 * Run one diff job (see the module comment). Resolves with its {@link JobOutcome} (`diff` set,
 * `stats` and `extract` its head side's) or throws a {@link JobFailure} (or
 * {@link JobAlreadyDone}, before any download); the job folder is gone either way.
 */
export async function processDiffJob(context: JobContext, deps: JobDeps): Promise<JobOutcome> {
  if (!JOB_FOLDER_ID.test(context.id)) throw new JobFailure("INVALID_REQUEST", "bad job ID");
  if (context.request.kind !== "diff") {
    throw new JobFailure("UNSUPPORTED_JOB", "an analysis runs through processJob");
  }
  const { diffs } = deps;
  if (diffs === undefined) throw new JobFailure("UNSUPPORTED_JOB", "no diff recorder");
  const { installationId } = context.request;
  if (installationId === undefined) {
    throw new JobFailure("INVALID_REQUEST", "a diff job runs through an installation");
  }
  const atStart = context.timeLeft?.();
  const withDiffs = { ...deps, diffs };
  const live = await findLive(context, diffs);
  const tokens = deps.installationToken;
  if (tokens === undefined) {
    throw new JobFailure("TOKEN_UNCONFIGURED", "no website origin for installation tokens");
  }
  const { siteOrigin } = deps;
  if (siteOrigin === undefined) {
    throw new JobFailure("TOKEN_UNCONFIGURED", "no website origin for the comment's link");
  }
  const poster = { tokens, siteOrigin, installationId };
  const owner = { installationId, repoId: live.repoId };

  if (live.status === "diffed") {
    const start = performance.now();
    await context.onStage?.("upload");
    const stored = await storedResult(context, withDiffs, owner);
    if (stored !== undefined) {
      const posted = await postAll(context, withDiffs, stored.made, poster);
      const { diff } = stored.made;
      return {
        stats: stored.stats,
        extract: { files: 0, directories: 0, tarBytes: 0, skipped: 0, skippedSample: [] },
        timings: { downloadMs: 0, analyzeMs: 0, publishMs: 0 },
        diff: {
          mergeBase: diff.base.repo.sha ?? "",
          broken: diff.broken.length,
          pullRequests: stored.records,
          reused: ["mergeBase", "head"],
          stored: [],
          posted,
          postMs: elapsed(start),
          resumed: true,
        },
      };
    }
    const reopened = await fromRecords("reopening the job", () => diffs.reopen(context.id));
    deps.log?.({ event: "diff_reopened", id: context.id, records: reopened });
  }

  await mkdir(deps.jobsRoot, { recursive: true });
  const dir = await mkdtemp(join(deps.jobsRoot, `${context.id}-`));
  try {
    let start = performance.now();
    await context.onStage?.("download");
    const { sides, head } = await fetchSides(context, withDiffs, tokens, installationId, dir);
    const downloadMs = elapsed(start);

    start = performance.now();
    await context.onStage?.("analyze");
    const [base, after] = sides;
    const reused: ("mergeBase" | "head")[] = [];
    const stored: ("mergeBase" | "head")[] = [];
    let cache: JobCache | undefined | null = null;
    const graphOf = async (side: Side, name: "mergeBase" | "head") => {
      const read = await storedSide(context, withDiffs, side, owner);
      if (read !== undefined) {
        reused.push(name);
        return read;
      }
      // Prepared once, and only when a side is analyzed (it purges other repos' folders).
      if (cache === null) cache = await jobCache(context, deps, owner);
      const analyzed = await analyzeSide(context, deps, side, cache, atStart);
      if (await storeSide(context, withDiffs, side, owner, analyzed.stats)) {
        stored.push(name);
      }
      return analyzed;
    };
    const before = await graphOf(base, "mergeBase");
    const analyzed = await graphOf(after, "head");
    const diff = diffGraphs(before.graph, analyzed.graph, {
      contents: { base: treeReader(base.src), head: treeReader(after.src) },
    });
    const analyzeMs = elapsed(start);

    start = performance.now();
    await context.onStage?.("upload");
    let records: DiffedPullRequest[];
    try {
      records = await diffs.publish({
        jobId: context.id,
        installationId,
        repoId: live.repoId,
        mergeBase: base.sha,
        headSha: after.sha,
        diff,
      });
    } catch (error) {
      if (error instanceof JobFailure) throw error;
      throw new JobFailure("PUBLISH_FAILED", "storing the diff failed", { cause: error });
    }
    const publishMs = elapsed(start);

    start = performance.now();
    const made = { diff, base: before.graph, head: analyzed.graph };
    const posted = records.length === 0 ? 0 : await postAll(context, withDiffs, made, poster);
    const postMs = elapsed(start);

    return {
      stats: analyzed.stats,
      extract: {
        files: head.files,
        directories: head.directories,
        tarBytes: head.tarBytes,
        skipped: head.skipped.length,
        skippedSample: head.skipped.slice(0, SKIPPED_SAMPLE_SIZE),
      },
      timings: { downloadMs, analyzeMs, publishMs },
      diff: {
        mergeBase: base.sha,
        broken: diff.broken.length,
        pullRequests: records.length,
        reused,
        stored,
        posted,
        postMs,
        resumed: false,
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
