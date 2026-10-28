/**
 * The writes behind an analysis (ADR-0063): the repo row, and one `analyses` row moving
 * through `queued` → `running` → `done` | `failed`.
 *
 * - **Who calls what:** the worker calls {@link upsertRepo} and {@link startAnalysis} when a
 *   job starts, {@link completeAnalysis} after the snapshot is in object storage (so a `done`
 *   row always has its object), {@link requeueAnalysis} when an attempt fails but will be
 *   retried, {@link failAnalysis} when the last one fails, and
 *   {@link failInterruptedAnalyses} at startup.
 * - **`done` is final:** a later attempt never touches a `done` row (the snapshot it names
 *   exists and is immutable), so a redundant job can't hide a cached result.
 * - **Times** come from the database's clock (`now()`), one clock for every writer.
 */
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { analyses, repos, type AnalysisStats } from "./schema.js";
import type * as schema from "./schema.js";

/** Any Drizzle database on GitInside's schema (postgres.js in production, PGlite in tests). */
export type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** What GitHub says about a repo; the worker reads it from `GET /repos/{owner}/{repo}`. */
export interface RepoFacts {
  providerRepoId: number;
  /** GitHub's current spelling (a rename or a case change updates the row). */
  owner: string;
  name: string;
  visibility: "public" | "private";
  defaultBranch: string;
}

/** The cache key of one analysis. */
export interface AnalysisKey {
  repoId: string;
  sha: string;
  analyzerVersion: string;
}

/** The error code {@link failInterruptedAnalyses} records. */
export const INTERRUPTED_CODE = "JOB_INTERRUPTED";

/**
 * Insert the repo, or update it by GitHub's ID (which survives renames). If another row
 * still holds this owner/name, that repo was renamed or deleted on GitHub since we saw it;
 * its name becomes `~<its GitHub ID>` (no GitHub name contains `~`) so it keeps its
 * analyses, and the next upsert of that repo restores its real name.
 */
export async function upsertRepo(db: AnyDatabase, facts: RepoFacts): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    await tx
      .update(repos)
      .set({ name: sql`'~' || ${repos.providerRepoId}::text`, updatedAt: sql`now()` })
      .where(
        and(
          sql`lower(${repos.owner}) = lower(${facts.owner})`,
          sql`lower(${repos.name}) = lower(${facts.name})`,
          ne(repos.providerRepoId, facts.providerRepoId),
        ),
      );
    const { owner, name, visibility, defaultBranch } = facts;
    const [row] = await tx
      .insert(repos)
      .values({ providerRepoId: facts.providerRepoId, owner, name, visibility, defaultBranch })
      .onConflictDoUpdate({
        target: repos.providerRepoId,
        set: { owner, name, visibility, defaultBranch, updatedAt: sql`now()` },
      })
      .returning({ id: repos.id });
    return row as { id: string };
  });
}

/**
 * Mark the analysis `running` (inserting the row if the web app didn't), clearing what a
 * failed earlier attempt left. A `done` row is returned unchanged.
 */
export async function startAnalysis(
  db: AnyDatabase,
  key: AnalysisKey,
): Promise<{ id: string; status: "running" | "done" }> {
  const running = {
    status: "running" as const,
    startedAt: sql`now()`,
    errorCode: null,
    snapshotKey: null,
    stats: null,
    finishedAt: null,
  };
  const [row] = await db
    .insert(analyses)
    .values({ ...key, ...running })
    .onConflictDoUpdate({
      target: [analyses.repoId, analyses.sha, analyses.analyzerVersion],
      set: running,
      setWhere: ne(analyses.status, "done"),
    })
    .returning({ id: analyses.id });
  if (row !== undefined) return { id: row.id, status: "running" };
  const [done] = await db
    .select({ id: analyses.id })
    .from(analyses)
    .where(
      and(
        eq(analyses.repoId, key.repoId),
        eq(analyses.sha, key.sha),
        eq(analyses.analyzerVersion, key.analyzerVersion),
      ),
    );
  return { id: (done as { id: string }).id, status: "done" };
}

/** Back to `queued` after a failed attempt that will be retried. Only a `running` row moves. */
export async function requeueAnalysis(db: AnyDatabase, id: string): Promise<boolean> {
  const rows = await db
    .update(analyses)
    .set({ status: "queued" })
    .where(and(eq(analyses.id, id), eq(analyses.status, "running")))
    .returning({ id: analyses.id });
  return rows.length > 0;
}

/**
 * Mark the analysis `done` with its snapshot and stats. Call only once the snapshot is
 * stored. Any status but `done` moves (a row an interrupted-sweep failed still has a valid
 * snapshot now); returns `false` if it was already `done`.
 */
export async function completeAnalysis(
  db: AnyDatabase,
  id: string,
  result: { snapshotKey: string; stats: AnalysisStats },
): Promise<boolean> {
  const rows = await db
    .update(analyses)
    .set({
      status: "done",
      snapshotKey: result.snapshotKey,
      stats: result.stats,
      errorCode: null,
      finishedAt: sql`now()`,
    })
    .where(and(eq(analyses.id, id), ne(analyses.status, "done")))
    .returning({ id: analyses.id });
  return rows.length > 0;
}

/** Mark a `queued` or `running` analysis `failed` with `errorCode`. */
export async function failAnalysis(
  db: AnyDatabase,
  id: string,
  errorCode: string,
): Promise<boolean> {
  const rows = await db
    .update(analyses)
    .set({ status: "failed", errorCode, snapshotKey: null, finishedAt: sql`now()` })
    .where(and(eq(analyses.id, id), inArray(analyses.status, ["queued", "running"])))
    .returning({ id: analyses.id });
  return rows.length > 0;
}

/**
 * Fail every analysis still `running` that started before `startedBefore` with
 * {@link INTERRUPTED_CODE}. The worker calls it at startup with its own start time: a row
 * left `running` then belongs to a process that died. If the queue then runs the job again
 * (stalled-job recovery), {@link startAnalysis} moves the row back to `running`; if the job
 * had used up its attempts, the row stays failed instead of `running` forever.
 */
export async function failInterruptedAnalyses(
  db: AnyDatabase,
  startedBefore: Date,
): Promise<number> {
  const rows = await db
    .update(analyses)
    .set({ status: "failed", errorCode: INTERRUPTED_CODE, finishedAt: sql`now()` })
    .where(and(eq(analyses.status, "running"), lt(analyses.startedAt, startedBefore)))
    .returning({ id: analyses.id });
  return rows.length;
}
