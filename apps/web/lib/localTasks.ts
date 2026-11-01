import { signRequest } from "@gitinside/worker/hmac";
import { DISPATCH_DEADLINE_SECONDS, RUN_PATH, isTaskId, type TaskQueue } from "./cloudTasks";

/**
 * Local development's stand-in for Cloud Tasks (ADR-0149): the website pushes each job
 * straight to a worker running on this machine, the way Cloud Tasks would push it to Cloud
 * Run, so the whole loop (Analyze ⇒ progress ⇒ diagram) runs without a Google project.
 *
 * - **Same request as Cloud Tasks makes:** the job JSON, HMAC-signed for `POST /run` once,
 *   when the task is created (as `createTask` signs it), with `X-CloudTasks-TaskRetryCount`
 *   (0 on the first attempt). The worker can't tell the two apart.
 * - **Task names dedupe in memory** for 24 hours, like Google's used-name window: a name
 *   already seen is `created: false`. The process forgets them on restart; the database row
 *   stays the real dedupe (enqueue.ts), and the worker answers a `done` job at once.
 * - **Retries like the queue:** any answer that isn't 2xx, or no answer, is tried again after
 *   a backoff, up to {@link LOCAL_MAX_ATTEMPTS} deliveries, then the task is dropped and
 *   logged (its row is failed by the worker on the last attempt, or by maintenance later).
 * - **One push at a time:** a local worker runs one job and answers `429` to a second, so
 *   tasks are delivered in order, each after the previous one's answer (Cloud Tasks' queue
 *   allows 2, one per Cloud Run instance).
 * - **Loopback only:** the worker URL must be `localhost`, `127.0.0.1`, or `[::1]`, and the
 *   environment must opt in (serverDeps.ts, never on Vercel), so a misconfigured deployment
 *   can't push jobs anywhere this way.
 *
 * `createTask` returns once the task is recorded, before the push, as Cloud Tasks does; it
 * never fails for a worker that's down (the push's failure is logged instead).
 */

/** Deliveries per task: the Cloud Tasks queue's `maxAttempts` (the worker's `MAX_ATTEMPTS`). */
export const LOCAL_MAX_ATTEMPTS = 3;
/** Cloud Tasks' count of earlier attempts (the worker's `RETRY_COUNT_HEADER`). */
export const RETRY_COUNT_HEADER = "x-cloudtasks-taskretrycount";
/** How long a used task name is remembered (Google's window is up to 24 hours). */
export const TASK_NAME_WINDOW_MS = 24 * 60 * 60 * 1000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** One line about a push, for the dev server's console. Never carries the secret. */
export type LocalTaskEvent =
  | { event: "local_task_delivered"; taskId: string; attempt: number; status: number }
  | { event: "local_task_retry"; taskId: string; attempt: number; status: number | "no answer" }
  | { event: "local_task_dropped"; taskId: string; attempts: number };

/** Options for {@link createLocalTaskQueue}. */
export interface LocalTaskQueueOptions {
  /** The local worker's origin, e.g. `http://127.0.0.1:8080`. */
  workerUrl: string;
  /** `ENQUEUE_HMAC_SECRET`, the worker's too. */
  secret: string;
  /** Wait before retry `n` (1 = the second delivery). Default 1 s, doubling, at most 10 s. */
  backoffMs?: (retry: number) => number;
  /** Default `console.info` of the event as JSON. */
  log?: (event: LocalTaskEvent) => void;
  fetch?: typeof fetch;
  /** Wall clock for signatures and the name window (tests fix it). Default `Date.now`. */
  now?: () => number;
  /** Each delivery gives up after this long. Default the dispatch deadline, 330 s. */
  timeoutMs?: number;
}

/** A {@link TaskQueue} that pushes to a local worker. */
export interface LocalTaskQueue extends TaskQueue {
  /** Resolves once every task created so far has been delivered or dropped (tests). */
  idle(): Promise<void>;
}

/** Whether `url` is an http(s) origin on this machine. */
export function isLoopbackOrigin(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    LOOPBACK_HOSTS.has(parsed.hostname) &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === ""
  );
}

/** A local queue. Throws at once unless `workerUrl` is a loopback origin. */
export function createLocalTaskQueue(options: LocalTaskQueueOptions): LocalTaskQueue {
  if (!isLoopbackOrigin(options.workerUrl)) {
    throw new Error("workerUrl must be an http origin on localhost, 127.0.0.1, or [::1]");
  }
  const url = new URL(RUN_PATH, options.workerUrl).href;
  // The global one is read at each push, not kept from when the queue was made.
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? fetch)(input, init);
  const now = options.now ?? Date.now;
  const backoffMs = options.backoffMs ?? ((retry) => Math.min(1_000 * 2 ** (retry - 1), 10_000));
  const log = options.log ?? ((event) => console.info(JSON.stringify(event)));
  const timeoutMs = options.timeoutMs ?? DISPATCH_DEADLINE_SECONDS * 1_000;
  /** Task name ⇒ when it was used. */
  const used = new Map<string, number>();
  let queue: Promise<void> = Promise.resolve();

  async function deliver(taskId: string, headers: Record<string, string>, body: Uint8Array) {
    for (let retry = 0; retry < LOCAL_MAX_ATTEMPTS; retry++) {
      if (retry > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs(retry)));
      const attempt = retry + 1;
      let status: number | "no answer";
      try {
        const response = await doFetch(url, {
          method: "POST",
          headers: { ...headers, [RETRY_COUNT_HEADER]: String(retry) },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel().catch(() => undefined);
        status = response.status;
      } catch {
        status = "no answer";
      }
      if (typeof status === "number" && status >= 200 && status < 300) {
        log({ event: "local_task_delivered", taskId, attempt, status });
        return;
      }
      if (attempt < LOCAL_MAX_ATTEMPTS) log({ event: "local_task_retry", taskId, attempt, status });
    }
    log({ event: "local_task_dropped", taskId, attempts: LOCAL_MAX_ATTEMPTS });
  }

  return {
    async createTask(job, taskId) {
      if (!isTaskId(taskId)) throw new Error("taskId has characters Cloud Tasks refuses");
      const at = now();
      for (const [name, usedAt] of used) {
        if (at - usedAt >= TASK_NAME_WINDOW_MS) used.delete(name);
      }
      if (used.has(taskId)) return { created: false };
      used.set(taskId, at);

      const body = new TextEncoder().encode(JSON.stringify({ kind: "analyze", ...job }));
      const headers = {
        "content-type": "application/json",
        ...signRequest(options.secret, { method: "POST", path: RUN_PATH, body }, at),
      };
      // In order, one at a time; a throwing `log` mustn't stop later tasks.
      queue = queue.then(() => deliver(taskId, headers, body)).catch(() => undefined);
      return { created: true };
    },
    idle: () => queue,
  };
}
