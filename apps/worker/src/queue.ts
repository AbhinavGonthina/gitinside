import {
  Queue,
  UnrecoverableError,
  Worker,
  type ConnectionOptions,
  type Job,
  type JobsOptions,
} from "bullmq";
import {
  JobRequestError,
  parseJobRequest,
  type JobKind,
  type JobQueue,
  type JobRequest,
  type JobStatus,
} from "./api.js";
import { FAILURE_CODE, JobFailure, RETRIABLE_CODES } from "./failure.js";
import { processJob, type JobDeps, type JobOutcome } from "./job.js";
import {
  STAGE_PROGRESS,
  isAnalyzerStep,
  stepProgress,
  type AnalyzerStep,
  type JobStage,
  type StepProgress,
} from "./progress.js";

/**
 * The BullMQ side of the worker (ADR-0014, ADR-0061): the {@link JobQueue} the enqueue API
 * writes to, and the `Worker` that runs {@link processJob} for each job.
 *
 * - **One queue,** {@link QUEUE_NAME}, on the Redis next to the worker (never public).
 * - **Concurrency {@link WORKER_CONCURRENCY}** per worker process; production runs one.
 * - **Retries:** `attempts: 3` with exponential backoff, for retriable failures only
 *   (failure.ts). A permanent failure throws BullMQ's `UnrecoverableError`, which fails the
 *   job at once.
 * - **Stalled jobs:** if the worker process dies mid-job its lock expires, and the stalled
 *   check puts the job back in the queue, at most {@link MAX_STALLED_COUNT} times. Past that
 *   it fails with `JOB_STALLED`. Stalls and attempts are counted apart, so a job that both
 *   stalls and fails retriably can start up to 3 + 2 = 5 times (DESIGN.md §12).
 * - **Dedupe:** the job ID is the enqueue API's derived ID, so the same commit is one job.
 *   Re-adding a job that **failed retriably** (GitHub was down for all 3 attempts) runs it
 *   again; any other existing job is left alone (`created: false`).
 * - **Shutdown:** {@link stopWorker} aborts running jobs (they fail with the retriable
 *   `CANCELLED`, so they run again after the restart) and waits for the worker to close.
 */

/** The queue's name in Redis. */
export const QUEUE_NAME = "analysis";
/** Jobs one worker runs at once (SECURITY.md T3, T9). */
export const WORKER_CONCURRENCY = 2;
/** Times a stalled job is put back before it fails (on top of the 3 attempts). */
export const MAX_STALLED_COUNT = 2;
/** How long queue calls from the API may take before it answers 503. */
export const QUEUE_CALL_TIMEOUT_MS = 5_000;

/** Every job's options: 3 attempts, exponential backoff, kept a day for status lookups. */
export const JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 15_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 24 * 60 * 60, count: 1_000 },
};

/**
 * What a job stores as its BullMQ progress: the stage, and while analyzing, the analyzer's
 * latest step and its count.
 */
export interface StoredProgress {
  stage: JobStage;
  progress: number;
  step?: AnalyzerStep;
  count?: number;
}

/** The progress stored when an analyzer step starts (or its count becomes known). */
export function progressForStep({ step, count }: StepProgress): StoredProgress {
  return {
    stage: "analyze",
    progress: stepProgress(step),
    step,
    ...(count === undefined ? {} : { count }),
  };
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isStoredProgress(value: unknown): value is StoredProgress {
  if (typeof value !== "object" || value === null) return false;
  const { stage, progress, step, count } = value as Record<string, unknown>;
  return (
    typeof stage === "string" &&
    Object.hasOwn(STAGE_PROGRESS, stage) &&
    isCount(progress) &&
    progress <= 100 &&
    (step === undefined || (stage === "analyze" && isAnalyzerStep(step))) &&
    (count === undefined || (step !== undefined && isCount(count)))
  );
}

/** The status fields of stored progress, and nothing else stored with it. */
function runningFields({ stage, progress, step, count }: StoredProgress): Partial<JobStatus> {
  return {
    stage,
    progress,
    ...(step === undefined ? {} : { step }),
    ...(count === undefined ? {} : { count }),
  };
}

/**
 * The code for a failed job's `failedReason`: our own code, `JOB_STALLED` when BullMQ gave
 * up on a job that kept stalling, or `WORKER_ERROR` for anything else.
 */
export function errorCodeFor(failedReason: string | undefined): string {
  if (failedReason !== undefined && FAILURE_CODE.test(failedReason)) return failedReason;
  if (failedReason !== undefined && /stalled/i.test(failedReason)) return "JOB_STALLED";
  return "WORKER_ERROR";
}

/** The facts {@link statusFromJob} needs, read from BullMQ. */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  /** `Job.getState()`. */
  state: string;
  /** `Job.progress`. */
  progress: unknown;
  failedReason?: string;
  /** Jobs ahead in the wait list, when `state` is `waiting`. */
  position?: number;
}

/**
 * Map a BullMQ job to the API's {@link JobStatus}: waiting, delayed (a retry's backoff),
 * and prioritized jobs are `queued` (only waiting ones have a position); active is
 * `running` with its stage; completed is `done`; failed has its code. `unknown` (gone,
 * or never added) is `undefined`.
 */
export function statusFromJob(job: JobSnapshot): JobStatus | undefined {
  const base = { id: job.id, kind: job.kind };
  switch (job.state) {
    case "waiting":
    case "prioritized":
    case "delayed":
    case "waiting-children":
      return {
        ...base,
        state: "queued",
        ...(job.state === "waiting" && job.position !== undefined
          ? { position: job.position }
          : {}),
      };
    case "active":
      return {
        ...base,
        state: "running",
        ...(isStoredProgress(job.progress) ? runningFields(job.progress) : {}),
      };
    case "completed":
      return { ...base, state: "done" };
    case "failed":
      return { ...base, state: "failed", errorCode: errorCodeFor(job.failedReason) };
    default:
      return undefined;
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`queue call took over ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A {@link JobQueue} on a BullMQ `Queue`, plus `close`. */
export interface BullJobQueue extends JobQueue {
  readonly queue: Queue<JobRequest, JobOutcome>;
  close(): Promise<void>;
}

/** Options for {@link createBullJobQueue}. */
export interface BullQueueOptions {
  connection: ConnectionOptions;
  /** Redis key prefix (tests isolate themselves with it). Default BullMQ's `bull`. */
  prefix?: string;
  /** Default {@link QUEUE_CALL_TIMEOUT_MS}. */
  callTimeoutMs?: number;
  /** Merged over {@link JOB_OPTIONS} (tests shorten the backoff). */
  jobOptions?: JobsOptions;
}

/** The enqueue API's queue, backed by BullMQ. */
export function createBullJobQueue(options: BullQueueOptions): BullJobQueue {
  const queue = new Queue<JobRequest, JobOutcome>(QUEUE_NAME, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: { ...JOB_OPTIONS, ...options.jobOptions },
  });
  const ms = options.callTimeoutMs ?? QUEUE_CALL_TIMEOUT_MS;
  // Connection errors surface through the calls below; without a listener they'd crash.
  queue.on("error", () => undefined);

  async function add(id: string, request: JobRequest): Promise<{ created: boolean }> {
    const existing = await queue.getJob(id);
    if (existing !== undefined) {
      const state = await existing.getState();
      const code = state === "failed" ? errorCodeFor(existing.failedReason) : undefined;
      if (code === undefined || !RETRIABLE_CODES.has(code)) return { created: false };
      await existing.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
      return { created: true };
    }
    await queue.add(request.kind, request, { jobId: id });
    return { created: true };
  }

  async function get(id: string): Promise<JobStatus | undefined> {
    const job = await queue.getJob(id);
    if (job === undefined) return undefined;
    const state = await job.getState();
    let position: number | undefined;
    if (state === "waiting") {
      // Oldest first, which is the order workers take them in.
      const waiting = await queue.getRanges(["wait"], 0, -1, true);
      const index = waiting.indexOf(id);
      if (index >= 0) position = index;
    }
    return statusFromJob({
      id,
      kind: job.data.kind,
      state,
      progress: job.progress,
      failedReason: job.failedReason,
      ...(position === undefined ? {} : { position }),
    });
  }

  return {
    queue,
    add: (id, request) => withTimeout(add(id, request), ms),
    get: (id) => withTimeout(get(id), ms),
    ping: async () => {
      await withTimeout(queue.getWaitingCount(), ms);
    },
    close: () => queue.close(),
  };
}

/** One structured log line (DESIGN.md §13); the worker's entry point writes them as JSON. */
export type WorkerLog = (event: Record<string, unknown>) => void;

/** Options for {@link createAnalysisWorker}. */
export interface AnalysisWorkerOptions {
  connection: ConnectionOptions;
  deps: JobDeps;
  prefix?: string;
  /** Default {@link WORKER_CONCURRENCY}. */
  concurrency?: number;
  /** BullMQ's lock and stalled-check timings (tests shorten them). Defaults 30 s each. */
  lockDuration?: number;
  stalledInterval?: number;
  log?: WorkerLog;
}

/**
 * The job processor BullMQ calls: validate the stored request, run {@link processJob},
 * report stages as progress, and turn failures into what BullMQ understands (a plain
 * `Error` is retried, an `UnrecoverableError` isn't). Both carry only the code.
 */
export function createProcessor(
  deps: JobDeps,
  log: WorkerLog = () => undefined,
): (
  job: Job<JobRequest, JobOutcome>,
  token: string | undefined,
  signal: AbortSignal | undefined,
) => Promise<JobOutcome> {
  // Three declared parameters: BullMQ passes the abort signal only to processors that
  // take it (Function.length >= 3).
  const jobDeps: JobDeps = { log, ...deps };
  return async (job, token, signal) => {
    void token;
    const id = job.id ?? "";
    const attempt = job.attemptsMade + 1;
    let failure: JobFailure;
    try {
      const request = parseJobRequest(job.data);
      const outcome = await processJob(
        {
          id,
          request,
          ...(signal === undefined ? {} : { signal }),
          onStage: (stage) => job.updateProgress({ stage, progress: STAGE_PROGRESS[stage] }),
          onStep: (step) => job.updateProgress(progressForStep(step)),
          lastAttempt: attempt >= (job.opts.attempts ?? 1),
        },
        jobDeps,
      );
      log({ event: "job_done", id, attempt, nodes: outcome.stats.nodes, ...outcome.timings });
      return outcome;
    } catch (error) {
      failure =
        error instanceof JobFailure
          ? error
          : error instanceof JobRequestError
            ? new JobFailure("INVALID_REQUEST", error.message)
            : new JobFailure(
                "WORKER_ERROR",
                error instanceof Error ? error.message : String(error),
              );
    }
    log({
      event: "job_failed",
      id,
      attempt,
      code: failure.code,
      retriable: failure.retriable,
      detail: failure.detail,
    });
    throw failure.retriable ? new Error(failure.code) : new UnrecoverableError(failure.code);
  };
}

/** The worker that runs analyses: concurrency 2, stalled-job recovery, retries. */
export function createAnalysisWorker(
  options: AnalysisWorkerOptions,
): Worker<JobRequest, JobOutcome> {
  const log = options.log ?? (() => undefined);
  const worker = new Worker<JobRequest, JobOutcome>(
    QUEUE_NAME,
    createProcessor(options.deps, log),
    {
      connection: options.connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      concurrency: options.concurrency ?? WORKER_CONCURRENCY,
      maxStalledCount: MAX_STALLED_COUNT,
      ...(options.lockDuration === undefined ? {} : { lockDuration: options.lockDuration }),
      ...(options.stalledInterval === undefined
        ? {}
        : { stalledInterval: options.stalledInterval }),
    },
  );
  worker.on("error", (error) => log({ event: "worker_error", message: error.message }));
  worker.on("stalled", (id) => log({ event: "job_stalled", id }));
  return worker;
}

/** Abort running jobs (they'll run again: `CANCELLED` is retriable), then close. */
export async function stopWorker(worker: Worker): Promise<void> {
  worker.cancelAllJobs("worker shutting down");
  await worker.close();
}
