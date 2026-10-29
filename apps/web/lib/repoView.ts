import {
  consumeRateLimit,
  findAnalysis,
  findPublishedAnalysis,
  queueAnalysis,
  refundRateLimit,
  upsertRepo,
  type AnyDatabase,
  type PublishedAnalysis,
} from "@gitinside/db";
import { resolveRepo, type GitHubOptions, type ResolveResult } from "./github";
import type { RepoRef } from "./repoUrl";
import { WorkerUnavailableError, type WorkerClient } from "./worker";

/**
 * What a repo page shows, with check-on-view re-analysis (SPEC §3 "Viewing re-analyzes
 * automatically if the default branch has a new commit", ADR-0068):
 *
 * 1. **Find** the newest finished analysis of the public repo (of the commit, on a
 *    `/<owner>/<repo>/<sha>` permalink). None: the repo page offers "Analyze", which goes
 *    through `/api/analyze` and the visitor's rate limit; a permalink is a 404.
 * 2. **Permalinks stop there:** a commit's diagram never changes, so no GitHub call.
 * 3. **Check** the default branch's latest commit on GitHub, remembered per repo for
 *    {@link HEAD_TTL_MS} so busy pages don't spend GitHub's hourly quota. If GitHub can't
 *    be asked, the diagram is still shown (`unknown`). If GitHub says the repo is gone or
 *    private now, it's a 404: a repo that went private must stop being served publicly.
 * 4. **Up to date** when the shown analysis is that commit by this analyzer version.
 *    Otherwise the newer commit's own state decides: finished ⇒ shown instead; in flight
 *    ⇒ `updating`; failed ⇒ `behind` (a deterministic failure isn't re-run on every view;
 *    "Analyze" retries it); none ⇒ enqueued.
 * 5. **Who pays:** re-analysis on view is charged to the repo, not the visitor
 *    (`repo:<GitHub ID>`, {@link RECHECKS_PER_HOUR} per hour), since a README image or a
 *    shared link is viewed by many people at once, and only a repo someone already paid to
 *    analyze is ever re-analyzed this way. The slot is refunded when no new job was made.
 */

/** How long a repo's latest commit, as GitHub last said, is trusted. */
export const HEAD_TTL_MS = 60_000;
/** New commits check-on-view may analyze per repo per hour. */
export const RECHECKS_PER_HOUR = 6;

/** Recent GitHub answers by repo, so repeated views cost one lookup a minute. */
export interface HeadCache {
  get(key: string): ResolveResult | undefined;
  set(key: string, value: ResolveResult): void;
}

/** A {@link HeadCache} in this process's memory; successful answers only, oldest dropped first. */
export function createHeadCache(
  options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): HeadCache {
  const { ttlMs = HEAD_TTL_MS, maxEntries = 1_000, now = Date.now } = options;
  const entries = new Map<string, { value: ResolveResult; expires: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.expires > now()) return entry.value;
      entries.delete(key);
      return undefined;
    },
    set(key, value) {
      if (!value.ok) return;
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
    },
  };
}

/** Everything {@link viewRepo} talks to. */
export interface RepoViewDeps {
  db: AnyDatabase;
  /** Without a worker (not configured), newer commits are reported but not analyzed. */
  worker: Pick<WorkerClient, "enqueue"> | undefined;
  github: GitHubOptions;
  /** `@gitinside/analyzer/version`. */
  analyzerVersion: string;
  heads: HeadCache;
  /** Default {@link RECHECKS_PER_HOUR}. */
  rechecksPerHour?: number;
}

/** How the shown diagram relates to the default branch's latest commit. */
export type HeadState =
  /** A permalink: the commit in the URL, never checked. */
  | { state: "pinned" }
  /** The latest commit, by this analyzer version. */
  | { state: "current" }
  /** A newer analysis is queued or running; `jobId` opens its progress page when known. */
  | { state: "updating"; sha: string; jobId?: string }
  /** Newer than what's shown, but not being analyzed now. */
  | { state: "behind"; sha: string; reason: "failed" | "limited" | "unavailable" }
  /** GitHub couldn't be asked. */
  | { state: "unknown" };

/** What a repo page renders. Owner and repo are our stored spelling (GitHub's). */
export type RepoView =
  | { status: "missing" }
  | { status: "not-analyzed"; owner: string; repo: string }
  | {
      status: "ready";
      owner: string;
      repo: string;
      sha: string;
      analyzerVersion: string;
      /** Where the browser fetches the graph (`/api/graph/…`). */
      graphUrl: string;
      head: HeadState;
    };

/** `/api/graph/<owner>/<repo>/<sha>`. */
export function graphPath(owner: string, repo: string, sha: string): string {
  return `/api/graph/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sha}`;
}

function ready(published: PublishedAnalysis, head: HeadState): RepoView {
  const { owner, name } = published.repo;
  const { sha, analyzerVersion } = published.analysis;
  return {
    status: "ready",
    owner,
    repo: name,
    sha,
    analyzerVersion,
    graphUrl: graphPath(owner, name, sha),
    head,
  };
}

async function latestCommit(ref: RepoRef, deps: RepoViewDeps): Promise<ResolveResult> {
  const key = `${ref.owner}/${ref.repo}`.toLowerCase();
  const cached = deps.heads.get(key);
  if (cached !== undefined) return cached;
  const resolved = await resolveRepo(ref, deps.github);
  deps.heads.set(key, resolved);
  return resolved;
}

/** Decide what `/<owner>/<repo>` (or `/<owner>/<repo>/<sha>` with `sha`) shows. */
export async function viewRepo(
  ref: RepoRef & { sha?: string },
  deps: RepoViewDeps,
): Promise<RepoView> {
  const { db } = deps;
  const published = await findPublishedAnalysis(db, {
    owner: ref.owner,
    name: ref.repo,
    ...(ref.sha === undefined ? {} : { sha: ref.sha }),
  });
  if (ref.sha !== undefined) {
    return published ? ready(published, { state: "pinned" }) : { status: "missing" };
  }
  if (published === undefined) return { status: "not-analyzed", owner: ref.owner, repo: ref.repo };

  const resolved = await latestCommit(ref, deps);
  if (!resolved.ok) {
    if (resolved.code === "REPO_NOT_FOUND" || resolved.code === "REPO_UNAVAILABLE") {
      return { status: "missing" };
    }
    return ready(published, { state: "unknown" });
  }
  const head = resolved.repo;
  // The name now belongs to a different repo (the old one was renamed or deleted).
  if (head.providerRepoId !== published.repo.providerRepoId) {
    return { status: "not-analyzed", owner: head.owner, repo: head.name };
  }
  const { analysis } = published;
  if (analysis.sha === head.sha && analysis.analyzerVersion === deps.analyzerVersion) {
    return ready(published, { state: "current" });
  }

  const existing = await findAnalysis(db, {
    providerRepoId: head.providerRepoId,
    sha: head.sha,
    analyzerVersion: deps.analyzerVersion,
  });
  if (existing?.status === "done") {
    const latest = await findPublishedAnalysis(db, {
      owner: published.repo.owner,
      name: published.repo.name,
      sha: head.sha,
    });
    if (latest !== undefined) return ready(latest, { state: "current" });
  }
  if (existing?.status === "failed") {
    return ready(published, { state: "behind", sha: head.sha, reason: "failed" });
  }
  const inFlight = existing?.status === "queued" || existing?.status === "running";
  const updating: HeadState = { state: "updating", sha: head.sha };
  const unavailable: HeadState = { state: "behind", sha: head.sha, reason: "unavailable" };
  if (deps.worker === undefined) return ready(published, inFlight ? updating : unavailable);

  const key = `repo:${head.providerRepoId}`;
  let charged: Date | undefined;
  if (!inFlight) {
    const limit = await consumeRateLimit(db, key, deps.rechecksPerHour ?? RECHECKS_PER_HOUR);
    if (!limit.allowed) {
      return ready(published, { state: "behind", sha: head.sha, reason: "limited" });
    }
    charged = limit.windowStart;
  }
  let job: { id: string; created: boolean };
  try {
    job = await deps.worker.enqueue({ owner: head.owner, repo: head.name, sha: head.sha });
  } catch (error) {
    if (!(error instanceof WorkerUnavailableError)) throw error;
    if (charged) await refundRateLimit(db, key, charged);
    return ready(published, inFlight ? updating : unavailable);
  }
  if (job.created) {
    const { id: repoId } = await upsertRepo(db, head);
    await queueAnalysis(db, { repoId, sha: head.sha, analyzerVersion: deps.analyzerVersion });
  } else if (charged) {
    await refundRateLimit(db, key, charged);
  }
  return ready(published, { state: "updating", sha: head.sha, jobId: job.id });
}
