/**
 * How a job fails (ADR-0061). Every failure has a stable code (stored as
 * `analyses.error_code` and returned by `GET /jobs/:id`) and says whether trying again
 * could help: a dropped connection or a GitHub rate limit can pass, a repo over the file
 * limit can't. The queue retries only retriable failures (`attempts: 3`); the others fail
 * the job at once.
 */

/** Short upper-case identifiers, never free text from the repo or a server. */
export const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Codes that are worth another attempt; everything else fails the job on the first try. */
export const RETRIABLE_CODES: ReadonlySet<string> = new Set([
  /** A network error or a GitHub 5xx while downloading. */
  "DOWNLOAD_FAILED",
  /** The download didn't finish within its budget. */
  "DOWNLOAD_TIMEOUT",
  /** GitHub refused with a rate limit; the backoff waits it out. */
  "GITHUB_RATE_LIMITED",
  /** The worker shut down mid-job; the next worker runs it again. */
  "CANCELLED",
  /** Storing the result (R2, Postgres) failed. */
  "PUBLISH_FAILED",
  /** Something unexpected in the worker itself (a full disk, a bug); logged with details. */
  "WORKER_ERROR",
]);

/** A job failure with its code. The message is the code itself, so nothing else is stored. */
export class JobFailure extends Error {
  override name = "JobFailure";
  /** Whether another attempt could succeed (see {@link RETRIABLE_CODES}). */
  readonly retriable: boolean;

  constructor(
    readonly code: string,
    /** For logs only: may hold hosts, statuses, or machine paths. Never sent to users. */
    readonly detail = "",
    options?: { cause?: unknown },
  ) {
    super(code, options);
    if (!FAILURE_CODE.test(code)) throw new Error(`not a failure code: ${JSON.stringify(code)}`);
    this.retriable = RETRIABLE_CODES.has(code);
  }
}
