/**
 * How a job fails (ADR-0061). Every failure has a stable code (stored as
 * `analyses.error_code` and shown by the website's job page) and says whether trying again
 * could help: a dropped connection or a GitHub rate limit can pass, a repo over the file
 * limit can't. `POST /run` asks Cloud Tasks to retry only retriable failures (3 attempts,
 * run.ts); the others fail the job at once.
 */

/** Short upper-case identifiers, never free text from the repo or a server. */
export const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Codes that are worth another attempt; everything else fails the job on the first try. */
export const RETRIABLE_CODES: ReadonlySet<string> = new Set([
  /** A network error or a GitHub 5xx while downloading. */
  "DOWNLOAD_FAILED",
  /** The download didn't finish within its budget. */
  "DOWNLOAD_TIMEOUT",
  /**
   * The analysis ran out of time that earlier stages (a slow start or download) had taken
   * from it, so it wasn't the repo that was too big (`LIMIT_TIME`; job.ts, R4).
   */
  "ANALYSIS_TIME_CUT",
  /** GitHub refused with a rate limit; the queue's retry backoff waits it out. */
  "GITHUB_RATE_LIMITED",
  /** The worker shut down mid-job (or the push hung up); the next delivery runs it again. */
  "CANCELLED",
  /** Storing the result (the bucket, Postgres) failed. */
  "PUBLISH_FAILED",
  /** Writing the job's start to Postgres failed (record.ts). */
  "RECORD_FAILED",
  /** The website couldn't give a private job's installation token just now (installationToken.ts). */
  "TOKEN_UNAVAILABLE",
  /** Posting a pull request's comment or Check Run met a network error or a GitHub 5xx (post.ts). */
  "POST_FAILED",
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
