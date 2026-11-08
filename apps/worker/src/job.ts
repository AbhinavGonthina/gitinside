import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExtractError, extractTarball, type ExtractLimits, type SkippedEntry } from "./extract.js";
import {
  cacheFolder,
  prepareCacheFolder,
  purgeUnlinkedFolders,
  type CacheOwner,
  type JobCache,
  type LinkedRepoIds,
} from "./factcache.js";
import type { DiffRecorder } from "./diffJob.js";
import { JobFailure } from "./failure.js";
import { openTarball, type DownloadOptions } from "./github.js";
import type { InstallationTokenSource } from "./installationToken.js";
import type { FoundFacts, JobStage, StepProgress, StoredProgress } from "./progress.js";
import type { AnalysisStats } from "./protocol.js";
import type { JobRequest } from "./request.js";
import { DEFAULT_RUNNER_LIMITS, runAnalysis, type RunOptions, type RunResult } from "./runner.js";

/**
 * One job, start to finish (docs/SECURITY.md §3; ADR-0061):
 * 1. **download + extract:** a job read through an installation first gets its token from
 *    the website (installationToken.ts, M8.3c3b); the recorder (if any) marks the analysis
 *    running in Postgres; then the tarball streams from GitHub (github.ts) straight into
 *    `<jobsRoot>/<id>-<random>/src` (extract.ts); nothing is buffered on disk first. All of
 *    it shares one budget, {@link DEFAULT_DOWNLOAD_TIMEOUT_MS}.
 * 2. **analyze:** the sandboxed child (runner.ts) writes `architecture.json` next to `src`,
 *    reusing facts from the job's fact cache folder (factcache.ts) if it has one, once the
 *    folders of repos no longer installed are deleted (M8.5b2). Under an
 *    attempt's deadline, running out of time it was guaranteed is `LIMIT_TIME`; running out
 *    after earlier stages ate into that share is the retriable `ANALYSIS_TIME_CUT`.
 * 3. **publish:** the caller's `publish` stores the graph (record.ts: the bucket, then Postgres).
 * 4. **clean up:** the job folder is deleted whatever happened. A failed attempt is
 *    recorded as queued again, or failed if it was final (a final failure before the
 *    recorder's start fails the row by job ID if it's still queued).
 *
 * Every failure is a {@link JobFailure} with a code; `POST /run` decides from `retriable`
 * whether Cloud Tasks tries again (run.ts). The folder name has a random part, so an attempt
 * still running when its retry starts never shares a folder with it.
 */

export { STAGE_PROGRESS, type JobStage } from "./progress.js";

/** Download + extraction budget. The analysis has its own (runner.ts, 5 minutes). */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
/** How many skipped tar entries a result lists (the count is always exact). */
export const SKIPPED_SAMPLE_SIZE = 50;

/** What `publish` gets: the job and its graph file, which is deleted after it returns. */
export interface JobArtifact {
  id: string;
  request: JobRequest;
  /** `architecture.json` for `request.sha`. */
  graphPath: string;
  stats: AnalysisStats;
  /** Wall-clock milliseconds of the stages before publishing. */
  timings: { downloadMs: number; analyzeMs: number };
  /** What the recorder wrote when the attempt started; absent without a recorder. */
  record?: RecordedJob;
}

/** A started attempt as Postgres knows it (record.ts). */
export interface RecordedJob {
  analysisId: string;
  repoId: string;
  visibility: "public" | "private";
  /** GitHub's current spelling of the repo, which may differ from the request's. */
  owner: string;
  name: string;
}

/**
 * What {@link processJob} throws when the recorder's start finds the job's row already `done`
 * (R9, second M5 review): a duplicate push that `POST /run`'s own `done` check missed (a
 * race, or a failed lookup). Not a failure: nothing is downloaded, run, published, or
 * recorded, and the attempt succeeds with nothing to do (attempt.ts).
 */
export class JobAlreadyDone extends Error {
  constructor() {
    super("the job's analysis is already done");
    this.name = "JobAlreadyDone";
  }
}

/**
 * Records each attempt in Postgres (record.ts; ADR-0063). `publish` marks the analysis done;
 * the recorder handles the rest of its lifecycle.
 */
export interface JobRecorder {
  /**
   * Before the download: look the repo up on GitHub (with `token`, a private job's
   * installation token, when given), upsert it, mark the analysis running as job `jobId`
   * (ADR-0139). `"done"` if its row is already `done` (final, left as it is): the job stops
   * there with {@link JobAlreadyDone}.
   */
  start(
    request: JobRequest,
    signal: AbortSignal,
    jobId: string,
    token?: string,
  ): Promise<RecordedJob | "done">;
  /** After a failed attempt: `final` marks the analysis failed, otherwise queued again. */
  failed(job: RecordedJob, code: string, final: boolean): Promise<void>;
  /**
   * After a final failure before `start` returned (a refused token, `REPO_NOT_FOUND`): fail
   * job `jobId`'s row if it's still queued, so the progress page names the code (M8.3c3b).
   */
  failedBeforeStart?(jobId: string, code: string): Promise<void>;
  /**
   * Where job `jobId`'s running attempt is, for the progress page (ADR-0139, ADR-0140).
   * `runAttempt` (attempt.ts) calls it with each progress update, one at a time, and only
   * logs a failure.
   */
  progress?(jobId: string, progress: StoredProgress): Promise<void>;
  /**
   * Whether job `jobId` already finished (its row is `done`, which is final). `POST /run`
   * asks before a push runs, so a duplicate push does no work (M5.17c2b).
   */
  done?(jobId: string): Promise<boolean>;
}

/** What a finished job returns. */
export interface JobOutcome {
  stats: AnalysisStats;
  extract: {
    files: number;
    directories: number;
    tarBytes: number;
    /** Entries not written (links, special files, odd names). */
    skipped: number;
    /** The first {@link SKIPPED_SAMPLE_SIZE} of them, sorted by path. */
    skippedSample: SkippedEntry[];
  };
  /** Wall-clock milliseconds per stage group. */
  timings: { downloadMs: number; analyzeMs: number; publishMs: number };
  /**
   * A diff job's result (diffJob.ts); `stats` and `extract` are then its head side's (`stats`
   * without stage times when the head's graph was stored).
   */
  diff?: {
    mergeBase: string;
    broken: number;
    /** The pull request records it landed on; 0 when each moved on to another pair. */
    pullRequests: number;
    /** The sides read from their stored graph instead of analyzed (M8.6d3c2). */
    reused: ("mergeBase" | "head")[];
    /** The analyzed sides stored as that commit's analysis (M8.6d4). */
    stored: ("mergeBase" | "head")[];
  };
}

/** What the worker supplies for every job. */
export interface JobDeps {
  /** Parent of the job folders (`/tmp/jobs` in production). Must exist or be creatable. */
  jobsRoot: string;
  /**
   * Parent of the fact cache folders (`/tmp/cache` in production, factcache.ts). Without it
   * every analysis runs cold.
   */
  cacheRoot?: string;
  /** The cache's cap over all its folders. Default `DEFAULT_FACT_CACHE_BYTES` (64 MiB). */
  cacheBytes?: number;
  /**
   * Which cached repos are still linked to their installation (db's `findLinkedRepoIds`),
   * asked before each job's cache is prepared so an uninstall's or a removed repo's facts are
   * deleted (M8.5b2). Without it, a job through an installation runs without a cache.
   */
  linkedRepoIds?: LinkedRepoIds;
  publish: (artifact: JobArtifact) => Promise<void>;
  download?: Omit<DownloadOptions, "signal">;
  /**
   * Gets a job with an `installationId` its installation token (installationToken.ts), which
   * replaces `download.token` for that job's facts and tarball and goes nowhere else (never to
   * the analysis child). Without it such a job fails as the permanent `TOKEN_UNCONFIGURED`.
   */
  installationToken?: InstallationTokenSource;
  downloadTimeoutMs?: number;
  extractLimits?: Partial<ExtractLimits>;
  run?: (job: Parameters<typeof runAnalysis>[0], options: RunOptions) => Promise<RunResult>;
  runOptions?: Omit<RunOptions, "signal">;
  /** Without one, nothing is written to Postgres (and `artifact.record` is absent). */
  recorder?: JobRecorder;
  /**
   * Finds a diff job's pull request records and stores its result (diffJob.ts, record.ts).
   * Without it a diff job fails as the permanent `UNSUPPORTED_JOB`.
   */
  diffs?: DiffRecorder;
  /** Where a failure to record a failure is reported (the job's own failure still wins). */
  log?: (event: Record<string, unknown>) => void;
}

/** What one job gets: its ID, the request, cancellation, and a progress callback. */
export interface JobContext {
  id: string;
  request: JobRequest;
  /** Fires on worker shutdown; the job fails with the retriable `CANCELLED`. */
  signal?: AbortSignal;
  onStage?: (stage: JobStage) => Promise<void> | void;
  /**
   * The analyzer's steps while in `analyze`, as the child streams them. Best effort: the
   * job doesn't wait for it, and its failure is logged (`progress_failed`), never the job's.
   */
  onStep?: (progress: StepProgress) => Promise<void> | void;
  /** What the analysis has found so far (#8), as the child streams it. Best effort, like `onStep`. */
  onFound?: (found: FoundFacts) => Promise<void> | void;
  /** The queue won't retry this attempt, so even a retriable failure is final. Default false. */
  lastAttempt?: boolean;
  /**
   * Milliseconds left in the attempt's whole budget (run.ts: Cloud Run's request timeout,
   * ADR-0114). The download and the analysis each get at most what's left minus
   * {@link PUBLISH_RESERVE_MS}; without it, each has only its own budget.
   */
  timeLeft?: () => number;
}

/**
 * Kept back from the download's and the analysis's budgets when the attempt has a deadline:
 * storing the graph (bucket, then Postgres) and recording the outcome must still fit.
 */
export const PUBLISH_RESERVE_MS = 20_000;

/**
 * How long the stages before the analysis (recording the start, the download, extraction)
 * may take before the analysis's timeout counts as cut by them (R4, second M5 review). In a
 * 280 s attempt the analysis is guaranteed 280 − 20 − 30 = 230 s: running out after at least
 * that is `LIMIT_TIME` (the repo is too big, held 7 days); running out of less is the
 * retriable `ANALYSIS_TIME_CUT`. cal.diy's 5,043 files downloaded in 9.5 s in production
 * (bench/results/2026-11-04-caldiy-stages.md).
 */
export const DOWNLOAD_ALLOWANCE_MS = 30_000;

/** What's left for a stage: its own budget, cut to the attempt's remaining time if it has one. */
export function stageBudget(context: JobContext, own: number): number {
  if (context.timeLeft === undefined) return own;
  return Math.min(own, context.timeLeft() - PUBLISH_RESERVE_MS);
}

/**
 * The analysis's guaranteed share of an attempt that had `atStart` ms when the job began: its
 * own limit (`own`, default the runner's 5 minutes), or `atStart` less the publish reserve and
 * {@link DOWNLOAD_ALLOWANCE_MS}, whichever is smaller. Running out after at least this much is
 * `LIMIT_TIME`, so it's the time limit the website names (230 s for `JOB_BUDGET_MS`).
 */
export function guaranteedAnalysisMs(
  atStart: number,
  own: number = DEFAULT_RUNNER_LIMITS.timeoutMs,
): number {
  return Math.min(own, atStart - PUBLISH_RESERVE_MS - DOWNLOAD_ALLOWANCE_MS);
}

/**
 * The analysis's timeout under the attempt's deadline, and whether earlier stages cut it below
 * its {@link guaranteedAnalysisMs} share.
 */
export function analysisBudget(
  own: number,
  atStart: number,
  context: JobContext,
): { timeoutMs: number; cut: boolean } {
  const left = stageBudget(context, own);
  const guaranteed = guaranteedAnalysisMs(atStart, own);
  // A cut budget in whole seconds, so the log line doesn't show a fraction.
  const timeoutMs = left < own ? Math.floor(left / 1000) * 1000 : own;
  return { timeoutMs, cut: left < guaranteed };
}

/** What a job ID must look like before it names a folder. */
export const JOB_FOLDER_ID = /^[A-Za-z0-9_-]{1,100}$/;
const elapsed = (start: number): number => Math.round(performance.now() - start);

/**
 * Record the attempt (if there's a recorder), then download and extract into `dest`, mapping
 * every error to a {@link JobFailure}. The record is kept in `attempt` as soon as it exists.
 */
async function fetchSource(
  context: JobContext,
  deps: JobDeps,
  dest: string,
  attempt: { record?: RecordedJob },
): Promise<Awaited<ReturnType<typeof extractTarball>>> {
  const budget = stageBudget(context, deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  if (budget <= 0) throw new JobFailure("DOWNLOAD_TIMEOUT", "no time left for the download");
  const timeout = AbortSignal.timeout(budget);
  const signal =
    context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  try {
    const { owner, repo, sha, installationId } = context.request;
    let token: string | undefined;
    if (installationId !== undefined) {
      if (deps.installationToken === undefined) {
        throw new JobFailure("TOKEN_UNCONFIGURED", "no website origin for installation tokens");
      }
      token = await deps.installationToken({ jobId: context.id, installationId }, signal);
    }
    if (deps.recorder !== undefined) {
      const record = await deps.recorder.start(context.request, signal, context.id, token);
      if (record === "done") throw new JobAlreadyDone();
      attempt.record = record;
    }
    const body = await openTarball(
      { owner, repo, sha },
      { ...deps.download, ...(token === undefined ? {} : { token }), signal },
    );
    await context.onStage?.("extract");
    return await extractTarball(body, dest, { limits: deps.extractLimits ?? {} });
  } catch (error) {
    if (error instanceof JobAlreadyDone) throw error;
    if (context.signal?.aborted) throw new JobFailure("CANCELLED", "cancelled while downloading");
    if (timeout.aborted) throw new JobFailure("DOWNLOAD_TIMEOUT", "download budget exceeded");
    if (error instanceof JobFailure) throw error;
    if (error instanceof ExtractError) throw new JobFailure(error.code, error.message);
    // The body failing mid-stream (a reset connection) is a download failure too.
    throw new JobFailure("DOWNLOAD_FAILED", "the download stopped", { cause: error });
  }
}

/**
 * Run one job. Resolves with its {@link JobOutcome} or throws a {@link JobFailure} (or
 * {@link JobAlreadyDone}, before any download); the job folder is gone either way.
 */
export async function processJob(context: JobContext, deps: JobDeps): Promise<JobOutcome> {
  // The ID names a folder; `POST /run` derives it, but check before touching the disk.
  if (!JOB_FOLDER_ID.test(context.id)) throw new JobFailure("INVALID_REQUEST", "bad job ID");
  if (context.request.kind !== "analyze") {
    throw new JobFailure("UNSUPPORTED_JOB", "a diff job runs through processDiffJob");
  }
  const atStart = context.timeLeft?.();
  await mkdir(deps.jobsRoot, { recursive: true });
  const dir = await mkdtemp(join(deps.jobsRoot, `${context.id}-`));
  const attempt: { record?: RecordedJob } = {};
  try {
    const src = join(dir, "src");
    const out = join(dir, "architecture.json");

    let start = performance.now();
    await context.onStage?.("download");
    const extracted = await fetchSource(context, deps, src, attempt);
    const downloadMs = elapsed(start);

    start = performance.now();
    await context.onStage?.("analyze");
    const run = deps.run ?? runAnalysis;
    const { owner, repo, sha, installationId } = context.request;
    const { record } = attempt;
    const cache = await jobCache(context, deps, {
      ...(installationId === undefined ? {} : { installationId }),
      ...(record === undefined ? {} : { repoId: record.repoId, visibility: record.visibility }),
    });
    const limits = deps.runOptions?.limits;
    let timeoutMs: number | undefined;
    let cut = false;
    if (atStart !== undefined) {
      const own = limits?.timeoutMs ?? DEFAULT_RUNNER_LIMITS.timeoutMs;
      ({ timeoutMs, cut } = analysisBudget(own, atStart, context));
      if (timeoutMs <= 0) {
        throw new JobFailure("ANALYSIS_TIME_CUT", "no time left for the analysis");
      }
    }
    const result = await run(
      { src, out, owner, name: repo, sha, ...(cache === undefined ? {} : { cache }) },
      {
        ...deps.runOptions,
        ...(timeoutMs === undefined ? {} : { limits: { ...limits, timeoutMs } }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(context.onStep === undefined
          ? {}
          : { onProgress: bestEffort(context, deps, context.onStep, (p) => ({ step: p.step })) }),
        ...(context.onFound === undefined
          ? {}
          : {
              onFound: bestEffort(context, deps, context.onFound, (f) => ({
                found: Object.keys(f),
              })),
            }),
      },
    );
    if (!result.ok && result.code === "LIMIT_TIME" && cut) {
      const detail = `analysis cut to ${String(timeoutMs)} ms by the stages before it`;
      throw new JobFailure("ANALYSIS_TIME_CUT", detail);
    }
    if (!result.ok) throw new JobFailure(result.code, result.stderrTail);
    const analyzeMs = elapsed(start);

    start = performance.now();
    await context.onStage?.("upload");
    try {
      await deps.publish({
        id: context.id,
        request: context.request,
        graphPath: out,
        stats: result.stats,
        timings: { downloadMs, analyzeMs },
        ...(attempt.record === undefined ? {} : { record: attempt.record }),
      });
    } catch (error) {
      // A failure `publish` named itself (its row deleted meanwhile, M8.5b) keeps its code.
      if (error instanceof JobFailure) throw error;
      throw new JobFailure("PUBLISH_FAILED", "storing the result failed", { cause: error });
    }
    const publishMs = elapsed(start);

    return {
      stats: result.stats,
      extract: {
        files: extracted.files,
        directories: extracted.directories,
        tarBytes: extracted.tarBytes,
        skipped: extracted.skipped.length,
        skippedSample: extracted.skipped.slice(0, SKIPPED_SAMPLE_SIZE),
      },
      timings: { downloadMs, analyzeMs, publishMs },
    };
  } catch (error) {
    if (attempt.record !== undefined) await recordFailure(context, deps, attempt.record, error);
    else if (error instanceof JobFailure) await recordEarlyFailure(context, deps, error);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * The job's fact cache (factcache.ts), or `undefined` when it gets none. First every
 * installation folder whose repo isn't linked to it any more is deleted (M8.5b2); if that
 * fails (logged as `cache_purge_failed`), the job runs without a cache. Without
 * `linkedRepoIds` nothing can be confirmed, so an installation's job gets no cache.
 */
export async function jobCache(
  context: JobContext,
  deps: JobDeps,
  owner: CacheOwner,
): Promise<JobCache | undefined> {
  const root = deps.cacheRoot;
  if (root === undefined) return undefined;
  if (deps.linkedRepoIds === undefined) {
    if (owner.installationId !== undefined) return undefined;
  } else {
    try {
      await purgeUnlinkedFolders(root, deps.linkedRepoIds);
    } catch (error) {
      deps.log?.({
        event: "cache_purge_failed",
        id: context.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
  const folder = cacheFolder(root, owner);
  if (folder === undefined) return undefined;
  return prepareCacheFolder(root, folder, deps.cacheBytes);
}

/**
 * A runner callback: pass each event to `report` at once (so updates reach the queue in
 * order) without waiting, logging a failure (`progress_failed`, with `describe`'s fields)
 * instead of throwing it.
 */
function bestEffort<T>(
  context: JobContext,
  deps: JobDeps,
  report: (event: T) => Promise<void> | void,
  describe: (event: T) => Record<string, unknown>,
): (event: T) => void {
  return (event) => {
    void (async () => report(event))().catch((error: unknown) => {
      deps.log?.({
        event: "progress_failed",
        id: context.id,
        ...describe(event),
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };
}

/**
 * Tell the recorder an attempt failed. Anything but a {@link JobFailure} becomes the
 * processor's retriable `WORKER_ERROR`, so it's final only on the last attempt. If recording
 * fails too, that is logged and the job's own failure is what the queue sees.
 */
async function recordFailure(
  context: JobContext,
  deps: JobDeps,
  record: RecordedJob,
  error: unknown,
): Promise<void> {
  const failure = error instanceof JobFailure ? error : new JobFailure("WORKER_ERROR");
  const final = !failure.retriable || context.lastAttempt === true;
  try {
    await deps.recorder?.failed(record, failure.code, final);
  } catch (recordError) {
    deps.log?.({
      event: "record_failed",
      id: context.id,
      code: failure.code,
      message: recordError instanceof Error ? recordError.message : String(recordError),
    });
  }
}

/**
 * Tell the recorder a final failure came before its start wrote the row `running` (a refused
 * installation token, a repo GitHub doesn't show; M8.3c3b), so the queued row names it. A
 * failure that will be retried changes nothing. A failure to record is logged, like
 * {@link recordFailure}'s.
 */
async function recordEarlyFailure(
  context: JobContext,
  deps: JobDeps,
  failure: JobFailure,
): Promise<void> {
  const write = deps.recorder?.failedBeforeStart?.bind(deps.recorder);
  if (write === undefined || (failure.retriable && context.lastAttempt !== true)) return;
  try {
    await write(context.id, failure.code);
  } catch (recordError) {
    deps.log?.({
      event: "record_failed",
      id: context.id,
      code: failure.code,
      message: recordError instanceof Error ? recordError.message : String(recordError),
    });
  }
}

/**
 * Delete every leftover job folder under `jobsRoot`. Run once at startup, before the
 * worker takes jobs: a crash (or a SIGKILL from the container) skips the `finally` above.
 * Only safe while no job runs, as each worker container owns its `jobsRoot`.
 */
export async function sweepJobsRoot(jobsRoot: string): Promise<number> {
  const names = await readdir(jobsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  await Promise.all(
    names.map((name) => rm(join(jobsRoot, name), { recursive: true, force: true, maxRetries: 3 })),
  );
  return names.length;
}
