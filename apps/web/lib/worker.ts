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

/**
 * A pull request's diff job (M8.6d, ADR-0245), queued by the `pull_request` webhook. Always
 * read through the installation that sent the event.
 */
export interface DiffJob {
  kind: "diff";
  owner: string;
  repo: string;
  /** The pull request's head commit. */
  sha: string;
  /** The event's base commit; the job finds the merge base with the head itself. */
  baseSha: string;
  installationId: number;
}

/** What one task carries: an analysis (sent with `kind: "analyze"`) or a diff. */
export type TaskJob = AnalyzeJob | DiffJob;

/** Thrown when the queue can't be reached or refuses; `reason` is for logs, never secret. */
export class WorkerUnavailableError extends Error {
  override name = "WorkerUnavailableError";
  constructor(readonly reason: string) {
    super(`worker unavailable: ${reason}`);
  }
}
