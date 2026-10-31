/**
 * An analysis's job, read and written by its queue job ID (ADR-0114, ADR-0139): the
 * `analyses` row carries the job's state, attempts, place in the queue, and live progress,
 * so the progress page reads Postgres instead of asking the worker.
 *
 * - **Writes:** the web app stores the job ID when it queues the row, and the worker when an
 *   attempt starts (`queueAnalysis`, `startAnalysis` in analyses.ts). While an attempt runs,
 *   the worker writes its progress with {@link recordJobProgress}, a few times per stage.
 * - **Reads:** {@link findJob}, for `GET /api/jobs/:id` and its SSE stream (M5.17a2).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { analyses, repos, type JobProgress } from "./schema.js";

/**
 * Store where the running attempt of job `jobId` is, stamped with the database's `now()`
 * (`progress_at`), so a reader can age `leftMs` on that one clock (ADR-0140). Only a
 * `running` row is written, so a late update from an attempt that already finished, failed,
 * or went back to the queue changes nothing. Returns whether a row was written.
 */
export async function recordJobProgress(
  db: AnyDatabase,
  jobId: string,
  progress: JobProgress,
): Promise<boolean> {
  const rows = await db
    .update(analyses)
    .set({ progress, progressAt: sql`now()` })
    .where(and(eq(analyses.jobId, jobId), eq(analyses.status, "running")))
    .returning({ id: analyses.id });
  return rows.length > 0;
}

/** One job as {@link findJob} reads it. */
export interface JobRecord {
  analysisId: string;
  status: "queued" | "running" | "done" | "failed";
  /** Set when `failed`. */
  errorCode: string | null;
  /** Attempts started since the row was last queued by the web app. */
  attempts: number;
  /** While `running`, once the worker wrote it; as stored, so check it before showing it. */
  progress: JobProgress | null;
  /**
   * With `progress`: milliseconds since it was written, by the database's clock (the same
   * clock that stamped it), so `progress.leftMs - progressAgeMs` is the time left now.
   */
  progressAgeMs?: number;
  /** Private jobs (M8) need an access check before anything about them is shown. */
  visibility: "public" | "private";
  /** While `queued`: how many `queued` rows entered the queue before it (0 = next). */
  position?: number;
}

/**
 * The job with ID `jobId`, or `undefined` if no row has it. If several rows do (a repo
 * deleted and created again with the same commits), the newest is the job. The position
 * counts every `queued` row ahead in queue order (when each last entered the queue, then ID).
 * The progress's age is `now()` minus `progress_at`, never below 0.
 */
export async function findJob(db: AnyDatabase, jobId: string): Promise<JobRecord | undefined> {
  const [row] = await db
    .select({
      analysisId: analyses.id,
      status: analyses.status,
      errorCode: analyses.errorCode,
      attempts: analyses.attempts,
      progress: analyses.progress,
      visibility: repos.visibility,
      position: sql<number | null>`case when ${analyses.status} = 'queued' then (
        select count(*)::int from ${analyses} as ahead
        where ahead.status = 'queued'
          and (ahead.queued_at, ahead.id) < (${analyses.queuedAt}, ${analyses.id})
      ) end`.mapWith(nullableNumber),
      // `greatest` skips nulls, so without the `case` no progress would read as age 0.
      progressAgeMs: sql<number | null>`case when ${analyses.progressAt} is not null then
        greatest(0, floor(extract(epoch from (now() - ${analyses.progressAt})) * 1000))::bigint
      end`.mapWith(nullableNumber),
    })
    .from(analyses)
    .innerJoin(repos, eq(repos.id, analyses.repoId))
    .where(eq(analyses.jobId, jobId))
    .orderBy(desc(analyses.createdAt), desc(analyses.id))
    .limit(1);
  if (row === undefined) return undefined;
  const { position, progressAgeMs, ...job } = row;
  return {
    ...job,
    ...(progressAgeMs === null ? {} : { progressAgeMs }),
    ...(position === null ? {} : { position }),
  };
}

/** A count from SQL (`int` or `bigint`, which drivers may return as a string), or null. */
function nullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value);
}
