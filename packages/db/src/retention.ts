/**
 * The reads and deletes behind snapshot retention (DESIGN.md §10, ADR-0077). The worker's
 * retention run (`apps/worker/src/retention.ts`) decides what to evict; this file only
 * lists what exists and deletes the rows it was told to.
 *
 * - {@link listStoredSnapshots}: every `done` analysis, i.e. every row that names an object.
 * - {@link listPinnedShas}: commits a pull request touched recently (its base, head, and its
 *   diff's merge base), which a PR diff may still need.
 * - {@link listDemoShas}: the demo pins' commits, which the landing page's gallery links.
 * - {@link listDiffKeys}: every stored PR diff a pull request record names (ADR-0245).
 * - {@link deleteDoneAnalyses}: removes evicted rows, only while they are still `done` with
 *   the same snapshot, so a row that changed since the plan was made is left alone.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { DEMO_PINS, type DemoPin } from "./demos.js";
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
 * A stored PR diff's key (`privateDiffKey`'s shape: `private/<installation>/<repoId>/diffs/
 * <merge base>-<head>/<version>.json.gz`), capturing the repo ID, merge base, and head.
 */
const DIFF_KEY =
  /^private\/[1-9][0-9]*\/([^/]+)\/diffs\/([0-9a-f]{40})-([0-9a-f]{40})\/[^/]+\.json\.gz$/;

/**
 * The merge base a record's diff was taken from, read from its key, or `undefined` when the
 * key is of another shape or names another repo or head than the record.
 */
function mergeBaseOf(record: {
  repoId: string;
  headSha: string;
  diffKey: string | null;
}): string | undefined {
  const match = record.diffKey === null ? null : DIFF_KEY.exec(record.diffKey);
  if (match === null || match[1] !== record.repoId || match[3] !== record.headSha) return undefined;
  return match[2];
}

/**
 * The commits of every pull request updated in the last `days` days (default
 * {@link PR_PIN_DAYS}), by the database's clock: the event's base and head, plus the merge
 * base the record's stored diff was taken from (M8.10b). The diff job diffs from the merge
 * base, usually not the event's base, and the comment's `?base=` link and `/api/diff` need
 * its analysis; the record keeps only the event's pair, so the merge base is read from the
 * diff key. A merge base equal to the base or head is listed once.
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
      diffKey: pullRequests.diffKey,
    })
    .from(pullRequests)
    .where(sql`${pullRequests.updatedAt} >= now() - make_interval(days => ${days})`);
  return rows.flatMap((row) => {
    const { repoId, baseSha, headSha } = row;
    const merge = mergeBaseOf(row);
    return [
      { repoId, sha: baseSha },
      { repoId, sha: headSha },
      ...(merge === undefined || merge === baseSha || merge === headSha
        ? []
        : [{ repoId, sha: merge }]),
    ];
  });
}

/**
 * The demo pins' commits (`DEMO_PINS`, ADR-0255), for every pin whose repo has a row, found by
 * GitHub's ID so a renamed repo's pin still counts. The gallery links them for good, so
 * retention keeps them like a pull request's commits, however many newer commits the repo has.
 */
export async function listDemoShas(
  db: AnyDatabase,
  pins: readonly DemoPin[] = DEMO_PINS,
): Promise<PinnedSha[]> {
  if (pins.length === 0) return [];
  const rows = await db
    .select({ id: repos.id, providerRepoId: repos.providerRepoId })
    .from(repos)
    .where(
      inArray(
        repos.providerRepoId,
        pins.map((pin) => pin.providerRepoId),
      ),
    );
  return pins.flatMap((pin) =>
    rows
      .filter((row) => row.providerRepoId === pin.providerRepoId)
      .map((row) => ({ repoId: row.id, sha: pin.sha })),
  );
}

/**
 * The diff keys pull request records name, each once, in no particular order. Any record's,
 * however old: the record is the only way to the diff, so a named diff is kept as long as
 * the record keeps it (a new pair clears it, ADR-0244), and every other diff object is an
 * orphan.
 */
export async function listDiffKeys(db: AnyDatabase): Promise<string[]> {
  const rows = await db
    .selectDistinct({ diffKey: pullRequests.diffKey })
    .from(pullRequests)
    .where(isNotNull(pullRequests.diffKey));
  return rows.map((row) => row.diffKey as string);
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
