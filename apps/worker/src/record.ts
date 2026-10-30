import {
  completeAnalysis,
  failAnalysis,
  requeueAnalysis,
  startAnalysis,
  upsertRepo,
  type AnyDatabase,
} from "@gitinside/db";
import type { JobRequest } from "./api.js";
import { JobFailure } from "./failure.js";
import { fetchRepoFacts, type DownloadOptions } from "./github.js";
import type { JobArtifact, JobRecorder, RecordedJob } from "./job.js";
import {
  privateSnapshotKey,
  publicSnapshotKey,
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
 *   the public cache.
 * - **publish = bucket, then Postgres:** the snapshot is uploaded first and the row marked `done`
 *   only after the bucket acknowledged it, so a `done` row always has its object. If the
 *   database write fails, the attempt is retried and the upload repeats under the same
 *   immutable key, which is harmless.
 * - **failed:** a final failure marks the row `failed` with its code; one that will be
 *   retried marks it `queued`.
 */

/** Options for {@link createAnalysisRecorder}. */
export interface RecorderOptions {
  db: AnyDatabase;
  store: ObjectStore;
  /** Part of every analysis row and snapshot key. */
  analyzerVersion: string;
  /** How to reach GitHub's API; the same settings as the job's download. */
  github?: Omit<DownloadOptions, "signal">;
}

/** A {@link JobRecorder} plus the job's `publish` step. */
export interface AnalysisRecorder extends JobRecorder {
  publish(artifact: JobArtifact): Promise<void>;
}

/** The recorder and publisher a worker passes as `JobDeps.recorder` and `JobDeps.publish`. */
export function createAnalysisRecorder(options: RecorderOptions): AnalysisRecorder {
  const { db, store, analyzerVersion } = options;

  async function start(request: JobRequest, signal: AbortSignal): Promise<RecordedJob> {
    const facts = await fetchRepoFacts(
      { owner: request.owner, repo: request.repo },
      { ...options.github, signal },
    );
    if (facts.private && request.installationId === undefined) {
      throw new JobFailure("REPO_NOT_PUBLIC", "a public job for a private repo");
    }
    const visibility = facts.private ? "private" : "public";
    try {
      const { id: repoId } = await upsertRepo(db, {
        providerRepoId: facts.id,
        owner: facts.owner,
        name: facts.name,
        visibility,
        defaultBranch: facts.defaultBranch,
      });
      const { id: analysisId } = await startAnalysis(db, {
        repoId,
        sha: request.sha,
        analyzerVersion,
      });
      return { analysisId, repoId, visibility, owner: facts.owner, name: facts.name };
    } catch (error) {
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
    await completeAnalysis(db, record.analysisId, {
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
      },
    });
  }

  async function failed(record: RecordedJob, code: string, final: boolean): Promise<void> {
    if (final) await failAnalysis(db, record.analysisId, code);
    else await requeueAnalysis(db, record.analysisId);
  }

  return { start, publish, failed };
}
