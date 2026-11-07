/**
 * What the web app hands the worker (docs/DESIGN.md §11): an analysis job, sent as a Cloud
 * Tasks task (cloudTasks.ts, ADR-0141). A job's status is read from its database row
 * (ADR-0139).
 */

/** An analysis job to add. */
export interface AnalyzeJob {
  owner: string;
  repo: string;
  sha: string;
  /**
   * GitHub's ID for the App installation the worker reads the repo through (a private repo,
   * M8.3c2, ADR-0227); part of the job ID. Left out for a public job.
   */
  installationId?: number;
}

/** Thrown when the queue can't be reached or refuses; `reason` is for logs, never secret. */
export class WorkerUnavailableError extends Error {
  override name = "WorkerUnavailableError";
  constructor(readonly reason: string) {
    super(`worker unavailable: ${reason}`);
  }
}
