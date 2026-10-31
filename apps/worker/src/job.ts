import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JobProgress } from "@gitinside/db";
import type { JobRequest } from "./api.js";
import { ExtractError, extractTarball, type ExtractLimits, type SkippedEntry } from "./extract.js";
import { JobFailure } from "./failure.js";
import { openTarball, type DownloadOptions } from "./github.js";
import type { FoundFacts, JobStage, StepProgress } from "./progress.js";
import type { AnalysisStats } from "./protocol.js";
import { runAnalysis, type RunOptions, type RunResult } from "./runner.js";

/**
 * One job, start to finish (docs/SECURITY.md §3; ADR-0061):
 * 1. **download + extract:** the recorder (if any) marks the analysis running in Postgres;
 *    then the tarball streams from GitHub (github.ts) straight into
 *    `<jobsRoot>/<id>-<random>/src` (extract.ts); nothing is buffered on disk first. All of
 *    it shares one budget, {@link DEFAULT_DOWNLOAD_TIMEOUT_MS}.
 * 2. **analyze:** the sandboxed child (runner.ts) writes `architecture.json` next to `src`.
 * 3. **publish:** the caller's `publish` stores the graph (record.ts: the bucket, then Postgres).
 * 4. **clean up:** the job folder is deleted whatever happened. A failed attempt is
 *    recorded as queued again, or failed if it was final.
 *
 * Every failure is a {@link JobFailure} with a code; the queue decides from
 * `retriable` whether to try again. The folder name has a random part, so a stalled
 * attempt that is still running elsewhere never shares a folder with its retry.
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
 * Records each attempt in Postgres (record.ts; ADR-0063). `publish` marks the analysis done;
 * the recorder handles the rest of its lifecycle.
 */
export interface JobRecorder {
  /**
   * Before the download: look the repo up on GitHub, upsert it, mark the analysis running
   * as job `jobId` (ADR-0139).
   */
  start(request: JobRequest, signal: AbortSignal, jobId: string): Promise<RecordedJob>;
  /** After a failed attempt: `final` marks the analysis failed, otherwise queued again. */
  failed(job: RecordedJob, code: string, final: boolean): Promise<void>;
  /**
   * Where job `jobId`'s running attempt is, for the progress page (ADR-0139). The queue's
   * processor calls it with each progress update, one at a time, and only logs a failure.
   */
  progress?(jobId: string, progress: JobProgress): Promise<void>;
}

/** What a finished job returns (the BullMQ return value). */
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
}

/** What the worker supplies for every job. */
export interface JobDeps {
  /** Parent of the job folders (`/tmp/jobs` in production). Must exist or be creatable. */
  jobsRoot: string;
  publish: (artifact: JobArtifact) => Promise<void>;
  download?: Omit<DownloadOptions, "signal">;
  downloadTimeoutMs?: number;
  extractLimits?: Partial<ExtractLimits>;
  run?: (job: Parameters<typeof runAnalysis>[0], options: RunOptions) => Promise<RunResult>;
  runOptions?: Omit<RunOptions, "signal">;
  /** Without one, nothing is written to Postgres (and `artifact.record` is absent). */
  recorder?: JobRecorder;
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
}

const JOB_FOLDER_ID = /^[A-Za-z0-9_-]{1,100}$/;
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
  const timeout = AbortSignal.timeout(deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  const signal =
    context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  try {
    if (deps.recorder !== undefined) {
      attempt.record = await deps.recorder.start(context.request, signal, context.id);
    }
    const { owner, repo, sha } = context.request;
    const body = await openTarball({ owner, repo, sha }, { ...deps.download, signal });
    await context.onStage?.("extract");
    return await extractTarball(body, dest, { limits: deps.extractLimits ?? {} });
  } catch (error) {
    if (context.signal?.aborted) throw new JobFailure("CANCELLED", "cancelled while downloading");
    if (timeout.aborted) throw new JobFailure("DOWNLOAD_TIMEOUT", "download budget exceeded");
    if (error instanceof JobFailure) throw error;
    if (error instanceof ExtractError) throw new JobFailure(error.code, error.message);
    // The body failing mid-stream (a reset connection) is a download failure too.
    throw new JobFailure("DOWNLOAD_FAILED", "the download stopped", { cause: error });
  }
}

/**
 * Run one job. Resolves with its {@link JobOutcome} or throws a {@link JobFailure};
 * the job folder is gone either way.
 */
export async function processJob(context: JobContext, deps: JobDeps): Promise<JobOutcome> {
  // The ID names a folder; the enqueue API derives it, but check before touching the disk.
  if (!JOB_FOLDER_ID.test(context.id)) throw new JobFailure("INVALID_REQUEST", "bad job ID");
  if (context.request.kind !== "analyze") {
    throw new JobFailure("UNSUPPORTED_JOB", `${context.request.kind} jobs arrive with M6`);
  }
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
    const { owner, repo, sha } = context.request;
    const result = await run(
      { src, out, owner, name: repo, sha },
      {
        ...deps.runOptions,
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
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
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
