/**
 * The bot's record of each pull request (M8.6c, ADR-0244): the newest base and head GitHub has
 * described, that pair's diff and broken count, the comment it edits in place, and that head's
 * Check Run. Webhooks can arrive out of order and diff jobs finish in any order, so every write
 * is conditional in the database: an older event never moves the record back, and a job's
 * result lands only while its pair is still the pull request's current one.
 */
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
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
 * clears the old diff, its job (which then stops being live), and its Check Run, which reported
 * that pair's diff (M8.6e1: a base that moves under the same head gets a new one); the comment is
 * kept (it is edited in place). The same pair described again
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
        checkRunId: sql`case when ${samePair} then ${pullRequests.checkRunId} end`,
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

/** A diff job as the pull request records naming it describe it (ADR-0245). */
export interface DiffJobRecord {
  /** Our repo row's ID: part of the diff's key. */
  repoId: string;
  /** The pair the job diffs: the event's base (not the merge base) and the head. */
  baseSha: string;
  headSha: string;
  /**
   * `queued` while some record naming the job has no diff yet; `diffed` once every one has its
   * diff and some still has no Check Run (posting is left, M8.6e2b); `done` once all are posted.
   */
  status: "queued" | "diffed" | "done";
}

/**
 * The diff job with ID `jobId` as the records naming it describe it, or `undefined` when none
 * does (every pull request it was queued for moved on to another pair, or was deleted). A
 * record names a job only for its current pair (the job is cleared with the pair), so every
 * record naming it has the same repo and pair. "Posted" is a stored Check Run, which belongs to
 * the record's current pair (M8.6e1).
 */
export async function findDiffJob(
  db: AnyDatabase,
  jobId: string,
): Promise<DiffJobRecord | undefined> {
  const rows = await db
    .select({
      repoId: pullRequests.repoId,
      baseSha: pullRequests.baseSha,
      headSha: pullRequests.headSha,
      diffKey: pullRequests.diffKey,
      checkRunId: pullRequests.checkRunId,
    })
    .from(pullRequests)
    .where(eq(pullRequests.diffJobId, jobId))
    .orderBy(desc(pullRequests.updatedAt), desc(pullRequests.id));
  const [first] = rows;
  if (first === undefined) return undefined;
  const status = rows.some((row) => row.diffKey === null)
    ? "queued"
    : rows.some((row) => row.checkRunId === null)
      ? "diffed"
      : "done";
  return { repoId: first.repoId, baseSha: first.baseSha, headSha: first.headSha, status };
}

/** A pull request a diff job still has to post to, as {@link findDiffJobPosts} reads it. */
export interface DiffJobPost {
  repoId: string;
  number: number;
  baseSha: string;
  headSha: string;
  /** Where the job's diff is stored. */
  diffKey: string;
}

/**
 * The records naming diff job `jobId` that hold its diff and have no Check Run yet (M8.6e2b):
 * the pull requests it still has to post to, sorted by repo and number. Empty when every one is
 * posted, has moved on, or has no diff yet. The poster still re-reads each record just before
 * posting (`findPullRequest`): a newer event can arrive meanwhile (ADR-0244).
 */
export async function findDiffJobPosts(db: AnyDatabase, jobId: string): Promise<DiffJobPost[]> {
  const rows = await db
    .select({
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      baseSha: pullRequests.baseSha,
      headSha: pullRequests.headSha,
      diffKey: pullRequests.diffKey,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.diffJobId, jobId),
        isNotNull(pullRequests.diffKey),
        isNull(pullRequests.checkRunId),
      ),
    );
  return rows
    .flatMap(({ diffKey, ...row }) => (diffKey === null ? [] : [{ ...row, diffKey }]))
    .sort((a, b) => (a.repoId === b.repoId ? a.number - b.number : a.repoId < b.repoId ? -1 : 1));
}

/**
 * Clears the diff from the records naming diff job `jobId` that have no Check Run yet
 * (M8.6e2b), so the job is `queued` again and runs from the start: for a retry that has to post
 * but can no longer read what the diff was made from (the diff's object or a side's stored
 * graph). The read token's window (`findJobInstallation`) opens again with it. Posted records
 * keep theirs. Answers how many records were cleared; the old diff object is then retention's
 * orphan, unless the run stores it again under the same key.
 */
export async function reopenDiffJob(db: AnyDatabase, jobId: string): Promise<number> {
  const rows = await db
    .update(pullRequests)
    .set({ diffKey: null, brokenCount: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(pullRequests.diffJobId, jobId),
        isNotNull(pullRequests.diffKey),
        isNull(pullRequests.checkRunId),
      ),
    )
    .returning({ id: pullRequests.id });
  return rows.length;
}

/** A diff job's stored result. */
export interface DiffJobResult {
  jobId: string;
  /** Where the diff is stored. */
  diffKey: string;
  brokenCount: number;
}

/** A pull request a diff job's result was recorded on. */
export interface DiffedPullRequest {
  repoId: string;
  number: number;
  baseSha: string;
  headSha: string;
}

/**
 * Records a diff job's result on every pull request record naming the job (ADR-0245; two pull
 * requests with the same pair share it). A record names the job only while its pair is the
 * job's, so an older job's result never lands on a newer pair. Answers the records written,
 * sorted by repo and number: empty means every one moved on and nothing is posted. A job
 * retried after recording writes the same result again and gets the same records, so it can
 * still post. `true` for a record doesn't hold its pair: a newer event can still arrive before
 * the post, so the poster checks again (ADR-0244).
 */
export async function recordDiffJobResult(
  db: AnyDatabase,
  result: DiffJobResult,
): Promise<DiffedPullRequest[]> {
  const rows = await db
    .update(pullRequests)
    .set({ diffKey: result.diffKey, brokenCount: result.brokenCount, updatedAt: sql`now()` })
    .where(eq(pullRequests.diffJobId, result.jobId))
    .returning({
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      baseSha: pullRequests.baseSha,
      headSha: pullRequests.headSha,
    });
  return rows.sort((a, b) =>
    a.repoId === b.repoId ? a.number - b.number : a.repoId < b.repoId ? -1 : 1,
  );
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

/** A stored diff to look for, as a pull request comment's link names it (M8.6f1). */
export interface StoredDiffQuery {
  /** Our repo row's ID. */
  repoId: string;
  /** The link's `?base=`: the diff's merge base, not the event's base the record holds. */
  baseSha: string;
  headSha: string;
  /** The analyzer version the diff was made by. */
  analyzerVersion: string;
}

/**
 * The key of a diff of `baseSha`...`headSha` by `analyzerVersion` that some pull request record
 * of the repo still names (M8.6f1), for the diagram page's diff mode on the comment's link
 * (`/<owner>/<repo>/<head>?base=<merge base>`). The record holds the event's base, not the
 * merge base, so the pair is read from the key (`privateDiffKey`'s shape: `private/<installation>/
 * <repoId>/diffs/<merge base>-<head>/<version>.json.gz`); a key of another shape is never
 * returned. A record whose pull request moved on no longer names its old diff, so an old link
 * finds nothing. Two records naming the pair under different installations answer the first
 * key in string order.
 */
export async function findPullRequestDiffKey(
  db: AnyDatabase,
  query: StoredDiffQuery,
): Promise<string | undefined> {
  const rows = await db
    .select({ diffKey: pullRequests.diffKey })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repoId, query.repoId),
        eq(pullRequests.headSha, query.headSha),
        isNotNull(pullRequests.diffKey),
      ),
    );
  const name = `/${query.repoId}/diffs/${query.baseSha}-${query.headSha}/${query.analyzerVersion}.json.gz`;
  return rows
    .flatMap(({ diffKey }) =>
      diffKey !== null &&
      /^private\/[1-9][0-9]*$/.test(diffKey.slice(0, -name.length)) &&
      diffKey.endsWith(name)
        ? [diffKey]
        : [],
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
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
 * Stores the ID of the Check Run created for the pair `baseSha`, `headSha`, only if that is
 * still the pull request's current pair (a Check Run sits on one head commit and reports one
 * pair's diff; M8.6e1). Answers whether it was stored. A stored Check Run is what makes the
 * pair posted (jobs.ts `findDiffJobToPost`).
 */
export async function recordPullRequestCheckRun(
  db: AnyDatabase,
  ref: PullRequestRef & { baseSha: string; headSha: string; checkRunId: number },
): Promise<boolean> {
  const rows = await db
    .update(pullRequests)
    .set({ checkRunId: ref.checkRunId, updatedAt: sql`now()` })
    .where(
      and(
        eq(pullRequests.repoId, ref.repoId),
        eq(pullRequests.number, ref.number),
        eq(pullRequests.baseSha, ref.baseSha),
        eq(pullRequests.headSha, ref.headSha),
      ),
    )
    .returning({ id: pullRequests.id });
  return rows.length > 0;
}
