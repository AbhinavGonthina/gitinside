/**
 * The writes behind an analysis (ADR-0063): the repo row, and one `analyses` row moving
 * through `queued` → `running` → `done` | `failed`.
 *
 * - **Who calls what:** the web app calls {@link findAnalysis} (the cache lookup),
 *   {@link findPublishedAnalysis} (what a repo page and `/api/graph` serve) and, when it
 *   enqueues a new job, {@link upsertRepo} and {@link queueAnalysis} (ADR-0066), and
 *   {@link hideRepo} when GitHub says a published repo went private or away. The worker calls {@link upsertRepo} and {@link startAnalysis} when a
 *   job starts, {@link completeAnalysis} after the snapshot is in object storage (so a `done`
 *   row always has its object), {@link requeueAnalysis} when an attempt fails but will be
 *   retried, {@link failAnalysis} when the last one fails, and
 *   {@link failInterruptedAnalyses} at startup.
 * - **`done` is final:** a later attempt never touches a `done` row (the snapshot it names
 *   exists and is immutable), so a redundant job can't hide a cached result.
 * - **Times** come from the database's clock (`now()`), one clock for every writer.
 */
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
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

/** What {@link findAnalysis} returns: the row's state, enough to answer `/api/analyze`. */
export interface AnalysisSummary {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  errorCode: string | null;
  snapshotKey: string | null;
}

/**
 * Look up one commit's analysis by GitHub's repo ID (so a renamed repo still finds its
 * cache), or `undefined` if there's none yet.
 */
export async function findAnalysis(
  db: AnyDatabase,
  key: { providerRepoId: number; sha: string; analyzerVersion: string },
): Promise<AnalysisSummary | undefined> {
  const [row] = await db
    .select({
      id: analyses.id,
      status: analyses.status,
      errorCode: analyses.errorCode,
      snapshotKey: analyses.snapshotKey,
    })
    .from(analyses)
    .innerJoin(repos, eq(repos.id, analyses.repoId))
    .where(
      and(
        eq(repos.providerRepoId, key.providerRepoId),
        eq(analyses.sha, key.sha),
        eq(analyses.analyzerVersion, key.analyzerVersion),
      ),
    );
  return row;
}

/** What {@link findPublishedAnalysis} returns: the repo as last seen, and one finished analysis. */
export interface PublishedAnalysis {
  repo: { id: string; providerRepoId: number; owner: string; name: string };
  analysis: { sha: string; analyzerVersion: string; snapshotKey: string; finishedAt: Date };
}

/**
 * The newest `done` analysis of a **public** repo, found by owner and name ignoring case
 * (the diagram page and `/api/graph`, ADR-0068); with `sha`, of that commit. "Newest" is
 * the latest finish, so a re-analysis by a newer analyzer version wins over the old one.
 * Private repos are never returned (M8 adds access checks).
 */
export async function findPublishedAnalysis(
  db: AnyDatabase,
  query: { owner: string; name: string; sha?: string },
): Promise<PublishedAnalysis | undefined> {
  const [row] = await db
    .select({
      id: repos.id,
      providerRepoId: repos.providerRepoId,
      owner: repos.owner,
      name: repos.name,
      sha: analyses.sha,
      analyzerVersion: analyses.analyzerVersion,
      snapshotKey: analyses.snapshotKey,
      finishedAt: analyses.finishedAt,
    })
    .from(analyses)
    .innerJoin(repos, eq(repos.id, analyses.repoId))
    .where(
      and(
        sql`lower(${repos.owner}) = lower(${query.owner})`,
        sql`lower(${repos.name}) = lower(${query.name})`,
        eq(repos.visibility, "public"),
        eq(analyses.status, "done"),
        query.sha === undefined ? undefined : eq(analyses.sha, query.sha),
      ),
    )
    .orderBy(desc(analyses.finishedAt), desc(analyses.createdAt))
    .limit(1);
  if (row === undefined) return undefined;
  const { id, providerRepoId, owner, name, sha, analyzerVersion } = row;
  // `done` rows always have both (the status check in schema.ts).
  const snapshotKey = row.snapshotKey as string;
  const finishedAt = row.finishedAt as Date;
  return {
    repo: { id, providerRepoId, owner, name },
    analysis: { sha, analyzerVersion, snapshotKey, finishedAt },
  };
}

/**
 * Stop serving a repo publicly: GitHub now says it's private, gone, or blocked (SECURITY.md
 * T6). Sets `visibility` to `private`, which {@link findPublishedAnalysis} filters out, so
 * its repo page, permalinks, graphs, and images all stop at once. The next {@link upsertRepo}
 * with GitHub's facts (an analysis request once it's public again) restores it. Returns
 * whether a public row changed.
 */
export async function hideRepo(db: AnyDatabase, id: string): Promise<boolean> {
  const rows = await db
    .update(repos)
    .set({ visibility: "private", updatedAt: sql`now()` })
    .where(and(eq(repos.id, id), eq(repos.visibility, "public")))
    .returning({ id: repos.id });
  return rows.length > 0;
}

/**
 * Record that the web app queued a job for this commit: insert a `queued` row, or move a
 * `failed` one back to `queued` (a new job will run it again). `queued`, `running`, and
 * `done` rows are left as they are; the returned status is the row's after the call.
 */
export async function queueAnalysis(
  db: AnyDatabase,
  key: AnalysisKey,
): Promise<{ id: string; status: AnalysisSummary["status"] }> {
  const queued = {
    status: "queued" as const,
    errorCode: null,
    snapshotKey: null,
    stats: null,
    startedAt: null,
    finishedAt: null,
  };
  const [row] = await db
    .insert(analyses)
    .values({ ...key, ...queued })
    .onConflictDoUpdate({
      target: [analyses.repoId, analyses.sha, analyses.analyzerVersion],
      set: queued,
      setWhere: eq(analyses.status, "failed"),
    })
    .returning({ id: analyses.id });
  if (row !== undefined) return { id: row.id, status: "queued" };
  const [existing] = await db
    .select({ id: analyses.id, status: analyses.status })
    .from(analyses)
    .where(
      and(
        eq(analyses.repoId, key.repoId),
        eq(analyses.sha, key.sha),
        eq(analyses.analyzerVersion, key.analyzerVersion),
      ),
    );
  return existing as { id: string; status: AnalysisSummary["status"] };
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
