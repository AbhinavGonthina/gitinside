/**
 * The bot's record of each pull request (M8.6c, ADR-0244): the newest base and head GitHub has
 * described, that pair's diff and broken count, the comment it edits in place, and that head's
 * Check Run. Webhooks can arrive out of order and diff jobs finish in any order, so every write
 * is conditional in the database: an older event never moves the record back, and a job's
 * result lands only while its pair is still the pull request's current one.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { pullRequests } from "./schema.js";

/** One stored pull request record. */
export type PullRequestRecord = typeof pullRequests.$inferSelect;

/** A pull request's base and head as one `pull_request` event describes them. */
export interface PullRequestHead {
  /** Our repo row's ID. */
  repoId: string;
  number: number;
  baseSha: string;
  headSha: string;
  /** GitHub's `pull_request.updated_at` in the event: orders events for one pull request. */
  headAt: Date;
}

/** Which pull request a later write is about. */
interface PullRequestRef {
  repoId: string;
  number: number;
}

/** A finished diff of one base and head. */
export interface PullRequestDiff extends PullRequestRef {
  baseSha: string;
  headSha: string;
  /** Where the diff is stored. */
  diffKey: string;
  brokenCount: number;
}

/** True while the stored row holds the same base and head as the one being written. */
const samePair = sql`${pullRequests.baseSha} = excluded.base_sha and ${pullRequests.headSha} = excluded.head_sha`;

/**
 * Records the base and head an event describes, creating the record on its first event. An
 * event older than the recorded one (`headAt` earlier) changes nothing and answers `undefined`:
 * the caller then queues no diff. Otherwise the row is returned as now stored. A different pair
 * clears the old diff and its job (which then stops being live), and a different head the old
 * head's Check Run; the comment is kept (it is edited in place). The same pair described again
 * keeps everything, so a caller seeing a `diffKey` has nothing to recompute. Events as new as the recorded one are taken: GitHub's
 * times are whole seconds, and two pushes in one second are then recorded in delivery order.
 */
export async function recordPullRequestHead(
  db: AnyDatabase,
  head: PullRequestHead,
): Promise<PullRequestRecord | undefined> {
  const [row] = await db
    .insert(pullRequests)
    .values(head)
    .onConflictDoUpdate({
      target: [pullRequests.repoId, pullRequests.number],
      set: {
        baseSha: sql`excluded.base_sha`,
        headSha: sql`excluded.head_sha`,
        headAt: sql`excluded.head_at`,
        diffKey: sql`case when ${samePair} then ${pullRequests.diffKey} end`,
        brokenCount: sql`case when ${samePair} then ${pullRequests.brokenCount} end`,
        diffJobId: sql`case when ${samePair} then ${pullRequests.diffJobId} end`,
        diffQueuedAt: sql`case when ${samePair} then ${pullRequests.diffQueuedAt} end`,
        checkRunId: sql`case when ${pullRequests.headSha} = excluded.head_sha then ${pullRequests.checkRunId} end`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${pullRequests.headAt} <= excluded.head_at`,
    })
    .returning();
  return row;
}

/** The record of pull request `number` in repo `repoId` (our row ID), if any. */
export async function findPullRequest(
  db: AnyDatabase,
  repoId: string,
  number: number,
): Promise<PullRequestRecord | undefined> {
  const [row] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, number)));
  return row;
}

/** A diff job to name on the record of the pair it diffs. */
export interface PullRequestDiffJob extends PullRequestRef {
  baseSha: string;
  headSha: string;
  /** The job's ID (`diff-` + 32 hex, the worker's `jobIdFor`). */
  jobId: string;
}

/**
 * Names `job.jobId` as the diff job of the pull request's current pair (ADR-0245), only while
 * that pair is still current and has no diff. Answers when the job was queued, the name its task
 * takes: the stored time when the record already names this job (a redelivered event then makes
 * the same task again, which the queue refuses as a duplicate), else now. `undefined` means
 * queue nothing: the pull request moved on, has its diff, or was never recorded. A different job
 * for the same pair (a new analyzer version) replaces the old one, which then stops being live.
 */
export async function queuePullRequestDiff(
  db: AnyDatabase,
  job: PullRequestDiffJob,
): Promise<Date | undefined> {
  const [row] = await db
    .update(pullRequests)
    .set({
      diffJobId: job.jobId,
      diffQueuedAt: sql`case when ${pullRequests.diffJobId} = ${job.jobId}
        then ${pullRequests.diffQueuedAt} else now() end`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(pullRequests.repoId, job.repoId),
        eq(pullRequests.number, job.number),
        eq(pullRequests.baseSha, job.baseSha),
        eq(pullRequests.headSha, job.headSha),
        isNull(pullRequests.diffKey),
      ),
    )
    .returning({ queuedAt: pullRequests.diffQueuedAt });
  return row?.queuedAt ?? undefined;
}

/**
 * Records a finished diff, only if its base and head are still the pull request's current pair.
 * Answers whether it was recorded: `false` means a newer event moved the pull request on (or it
 * was never recorded), and the caller posts nothing for this result. `true` doesn't hold the
 * pair: a newer event can still arrive before the post, so the poster checks again (ADR-0244).
 */
export async function recordPullRequestDiff(
  db: AnyDatabase,
  diff: PullRequestDiff,
): Promise<boolean> {
  const rows = await db
    .update(pullRequests)
    .set({ diffKey: diff.diffKey, brokenCount: diff.brokenCount, updatedAt: sql`now()` })
    .where(
      and(
        eq(pullRequests.repoId, diff.repoId),
        eq(pullRequests.number, diff.number),
        eq(pullRequests.baseSha, diff.baseSha),
        eq(pullRequests.headSha, diff.headSha),
      ),
    )
    .returning({ id: pullRequests.id });
  return rows.length > 0;
}

/**
 * Stores the ID of the pull request's comment, whatever its head (the comment is edited in
 * place across heads), replacing an earlier one (say, deleted on GitHub and posted again).
 * Answers whether the record exists.
 */
export async function recordPullRequestComment(
  db: AnyDatabase,
  ref: PullRequestRef & { commentId: number },
): Promise<boolean> {
  const rows = await db
    .update(pullRequests)
    .set({ commentId: ref.commentId, updatedAt: sql`now()` })
    .where(and(eq(pullRequests.repoId, ref.repoId), eq(pullRequests.number, ref.number)))
    .returning({ id: pullRequests.id });
  return rows.length > 0;
}

/**
 * Stores the ID of the Check Run created for `headSha`, only if that is still the pull
 * request's head (a Check Run belongs to one head commit). Answers whether it was stored.
 */
export async function recordPullRequestCheckRun(
  db: AnyDatabase,
  ref: PullRequestRef & { headSha: string; checkRunId: number },
): Promise<boolean> {
  const rows = await db
    .update(pullRequests)
    .set({ checkRunId: ref.checkRunId, updatedAt: sql`now()` })
    .where(
      and(
        eq(pullRequests.repoId, ref.repoId),
        eq(pullRequests.number, ref.number),
        eq(pullRequests.headSha, ref.headSha),
      ),
    )
    .returning({ id: pullRequests.id });
  return rows.length > 0;
}
