import type { WorkerLog } from "./attempt.js";

/**
 * Structured logs (DESIGN.md §13): one JSON object per line on stdout, `time` first, then
 * `event` and the event's fields. Cloud Run sends stdout to Cloud Logging, which parses
 * each line as a JSON payload.
 *
 * Callers log codes, IDs, counts, and timings only: never a secret, a URL with credentials,
 * or a repo's file contents. A failure is logged through {@link errorFields} (its name and
 * code, never its message), and an error passed as a field is reduced to its name. A field
 * that can't be serialized (a `BigInt`, a cycle) never throws: the line says
 * `log_unserializable` instead, with the event name.
 *
 * Messages kept, each for a stated reason (M8.10e2b, ADR-0248): `startup_failed` (with
 * main.ts's `errorCauses`), `shutdown_step_failed`, and `server_error`, once per process
 * start or stop, where the message is a broken deploy's one clue; `config_invalid`, whose
 * problems are the worker's own text naming variables, not values; the kill switch's
 * `billing_disable_failed`, built from its own text and status; and `job_failed`'s `detail`
 * (`JobFailure.detail`), the only trace of an unexpected `WORKER_ERROR`.
 */
export function createJsonLog(
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): WorkerLog {
  return (event) => {
    const time = now().toISOString();
    let line: string;
    try {
      line = JSON.stringify({ time, ...event }, (_key, value: unknown) =>
        value instanceof Error ? value.name : value,
      );
    } catch {
      line = JSON.stringify({
        time,
        event: "log_unserializable",
        original: typeof event.event === "string" ? event.event : null,
      });
    }
    write(`${line}\n`);
  };
}

/** What a code looks like (SQLSTATE `42P01`, `ECONNREFUSED`, S3's `AccessDenied`): never free text. */
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** How many errors deep {@link errorFields} looks for a code. */
const MAX_DEPTH = 5;

/** The fields a log line gives a failure: see {@link errorFields}. */
export interface ErrorFields {
  /** The error's `name` (`PostgresError`, `StorageError`), or `typeof` what was thrown. */
  error: string;
  /** A code-shaped `code` (or S3's `s3Code`) of the error or, failing that, a wrapped `cause`. */
  errorCode?: string;
  /** An HTTP status the error carries (`StorageError.status`). */
  httpStatus?: number;
}

/**
 * What a log line says about a failure (M8.10e2b): the error's name, a code, an HTTP status;
 * never its message. A driver's message names the database host (`connect ECONNREFUSED
 * <host>:5432`), a parse error quotes the text it read (a stored graph: a repo's names), a
 * storage error its endpoint. The code is looked for on wrapped causes too, as Drizzle puts
 * Postgres's error (with its SQLSTATE) on `cause`.
 */
export function errorFields(error: unknown): ErrorFields {
  const fields: ErrorFields = { error: error instanceof Error ? error.name : typeof error };
  let next = error;
  for (let depth = 0; depth < MAX_DEPTH && typeof next === "object" && next !== null; depth++) {
    const { code, s3Code, cause } = next as { code?: unknown; s3Code?: unknown; cause?: unknown };
    const found = [code, s3Code].find(
      (value): value is string => typeof value === "string" && CODE.test(value),
    );
    if (found !== undefined) {
      fields.errorCode = found;
      break;
    }
    next = cause;
  }
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (Number.isInteger(status)) fields.httpStatus = status as number;
  return fields;
}
