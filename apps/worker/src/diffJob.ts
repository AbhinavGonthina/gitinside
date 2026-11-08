import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { DiffedPullRequest } from "@gitinside/db";
import { diffGraphs } from "@gitinside/diff";
import { parseGraph, type ArchitectureGraph, type GraphDiff } from "@gitinside/schema";
import { ExtractError, extractTarball } from "./extract.js";
import { JobFailure } from "./failure.js";
import { fetchMergeBase, openTarball } from "./github.js";
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
import type { AnalysisStats } from "./protocol.js";
import { DEFAULT_RUNNER_LIMITS, runAnalysis } from "./runner.js";

/**
 * A pull request's diff job (ADR-0245), start to finish:
 * 1. **the record:** the pull request records naming the job give its repo row
 *    (`DiffRecorder.find`); none ⇒ the permanent `JOB_NOT_LIVE` (every pull request it was
 *    queued for moved on), all diffed ⇒ {@link JobAlreadyDone}.
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
 *
 * A diff job has no `analyses` row: a failure is only logged (and answered to the queue), and
 * the record keeps naming the job until the next push (ADR-0245). It reports stages, never the
 * analyzer's steps: no page shows a diff job's progress.
 */

/** A diff job as the pull request records naming it describe it (db's `findDiffJob`). */
export interface LiveDiffJob {
  /** Our repo row's ID: part of the diff's key and the fact cache folder. */
  repoId: string;
  /** `queued` while some record naming the job has no diff yet, else `done`. */
  status: "queued" | "done";
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
   * the key an analysis job would use, then a `done` row. Answers whether the row was written.
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
   * records (empty: each moved on to another pair, and nothing is posted).
   */
  publish(diff: DiffToStore): Promise<DiffedPullRequest[]>;
}

/** One side of the diff in the job folder. */
interface Side {
  sha: string;
  src: string;
  out: string;
}

const elapsed = (start: number): number => Math.round(performance.now() - start);

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

/**
 * Find the job's record, get the token and the merge base, and download and extract both
 * sides, mapping every error to a {@link JobFailure} as an analysis's download does.
 */
async function fetchSides(
  context: JobContext,
  deps: JobDeps & { diffs: DiffRecorder },
  installationId: number,
  dir: string,
): Promise<{ live: LiveDiffJob; sides: [Side, Side]; head: ExtractedHead }> {
  const budget = stageBudget(context, deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  if (budget <= 0) throw new JobFailure("DOWNLOAD_TIMEOUT", "no time left for the download");
  const timeout = AbortSignal.timeout(budget);
  const signal =
    context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  const { owner, repo, sha, baseSha } = context.request;
  if (baseSha === undefined) throw new JobFailure("INVALID_REQUEST", "a diff job needs its base");
  try {
    let live: LiveDiffJob | undefined;
    try {
      live = await deps.diffs.find(context.id);
    } catch (error) {
      throw new JobFailure("RECORD_FAILED", "reading the job's records failed", { cause: error });
    }
    if (live === undefined) throw new JobFailure("JOB_NOT_LIVE", "no record names the job");
    if (live.status === "done") throw new JobAlreadyDone();
    if (deps.installationToken === undefined) {
      throw new JobFailure("TOKEN_UNCONFIGURED", "no website origin for installation tokens");
    }
    const token = await deps.installationToken({ jobId: context.id, installationId }, signal);
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
    return { live, sides: sides as [Side, Side], head };
  } catch (error) {
    if (error instanceof JobAlreadyDone) throw error;
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
 * `side`'s stored graph, with the counts the child would report for it (no stage times), or
 * `undefined` when it has none or it can't be used (logged), and the side is analyzed.
 */
async function storedSide(
  context: JobContext,
  deps: JobDeps & { diffs: DiffRecorder },
  side: Side,
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
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Store a side the job just analyzed as that commit's analysis (`DiffRecorder.storeSide`,
 * M8.6d4); answers whether its row was written. A failure is logged (`side_store_failed`, the
 * error's message only) and the job goes on: the diff doesn't depend on it.
 */
async function storeSide(
  context: JobContext,
  deps: JobDeps & { diffs: DiffRecorder },
  side: Side,
  owner: { installationId: number; repoId: string },
  stats: AnalysisStats,
): Promise<boolean> {
  try {
    return await deps.diffs.storeSide({ ...owner, sha: side.sha, graphPath: side.out, stats });
  } catch (error) {
    deps.log?.({
      event: "side_store_failed",
      id: context.id,
      sha: side.sha,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
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
  await mkdir(deps.jobsRoot, { recursive: true });
  const dir = await mkdtemp(join(deps.jobsRoot, `${context.id}-`));
  try {
    let start = performance.now();
    await context.onStage?.("download");
    const { live, sides, head } = await fetchSides(
      context,
      { ...deps, diffs },
      installationId,
      dir,
    );
    const downloadMs = elapsed(start);

    start = performance.now();
    await context.onStage?.("analyze");
    const owner = { installationId, repoId: live.repoId };
    const [base, after] = sides;
    const reused: ("mergeBase" | "head")[] = [];
    const stored: ("mergeBase" | "head")[] = [];
    let cache: JobCache | undefined | null = null;
    const graphOf = async (side: Side, name: "mergeBase" | "head") => {
      const read = await storedSide(context, { ...deps, diffs }, side, owner);
      if (read !== undefined) {
        reused.push(name);
        return read;
      }
      // Prepared once, and only when a side is analyzed (it purges other repos' folders).
      if (cache === null) cache = await jobCache(context, deps, owner);
      const analyzed = await analyzeSide(context, deps, side, cache, atStart);
      if (await storeSide(context, { ...deps, diffs }, side, owner, analyzed.stats)) {
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
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
