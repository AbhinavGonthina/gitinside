/**
 * The reads and deletes behind snapshot retention (DESIGN.md §10, ADR-0077). The worker's
 * retention run (`apps/worker/src/retention.ts`) decides what to evict; this file only
 * lists what exists and deletes the rows it was told to.
 *
 * - {@link listStoredSnapshots}: every `done` analysis, i.e. every row that names an object.
 * - {@link listPinnedShas}: commits a pull request touched recently, which a PR diff may
 *   still need.
 * - {@link deleteDoneAnalyses}: removes evicted rows, only while they are still `done` with
 *   the same snapshot, so a row that changed since the plan was made is left alone.
 */
import { and, eq, sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { analyses, pullRequests, repos } from "./schema.js";

/** One `done` analysis and the object it names. */
export interface StoredSnapshotRow {
  id: string;
  repoId: string;
  /** The repo's current owner and name (its job ID is derived from them, ADR-0082). */
  owner: string;
  name: string;
  visibility: "public" | "private";
  sha: string;
  analyzerVersion: string;
  snapshotKey: string;
  createdAt: Date;
  finishedAt: Date;
}

/** A commit of one repo that retention must keep. */
export interface PinnedSha {
  repoId: string;
  sha: string;
}

/** How long a pull request's commits stay pinned after its last update (DESIGN.md §10). */
export const PR_PIN_DAYS = 30;

/** Rows per delete statement. */
const DELETE_BATCH = 500;

/** Every `done` analysis with its repo's visibility, in no particular order. */
export async function listStoredSnapshots(db: AnyDatabase): Promise<StoredSnapshotRow[]> {
  const rows = await db
    .select({
      id: analyses.id,
      repoId: analyses.repoId,
      owner: repos.owner,
      name: repos.name,
      visibility: repos.visibility,
      sha: analyses.sha,
      analyzerVersion: analyses.analyzerVersion,
      snapshotKey: analyses.snapshotKey,
      createdAt: analyses.createdAt,
      finishedAt: analyses.finishedAt,
    })
    .from(analyses)
    .innerJoin(repos, eq(repos.id, analyses.repoId))
    .where(eq(analyses.status, "done"));
  // `done` rows always have both (the status check in schema.ts).
  return rows.map((row) => ({
    ...row,
    snapshotKey: row.snapshotKey as string,
    finishedAt: row.finishedAt as Date,
  }));
}

/**
 * The base and head commits of every pull request updated in the last `days` days
 * (default {@link PR_PIN_DAYS}), by the database's clock.
 */
export async function listPinnedShas(
  db: AnyDatabase,
  days: number = PR_PIN_DAYS,
): Promise<PinnedSha[]> {
  if (!Number.isInteger(days) || days < 0) throw new Error("days must be a whole number ≥ 0");
  const rows = await db
    .select({
      repoId: pullRequests.repoId,
      baseSha: pullRequests.baseSha,
      headSha: pullRequests.headSha,
    })
    .from(pullRequests)
    .where(sql`${pullRequests.updatedAt} >= now() - make_interval(days => ${days})`);
  return rows.flatMap(({ repoId, baseSha, headSha }) => [
    { repoId, sha: baseSha },
    { repoId, sha: headSha },
  ]);
}

/**
 * Delete the given analyses, each only if it is still `done` with the snapshot key it was
 * listed with. Returns the rows actually deleted, so the caller deletes only their objects.
 */
export async function deleteDoneAnalyses(
  db: AnyDatabase,
  rows: readonly { id: string; snapshotKey: string }[],
): Promise<{ id: string; snapshotKey: string }[]> {
  const deleted: { id: string; snapshotKey: string }[] = [];
  for (let i = 0; i < rows.length; i += DELETE_BATCH) {
    const batch = rows.slice(i, i + DELETE_BATCH);
    const pairs = sql.join(
      batch.map(({ id, snapshotKey }) => sql`(${id}::uuid, ${snapshotKey})`),
      sql`, `,
    );
    const gone = await db
      .delete(analyses)
      .where(
        and(
          eq(analyses.status, "done"),
          sql`(${analyses.id}, ${analyses.snapshotKey}) in (${pairs})`,
        ),
      )
      .returning({ id: analyses.id, snapshotKey: analyses.snapshotKey });
    // The where clause matched each row's own key, so it is set.
    for (const row of gone) deleted.push({ id: row.id, snapshotKey: row.snapshotKey as string });
  }
  return deleted;
}
