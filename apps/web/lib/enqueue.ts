import {
  QUEUE_UNAVAILABLE_CODE,
  countComputeUsage,
  failAnalysis,
  queueAnalysis,
  upsertRepo,
  type AnyDatabase,
} from "@gitinside/db";
import { jobIdFor } from "@gitinside/worker/request";
import { taskIdFor, type TaskQueue } from "./cloudTasks";
import type { ResolvedRepo } from "./github";
import { WorkerUnavailableError } from "./worker";

/**
 * Queue one commit's analysis on Cloud Tasks (ADR-0139, ADR-0141), for `/api/analyze` and
 * check-on-view alike:
 *
 * 1. **The row first.** The repo and a `queued` row are written (`queueAnalysis`), under the
 *    job ID the worker derives too (`jobIdFor` from `@gitinside/worker/request`). The row is
 *    the dedupe: a commit already `running` or `done` gets no task.
 * 2. **Then the task,** named from the row's queue entry (`taskIdFor(jobId, queued_at)`), so
 *    two requests racing for one entry create one task, and a failed job queued again gets a
 *    fresh name.
 * 3. **No task, no queued row.** If the task can't be created, the row this call queued is
 *    failed with {@link QUEUE_UNAVAILABLE} (retryable: "Analyze again"), so it never sits in
 *    everyone's queue position with nothing to run it. A row another request queued is left
 *    to that request. If a racing request did create the task, the worker's start moves the
 *    failed row to `running` anyway.
 * 4. **Counted:** each create call is a Cloud Tasks operation in the month's compute
 *    (ADR-0156); the worker counts the deliveries.
 */

/**
 * The error code of a row whose task couldn't be created, or that the worker's maintenance
 * found queued past every task's window (ADR-0147). Not permanent: retrying can pass.
 */
export const QUEUE_UNAVAILABLE = QUEUE_UNAVAILABLE_CODE;

/** Everything {@link enqueueAnalysis} talks to. */
export interface EnqueueDeps {
  db: AnyDatabase;
  queue: Pick<TaskQueue, "createTask">;
  /** `@gitinside/analyzer/version`: part of the row's key and the job ID. */
  analyzerVersion: string;
}

/** Where the commit's analysis stands after {@link enqueueAnalysis}. */
export type EnqueueResult =
  /** Finished meanwhile (a racing job): nothing queued. */
  | { status: "done" }
  /**
   * In the queue or running. `entered`: this call queued it (a new analysis, charged to
   * whoever asked); otherwise it was already in flight.
   */
  | { status: "queued" | "running"; jobId: string; entered: boolean }
  /** The task couldn't be created; a row this call queued is failed. */
  | { status: "unavailable" };

/** Queue `repo`'s commit (GitHub's facts, as resolved) unless it's already in flight or done. */
export async function enqueueAnalysis(
  repo: ResolvedRepo,
  deps: EnqueueDeps,
): Promise<EnqueueResult> {
  const job = { owner: repo.owner, repo: repo.name, sha: repo.sha };
  const jobId = jobIdFor({ kind: "analyze", ...job }, deps.analyzerVersion);
  const { id: repoId } = await upsertRepo(deps.db, repo);
  const row = await queueAnalysis(
    deps.db,
    { repoId, sha: repo.sha, analyzerVersion: deps.analyzerVersion },
    // The size it's queued at: a `LIMIT_*` failure holds the repo until it halves (sizeHold.ts).
    repo.sizeKb === undefined ? { jobId } : { jobId, repoSizeKb: repo.sizeKb },
  );
  if (row.status === "done") return { status: "done" };
  if (row.status === "running") return { status: "running", jobId, entered: false };

  try {
    await deps.queue.createTask(job, taskIdFor(jobId, row.queuedAt));
  } catch (error) {
    await countTaskOperation(deps.db);
    if (row.entered) await failAnalysis(deps.db, row.id, QUEUE_UNAVAILABLE);
    if (error instanceof WorkerUnavailableError) return { status: "unavailable" };
    throw error;
  }
  await countTaskOperation(deps.db);
  return { status: "queued", jobId, entered: row.entered };
}

/**
 * Count one Cloud Tasks operation (a create call, answered or not) in the month's compute
 * (`compute_usage`, ADR-0156). A count that fails is logged by name, never thrown: the task
 * exists either way.
 */
async function countTaskOperation(db: AnyDatabase): Promise<void> {
  try {
    await countComputeUsage(db, { taskOperations: 1 });
  } catch (error) {
    // By name only: a driver error's message can carry connection details.
    console.error(
      JSON.stringify({
        event: "compute_count_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}
