import {
  deleteDoneAnalyses,
  listPinnedShas,
  listStoredSnapshots,
  type AnyDatabase,
  type PinnedSha,
  type StoredSnapshotRow,
} from "@gitinside/db";
import { compareStrings } from "@gitinside/schema";
import { jobIdFor } from "./api.js";
import type { CompletedJobs } from "./queue.js";
import type { ListedObject, ObjectStore } from "./storage.js";

/**
 * Snapshot retention (DESIGN.md §10, ADR-0077): keeps the bucket inside R2's free 10 GB.
 *
 * **What is kept**, decided by the pure {@link planRetention}:
 * 1. Per **public** repo, the latest {@link RetentionPolicy.keepPerRepo} commits (5), each by
 *    the analysis a permalink serves (the newest finished, as `findPublishedAnalysis` picks).
 *    Older commits are evicted (`beyond-latest`), and so is every other analysis of a kept
 *    commit (`superseded`: an older analyzer version nothing serves any more).
 * 2. Plus any commit a pull request updated in the last 30 days names as base or head
 *    (pinned): a PR diff may still need it. Pinned snapshots are never evicted.
 * 3. If the bucket would still hold more than {@link RetentionPolicy.budgetBytes} (8 GB),
 *    the oldest snapshots by finish time go first, globally, private ones included
 *    (`over-budget`), until it fits.
 * 4. **Orphans**, objects with a snapshot key that no `done` row names, are deleted once
 *    older than an hour (an upload is written before its row, ADR-0063). Objects outside
 *    the snapshot key shapes are never touched, only counted.
 *
 * Sizes come from listing the bucket, not from our rows: the listing is what R2 bills.
 *
 * **How a run applies it** ({@link runRetention}): rows are read **before** the bucket is
 * listed, so any row the run sees has its object in the listing (publish uploads first).
 * Evicted rows are deleted first, then their objects: a crash in between leaves an orphan,
 * which the next run deletes, never a row pointing at nothing. A `done` row whose object
 * is missing is only reported (`missing`), because deleting rows on the word of a listing
 * is how a listing bug would destroy the database.
 *
 * Each deleted row's **completed BullMQ job** is removed next (ADR-0082). Its ID is derived
 * from the commit and analyzer version, like the row, and BullMQ keeps it a day; while it
 * exists the enqueue API answers `created: false` and "done" for a commit that no longer has
 * an analysis, so nobody could analyze it again. The ID is computed from the repo's current
 * name, the one the web app enqueues under. A failed removal is counted and the run goes on:
 * the job expires on its own within the day.
 *
 * Known race, accepted: a commit re-analyzed in the instant between its row's deletion and
 * its object's deletion would lose the new object (same key); the next view re-analyzes it.
 */

/** The knobs of {@link planRetention}. */
export interface RetentionPolicy {
  /** Commits kept per public repo, newest first. */
  keepPerRepo: number;
  /** Bucket bytes allowed after a run; past it the oldest snapshots go. */
  budgetBytes: number;
  /** An object no row names is deleted only once it is this old. */
  orphanGraceMs: number;
}

/**
 * DESIGN.md §10's numbers. 8 GB counted as 8 × 10⁹ bytes, the smaller reading of R2's
 * "10 GB" free tier, leaves room for an hour of uploads between runs.
 */
export const RETENTION_POLICY: RetentionPolicy = {
  keepPerRepo: 5,
  budgetBytes: 8_000_000_000,
  orphanGraceMs: 60 * 60 * 1000,
};

/** Why a row was evicted. */
export type EvictionReason = "superseded" | "beyond-latest" | "over-budget";

/** One evicted analysis. */
export interface Eviction {
  id: string;
  snapshotKey: string;
  reason: EvictionReason;
}

/** What to delete, and the bucket's size before and after. */
export interface RetentionPlan {
  /** Rows to delete, by ID. */
  evict: Eviction[];
  /** Objects to delete: evicted snapshots no kept row names, then orphans. Sorted. */
  deleteKeys: string[];
  /** Orphaned snapshot objects (a subset of `deleteKeys`). Sorted. */
  orphans: string[];
  /** Kept rows whose object the listing doesn't have. Sorted IDs. */
  missing: string[];
  /** Objects and bytes in the whole bucket. */
  objects: number;
  storedBytes: number;
  /** Bucket bytes once `deleteKeys` are gone. */
  retainedBytes: number;
}

/** What {@link planRetention} reads. */
export interface RetentionInput {
  rows: readonly StoredSnapshotRow[];
  objects: readonly ListedObject[];
  pinned: readonly PinnedSha[];
  now: Date;
  policy?: RetentionPolicy;
}

/** The two snapshot key shapes of storage.ts; anything else in the bucket isn't ours to judge. */
const SNAPSHOT_KEY = /^(?:public|private)\/(?:[^/]+\/){2}[0-9a-f]{40}\/[^/]+\.json\.gz$/;

/** Newest finish first; ties by creation, then ID, so a plan never depends on input order. */
function newestFirst(a: StoredSnapshotRow, b: StoredSnapshotRow): number {
  return (
    b.finishedAt.getTime() - a.finishedAt.getTime() ||
    b.createdAt.getTime() - a.createdAt.getTime() ||
    compareStrings(a.id, b.id)
  );
}

const pinKey = (repoId: string, sha: string) => `${repoId}\n${sha}`;

/** Decide what a retention run deletes. Pure: the same input gives the same plan. */
export function planRetention(input: RetentionInput): RetentionPlan {
  const policy = input.policy ?? RETENTION_POLICY;
  const sizes = new Map(input.objects.map((o) => [o.key, o.size]));
  const storedBytes = input.objects.reduce((sum, o) => sum + o.size, 0);
  const pinned = new Set(input.pinned.map((p) => pinKey(p.repoId, p.sha)));
  const evicted = new Map<string, EvictionReason>();

  // 1–2: per public repo, the served analysis of the latest commits, plus pinned commits.
  const byRepo = new Map<string, StoredSnapshotRow[]>();
  for (const row of input.rows) {
    if (row.visibility !== "public") continue;
    byRepo.set(row.repoId, [...(byRepo.get(row.repoId) ?? []), row]);
  }
  for (const rows of byRepo.values()) {
    const seen = new Set<string>();
    for (const row of [...rows].sort(newestFirst)) {
      if (seen.has(row.sha)) {
        evicted.set(row.id, "superseded");
        continue;
      }
      seen.add(row.sha);
      const latest = seen.size <= policy.keepPerRepo;
      if (!latest && !pinned.has(pinKey(row.repoId, row.sha))) evicted.set(row.id, "beyond-latest");
    }
  }

  // Which kept rows name each key (two rows can share one after a rename, ADR-0077).
  const keptByKey = new Map<string, number>();
  for (const row of input.rows) {
    if (evicted.has(row.id)) continue;
    keptByKey.set(row.snapshotKey, (keptByKey.get(row.snapshotKey) ?? 0) + 1);
  }
  const named = new Set(input.rows.map((row) => row.snapshotKey));
  const deleteKeys = new Set<string>();
  for (const row of input.rows) {
    if (evicted.has(row.id) && !keptByKey.has(row.snapshotKey)) deleteKeys.add(row.snapshotKey);
  }
  const graceEnd = input.now.getTime() - policy.orphanGraceMs;
  const orphans = input.objects
    .filter((o) => SNAPSHOT_KEY.test(o.key) && !named.has(o.key))
    .filter((o) => o.lastModified.getTime() <= graceEnd)
    .map((o) => o.key)
    .sort(compareStrings);
  for (const key of orphans) deleteKeys.add(key);
  const freed = (keys: Iterable<string>) => {
    let total = 0;
    for (const key of keys) total += sizes.get(key) ?? 0;
    return total;
  };
  let retainedBytes = storedBytes - freed(deleteKeys);

  // 3: over budget ⇒ the oldest kept, unpinned snapshots go, globally.
  if (retainedBytes > policy.budgetBytes) {
    const candidates = input.rows
      .filter((row) => !evicted.has(row.id) && sizes.has(row.snapshotKey))
      .filter((row) => !pinned.has(pinKey(row.repoId, row.sha)))
      .sort((a, b) => newestFirst(b, a));
    for (const row of candidates) {
      if (retainedBytes <= policy.budgetBytes) break;
      evicted.set(row.id, "over-budget");
      const left = (keptByKey.get(row.snapshotKey) ?? 1) - 1;
      keptByKey.set(row.snapshotKey, left);
      if (left === 0 && !deleteKeys.has(row.snapshotKey)) {
        deleteKeys.add(row.snapshotKey);
        retainedBytes -= sizes.get(row.snapshotKey) ?? 0;
      }
    }
  }

  const evict = input.rows
    .filter((row) => evicted.has(row.id))
    .map((row) => ({
      id: row.id,
      snapshotKey: row.snapshotKey,
      reason: evicted.get(row.id) as EvictionReason,
    }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const missing = input.rows
    .filter((row) => !evicted.has(row.id) && !sizes.has(row.snapshotKey))
    .map((row) => row.id)
    .sort(compareStrings);
  return {
    evict,
    deleteKeys: [...deleteKeys].sort(compareStrings),
    orphans,
    missing,
    objects: input.objects.length,
    storedBytes,
    retainedBytes,
  };
}

/** What {@link runRetention} needs. */
export interface RetentionDeps {
  db: AnyDatabase;
  store: Pick<ObjectStore, "list" | "delete">;
  /** The queue whose completed jobs of deleted rows are removed. Without it, none are. */
  jobs?: CompletedJobs;
  /** Default now. */
  now?: () => Date;
  policy?: RetentionPolicy;
  /** Object deletes in flight at once. Default 4. */
  deleteConcurrency?: number;
}

/** What a run did, for the log and the quota check (M5.12b). */
export interface RetentionReport {
  objects: number;
  storedBytes: number;
  /** Bucket bytes after the run, assuming every planned delete succeeded. */
  retainedBytes: number;
  /** Rows deleted, by reason (a row that changed since it was listed isn't counted). */
  evicted: Record<EvictionReason, number>;
  orphans: number;
  missing: number;
  /** Objects deleted, and deletes that failed (left for the next run as orphans). */
  deletedObjects: number;
  failedDeletes: number;
  /** Completed jobs of deleted rows removed, and removals that failed (they expire anyway). */
  removedJobs: number;
  failedJobRemovals: number;
}

/**
 * Run retention once: read the rows and the bucket, plan, delete the evicted rows, then the
 * completed jobs and objects of the rows actually deleted, plus the orphans. A failed listing
 * or row delete rejects before any job or object is touched; a failed job removal or object
 * delete is counted, not thrown.
 */
export async function runRetention(deps: RetentionDeps): Promise<RetentionReport> {
  const { db, store } = deps;
  const rows = await listStoredSnapshots(db);
  const pinned = await listPinnedShas(db);
  const objects: ListedObject[] = [];
  for await (const object of store.list()) objects.push(object);
  const plan = planRetention({
    rows,
    objects,
    pinned,
    now: (deps.now ?? (() => new Date()))(),
    ...(deps.policy === undefined ? {} : { policy: deps.policy }),
  });

  const gone = await deleteDoneAnalyses(db, plan.evict);
  const goneIds = new Set(gone.map((row) => row.id));
  const goneKeys = new Set(gone.map((row) => row.snapshotKey));

  const jobIds = rows
    .filter((row) => goneIds.has(row.id))
    .map((row) =>
      jobIdFor(
        { kind: "analyze", owner: row.owner, repo: row.name, sha: row.sha },
        row.analyzerVersion,
      ),
    )
    .sort(compareStrings);
  const jobs =
    deps.jobs === undefined || jobIds.length === 0
      ? { removed: 0, failed: 0 }
      : await deps.jobs
          .removeCompleted(jobIds)
          .catch(() => ({ removed: 0, failed: jobIds.length }));

  const orphans = new Set(plan.orphans);
  const keys = plan.deleteKeys.filter((key) => goneKeys.has(key) || orphans.has(key));
  let deletedObjects = 0;
  let failedDeletes = 0;
  let next = 0;
  const lane = async () => {
    while (next < keys.length) {
      const key = keys[next++] as string;
      try {
        await store.delete(key);
        deletedObjects++;
      } catch {
        failedDeletes++;
      }
    }
  };
  await Promise.all(Array.from({ length: deps.deleteConcurrency ?? 4 }, lane));

  const evicted: Record<EvictionReason, number> = {
    superseded: 0,
    "beyond-latest": 0,
    "over-budget": 0,
  };
  for (const { id, reason } of plan.evict) if (goneIds.has(id)) evicted[reason]++;
  return {
    objects: plan.objects,
    storedBytes: plan.storedBytes,
    retainedBytes: plan.retainedBytes,
    evicted,
    orphans: plan.orphans.length,
    missing: plan.missing.length,
    deletedObjects,
    failedDeletes,
    removedJobs: jobs.removed,
    failedJobRemovals: jobs.failed,
  };
}
