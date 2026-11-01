import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { runAttempt, type ProcessorEstimates, type WorkerLog } from "./attempt.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "./hmac.js";
import { HEALTH_PATH, MAX_BODY_BYTES, isJson, readBody, send } from "./http.js";
import type { JobDeps } from "./job.js";
import { JobRequestError, jobIdFor, parseJobRequest } from "./request.js";

/**
 * The worker's Cloud Run endpoint (ADR-0114): Cloud Tasks pushes each job to `POST /run`,
 * and the request runs it start to finish (download ⇒ extract ⇒ child ⇒ publish).
 *
 * - **Who may call:** Cloud Run's IAM admits only the queue's invoker service account (its
 *   OIDC token); on top of that, the body must carry the website's HMAC signature
 *   (hmac.ts), checked on the raw bytes before anything is parsed or routed. Only
 *   {@link HEALTH_PATH} answers without one, and says nothing but "ok". The signature
 *   is dated when the task was created, so it's accepted up to {@link MAX_TASK_AGE_SECONDS}
 *   old (a task can wait in the queue and between retries).
 * - **One job per request, one request at a time** (Cloud Run concurrency 1). A request that
 *   arrives while a job runs is answered `429 BUSY`, which Cloud Tasks retries.
 * - **One deadline:** the job has {@link JOB_BUDGET_MS} from the request's arrival, inside
 *   Cloud Run's 5-minute request timeout (ADR-0111). The download and the child's kill time
 *   come from what's left (job.ts, `PUBLISH_RESERVE_MS` kept back for publishing).
 * - **Attempts:** Cloud Tasks counts them (`X-CloudTasks-TaskRetryCount`, 0 on the first);
 *   the queue allows {@link MAX_ATTEMPTS} (M5.17e sets it). Progress goes to the job's Neon
 *   row (the recorder), never back in the answer.
 * - **The answer tells Cloud Tasks whether to retry:** `200` for success and for a failure
 *   that's final (permanent, or the last attempt; the row already says `failed`), `503` for
 *   a retriable failure with attempts left (the row is `queued` again). A request that is
 *   refused before it runs (`400`, `401`, `413`, `415`) is a bug or a forgery; Cloud Tasks
 *   retries it too, and it fails the same way each time without doing any work.
 * - **Already done:** Cloud Tasks delivers at least once, and the website can queue a job
 *   again; a push whose job's row is already `done` (final) is answered `200` at once, with
 *   no GitHub call, download, or child (ADR-0145). If the lookup fails, the job runs as
 *   usual: `startAnalysis` still leaves a `done` row alone.
 * - **Cancelled:** if the caller hangs up (Cloud Tasks gave up) or the process shuts down
 *   (`signal`), the job is killed and fails with the retriable `CANCELLED`.
 * - **After the job,** before the answer, `afterJob` gets what's left of the budget: the
 *   entry point runs the hourly maintenance there (ADR-0147), since Cloud Run gives an
 *   instance CPU only while a request is open. A push arriving meanwhile is still `429`.
 * - **Counted:** every answer but {@link HEALTH_PATH}'s first adds the request's time to the
 *   month's compute count (`meter`, compute.ts, ADR-0156), so new analyses can pause before
 *   the free allowance runs out.
 */

/** The path Cloud Tasks pushes to (apps/web's `RUN_PATH`). */
export const RUN_PATH = "/run";
export { HEALTH_PATH };
/** Attempts the queue makes; the last one's failure is final (`infra/gcp/queue.json`). */
export const MAX_ATTEMPTS = 3;
/**
 * The job's whole budget from the request's arrival: Cloud Run's 300 s request timeout less
 * 20 s to record a failure, delete the job folder, and answer.
 */
export const JOB_BUDGET_MS = 280_000;
/**
 * How old a push's signature may be: a day. Tasks are signed when created, then wait for a
 * free worker (at most 2 run at once) and between retries.
 */
export const MAX_TASK_AGE_SECONDS = 24 * 60 * 60;
/** Cloud Tasks' count of earlier attempts at this task. */
export const RETRY_COUNT_HEADER = "x-cloudtasks-taskretrycount";

const RETRY_COUNT = /^[0-9]{1,6}$/;

/** Options for {@link createRunHandler}. */
export interface RunHandlerOptions {
  deps: JobDeps;
  /** Accepted signing secrets: the current one first, the previous one during a rollover. */
  secrets: readonly string[];
  /** Part of every job ID, as in the website's `jobIdFor`. */
  analyzerVersion: string;
  log?: WorkerLog;
  estimates?: ProcessorEstimates;
  /** Fires on shutdown: the running job is cancelled. */
  signal?: AbortSignal;
  /**
   * Called once a job is over (done, failed, or already done), before its push is answered,
   * with what's left of the budget: maintenance runs here (ADR-0147), while the instance
   * still has CPU. Not called for a cancelled job; a rejection is logged.
   */
  afterJob?: (end: { timeLeftMs: number; signal: AbortSignal }) => Promise<unknown>;
  /**
   * Called with the request's time so far (ms) just before every answer except
   * {@link HEALTH_PATH}'s, while the instance still has CPU: the compute count (compute.ts,
   * ADR-0156). A rejection is logged; the answer is sent anyway.
   */
  meter?: (ms: number) => Promise<unknown>;
  /** Default {@link JOB_BUDGET_MS}. */
  budgetMs?: number;
  /** Wall clock for the signature's age (tests fix it). Default `Date.now`. */
  now?: () => number;
  /** Monotonic clock for the budget (tests step it). Default `performance.now`. */
  clock?: () => number;
  /** Largest accepted body. Default `MAX_BODY_BYTES`. */
  maxBodyBytes?: number;
}

/** The handler, and whether a job is running (for the entry point's shutdown and tests). */
export interface RunHandler {
  (req: IncomingMessage, res: ServerResponse): void;
  busy(): boolean;
}

/** The attempt number Cloud Tasks says this is (1 on the first; 1 if the header is unusable). */
export function attemptFrom(header: unknown): number {
  return typeof header === "string" && RETRY_COUNT.test(header) ? Number(header) + 1 : 1;
}

/** Build the `POST /run` handler. It never throws: anything unexpected is `500 INTERNAL`. */
export function createRunHandler(options: RunHandlerOptions): RunHandler {
  const { deps, secrets, analyzerVersion } = options;
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const clock = options.clock ?? (() => performance.now());
  const budgetMs = options.budgetMs ?? JOB_BUDGET_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (secrets.length === 0) throw new Error("POST /run needs at least one secret");
  let running = false;

  /** Whether the job's row is already `done`; a failed lookup is logged and reads as no. */
  async function alreadyDone(id: string): Promise<boolean> {
    const done = deps.recorder?.done?.bind(deps.recorder);
    if (done === undefined) return false;
    try {
      return await done(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log({ event: "done_check_failed", id, message });
      return false;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const arrived = clock();
    const target = req.url ?? "/";
    const method = req.method ?? "GET";
    const path = target.split("?", 1)[0] as string;

    if (path === HEALTH_PATH) {
      if (method !== "GET" && method !== "HEAD") {
        send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: "GET, HEAD" });
        return;
      }
      send(res, 200, { status: "ok" });
      return;
    }
    /** Count the request's compute, then answer. */
    const reply = async (
      status: number,
      answer: Record<string, unknown>,
      headers: Record<string, string> = {},
    ): Promise<void> => {
      if (options.meter !== undefined) {
        try {
          await options.meter(clock() - arrived);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log({ event: "meter_failed", message });
        }
      }
      send(res, status, answer, headers);
    };
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBodyBytes) {
      req.resume();
      await reply(413, { error: "BODY_TOO_LARGE" }, { connection: "close" });
      return;
    }
    const body = await readBody(req, maxBodyBytes);
    if (body === undefined) {
      await reply(413, { error: "BODY_TOO_LARGE" }, { connection: "close" });
      return;
    }
    const verdict = verifyRequest(
      secrets,
      { method, path: target, body },
      { timestamp: req.headers[TIMESTAMP_HEADER], signature: req.headers[SIGNATURE_HEADER] },
      now(),
      { maxAgeSeconds: MAX_TASK_AGE_SECONDS },
    );
    if (!verdict.ok) {
      await reply(401, { error: verdict.reason });
      return;
    }
    if (path !== RUN_PATH) {
      await reply(404, { error: "NOT_FOUND" });
      return;
    }
    if (method !== "POST") {
      await reply(405, { error: "METHOD_NOT_ALLOWED" }, { allow: "POST" });
      return;
    }
    if (!isJson(req)) {
      await reply(415, { error: "UNSUPPORTED_MEDIA_TYPE" });
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(body.toString("utf8"));
    } catch {
      await reply(400, { error: "INVALID_JSON" });
      return;
    }
    let id: string;
    try {
      id = jobIdFor(parseJobRequest(data), analyzerVersion);
    } catch (error) {
      if (!(error instanceof JobRequestError)) throw error;
      await reply(400, { error: "INVALID_REQUEST", message: error.message });
      return;
    }
    if (running) {
      await reply(429, { error: "BUSY" });
      return;
    }

    running = true;
    // The job stops if the caller hangs up before the answer, or on shutdown.
    const hangUp = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) hangUp.abort();
    };
    res.on("close", onClose);
    const signal =
      options.signal === undefined
        ? hangUp.signal
        : AbortSignal.any([hangUp.signal, options.signal]);
    const attempt = attemptFrom(req.headers[RETRY_COUNT_HEADER]);
    const lastAttempt = attempt >= MAX_ATTEMPTS;
    const timeLeft = () => budgetMs - (clock() - arrived);
    try {
      let status: number;
      let answer: Record<string, unknown>;
      if (await alreadyDone(id)) {
        log({ event: "job_already_done", id, attempt });
        [status, answer] = [200, { id, state: "done" }];
      } else {
        const result = await runAttempt(
          { id, data, attempt, lastAttempt, signal, timeLeft },
          deps,
          log,
          options.estimates,
        );
        if (result.ok) {
          [status, answer] = [200, { id, state: "done" }];
        } else if (result.failure.retriable && !lastAttempt) {
          [status, answer] = [503, { error: result.failure.code }];
        } else {
          [status, answer] = [200, { id, state: "failed", errorCode: result.failure.code }];
        }
      }
      if (options.afterJob !== undefined && !signal.aborted) {
        try {
          await options.afterJob({ timeLeftMs: timeLeft(), signal });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log({ event: "after_job_failed", id, message });
        }
      }
      // While shutting down, the connection closes with the answer: the server's close
      // otherwise waits for the caller to drop its idle keep-alive socket (seconds).
      const headers: Record<string, string> =
        options.signal?.aborted === true ? { connection: "close" } : {};
      await reply(status, answer, headers);
    } finally {
      running = false;
      res.off("close", onClose);
    }
  }

  const handler = ((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "INTERNAL" });
      else res.destroy();
    });
  }) as RunHandler;
  handler.busy = () => running;
  return handler;
}

/**
 * An HTTP server around {@link createRunHandler}. Headers must arrive within 10 s; the
 * request itself may take as long as the job (Cloud Run's timeout bounds it).
 */
export function createRunServer(options: RunHandlerOptions): Server {
  const server = createServer(createRunHandler(options));
  server.headersTimeout = 10_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  return server;
}
