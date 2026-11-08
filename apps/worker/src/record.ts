import {
  completeAnalysis,
  failAnalysis,
  failQueuedJob,
  findAnalysisStatus,
  findDiffJob,
  findDiffJobPosts,
  findDoneSnapshotKey,
  findJob,
  findLinkedRepo,
  findPullRequest,
  isPrivateSnapshot,
  JobGoneError,
  recordDiffJobResult,
  recordJobProgress,
  recordPullRequestCheckRun,
  recordPullRequestComment,
  reopenDiffJob,
  requeueAnalysis,
  startAnalysis,
  startInstallationAnalysis,
  storeDiffSideAnalysis,
  UnknownInstallationError,
  upsertRepo,
  type AnyDatabase,
} from "@gitinside/db";
import { stringifyDiff } from "@gitinside/schema";
import type { DiffRecorder } from "./diffJob.js";
import { JobFailure } from "./failure.js";
import { fetchRepoFacts, type DownloadOptions } from "./github.js";
import type { JobArtifact, JobRecorder, RecordedJob } from "./job.js";
import { recordedProgress, type StoredProgress } from "./progress.js";
import type { JobRequest } from "./request.js";
import {
  privateDiffKey,
  privateSnapshotKey,
  publicSnapshotKey,
  uploadDiff,
  uploadSnapshot,
  type ObjectStore,
} from "./storage.js";

/**
 * Where a job's results go (DESIGN.md §10; ADR-0063): the `repos` and `analyses` rows in
 * Postgres, and the snapshot in object storage.
 *
 * - **start** (before the download): GitHub's `GET /repos/{owner}/{repo}` gives the repo's
 *   ID, current name, visibility, and default branch; the repo is upserted and the analysis
 *   marked `running`. A **private repo on a job without an installation is refused**
 *   (`REPO_NOT_PUBLIC`): the worker's token may be able to read it, but it must never reach
 *   the public cache. A job with an installation links the repo to it (ADR-0227); one whose
 *   installation isn't stored (the website refuses those at enqueue, so it was deleted
 *   meanwhile) fails as the permanent `INSTALLATION_NOT_FOUND`, writing nothing. Such a job
 *   starts only while its queued row exists and its repo is linked to that installation
 *   (`startInstallationAnalysis`, M8.5b): an uninstall or a removed repo since the job was
 *   queued fails it as the permanent `REPO_NOT_INSTALLED` (as the token route words it),
 *   re-creating nothing. A row
 *   that's already `done` stays as it is and the start answers
 *   `"done"`, so the job stops before the download (R9).
 * - **publish = bucket, then Postgres:** the snapshot is uploaded first and the row marked `done`
 *   only after the bucket acknowledged it, so a `done` row always has its object. If the
 *   database write fails, the attempt is retried and the upload repeats under the same
 *   immutable key, which is harmless. If the uninstall flow deleted the row while the job ran
 *   (M8.5b), a private snapshot is deleted at once and the job fails as `REPO_NOT_INSTALLED`.
 * - **failed:** a final failure marks the row `failed` with its code; one that will be
 *   retried marks it `queued`. A final failure before the start wrote the row (a refused
 *   installation token, `REPO_NOT_FOUND`) fails it by job ID if it's still `queued`
 *   (`failQueuedJob`, M8.3c3b).
 * - **A private job's token** (M8.3c3b): when the job passes its installation token to the
 *   start, the facts are read with it instead of the worker's own token.
 * - **progress** (ADR-0139, ADR-0140): the row carries the job ID from the start, and each
 *   progress update the queue stores is written to it too, so the progress page can read
 *   Postgres. The estimate is written as the time left at the write, never as a moment on
 *   this process's clock.
 * - **done** (M5.17c2b): whether the job's row is already `done`, read by job ID before a
 *   push runs (`findJob`); for a `diff-` job, whether the pull request records naming it all
 *   have their Check Run, so it's posted, not only diffed (`findDiffJob`, ADR-0245, M8.6e2b).
 */

/** Options for {@link createAnalysisRecorder}. */
export interface RecorderOptions {
  db: AnyDatabase;
  store: ObjectStore;
  /** Part of every analysis row and snapshot key. */
  analyzerVersion: string;
  /** How to reach GitHub's API; the same settings as the job's download. */
  github?: Omit<DownloadOptions, "signal">;
  /** The clock progress's `since` was read from (the queue's processor's). Default `Date.now`. */
  now?: () => number;
}

/** A {@link JobRecorder} plus the job's `publish` step. */
export interface AnalysisRecorder extends JobRecorder {
  publish(artifact: JobArtifact): Promise<void>;
}

/** The recorder and publisher a worker passes as `JobDeps.recorder` and `JobDeps.publish`. */
export function createAnalysisRecorder(options: RecorderOptions): AnalysisRecorder {
  const { db, store, analyzerVersion } = options;

  async function start(
    request: JobRequest,
    signal: AbortSignal,
    jobId: string,
    token?: string,
  ): Promise<RecordedJob | "done"> {
    const facts = await fetchRepoFacts(
      { owner: request.owner, repo: request.repo },
      { ...options.github, ...(token === undefined ? {} : { token }), signal },
    );
    if (facts.private && request.installationId === undefined) {
      throw new JobFailure("REPO_NOT_PUBLIC", "a public job for a private repo");
    }
    const visibility = facts.private ? "private" : "public";
    const { installationId, sha } = request;
    const repo = {
      providerRepoId: facts.id,
      owner: facts.owner,
      name: facts.name,
      visibility,
      defaultBranch: facts.defaultBranch,
    } as const;
    try {
      let repoId: string;
      let started: { id: string; status: "running" | "done" };
      if (installationId === undefined) {
        ({ id: repoId } = await upsertRepo(db, repo));
        started = await startAnalysis(db, { repoId, sha, analyzerVersion }, { jobId });
      } else {
        ({ repoId, ...started } = await startInstallationAnalysis(
          db,
          { ...repo, githubInstallationId: installationId },
          { sha, analyzerVersion, jobId },
        ));
      }
      if (started.status === "done") return "done";
      return { analysisId: started.id, repoId, visibility, owner: facts.owner, name: facts.name };
    } catch (error) {
      if (error instanceof UnknownInstallationError) {
        throw new JobFailure("INSTALLATION_NOT_FOUND", "the job's installation isn't stored");
      }
      if (error instanceof JobGoneError) {
        throw new JobFailure("REPO_NOT_INSTALLED", "the job's row or its repo's link was deleted");
      }
      throw new JobFailure("RECORD_FAILED", "writing the job's start failed", { cause: error });
    }
  }

  function snapshotKey(record: RecordedJob, request: JobRequest): string {
    const { sha } = request;
    if (record.visibility === "public") {
      return publicSnapshotKey({ owner: record.owner, repo: record.name, sha, analyzerVersion });
    }
    if (request.installationId === undefined)
      throw new Error("a private job needs its installation");
    return privateSnapshotKey({
      installationId: request.installationId,
      repoId: record.repoId,
      sha,
      analyzerVersion,
    });
  }

  async function publish(artifact: JobArtifact): Promise<void> {
    const { record, request, stats, timings } = artifact;
    if (record === undefined) throw new Error("the job was not recorded");
    const key = snapshotKey(record, request);
    const uploadStart = performance.now();
    const stored = await uploadSnapshot(store, artifact.graphPath, key, record.visibility);
    const upload = Math.round(performance.now() - uploadStart);
    const completed = await completeAnalysis(db, record.analysisId, {
      snapshotKey: key,
      stats: {
        files: stats.files,
        nodes: stats.nodes,
        edges: stats.edges,
        unresolved: stats.unresolved,
        warnings: stats.warnings,
        graphBytes: stored.bytes,
        snapshotBytes: stored.storedBytes,
        stageMs: stats.stageMs,
        jobMs: { download: timings.downloadMs, analyze: timings.analyzeMs, upload },
        ...(stats.peakRssBytes === undefined ? {} : { peakRssBytes: stats.peakRssBytes }),
        ...(stats.heapBytes === undefined ? {} : { heapBytes: stats.heapBytes }),
        ...(stats.gcMs === undefined ? {} : { gcMs: stats.gcMs }),
      },
    });
    if (completed || (await findAnalysisStatus(db, record.analysisId)) !== undefined) return;
    // The uninstall flow deleted the row while the job ran (M8.5b): nothing will ever name a
    // private key again (it holds the deleted repo row's ID), so its object goes now rather
    // than at retention's orphan sweep. A public key could be named again by the repo's next
    // job, so it's left to the sweep, which checks.
    let detail = "the job's row was deleted while it ran";
    if (isPrivateSnapshot(key)) {
      await store.delete(key).catch(() => {
        detail += "; deleting its snapshot failed (left to retention)";
      });
    }
    throw new JobFailure("REPO_NOT_INSTALLED", detail);
  }

  async function failed(record: RecordedJob, code: string, final: boolean): Promise<void> {
    if (final) await failAnalysis(db, record.analysisId, code);
    else await requeueAnalysis(db, record.analysisId);
  }

  async function failedBeforeStart(jobId: string, code: string): Promise<void> {
    await failQueuedJob(db, jobId, code);
  }

  async function progress(jobId: string, current: StoredProgress): Promise<void> {
    // The estimate's `since` is this process's clock, so the time left is taken here, on it;
    // the database stamps the write with its own clock for readers (ADR-0140).
    await recordJobProgress(db, jobId, recordedProgress(current, (options.now ?? Date.now)()));
  }

  async function done(jobId: string): Promise<boolean> {
    // A diff job is done once every pull request record naming it is posted (M8.6e2b).
    if (jobId.startsWith("diff-")) return (await findDiffJob(db, jobId))?.status === "done";
    return (await findJob(db, jobId))?.status === "done";
  }

  return { start, publish, failed, failedBeforeStart, progress, done };
}

/**
 * Whether a diff job through installation `side.installationId` may read the snapshot under
 * `key` for repo row `side.repoId` (M8.6d3c2): a public one (served to anyone), or a private one
 * under that installation's folder for that repo. A private snapshot another installation stored
 * (the repo moved between installations) is never read: that side is analyzed instead.
 */
export function readableBy(key: string, side: { installationId: number; repoId: string }): boolean {
  if (key.startsWith("public/")) return true;
  return key.startsWith(`private/${String(side.installationId)}/${side.repoId}/`);
}

/**
 * Where a diff job's results go (ADR-0245): its records are found by job ID (`findDiffJob`),
 * and `publish` uploads the diff (`stringifyDiff`, gzipped, `private, no-store`) under
 * `privateDiffKey` (merge base and head) before recording it on every record naming the job
 * (`recordDiffJobResult`), so a recorded key always has its object. An upload no record names
 * afterwards (each moved on meanwhile) is left to retention's orphan sweep: another job whose
 * pair has the same merge base and head can name the same key, and only the sweep checks.
 * `storedGraph` reads a side's `done` analysis by this analyzer version
 * (`findDoneSnapshotKey`) when {@link readableBy} allows its key (M8.6d3c2). `storeSide`
 * (M8.6d4) keys a side the job analyzed as an analysis job would (public repo ⇒ the public key,
 * else this installation's private one), uploads it, then writes its `done` row through
 * `storeDiffSideAnalysis` (no row, or a `failed` one, and the repo still linked). Its stats
 * have no `jobMs`: the job's download and upload covered both sides and the diff. An upload
 * whose row isn't written (another job holds it, or the repo was unlinked meanwhile) is left
 * to retention's orphan sweep, which checks every row first: a `done` row may name the same
 * key. Posting (M8.6e2b) reads the records left to post to (`findDiffJobPosts`), each record
 * again just before its post (`findPullRequest`), a `diffed` retry's stored diff by the key
 * the records name, and stores the comment and Check Run IDs; `reopen` clears the unposted
 * records' diff (`reopenDiffJob`) when a retry can't read what it was made from.
 */
export function createDiffRecorder(
  options: Pick<RecorderOptions, "db" | "store" | "analyzerVersion">,
): DiffRecorder {
  const { db, store, analyzerVersion } = options;
  return {
    find: (jobId) => findDiffJob(db, jobId),
    async storedGraph(side) {
      const key = await findDoneSnapshotKey(db, {
        repoId: side.repoId,
        sha: side.sha,
        analyzerVersion,
      });
      if (key === undefined || !readableBy(key, side)) return undefined;
      const object = await store.get(key);
      // Retention deleted it since the row was read (or the row outlived it): analyze instead.
      if (object === undefined) return undefined;
      return new Response(object.body).text();
    },
    async storeSide(side) {
      const { installationId, repoId, sha } = side;
      const repo = await findLinkedRepo(db, { githubInstallationId: installationId, repoId });
      if (repo === undefined) return false;
      // The key an analysis job through this installation would use (`snapshotKey` above).
      const key =
        repo.visibility === "public"
          ? publicSnapshotKey({ owner: repo.owner, repo: repo.name, sha, analyzerVersion })
          : privateSnapshotKey({ installationId, repoId, sha, analyzerVersion });
      const uploaded = await uploadSnapshot(store, side.graphPath, key, repo.visibility);
      const { stats } = side;
      return storeDiffSideAnalysis(db, {
        githubInstallationId: installationId,
        repoId,
        sha,
        analyzerVersion,
        snapshotKey: key,
        stats: {
          files: stats.files,
          nodes: stats.nodes,
          edges: stats.edges,
          unresolved: stats.unresolved,
          warnings: stats.warnings,
          graphBytes: uploaded.bytes,
          snapshotBytes: uploaded.storedBytes,
          stageMs: stats.stageMs,
          ...(stats.peakRssBytes === undefined ? {} : { peakRssBytes: stats.peakRssBytes }),
          ...(stats.heapBytes === undefined ? {} : { heapBytes: stats.heapBytes }),
          ...(stats.gcMs === undefined ? {} : { gcMs: stats.gcMs }),
        },
      });
    },
    async publish(stored) {
      const key = privateDiffKey({
        installationId: stored.installationId,
        repoId: stored.repoId,
        baseSha: stored.mergeBase,
        headSha: stored.headSha,
        analyzerVersion,
      });
      await uploadDiff(store, stringifyDiff(stored.diff), key);
      return recordDiffJobResult(db, {
        jobId: stored.jobId,
        diffKey: key,
        brokenCount: stored.diff.broken.length,
      });
    },
    posts: (jobId) => findDiffJobPosts(db, jobId),
    async current({ repoId, number }) {
      const row = await findPullRequest(db, repoId, number);
      if (row === undefined) return undefined;
      const { diffJobId, baseSha, headSha, commentId, checkRunId } = row;
      return { diffJobId, baseSha, headSha, commentId, checkRunId };
    },
    async storedDiff(key) {
      const object = await store.get(key);
      return object === undefined ? undefined : new Response(object.body).text();
    },
    reopen: (jobId) => reopenDiffJob(db, jobId),
    recordComment: (ref) => recordPullRequestComment(db, ref),
    recordCheckRun: (ref) => recordPullRequestCheckRun(db, ref),
  };
}
