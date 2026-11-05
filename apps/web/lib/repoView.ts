import {
  consumeRateLimit,
  findComputePause,
  findPublishedAnalysis,
  hideRepo,
  refundRateLimit,
  type AnyDatabase,
  type PublishedAnalysis,
} from "@gitinside/db";
import { findTooMuchCode, type CodeSizeCache } from "./codeSize";
import { COMMIT_SHA, type BaseView, type SearchParams } from "./compare";
import {
  QUEUE_UNAVAILABLE,
  enqueueAnalysis,
  findAnalysisToQueue,
  type EnqueueDeps,
} from "./enqueue";
import { resolveRepo, type GitHubOptions, type ResolvedRepo, type ResolveResult } from "./github";
import type { RepoRef } from "./repoUrl";
import { findSizeHold } from "./sizeHold";

/**
 * What a repo page shows, with check-on-view re-analysis (SPEC §3 "Viewing re-analyzes
 * automatically if the default branch has a new commit", ADR-0068):
 *
 * 1. **Find** the newest finished analysis of the public repo (of the commit, on a
 *    `/<owner>/<repo>/<sha>` permalink). None: GitHub is asked whether the repo has another
 *    name now (`findRenamed`, M5.13b3) and the page follows it; else the repo page offers
 *    "Analyze", which goes through `/api/analyze` and the visitor's rate limit; a permalink
 *    is a 404.
 * 2. **Permalinks stop there:** a commit's diagram never changes, so no GitHub call.
 * 3. **Check** the default branch's latest commit on GitHub, remembered per repo and shown
 *    analysis for {@link HEAD_TTL_MS} so busy pages don't spend GitHub's hourly quota. If
 *    GitHub can't be asked, the diagram is still shown (`unknown`). If GitHub says it's gone or
 *    private now, it's a 404, and the repo is hidden (`hideRepo`) so its permalinks, graphs,
 *    and images stop too: a repo that went private must stop being served publicly.
 * 4. **Up to date** when the shown analysis is that commit by this analyzer version.
 *    Otherwise the newer commit's own state decides: finished ⇒ shown instead; in flight
 *    ⇒ `updating`; failed ⇒ `behind` with its code (a failure isn't re-run on every view;
 *    "Analyze again" retries one that could pass); the repo held after a `LIMIT_*` failure
 *    (`findSizeHold`, #11) ⇒ `behind`, `too-big`; over twice the supported size of TypeScript
 *    and JavaScript by GitHub's count (`findTooMuchCode`, ADR-0154) ⇒ `behind`,
 *    `too-much-code`; new analyses paused for the month's compute (`findComputePause`,
 *    ADR-0156) ⇒ `behind`, `paused`; none, a row whose task was never created
 *    (`QUEUE_UNAVAILABLE`), or one `queued` with no task coming any more
 *    (`findAnalysisToQueue`, R10) ⇒ enqueued on Cloud Tasks (`enqueueAnalysis`).
 * 5. **Who pays:** re-analysis on view is charged to the repo, not the visitor
 *    (`repo:<GitHub ID>`, {@link RECHECKS_PER_HOUR} per hour), since a README image or a
 *    shared link is viewed by many people at once, and only a repo someone already paid to
 *    analyze is ever re-analyzed this way. The slot is refunded when no new job was made.
 */

/** How long a repo's latest commit, as GitHub last said, is trusted. */
export const HEAD_TTL_MS = 60_000;
/** New commits check-on-view may analyze per repo per hour. */
export const RECHECKS_PER_HOUR = 6;
/**
 * Names with no analysis that may be looked up on GitHub per hour, site-wide (a rename,
 * M5.13b3): about a tenth of a token's 5,000, so made-up URLs can't spend the quota that
 * `/api/analyze` and check-on-view need. Past it, such a page offers "Analyze" unchecked.
 */
export const UNKNOWN_LOOKUPS_PER_HOUR = 500;
/** {@link UNKNOWN_LOOKUPS_PER_HOUR}'s `rate_limits` key (never `ip:` or `repo:`). */
export const UNKNOWN_LOOKUPS_KEY = "site:unknown-repo";

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
  /** Without a queue (not configured), newer commits are reported but not analyzed. */
  queue: EnqueueDeps["queue"] | undefined;
  github: GitHubOptions;
  /** `@gitinside/analyzer/version`. */
  analyzerVersion: string;
  heads: HeadCache;
  /** GitHub's code counts by commit (`findTooMuchCode`); without it, asked every time. */
  codeSizes?: CodeSizeCache;
  /** Default {@link RECHECKS_PER_HOUR}. */
  rechecksPerHour?: number;
  /** Default {@link UNKNOWN_LOOKUPS_PER_HOUR}. */
  unknownLookupsPerHour?: number;
}

/** How the shown diagram relates to the default branch's latest commit. */
export type HeadState =
  /** A permalink: the commit in the URL, never checked. */
  | { state: "pinned" }
  /** The latest commit, by this analyzer version. */
  | { state: "current" }
  /** A newer analysis is queued or running; `jobId` opens its progress page when known. */
  | { state: "updating"; sha: string; jobId?: string }
  /** Newer than what's shown, but its analysis failed with `errorCode`. */
  | { state: "behind"; sha: string; reason: "failed"; errorCode: string }
  /** Newer than what's shown, but not being analyzed now. */
  | { state: "behind"; sha: string; reason: "limited" | "unavailable" }
  /**
   * Newer than what's shown, but an analysis of the repo hit `errorCode` (`LIMIT_*`) in the
   * past week, so new ones wait until `until` (ISO 8601) unless it shrinks (#11).
   */
  | { state: "behind"; sha: string; reason: "too-big"; errorCode: string; until: string }
  /**
   * Newer than what's shown, but GitHub counts `codeBytes` of TypeScript and JavaScript in
   * the repo, over twice the supported size, so it isn't analyzed (ADR-0154).
   */
  | { state: "behind"; sha: string; reason: "too-much-code"; codeBytes: number }
  /**
   * Newer than what's shown, but new analyses are paused until `until` (ISO 8601, the next
   * UTC month): the month's compute reached 80% of Google's free allowance (ADR-0156).
   */
  | { state: "behind"; sha: string; reason: "paused"; until: string }
  /** GitHub couldn't be asked. */
  | { state: "unknown" };

/** What a repo page renders. Owner and repo are our stored spelling (GitHub's). */
export type RepoView =
  | { status: "missing" }
  | { status: "not-analyzed"; owner: string; repo: string }
  /** GitHub knows the repo under another name now (a rename or transfer): open that one. */
  | { status: "moved"; owner: string; repo: string }
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

/**
 * GitHub's answer for `ref`, remembered per repo **and per shown analysis**: once a newer
 * analysis is published (a job finished, often started by `/api/analyze`, which asked GitHub
 * itself), an answer remembered before it may name an older commit, and would show that
 * older commit's diagram as "up to date" (M5 review). Keying on the shown analysis makes
 * that answer a miss, so a publish costs one more lookup, never a wrong label.
 */
async function latestCommit(
  ref: RepoRef,
  shown: PublishedAnalysis["analysis"],
  deps: RepoViewDeps,
): Promise<ResolveResult> {
  const repo = `${ref.owner}/${ref.repo}`.toLowerCase();
  const key = `${repo}@${shown.sha}/${shown.analyzerVersion}`;
  const cached = deps.heads.get(key);
  if (cached !== undefined) return cached;
  const resolved = await resolveRepo(ref, deps.github);
  deps.heads.set(key, resolved);
  return resolved;
}

/**
 * Where a `moved` repo page goes: `/<owner>/<repo>` in GitHub's new spelling, with the page's
 * query as it came (each value of a repeated key, in order), so a deep link survives.
 */
export function movedPath(
  moved: { owner: string; repo: string },
  query: SearchParams = {},
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      if (one !== undefined) search.append(key, one);
    }
  }
  const path = `/${encodeURIComponent(moved.owner)}/${encodeURIComponent(moved.repo)}`;
  return search.size === 0 ? path : `${path}?${search.toString()}`;
}

/**
 * What a link's `?base=<sha>` compares the shown diagram with (diff mode, M6.9e2): that
 * commit's published analysis of the same repo (looked up by the stored spelling, like a
 * permalink: never checked against GitHub, nothing enqueued). `base` is the raw value.
 */
export async function viewBase(
  shown: { owner: string; repo: string },
  base: string,
  db: AnyDatabase,
): Promise<BaseView> {
  if (!COMMIT_SHA.test(base)) return { status: "invalid" };
  const published = await findPublishedAnalysis(db, {
    owner: shown.owner,
    name: shown.repo,
    sha: base,
  });
  if (published === undefined) return { status: "missing", sha: base };
  const { owner, name } = published.repo;
  return { status: "ready", sha: base, graphUrl: graphPath(owner, name, base) };
}

/** Whether GitHub's names are the URL's, ignoring case (GitHub's own rule). */
function sameName(head: ResolvedRepo, ref: RepoRef): boolean {
  return (
    head.owner.toLowerCase() === ref.owner.toLowerCase() &&
    head.name.toLowerCase() === ref.repo.toLowerCase()
  );
}

/**
 * A name with no published analysis (M5.13b3). GitHub answers a renamed or transferred
 * repo's old name with the repo itself (`resolveRepo` follows the redirect), so ask it:
 * - another name ⇒ `moved` there, so old links and README images keep working;
 * - the same name ⇒ the repo by GitHub's ID, if it was analyzed under an older name (else
 *   `not-analyzed` in GitHub's spelling);
 * - GitHub can't say (not found, unavailable), or {@link UNKNOWN_LOOKUPS_PER_HOUR} is used
 *   up ⇒ `not-analyzed` as written, as before: "Analyze" asks GitHub again anyway.
 *
 * Answers are remembered like check-on-view's, so a busy old link asks once a minute.
 */
async function findRenamed(
  ref: RepoRef,
  deps: RepoViewDeps,
): Promise<RepoView | { published: PublishedAnalysis; resolved: ResolveResult }> {
  const { db } = deps;
  const notAnalyzed: RepoView = { status: "not-analyzed", owner: ref.owner, repo: ref.repo };
  const key = `${ref.owner}/${ref.repo}@unknown`.toLowerCase();
  let resolved = deps.heads.get(key);
  if (resolved === undefined) {
    const limit = deps.unknownLookupsPerHour ?? UNKNOWN_LOOKUPS_PER_HOUR;
    if (!(await consumeRateLimit(db, UNKNOWN_LOOKUPS_KEY, limit)).allowed) return notAnalyzed;
    resolved = await resolveRepo(ref, deps.github);
    deps.heads.set(key, resolved);
  }
  if (!resolved.ok) return notAnalyzed;
  const head = resolved.repo;
  if (!sameName(head, ref)) return { status: "moved", owner: head.owner, repo: head.name };
  const published = await findPublishedAnalysis(db, { providerRepoId: head.providerRepoId });
  if (published === undefined)
    return { status: "not-analyzed", owner: head.owner, repo: head.name };
  return { published, resolved };
}

/** Decide what `/<owner>/<repo>` (or `/<owner>/<repo>/<sha>` with `sha`) shows. */
export async function viewRepo(
  ref: RepoRef & { sha?: string },
  deps: RepoViewDeps,
): Promise<RepoView> {
  const { db } = deps;
  let published = await findPublishedAnalysis(db, {
    owner: ref.owner,
    name: ref.repo,
    ...(ref.sha === undefined ? {} : { sha: ref.sha }),
  });
  if (ref.sha !== undefined) {
    return published ? ready(published, { state: "pinned" }) : { status: "missing" };
  }
  let resolved: ResolveResult;
  if (published === undefined) {
    const found = await findRenamed(ref, deps);
    if ("status" in found) return found;
    ({ published, resolved } = found);
  } else {
    resolved = await latestCommit(ref, published.analysis, deps);
  }
  if (!resolved.ok) {
    if (resolved.code === "REPO_NOT_FOUND" || resolved.code === "REPO_UNAVAILABLE") {
      // Recorded, so its permalinks and graphs (which never ask GitHub) stop too.
      await hideRepo(db, published.repo.id);
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

  const existing = await findAnalysisToQueue(db, {
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
  // A job that never got its task failed no analysis: try again, as if it had no row.
  if (existing?.status === "failed" && existing.errorCode !== QUEUE_UNAVAILABLE) {
    // `failed` rows always carry a code (schema.ts); the fallback is the worker's own.
    const errorCode = existing.errorCode ?? "WORKER_ERROR";
    return ready(published, { state: "behind", sha: head.sha, reason: "failed", errorCode });
  }
  const inFlight = existing?.status === "queued" || existing?.status === "running";
  const updating: HeadState = { state: "updating", sha: head.sha };
  const unavailable: HeadState = { state: "behind", sha: head.sha, reason: "unavailable" };
  if (deps.queue === undefined) return ready(published, inFlight ? updating : unavailable);
  if (!inFlight) {
    const hold = await findSizeHold(db, head);
    if (hold !== undefined) {
      const { errorCode, until } = hold;
      return ready(published, {
        state: "behind",
        sha: head.sha,
        reason: "too-big",
        errorCode,
        until: until.toISOString(),
      });
    }
    const codeBytes = await findTooMuchCode(head, deps.github, deps.codeSizes);
    if (codeBytes !== undefined) {
      return ready(published, {
        state: "behind",
        sha: head.sha,
        reason: "too-much-code",
        codeBytes,
      });
    }
    const pause = await findComputePause(db);
    if (pause !== undefined) {
      return ready(published, {
        state: "behind",
        sha: head.sha,
        reason: "paused",
        until: pause.until.toISOString(),
      });
    }
  }

  const key = `repo:${head.providerRepoId}`;
  let charged: Date | undefined;
  if (!inFlight) {
    const limit = await consumeRateLimit(db, key, deps.rechecksPerHour ?? RECHECKS_PER_HOUR);
    if (!limit.allowed) {
      return ready(published, { state: "behind", sha: head.sha, reason: "limited" });
    }
    charged = limit.windowStart;
  }
  const queued = await enqueueAnalysis(head, {
    db,
    queue: deps.queue,
    analyzerVersion: deps.analyzerVersion,
  });
  const isNew = queued.status === "queued" && queued.entered;
  if (charged && !isNew) await refundRateLimit(db, key, charged);
  switch (queued.status) {
    case "done": {
      // Finished since the lookup above (a racing job).
      const latest = await findPublishedAnalysis(db, {
        owner: published.repo.owner,
        name: published.repo.name,
        sha: head.sha,
      });
      return latest === undefined
        ? ready(published, updating)
        : ready(latest, { state: "current" });
    }
    case "unavailable":
      return ready(published, unavailable);
    default:
      return ready(published, { state: "updating", sha: head.sha, jobId: queued.jobId });
  }
}
