/**
 * What the web app hands the worker (docs/DESIGN.md §11): a public analysis job, sent as a
 * Cloud Tasks task (cloudTasks.ts, ADR-0141). A job's status is read from its database row
 * (ADR-0139).
 */

/** A public analysis job to add. */
export interface AnalyzeJob {
  owner: string;
  repo: string;
  sha: string;
}

/** Thrown when the queue can't be reached or refuses; `reason` is for logs, never secret. */
export class WorkerUnavailableError extends Error {
  override name = "WorkerUnavailableError";
  constructor(readonly reason: string) {
    super(`worker unavailable: ${reason}`);
  }
}
