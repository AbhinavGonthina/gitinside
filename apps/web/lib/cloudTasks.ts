import { signRequest } from "@gitinside/worker/hmac";
import { GoogleAuthError } from "./googleAuth";
import { WorkerUnavailableError, type TaskJob } from "./worker";

/**
 * The web app's side of the Cloud Tasks queue (ADR-0114, ADR-0141): one REST call,
 * `POST cloudtasks.googleapis.com/v2/projects/<p>/locations/<l>/queues/<q>/tasks`, without a
 * Google SDK. Cloud Tasks then pushes the task to the worker's `POST /run` on Cloud Run with
 * an OIDC token for `invokerServiceAccount` (so Cloud Run's IAM lets it in), at most 2 at
 * once and 3 attempts (the queue's own settings, M5.17e).
 *
 * - **The body is the job, HMAC-signed** for `POST /run` with `@gitinside/worker/hmac`, the
 *   signature carried in the task's headers. It's signed when the task is created, so the
 *   worker must accept the signature for as long as a task can wait and retry (M5.17c).
 * - **A task is named** ({@link taskIdFor}), and Cloud Tasks refuses a name used in the last
 *   ~24 hours with `ALREADY_EXISTS`: that means the job is already queued (`created: false`).
 * - **The dispatch deadline** ({@link DISPATCH_DEADLINE_SECONDS}) outlasts Cloud Run's 5 min
 *   request timeout, so Cloud Run ends an overlong job and answers first; Cloud Tasks never
 *   gives up on a request that's still running and pushes a second copy beside it.
 *
 * Every failure (no Google token, network, a refusal) is a {@link WorkerUnavailableError},
 * which `/api/analyze` and check-on-view answer as "temporarily unavailable" (enqueue.ts).
 */

/** Options for {@link createTaskQueue}. */
export interface TaskQueueOptions {
  /** The queue: project ID, region, and queue ID. */
  queue: { project: string; location: string; queue: string };
  /** The worker's Cloud Run service URL (an origin), the OIDC token's audience. */
  workerUrl: string;
  /** The service account Cloud Tasks signs each push as (Cloud Run's only invoker). */
  invokerServiceAccount: string;
  /** `ENQUEUE_HMAC_SECRET`. */
  secret: string;
  /** An access token of the enqueue-only service account (googleAuth.ts). */
  token: () => Promise<string>;
  /** Overrides Google's API origin (the fake Google server). */
  endpoint?: string;
  /** Each request gives up after this long. Default 5 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Clock for the signature (tests fix it). Default `Date.now`. */
  now?: () => number;
}

/** Adds analysis and diff tasks to the queue. */
export interface TaskQueue {
  /**
   * Create the task `taskId` for `job` (an `AnalyzeJob` is sent with `kind: "analyze"`, a
   * `DiffJob` with its own kind); `created: false` if that name was already used.
   */
  createTask(job: TaskJob, taskId: string): Promise<{ created: boolean }>;
}

/** The worker's path Cloud Tasks pushes to (M5.17c). */
export const RUN_PATH = "/run";
/**
 * How long Cloud Tasks waits for the worker's answer: 30 s past Cloud Run's 300 s request
 * timeout (ADR-0111). Google allows 15 s to 30 min for HTTP targets (checked 2026-10-31).
 */
export const DISPATCH_DEADLINE_SECONDS = 330;
/** The queue's deliveries per task (`maxAttempts`, the worker's `MAX_ATTEMPTS`). */
export const TASK_ATTEMPTS = 3;
/** The queue's waits between those deliveries, in seconds (`minBackoff` 30 s, doubling). */
export const RETRY_BACKOFF_SECONDS: readonly number[] = [30, 60];
/** The queue's concurrent dispatches (`maxConcurrentDispatches`: one per worker instance). */
export const QUEUE_SLOTS = 2;
/**
 * How long a row stays `queued` before a request may give it a fresh task (R10, ADR-0147's
 * amendment): every delivery's deadline plus both backoffs (18 min), and 2 min for the
 * first dispatch and the worker's first write. Only once a dispatch slot is free, too
 * (`failStrandedAnalysis`): a task waiting behind other jobs can take longer.
 */
export const STRANDED_AFTER_SECONDS =
  TASK_ATTEMPTS * DISPATCH_DEADLINE_SECONDS +
  RETRY_BACKOFF_SECONDS.reduce((sum, wait) => sum + wait, 0) +
  120;

const ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z]+-[a-z]+[0-9]+$/;
const QUEUE = /^[A-Za-z0-9-]{1,100}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,500}$/;
const JOB_ID = /^(?:analyze|diff)-[0-9a-f]{32}$/;

/** Whether Cloud Tasks accepts `taskId` as a task's ID (letters, digits, `-`, `_`; ≤ 500). */
export function isTaskId(taskId: string): boolean {
  return TASK_ID.test(taskId);
}

/**
 * The task name for one queue entry of a job: `<job ID>-<entry time in ms>`. The job ID keeps
 * requests for one queue entry on one name (they share the row's `queued_at`), so a race
 * creates one task; the entry time gives a failed job that's queued again a fresh name, since
 * Google keeps a used name for up to 24 hours. The hashed job ID first spreads names over
 * Google's index, as Google asks (a timestamp prefix slows every task call).
 */
export function taskIdFor(jobId: string, queuedAt: Date): string {
  const ms = queuedAt.getTime();
  if (!JOB_ID.test(jobId) || !Number.isSafeInteger(ms) || ms < 0) {
    throw new Error("taskIdFor needs a job ID and a valid time");
  }
  return `${jobId}-${ms}`;
}

/** A queue client. Throws at once on a malformed queue name or worker URL. */
export function createTaskQueue(options: TaskQueueOptions): TaskQueue {
  const { project, location, queue } = options.queue;
  if (!ID.test(project) || !LOCATION.test(location) || !QUEUE.test(queue)) {
    throw new Error("queue must name a project ID, a region, and a queue ID");
  }
  const worker = new URL(options.workerUrl);
  if (worker.protocol !== "https:" || worker.pathname !== "/" || worker.search !== "") {
    throw new Error("workerUrl must be an https origin");
  }
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const parent = `projects/${project}/locations/${location}/queues/${queue}`;
  const endpoint = `${options.endpoint ?? "https://cloudtasks.googleapis.com"}/v2/${parent}/tasks`;

  return {
    async createTask(job, taskId) {
      if (!isTaskId(taskId)) throw new Error("taskId has characters Cloud Tasks refuses");
      const body = new TextEncoder().encode(JSON.stringify({ kind: "analyze", ...job }));
      const signature = signRequest(
        options.secret,
        { method: "POST", path: RUN_PATH, body },
        now(),
      );
      const task = {
        name: `${parent}/tasks/${taskId}`,
        dispatchDeadline: `${DISPATCH_DEADLINE_SECONDS}s`,
        httpRequest: {
          url: new URL(RUN_PATH, worker).href,
          httpMethod: "POST",
          // Cloud Tasks sets no content type of its own.
          headers: { "content-type": "application/json", ...signature },
          body: Buffer.from(body).toString("base64"),
          oidcToken: {
            serviceAccountEmail: options.invokerServiceAccount,
            audience: worker.origin,
          },
        },
      };

      let token: string;
      try {
        token = await options.token();
      } catch (error) {
        const reason = error instanceof GoogleAuthError ? error.reason : "failed";
        throw new WorkerUnavailableError(`google token: ${reason}`);
      }
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ task }),
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        });
      } catch {
        throw new WorkerUnavailableError("request failed");
      }
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { created: true };
      }
      // 409 is also ABORTED (a concurrency conflict), so only the status name means "used".
      if (response.status === 409 && (await googleStatus(response)) === "ALREADY_EXISTS") {
        return { created: false };
      }
      await response.body?.cancel().catch(() => undefined);
      throw new WorkerUnavailableError(`status ${response.status}`);
    },
  };
}

/** `error.status` of a Google error answer (`{ error: { code, message, status } }`). */
async function googleStatus(response: Response): Promise<string | undefined> {
  try {
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("error" in value)) return undefined;
    const { error } = value;
    if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
    return typeof error.status === "string" ? error.status : undefined;
  } catch {
    return undefined;
  }
}
