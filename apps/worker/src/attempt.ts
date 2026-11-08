import { JobRequestError, parseJobRequest } from "./request.js";
import {
  BENCH_MODEL,
  expectedMs,
  timingModel,
  type EstimatePoint,
  type TimingSample,
} from "./estimate.js";
import { JobFailure } from "./failure.js";
import { processDiffJob } from "./diffJob.js";
import { JobAlreadyDone, processJob, type JobDeps, type JobOutcome } from "./job.js";
import {
  STAGE_PROGRESS,
  stepProgress,
  type FoundFacts,
  type StepProgress,
  type StoredProgress,
} from "./progress.js";

/**
 * One attempt at a job, as Cloud Tasks' push to `POST /run` delivers it (run.ts, ADR-0114):
 * validate the request, run {@link processJob} (an analysis) or {@link processDiffJob} (a
 * pull request's diff),
 * report each stage and step as progress (with the time expected from each step on, once the
 * file count is known, ADR-0136) to the caller and to the recorder's Postgres row
 * (ADR-0139), log the outcome, and turn every error into a {@link JobFailure}.
 */

/** One structured log line (DESIGN.md §13); the worker's entry point writes them as JSON. */
export type WorkerLog = (event: Record<string, unknown>) => void;

/** Where the time estimates come from (estimate.ts, ADR-0136). */
export interface ProcessorEstimates {
  /**
   * Recent finished analyses' stats, read once per attempt. Without it, while it's pending,
   * or if it fails (logged as `estimate_samples_failed`), the benchmark's rates are used.
   */
  samples?: () => Promise<readonly TimingSample[]>;
  /** Clock for when each stage or step started. Default `Date.now`. */
  now?: () => number;
}

/** What one attempt is given. */
export interface AttemptInput {
  /** The job ID (derived from the request by run.ts). */
  id: string;
  /** The job body as delivered; checked with `parseJobRequest` before anything runs. */
  data: unknown;
  /** 1 for the first attempt. */
  attempt: number;
  /** No attempt follows this one, so even a retriable failure is final. */
  lastAttempt: boolean;
  /** Cancels the job (shutdown, or the caller gone); it fails with the retriable `CANCELLED`. */
  signal?: AbortSignal;
  /** Milliseconds left in the attempt's budget (run.ts's deadline); none without it. */
  timeLeft?: () => number;
  /** Gets every progress update too, awaited before the job goes on (tests watch with it). */
  report?: (progress: StoredProgress) => Promise<void>;
}

/**
 * How an attempt ended. `alreadyDone`: the recorder's start found the row `done`, so nothing
 * ran (R9); it succeeds all the same, since the result exists.
 */
export type AttemptResult =
  | { ok: true; outcome: JobOutcome; alreadyDone?: never }
  | { ok: true; alreadyDone: true; outcome?: never }
  | { ok: false; failure: JobFailure };

/** The progress stored when an analyzer step starts (or its count becomes known). */
export function progressForStep({ step, count }: StepProgress): StoredProgress {
  return {
    stage: "analyze",
    progress: stepProgress(step),
    step,
    ...(count === undefined ? {} : { count }),
  };
}

/** Where `progress` is for {@link expectedMs}, if it's somewhere an estimate can be made. */
function estimatePoint({ stage, step }: StoredProgress): EstimatePoint | undefined {
  if (stage === "upload") return { stage };
  return stage === "analyze" && step !== undefined ? { stage, step } : undefined;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Run one attempt. Never rejects: the result says whether it succeeded, and a failure carries
 * its code (an invalid request is `INVALID_REQUEST`, anything unexpected `WORKER_ERROR`).
 * Logs `job_done`, `job_already_done`, or `job_failed`.
 */
export async function runAttempt(
  input: AttemptInput,
  deps: JobDeps,
  log: WorkerLog = () => undefined,
  estimates: ProcessorEstimates = {},
): Promise<AttemptResult> {
  const { id, attempt } = input;
  const jobDeps: JobDeps = { log, ...deps };
  const now = estimates.now ?? Date.now;
  // Past jobs' rates once they're read; the benchmark's until then.
  let model = BENCH_MODEL;
  void estimates.samples?.().then(
    (samples) => {
      model = timingModel(samples);
    },
    (error: unknown) => {
      log({ event: "estimate_samples_failed", id, message: messageOf(error) });
    },
  );
  // What this attempt has found stays in every later update, the upload stage's too; a
  // retry starts over, so nothing from an earlier attempt shows.
  let latest: StoredProgress = { stage: "download", progress: STAGE_PROGRESS.download };
  let found: FoundFacts | undefined;
  // Postgres gets every update too (ADR-0139), one write at a time so they land in order;
  // the job never waits for them, and a failed one is only logged.
  let written = Promise.resolve();
  const record = (progress: StoredProgress) => {
    const write = jobDeps.recorder?.progress?.bind(jobDeps.recorder);
    if (write === undefined) return;
    written = written
      .then(() => write(id, progress))
      .catch((error: unknown) => {
        log({
          event: "progress_record_failed",
          id,
          stage: progress.stage,
          message: messageOf(error),
        });
      });
  };
  const store = async (progress: StoredProgress) => {
    latest = progress;
    const stored = found === undefined ? progress : { ...progress, found };
    record(stored);
    await input.report?.(stored);
  };
  // When the current stage or step started, and the source files (from `programs` on).
  let place = "";
  let since = now();
  let files: number | undefined;
  const estimated = (progress: StoredProgress): StoredProgress => {
    const here = `${progress.stage}/${progress.step ?? ""}`;
    if (here !== place) {
      place = here;
      since = now();
    }
    if (progress.step === "programs" && progress.count !== undefined) files = progress.count;
    const point = estimatePoint(progress);
    const expectMs = point === undefined ? undefined : expectedMs(model, point, files);
    return expectMs === undefined ? progress : { ...progress, since, expectMs };
  };
  let failure: JobFailure;
  try {
    const request = parseJobRequest(input.data);
    const runJob = request.kind === "diff" ? processDiffJob : processJob;
    const outcome = await runJob(
      {
        id,
        request,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.timeLeft === undefined ? {} : { timeLeft: input.timeLeft }),
        onStage: (stage) => store(estimated({ stage, progress: STAGE_PROGRESS[stage] })),
        onStep: (step) => store(estimated(progressForStep(step))),
        onFound: (facts) => {
          found = facts;
          return store(latest);
        },
        lastAttempt: input.lastAttempt,
      },
      jobDeps,
    );
    log({
      event: "job_done",
      id,
      attempt,
      nodes: outcome.stats.nodes,
      ...outcome.timings,
      ...(outcome.diff === undefined ? {} : outcome.diff),
    });
    return { ok: true, outcome };
  } catch (error) {
    if (error instanceof JobAlreadyDone) {
      log({ event: "job_already_done", id, attempt });
      return { ok: true, alreadyDone: true };
    }
    failure =
      error instanceof JobFailure
        ? error
        : error instanceof JobRequestError
          ? new JobFailure("INVALID_REQUEST", error.message)
          : new JobFailure("WORKER_ERROR", messageOf(error));
  }
  log({
    event: "job_failed",
    id,
    attempt,
    code: failure.code,
    retriable: failure.retriable,
    detail: failure.detail,
  });
  return { ok: false, failure };
}
