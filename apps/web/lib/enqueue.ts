import {
  QUEUE_UNAVAILABLE_CODE,
  countComputeUsage,
  failAnalysis,
  failStrandedAnalysis,
  findAnalysis,
  findInstallation,
  isPrivateSnapshot,
  queueAnalysis,
  UnknownInstallationError,
  upsertRepo,
  type AnalysisSummary,
  type AnyDatabase,
  type StrandedWait,
} from "@gitinside/db";
import { jobIdFor } from "@gitinside/worker/request";
import {
  DISPATCH_DEADLINE_SECONDS,
  QUEUE_SLOTS,
  STRANDED_AFTER_SECONDS,
  taskIdFor,
  type TaskQueue,
} from "./cloudTasks";
import type { ResolvedRepo } from "./github";
import { WorkerUnavailableError, type AnalyzeJob } from "./worker";

/**
 * Queue one commit's analysis on Cloud Tasks (ADR-0139, ADR-0141), for `/api/analyze` and
 * check-on-view alike:
 *
 * 1. **The row first.** The repo and a `queued` row are written (`queueAnalysis`), under the
 *    job ID the worker derives too (`jobIdFor` from `@gitinside/worker/request`). The row is
 *    the dedupe: a commit already `running` or `done` gets no task, and neither does one
 *    `queued` for a retry (`retrying`): Cloud Tasks pushes that task again after its backoff,
 *    and a second task would run beside it (R1, ADR-0142's amendment).
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

/** When a `queued` row has no task coming any more (`failStrandedAnalysis`). */
const STRANDED_WAIT: StrandedWait = {
  queuedForSeconds: STRANDED_AFTER_SECONDS,
  // Cloud Tasks frees a slot once the push is answered or its deadline passes.
  runningForSeconds: DISPATCH_DEADLINE_SECONDS,
  slots: QUEUE_SLOTS,
};

/**
 * The commit's analysis (`findAnalysis`), for a caller that may queue it: `/api/analyze`
 * and check-on-view. A `queued` row no task is coming for any more (R10: Cloud Tasks gave
 * up before the worker wrote anything, e.g. three `503`s at a cold start or a `401` during
 * a secret rotation) is failed with {@link QUEUE_UNAVAILABLE} first. The caller then treats
 * the commit as a new analysis (every limit applies, a slot is taken), and
 * {@link enqueueAnalysis} queues it again under a fresh task name, where it used to count as
 * in flight, its name refused as `ALREADY_EXISTS`, until maintenance failed it a day later.
 *
 * With `replacePrivate` (a public job), a `done` row stored under `private/` is no analysis at
 * all: {@link enqueueAnalysis} queues it again (M8.4d2, ADR-0239).
 */
export async function findAnalysisToQueue(
  db: AnyDatabase,
  key: Parameters<typeof findAnalysis>[1],
  options: { replacePrivate?: boolean } = {},
): Promise<AnalysisSummary | undefined> {
  const found = await findAnalysis(db, key);
  if (options.replacePrivate === true && found?.status === "done") {
    if (isPrivateSnapshot(found.snapshotKey)) return undefined;
  }
  if (found?.status !== "queued") return found;
  if (!(await failStrandedAnalysis(db, found.id, STRANDED_WAIT))) return found;
  return findAnalysis(db, key);
}

/** A repo's visibility, and the installation it's read through: a private repo always names one. */
type ReadThrough =
  | { visibility: "public"; installationId?: number }
  | { visibility: "private"; installationId: number };

/** A repo to store: GitHub's facts about it, and the installation (GitHub's ID) it's read through. */
export type StoreRepo = Pick<ResolvedRepo, "providerRepoId" | "owner" | "name" | "defaultBranch"> &
  ReadThrough;

/** A repo to queue: GitHub's facts as resolved, with the commit, and its installation. */
export type QueueRepo = Omit<ResolvedRepo, "visibility"> & ReadThrough;

/** Why {@link enqueueAnalysis} refused a repo's installation; `jobs.ts` words each code. */
export type InstallationRefusal = "INSTALLATION_NOT_FOUND" | "INSTALLATION_SUSPENDED";

/**
 * Thrown by {@link enqueueAnalysis} before anything is written when the repo's installation
 * isn't stored (uninstalled, or its events never arrived) or is suspended (ADR-0227). GitHub
 * would refuse its token anyway; refusing here says why instead of failing the job later.
 */
export class InstallationRefusedError extends Error {
  override name = "InstallationRefusedError";
  constructor(readonly code: InstallationRefusal) {
    super(`installation refused: ${code}`);
  }
}

/**
 * Store `repo` (GitHub's facts) and return its row's ID. Through an installation, the stored
 * installation is checked first and the repo linked to it (ADR-0227); one that isn't stored or
 * is suspended throws {@link InstallationRefusedError} with nothing written, so a refused
 * private repo's name is never stored.
 */
export async function storeQueueRepo(db: AnyDatabase, repo: StoreRepo): Promise<{ id: string }> {
  const { installationId } = repo;
  if (installationId !== undefined) {
    const installation = await findInstallation(db, installationId);
    if (installation === undefined) throw new InstallationRefusedError("INSTALLATION_NOT_FOUND");
    if (installation.suspendedAt !== null) {
      throw new InstallationRefusedError("INSTALLATION_SUSPENDED");
    }
  }
  return upsertRepo(db, {
    providerRepoId: repo.providerRepoId,
    owner: repo.owner,
    name: repo.name,
    visibility: repo.visibility,
    defaultBranch: repo.defaultBranch,
    ...(installationId === undefined ? {} : { githubInstallationId: installationId }),
  }).catch((error: unknown) => {
    // Deleted since the check (M8.5): the same refusal, still with nothing written.
    if (error instanceof UnknownInstallationError) {
      throw new InstallationRefusedError("INSTALLATION_NOT_FOUND");
    }
    throw error;
  });
}

/**
 * Queue `repo`'s commit (GitHub's facts, as resolved) unless it's already in flight or done.
 *
 * Through an installation (ADR-0227): the stored installation is checked first, the repo is
 * linked to it, the job ID includes it (`jobIdFor`), and so does the task's body, so the
 * worker reads the repo through it. A commit already in flight under another job ID (queued
 * without the installation, or through another one) is followed, not queued beside it: the
 * row is the dedupe, and the task names come from the job ID.
 *
 * Without an installation (a public job), a `done` row stored under `private/` counts as not
 * analyzed: the repo was analyzed privately and is public now, so the commit is queued again
 * and its snapshot written under the public key (M8.4d2, ADR-0239), never served publicly
 * from the private one.
 */
export async function enqueueAnalysis(repo: QueueRepo, deps: EnqueueDeps): Promise<EnqueueResult> {
  const { installationId } = repo;
  const job: AnalyzeJob = {
    owner: repo.owner,
    repo: repo.name,
    sha: repo.sha,
    ...(installationId === undefined ? {} : { installationId }),
  };
  const jobId = jobIdFor({ kind: "analyze", ...job }, deps.analyzerVersion);
  const { id: repoId } = await storeQueueRepo(deps.db, repo);
  const row = await queueAnalysis(
    deps.db,
    { repoId, sha: repo.sha, analyzerVersion: deps.analyzerVersion },
    {
      jobId,
      // The size it's queued at: a `LIMIT_*` failure holds the repo until it halves (sizeHold.ts).
      ...(repo.sizeKb === undefined ? {} : { repoSizeKb: repo.sizeKb }),
      // A public job analyzes again what was analyzed privately (M8.4d2, ADR-0239).
      replacePrivate: installationId === undefined,
    },
  );
  if (row.status === "done") return { status: "done" };
  // The row's own job, if another request queued or started it under another ID.
  const current = row.entered ? jobId : (row.jobId ?? jobId);
  if (row.status === "running") return { status: "running", jobId: current, entered: false };
  // Its task will push it again after the backoff; a new task would run beside it (R1).
  if (row.retrying) return { status: "queued", jobId: current, entered: false };
  // Another job's entry: its task is that request's to create, under that job's name.
  if (current !== jobId) return { status: "queued", jobId: current, entered: false };

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
export async function countTaskOperation(db: AnyDatabase): Promise<void> {
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
