import { findJob, type AnyDatabase, type JobRecord } from "@gitinside/db";
import { UNAVAILABLE_VIEW, isFinal, jobView, type JobView } from "./jobs";

/**
 * `GET /api/jobs/:id` and its SSE variant `GET /api/jobs/:id/events` (docs/DESIGN.md §11,
 * ADR-0067), apart from Next.js so tests call them with plain values.
 *
 * Both answer with a {@link JobView}: the job's `analyses` row (ADR-0139, ADR-0140), checked
 * and put into words; the worker is never asked. The stream reads the row every
 * {@link EventOptions.intervalMs}, sends a `status` event only when the view changes, and
 * ends after a final view (done, failed, missing) or after {@link EventOptions.lifetimeMs}.
 * The browser's `EventSource` reconnects by itself after `retry`, so a long analysis is a
 * chain of short requests, each well inside a serverless function's time limit, and a closed
 * tab stops the polling at once.
 */

/** What the job routes read: a job's row by its ID (`findJob`). */
export interface JobRouteDeps {
  findJob(id: string): Promise<JobRecord | undefined>;
}

/** The job routes' deps over `db`. */
export function jobRouteDeps(db: AnyDatabase): JobRouteDeps {
  return { findJob: (id) => findJob(db, id) };
}

/** The only job IDs the web app shows: analyses (diff jobs are the PR bot's). */
export const ANALYZE_JOB_ID = /^analyze-[0-9a-f]{32}$/;

/** Timing for {@link handleJobEvents} (tests shorten it). */
export interface EventOptions {
  /** Time between status checks. Default 1 s. */
  intervalMs?: number;
  /** How long one response streams before it ends and the browser reconnects. Default 25 s. */
  lifetimeMs?: number;
  /** A comment line after this long without an event, so proxies keep the connection. Default 10 s. */
  heartbeatMs?: number;
  /** The `retry` sent to the browser: how long it waits before reconnecting. Default 1 s. */
  retryMs?: number;
}

const NOT_FOUND = { error: "JOB_NOT_FOUND", message: "There's no analysis with that ID." };

/**
 * The view for `id` now. Every failure to read is "unavailable" and logged by name only (a
 * message can carry connection details); nothing about it is shown.
 */
async function currentView(id: string, deps: JobRouteDeps | undefined): Promise<JobView> {
  if (deps === undefined) return UNAVAILABLE_VIEW;
  try {
    return jobView(await deps.findJob(id));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "job_status_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return UNAVAILABLE_VIEW;
  }
}

const HTTP_STATUS: Readonly<Record<JobView["state"], number>> = {
  queued: 200,
  running: 200,
  done: 200,
  failed: 200,
  missing: 404,
  unavailable: 503,
};

/** Answer `GET /api/jobs/:id` with the job's {@link JobView} as JSON. */
export async function handleJobRequest(
  id: string,
  deps: JobRouteDeps | undefined,
): Promise<Response> {
  if (!ANALYZE_JOB_ID.test(id)) return Response.json(NOT_FOUND, noStore(404));
  const view = await currentView(id, deps);
  return Response.json(view, noStore(HTTP_STATUS[view.state]));
}

function noStore(status: number): ResponseInit {
  return { status, headers: { "cache-control": "no-store" } };
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/**
 * Answer `GET /api/jobs/:id/events` with a `text/event-stream` of `status` events, each a
 * {@link JobView} as JSON. `signal` is the request's: when the browser goes away, the
 * polling stops.
 */
export function handleJobEvents(
  id: string,
  signal: AbortSignal,
  deps: JobRouteDeps | undefined,
  options: EventOptions = {},
): Response {
  if (!ANALYZE_JOB_ID.test(id)) return Response.json(NOT_FOUND, noStore(404));
  const intervalMs = options.intervalMs ?? 1_000;
  const lifetimeMs = options.lifetimeMs ?? 25_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const retryMs = options.retryMs ?? 1_000;

  const encoder = new TextEncoder();
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal.addEventListener("abort", onAbort);

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));
      const started = Date.now();
      let lastWrite = started;
      let last = "";
      try {
        write(`retry: ${retryMs}\n\n`);
        while (!stop.signal.aborted) {
          const view = await currentView(id, deps);
          if (stop.signal.aborted) break;
          const data = JSON.stringify(view);
          if (data !== last) {
            write(`event: status\ndata: ${data}\n\n`);
            last = data;
            lastWrite = Date.now();
          }
          if (isFinal(view) || Date.now() - started + intervalMs > lifetimeMs) break;
          await pause(intervalMs, stop.signal);
          if (!stop.signal.aborted && Date.now() - lastWrite >= heartbeatMs) {
            write(": keep-alive\n\n");
            lastWrite = Date.now();
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // Already cancelled by the reader.
        }
      }
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
