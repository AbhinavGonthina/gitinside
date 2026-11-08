/**
 * The writes behind an analysis (ADR-0063): the repo row, and one `analyses` row moving
 * through `queued` → `running` → `done` | `failed`.
 *
 * - **Who calls what:** the web app calls {@link findAnalysis} (the cache lookup),
 *   {@link findPublishedAnalysis} (what a repo page serves), {@link findStoredAnalysis}
 *   (what `/api/graph` serves, private repos behind an access check) and, when it
 *   enqueues a new job, {@link upsertRepo} and {@link queueAnalysis} (ADR-0066), before that
 *   {@link failStrandedAnalysis} on a commit that's `queued` with no task coming, and
 *   {@link hideRepo} when GitHub says a published repo went private or away. The worker calls {@link upsertRepo} and {@link startAnalysis} when a
 *   job starts ({@link startInstallationAnalysis} for a job through an installation),
 *   {@link completeAnalysis} after the snapshot is in object storage (so a `done`
 *   row always has its object; {@link findAnalysisStatus} when it finds none), {@link requeueAnalysis} when an attempt fails but will be
 *   retried, {@link failAnalysis} when the last one fails,
 *   {@link failInterruptedAnalyses} at startup, and {@link recentAnalysisStats} when a job
 *   starts (for its time estimate).
 * - **`done` is final:** a later attempt never touches a `done` row (the snapshot it names
 *   exists and is immutable), so a redundant job can't hide a cached result.
 * - **Times** come from the database's clock (`now()`), one clock for every writer.
 */
import { and, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { analyses, installations, repos, type AnalysisStats } from "./schema.js";
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
  /**
   * GitHub's ID for the App installation the repo was read through, if any (M8.3c2): the
   * repo is linked to it, moving from another installation (a transfer). Left out, the
   * repo's link stays as it is: a public job never unlinks a repo.
   */
  githubInstallationId?: number;
}

/**
 * Thrown by {@link upsertRepo} when `githubInstallationId` names an installation that isn't
 * stored (never recorded, or deleted meanwhile). Nothing is written.
 */
export class UnknownInstallationError extends Error {
  override name = "UnknownInstallationError";
  constructor() {
    super("the repo's installation isn't stored");
  }
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
 * The error code for a queued job no task will run (ADR-0142, ADR-0147): its task was never
 * created, or {@link failStaleQueuedAnalyses} found it waiting past every task's window. It
 * is retryable: the website queues the commit again on the next request or view.
 */
export const QUEUE_UNAVAILABLE_CODE = "QUEUE_UNAVAILABLE";

/**
 * Insert the repo, or update it by GitHub's ID (which survives renames). If another row
 * still holds this owner/name, that repo was renamed or deleted on GitHub since we saw it;
 * its name becomes `~<its GitHub ID>` (no GitHub name contains `~`) so it keeps its
 * analyses, and the next upsert of that repo restores its real name.
 *
 * Races: `on conflict` only covers the GitHub ID's index. When another request's insert of
 * this owner/name is still uncommitted, this one's insert waits on it in the
 * `lower(owner), lower(name)` index and fails with a unique violation once it commits
 * (Postgres checks non-arbiter indexes plainly). So a unique violation runs the upsert once
 * more, in a new transaction that sees the committed row (M5A.3d1).
 *
 * With `githubInstallationId`, the repo is linked to that installation in the same
 * transaction; an installation that isn't stored throws {@link UnknownInstallationError}.
 */
export async function upsertRepo(db: AnyDatabase, facts: RepoFacts): Promise<{ id: string }> {
  try {
    return await upsertRepoOnce(db, facts);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return upsertRepoOnce(db, facts);
  }
}

/** Whether a query failed with Postgres's `unique_violation` (Drizzle may wrap it in `cause`). */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if ("code" in e && e.code === "23505") return true;
  }
  return false;
}

async function upsertRepoOnce(db: AnyDatabase, facts: RepoFacts): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    let link: { installationId?: string } = {};
    if (facts.githubInstallationId !== undefined) {
      // Locked, so a deletion of the installation (M8.5) waits for this link, then sees it.
      const [installation] = await tx
        .select({ id: installations.id })
        .from(installations)
        .where(eq(installations.githubInstallationId, facts.githubInstallationId))
        .for("share");
      if (installation === undefined) throw new UnknownInstallationError();
      link = { installationId: installation.id };
    }
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
      .values({
        providerRepoId: facts.providerRepoId,
        owner,
        name,
        visibility,
        defaultBranch,
        ...link,
      })
      .onConflictDoUpdate({
        target: repos.providerRepoId,
        set: { owner, name, visibility, defaultBranch, ...link, updatedAt: sql`now()` },
      })
      .returning({ id: repos.id });
    return row as { id: string };
  });
}

/** The job a write belongs to, when the caller knows it (ADR-0139). */
export interface JobOptions {
  /** The queue's job ID, `analyze-<32 hex>`; stored on the row so `findJob` finds it. */
  jobId?: string;
}

/**
 * Mark the analysis `running` (inserting the row if the web app didn't), clearing what a
 * failed earlier attempt left and counting the attempt. A `done` row is returned unchanged.
 */
export async function startAnalysis(
  db: AnyDatabase,
  key: AnalysisKey,
  options: JobOptions = {},
): Promise<{ id: string; status: "running" | "done" }> {
  const running = {
    status: "running" as const,
    startedAt: sql`now()`,
    errorCode: null,
    snapshotKey: null,
    stats: null,
    finishedAt: null,
    progress: null,
    progressAt: null,
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
  };
  const [row] = await db
    .insert(analyses)
    .values({ ...key, ...running, attempts: 1 })
    .onConflictDoUpdate({
      target: [analyses.repoId, analyses.sha, analyses.analyzerVersion],
      set: { ...running, attempts: sql`${analyses.attempts} + 1` },
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

/**
 * Thrown by {@link startInstallationAnalysis} when the job's row is gone, or its repo is no
 * longer linked to the job's installation: the installation was uninstalled or lost the repo
 * since the job was queued (M8.5b, ADR-0241). Nothing is written.
 */
export class JobGoneError extends Error {
  override name = "JobGoneError";
  constructor() {
    super("the job's row is gone");
  }
}

/**
 * The worker's start of a job through an installation (M8.5b, ADR-0241): {@link upsertRepo}
 * and {@link startAnalysis} in one transaction, but only while the job is still ours to run.
 * The website queued its row (with job ID `jobId`) and linked the repo to the installation
 * before creating the task, and the uninstall flow (`deleteInstallationData`) deletes or
 * unlinks both. So the row must still exist, for the repo with GitHub's ID
 * `facts.providerRepoId`, linked to installation `facts.githubInstallationId`; otherwise
 * {@link JobGoneError}, and a removed private repo's row is never created again.
 *
 * The installation's row is locked (`FOR SHARE`) before the check, so a deletion holding it
 * `FOR UPDATE` either commits first (and the check sees what it deleted) or waits until this
 * start has committed (and deletes the running row with the rest). An installation that isn't
 * stored throws {@link UnknownInstallationError}.
 */
export async function startInstallationAnalysis(
  db: AnyDatabase,
  facts: RepoFacts & { githubInstallationId: number },
  start: { sha: string; analyzerVersion: string; jobId: string },
): Promise<{ repoId: string; id: string; status: "running" | "done" }> {
  const once = () =>
    db.transaction(async (tx) => {
      const [installation] = await tx
        .select({ id: installations.id })
        .from(installations)
        .where(eq(installations.githubInstallationId, facts.githubInstallationId))
        .for("share");
      if (installation === undefined) throw new UnknownInstallationError();
      const [job] = await tx
        .select({ id: analyses.id })
        .from(analyses)
        .innerJoin(repos, eq(repos.id, analyses.repoId))
        .where(
          and(
            eq(analyses.jobId, start.jobId),
            eq(repos.providerRepoId, facts.providerRepoId),
            eq(repos.installationId, installation.id),
          ),
        )
        .limit(1);
      if (job === undefined) throw new JobGoneError();
      const { id: repoId } = await upsertRepoOnce(tx, facts);
      const { sha, analyzerVersion, jobId } = start;
      const started = await startAnalysis(tx, { repoId, sha, analyzerVersion }, { jobId });
      return { repoId, ...started };
    });
  try {
    return await once();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return once();
  }
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

/**
 * Where the worker stores a private job's snapshot (`private/<installationId>/…`, its
 * `storage.ts`). Such an analysis is only ever served behind the access check, whatever the
 * repo's visibility now (M8.4d2, ADR-0239): a repo turned public is analyzed again under the
 * public key, so deleting an installation's objects (M8.5) never breaks a public diagram.
 */
export const PRIVATE_SNAPSHOT_PREFIX = "private/";

/** Whether `snapshotKey` is a private job's ({@link PRIVATE_SNAPSHOT_PREFIX}). */
export function isPrivateSnapshot(snapshotKey: string | null): boolean {
  return snapshotKey?.startsWith(PRIVATE_SNAPSHOT_PREFIX) === true;
}

/** {@link isPrivateSnapshot} in SQL, of an `analyses` row. */
const storedPrivately = sql`left(${analyses.snapshotKey}, ${PRIVATE_SNAPSHOT_PREFIX.length}) = ${PRIVATE_SNAPSHOT_PREFIX}`;

/** What {@link findPublishedAnalysis} returns: the repo as last seen, and one finished analysis. */
export interface PublishedAnalysis {
  repo: { id: string; providerRepoId: number; owner: string; name: string };
  analysis: { sha: string; analyzerVersion: string; snapshotKey: string; finishedAt: Date };
}

/**
 * The newest `done` analysis of a **public** repo, found by owner and name ignoring case
 * (the diagram page and `/api/graph`, ADR-0068); with `sha`, of that commit. "Newest" is
 * the latest finish, so a re-analysis by a newer analyzer version wins over the old one.
 * With `providerRepoId` instead of a name, by GitHub's repo ID (a repo renamed since it was
 * stored, M5.13b3). Private repos are never returned, and neither is an analysis stored under
 * {@link PRIVATE_SNAPSHOT_PREFIX} (a repo analyzed privately that's public now, M8.4d2):
 * {@link findStoredAnalysis} returns both, for routes that check access.
 */
export async function findPublishedAnalysis(
  db: AnyDatabase,
  query: AnalysisQuery,
): Promise<PublishedAnalysis | undefined> {
  const found = await newestDone(db, query, true);
  if (found === undefined) return undefined;
  const { id, providerRepoId, owner, name } = found.repo;
  return { repo: { id, providerRepoId, owner, name }, analysis: found.analysis };
}

/**
 * What {@link findStoredAnalysis} returns: a {@link PublishedAnalysis} with the repo's visibility
 * and GitHub's ID of the installation it's linked to (`null` if none), which a private repo's
 * newer commits are queued through (M8.4c2).
 */
export interface StoredAnalysis {
  repo: PublishedAnalysis["repo"] & {
    visibility: "public" | "private";
    githubInstallationId: number | null;
  };
  analysis: PublishedAnalysis["analysis"];
}

/**
 * Like {@link findPublishedAnalysis}, but whatever the repo's visibility, which it returns
 * (M8.4b), and whatever the snapshot's key: for a route that checks a private repo's viewer
 * itself before serving it. One {@link findPublishedAnalysis} would return comes first, so
 * both name the same analysis whenever a public one exists (M8.4d2). Never serve what this
 * finds without asking {@link servedPrivately} first.
 */
export async function findStoredAnalysis(
  db: AnyDatabase,
  query: AnalysisQuery,
): Promise<StoredAnalysis | undefined> {
  return newestDone(db, query, false);
}

/**
 * Whether `stored` may only be served after the access check, `private, no-store`: its repo
 * is private, or it was analyzed privately (stored under {@link PRIVATE_SNAPSHOT_PREFIX}),
 * whatever the repo's visibility now (M8.4d2, ADR-0239).
 */
export function servedPrivately(stored: StoredAnalysis): boolean {
  return stored.repo.visibility === "private" || isPrivateSnapshot(stored.analysis.snapshotKey);
}

/** A repo by name (ignoring case) or by GitHub's ID, and optionally one commit. */
type AnalysisQuery = ({ owner: string; name: string } | { providerRepoId: number }) & {
  sha?: string;
};

async function newestDone(
  db: AnyDatabase,
  query: AnalysisQuery,
  publicOnly: boolean,
): Promise<StoredAnalysis | undefined> {
  const repo =
    "providerRepoId" in query
      ? [eq(repos.providerRepoId, query.providerRepoId)]
      : [
          sql`lower(${repos.owner}) = lower(${query.owner})`,
          sql`lower(${repos.name}) = lower(${query.name})`,
        ];
  const servedPublicly = sql`(${repos.visibility} = 'public' and not ${storedPrivately})`;
  const [row] = await db
    .select({
      id: repos.id,
      providerRepoId: repos.providerRepoId,
      owner: repos.owner,
      name: repos.name,
      visibility: repos.visibility,
      githubInstallationId: installations.githubInstallationId,
      sha: analyses.sha,
      analyzerVersion: analyses.analyzerVersion,
      snapshotKey: analyses.snapshotKey,
      finishedAt: analyses.finishedAt,
    })
    .from(analyses)
    .innerJoin(repos, eq(repos.id, analyses.repoId))
    .leftJoin(installations, eq(installations.id, repos.installationId))
    .where(
      and(
        ...repo,
        publicOnly ? servedPublicly : undefined,
        eq(analyses.status, "done"),
        query.sha === undefined ? undefined : eq(analyses.sha, query.sha),
      ),
    )
    // What a public page shows first, so the graph route serves the analysis the page names.
    .orderBy(sql`${servedPublicly} desc`, desc(analyses.finishedAt), desc(analyses.createdAt))
    .limit(1);
  if (row === undefined) return undefined;
  const {
    id,
    providerRepoId,
    owner,
    name,
    visibility,
    githubInstallationId,
    sha,
    analyzerVersion,
  } = row;
  // `done` rows always have both (the status check in schema.ts).
  const snapshotKey = row.snapshotKey as string;
  const finishedAt = row.finishedAt as Date;
  return {
    repo: { id, providerRepoId, owner, name, visibility, githubInstallationId },
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

/** What {@link queueAnalysis} returns: the row after the call. */
export interface QueuedAnalysis {
  id: string;
  status: AnalysisSummary["status"];
  /** Whether this call put the row in the queue (inserted it, or moved it from `failed`). */
  entered: boolean;
  /**
   * Whether the row is `queued` for a retry: an attempt already ran and failed retriably
   * ({@link requeueAnalysis}), so the queue's own task will push it again after its backoff
   * and nobody may create another (R1, second M5 review).
   */
  retrying: boolean;
  /** When the row last entered the queue: names its Cloud Tasks task (ADR-0141). */
  queuedAt: Date;
  /**
   * The job the row belongs to: the caller's when it `entered`, otherwise whoever queued or
   * started it (`null` if none said). A caller whose own job ID differs follows this one
   * (ADR-0227).
   */
  jobId: string | null;
}

/** What the web app knows when it queues a commit. */
export interface QueueOptions extends JobOptions {
  /** GitHub's repo `size` in KiB, kept for {@link findLimitFailure}'s callers. */
  repoSizeKb?: number;
  /**
   * A public job (M8.4d2): a `done` row stored under {@link PRIVATE_SNAPSHOT_PREFIX} (the repo
   * was analyzed privately and is public now) is queued again like a `failed` one, so the
   * commit is analyzed under the public key instead of being served from the private one.
   */
  replacePrivate?: boolean;
}

/**
 * Record that the web app is queuing a job for this commit: insert a `queued` row, or move a
 * `failed` one back to `queued` (a new job will run it again: attempts start over, and it
 * joins the back of the queue); with `replacePrivate`, a privately stored `done` one too.
 * Other `queued`, `running`, and `done` rows are left as they are;
 * the returned status is the row's after the call, `entered` says whether this call
 * queued it, and `retrying` whether a `queued` row is waiting for its task's retry.
 */
export async function queueAnalysis(
  db: AnyDatabase,
  key: AnalysisKey,
  options: QueueOptions = {},
): Promise<QueuedAnalysis> {
  const queued = {
    repoSizeKb: options.repoSizeKb ?? null,
    status: "queued" as const,
    errorCode: null,
    snapshotKey: null,
    stats: null,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    queuedAt: sql`now()`,
    progress: null,
    progressAt: null,
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
  };
  const [row] = await db
    .insert(analyses)
    .values({ ...key, ...queued })
    .onConflictDoUpdate({
      target: [analyses.repoId, analyses.sha, analyses.analyzerVersion],
      set: queued,
      setWhere:
        options.replacePrivate === true
          ? sql`(${analyses.status} = 'failed' or (${analyses.status} = 'done' and ${storedPrivately}))`
          : eq(analyses.status, "failed"),
    })
    .returning({ id: analyses.id, queuedAt: analyses.queuedAt, jobId: analyses.jobId });
  if (row !== undefined) return { ...row, status: "queued", entered: true, retrying: false };
  const [existing] = await db
    .select({
      id: analyses.id,
      status: analyses.status,
      queuedAt: analyses.queuedAt,
      attempts: analyses.attempts,
      jobId: analyses.jobId,
    })
    .from(analyses)
    .where(
      and(
        eq(analyses.repoId, key.repoId),
        eq(analyses.sha, key.sha),
        eq(analyses.analyzerVersion, key.analyzerVersion),
      ),
    );
  const { id, status, queuedAt, attempts, jobId } = existing as Omit<
    QueuedAnalysis,
    "entered" | "retrying"
  > & { attempts: number };
  // Entering the queue sets `attempts` to 0 and only a start raises it, so a `queued` row
  // with attempts is one `requeueAnalysis` put back for its task's retry.
  const retrying = status === "queued" && attempts > 0;
  return { id, status, queuedAt, jobId, entered: false, retrying };
}

/**
 * Back to `queued` after a failed attempt that will be retried, at the back of the queue
 * (the retry waits out a backoff anyway) and without the attempt's progress. Only a
 * `running` row moves. Its `attempts` stay, so {@link queueAnalysis} reports it `retrying`
 * and the website creates no second task beside the retry (R1).
 */
export async function requeueAnalysis(db: AnyDatabase, id: string): Promise<boolean> {
  const rows = await db
    .update(analyses)
    .set({ status: "queued", queuedAt: sql`now()`, progress: null, progressAt: null })
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
      progress: null,
      progressAt: null,
    })
    .where(and(eq(analyses.id, id), ne(analyses.status, "done")))
    .returning({ id: analyses.id });
  return rows.length > 0;
}

/**
 * The status of analysis `id`, or `undefined` if no row has that ID (any more): when
 * {@link completeAnalysis} returns `false`, this tells a row already `done` from one the
 * uninstall flow deleted while the job ran (M8.5b, ADR-0241).
 */
export async function findAnalysisStatus(
  db: AnyDatabase,
  id: string,
): Promise<AnalysisSummary["status"] | undefined> {
  const [row] = await db
    .select({ status: analyses.status })
    .from(analyses)
    .where(eq(analyses.id, id));
  return row?.status;
}

/**
 * The snapshot key of repo row `repoId`'s `done` analysis of `sha` by `analyzerVersion`, or
 * `undefined` if there's none (yet): a pull request's diff job reads that side's stored graph
 * instead of analyzing it (M8.6d3c2, ADR-0245). The caller decides whether it may read the key.
 */
export async function findDoneSnapshotKey(
  db: AnyDatabase,
  key: { repoId: string; sha: string; analyzerVersion: string },
): Promise<string | undefined> {
  const [row] = await db
    .select({ snapshotKey: analyses.snapshotKey })
    .from(analyses)
    .where(
      and(
        eq(analyses.repoId, key.repoId),
        eq(analyses.sha, key.sha),
        eq(analyses.analyzerVersion, key.analyzerVersion),
        eq(analyses.status, "done"),
      ),
    );
  // `done` rows always have one (the status check in schema.ts).
  return row?.snapshotKey ?? undefined;
}

/** What {@link findLinkedRepo} returns: the repo as last seen, enough for its snapshot key. */
export interface LinkedRepo {
  owner: string;
  name: string;
  visibility: "public" | "private";
}

/**
 * Repo row `repoId` if it's linked to the installation with GitHub's ID `githubInstallationId`,
 * else `undefined`: a diff job keys a side it analyzed by it before storing it
 * (M8.6d4, ADR-0245).
 */
export async function findLinkedRepo(
  db: AnyDatabase,
  link: { githubInstallationId: number; repoId: string },
): Promise<LinkedRepo | undefined> {
  const [row] = await db
    .select({ owner: repos.owner, name: repos.name, visibility: repos.visibility })
    .from(repos)
    .innerJoin(installations, eq(installations.id, repos.installationId))
    .where(
      and(
        eq(repos.id, link.repoId),
        eq(installations.githubInstallationId, link.githubInstallationId),
      ),
    );
  return row;
}

/**
 * Store a side a pull request's diff job analyzed as that commit's analysis (M8.6d4,
 * ADR-0245), once its snapshot is in object storage: a new `done` row, or a `failed` one moved
 * to `done`. A row another job holds (`queued` or `running`) and a `done` one are left as they
 * are, as is everything when the repo is no longer linked to the job's installation (an
 * uninstall or a removed repo since the job started). The installation's row is locked
 * (`FOR SHARE`) as in {@link startInstallationAnalysis}, so the uninstall flow's deletion
 * either ran first (and nothing is written) or deletes this row with the rest. The row gets no
 * job ID (`analyze-` IDs only) and no attempts. Returns whether a row was written.
 */
export async function storeDiffSideAnalysis(
  db: AnyDatabase,
  side: AnalysisKey & {
    githubInstallationId: number;
    snapshotKey: string;
    stats: AnalysisStats;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [linked] = await tx
      .select({ id: installations.id })
      .from(installations)
      .innerJoin(repos, eq(repos.installationId, installations.id))
      .where(
        and(
          eq(installations.githubInstallationId, side.githubInstallationId),
          eq(repos.id, side.repoId),
        ),
      )
      .for("share", { of: installations });
    if (linked === undefined) return false;
    const done = {
      status: "done" as const,
      snapshotKey: side.snapshotKey,
      stats: side.stats,
      errorCode: null,
      finishedAt: sql`now()`,
      progress: null,
      progressAt: null,
    };
    const { repoId, sha, analyzerVersion } = side;
    const rows = await tx
      .insert(analyses)
      .values({ repoId, sha, analyzerVersion, ...done })
      .onConflictDoUpdate({
        target: [analyses.repoId, analyses.sha, analyses.analyzerVersion],
        set: done,
        setWhere: eq(analyses.status, "failed"),
      })
      .returning({ id: analyses.id });
    return rows.length > 0;
  });
}

/**
 * The stats of the `limit` most recently finished `done` analyses, newest first, of any repo
 * or visibility (counts and timings only, nothing that names a repo). The worker estimates a
 * running job's time left from them (ADR-0136).
 */
export async function recentAnalysisStats(
  db: AnyDatabase,
  limit: number,
): Promise<AnalysisStats[]> {
  const rows = await db
    .select({ stats: analyses.stats })
    .from(analyses)
    .where(and(eq(analyses.status, "done"), sql`${analyses.stats} is not null`))
    .orderBy(desc(analyses.finishedAt), desc(analyses.id))
    .limit(limit);
  return rows.flatMap(({ stats }) => (stats === null ? [] : [stats]));
}

/** A recent analysis that stopped at one of the worker's size, time, or memory limits. */
export interface LimitFailure {
  /** `LIMIT_FILES`, `LIMIT_TIME`, …: the newest such failure's code. */
  errorCode: string;
  /** When it failed, and when the repo may be analyzed again (both by the database's clock). */
  failedAt: Date;
  until: Date;
  /** GitHub's size of the repo when that analysis was queued, if known. */
  repoSizeKb: number | null;
}

/**
 * The newest analysis of the repo (by GitHub's ID, any commit or analyzer version) that
 * failed with a `LIMIT_*` code less than `days` ago, unless an analysis of the repo finished
 * `done` after it (the repo fits again). `until` is that failure plus `days`. The website
 * refuses new analyses of the repo until then (#11, ADR-0153): a busy repo that's too big
 * gets a new commit every few minutes, so the per-commit cache never stops it.
 */
export async function findLimitFailure(
  db: AnyDatabase,
  providerRepoId: number,
  days: number,
): Promise<LimitFailure | undefined> {
  if (!Number.isFinite(days) || days <= 0) throw new RangeError("days must be a finite number > 0");
  const window = sql`${days} * interval '1 day'`;
  const [row] = await db
    .select({
      errorCode: analyses.errorCode,
      failedAt: analyses.finishedAt,
      until: sql<Date>`${analyses.finishedAt} + ${window}`.mapWith(analyses.finishedAt),
      repoSizeKb: analyses.repoSizeKb,
    })
    .from(analyses)
    .innerJoin(repos, eq(repos.id, analyses.repoId))
    .where(
      and(
        eq(repos.providerRepoId, providerRepoId),
        eq(analyses.status, "failed"),
        sql`left(${analyses.errorCode}, 6) = 'LIMIT_'`,
        sql`${analyses.finishedAt} > now() - ${window}`,
        sql`not exists (
          select 1 from ${analyses} as fit
          where fit.repo_id = ${analyses.repoId}
            and fit.status = 'done'
            and fit.finished_at > ${analyses.finishedAt}
        )`,
      ),
    )
    .orderBy(desc(analyses.finishedAt), desc(analyses.id))
    .limit(1);
  if (row === undefined) return undefined;
  // `failed` rows always have both (the status check in schema.ts).
  const { repoSizeKb } = row;
  return {
    errorCode: row.errorCode as string,
    failedAt: row.failedAt as Date,
    until: row.until,
    repoSizeKb,
  };
}

/** Mark a `queued` or `running` analysis `failed` with `errorCode`. */
export async function failAnalysis(
  db: AnyDatabase,
  id: string,
  errorCode: string,
): Promise<boolean> {
  const rows = await db
    .update(analyses)
    .set({
      status: "failed",
      errorCode,
      snapshotKey: null,
      finishedAt: sql`now()`,
      progress: null,
      progressAt: null,
    })
    .where(and(eq(analyses.id, id), inArray(analyses.status, ["queued", "running"])))
    .returning({ id: analyses.id });
  return rows.length > 0;
}

/**
 * Fail every analysis that has been `running` for at least `runningForSeconds` (by the
 * database's clock) with {@link INTERRUPTED_CODE}. The worker calls it at startup with
 * longer than any attempt can run (Cloud Run ends a request at 5 minutes), so a row that
 * old belongs to an instance that died, while another instance's live job is left alone.
 * If the queue then runs the job again, {@link startAnalysis} moves the row back to
 * `running`; if the job had used up its attempts, the row stays failed instead of
 * `running` forever.
 */
export async function failInterruptedAnalyses(
  db: AnyDatabase,
  runningForSeconds: number,
): Promise<number> {
  if (!Number.isFinite(runningForSeconds) || runningForSeconds < 0) {
    throw new RangeError("runningForSeconds must be a finite number ≥ 0");
  }
  const cutoff = sql`now() - ${runningForSeconds} * interval '1 second'`;
  const rows = await db
    .update(analyses)
    .set({
      status: "failed",
      errorCode: INTERRUPTED_CODE,
      finishedAt: sql`now()`,
      progress: null,
      progressAt: null,
    })
    .where(and(eq(analyses.status, "running"), lte(analyses.startedAt, cutoff)))
    .returning({ id: analyses.id });
  return rows.length;
}

/**
 * Fail every analysis that has been `queued` for at least `queuedForSeconds` (since it last
 * entered the queue, by the database's clock) with {@link QUEUE_UNAVAILABLE_CODE}. The
 * worker's maintenance passes longer than any task can still be accepted, so such a row is
 * one a website function left without a task (it died between the row and the task), or
 * whose task ran out; until failed it would count in everyone's queue position. If a task
 * for it does arrive, {@link startAnalysis} moves the row to `running` all the same.
 */
export async function failStaleQueuedAnalyses(
  db: AnyDatabase,
  queuedForSeconds: number,
): Promise<number> {
  if (!Number.isFinite(queuedForSeconds) || queuedForSeconds < 0) {
    throw new RangeError("queuedForSeconds must be a finite number ≥ 0");
  }
  const cutoff = sql`now() - ${queuedForSeconds} * interval '1 second'`;
  const rows = await db
    .update(analyses)
    .set({ status: "failed", errorCode: QUEUE_UNAVAILABLE_CODE, finishedAt: sql`now()` })
    .where(and(eq(analyses.status, "queued"), lte(analyses.queuedAt, cutoff)))
    .returning({ id: analyses.id });
  return rows.length;
}

/** How long {@link failStrandedAnalysis} waits before calling a queued row stranded. */
export interface StrandedWait {
  /** Queued (since it last entered the queue) at least this long: every attempt is over. */
  queuedForSeconds: number;
  /** A row `running` for less than this still holds one of the queue's dispatch slots. */
  runningForSeconds: number;
  /** The queue's concurrent dispatches. */
  slots: number;
}

/**
 * Fail one `queued` analysis with {@link QUEUE_UNAVAILABLE_CODE} when no task can still be
 * coming for it (R10, second M5 review), so the next request queues it afresh instead of
 * waiting out {@link failStaleQueuedAnalyses}'s day: it has been queued for
 * `queuedForSeconds` (past every attempt and backoff of a task), and fewer than `slots`
 * rows are `running` younger than `runningForSeconds`, so a free dispatch slot would have
 * pushed a task still waiting in the queue. One statement, so of two racing requests one
 * fails it. Returns whether it did. A task that does arrive late still starts the row
 * ({@link startAnalysis}).
 */
export async function failStrandedAnalysis(
  db: AnyDatabase,
  id: string,
  wait: StrandedWait,
): Promise<boolean> {
  const { queuedForSeconds, runningForSeconds, slots } = wait;
  for (const seconds of [queuedForSeconds, runningForSeconds]) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new RangeError("waits must be finite numbers ≥ 0");
    }
  }
  if (!Number.isSafeInteger(slots) || slots < 1) throw new RangeError("slots must be ≥ 1");
  const queuedBefore = sql`now() - ${queuedForSeconds} * interval '1 second'`;
  const busySince = sql`now() - ${runningForSeconds} * interval '1 second'`;
  const busy = sql`(select count(*) from ${analyses} as busy
    where busy.status = 'running' and busy.started_at > ${busySince})`;
  const rows = await db
    .update(analyses)
    .set({ status: "failed", errorCode: QUEUE_UNAVAILABLE_CODE, finishedAt: sql`now()` })
    .where(
      and(
        eq(analyses.id, id),
        eq(analyses.status, "queued"),
        lte(analyses.queuedAt, queuedBefore),
        sql`${busy} < ${slots}`,
      ),
    )
    .returning({ id: analyses.id });
  return rows.length > 0;
}
