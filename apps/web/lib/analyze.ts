import {
  consumeRateLimit,
  findAnalysis,
  queueAnalysis,
  refundRateLimit,
  upsertRepo,
  type AnyDatabase,
} from "@gitinside/db";
import { rateLimitKey } from "./clientIp";
import { resolveRepo, type GitHubOptions, type ResolveFailure } from "./github";
import { parseRepoUrl } from "./repoUrl";
import { WorkerUnavailableError, type WorkerClient } from "./worker";

/**
 * What `POST /api/analyze` does once the body is read (docs/DESIGN.md §11, ADR-0066):
 *
 * 1. **Parse** the pasted URL with GitHub's name rules (`parseRepoUrl`).
 * 2. **Resolve** the repo and its default branch's latest commit on GitHub (public only).
 * 3. **Cache:** a `done` analysis of that commit by this analyzer version is returned as is.
 *    Viewing and re-asking are never rate-limited.
 * 4. **Dedupe:** a commit already `queued` or `running` gets the same job back (the job ID
 *    is derived from the commit), again without counting against the limit.
 * 5. **Rate limit** anything else: a new analysis counts against the caller's hourly
 *    window (5 signed out). The slot is given back if the queue turns out to be down or
 *    the job already existed (someone else's request covered the commit first).
 * 6. **Enqueue** through the signed worker API; when this request created the job, record
 *    the repo and a `queued` row so the next request sees it in flight.
 */

/** Everything {@link requestAnalysis} talks to. */
export interface AnalyzeDeps {
  db: AnyDatabase;
  worker: WorkerClient;
  github: GitHubOptions;
  /** `@gitinside/analyzer/version`: part of the cache key. */
  analyzerVersion: string;
  /** Server secret the rate-limit keys are derived from (`rateLimitKey`). */
  rateLimitSecret: string;
  /** New analyses per hour for a signed-out address. */
  hourlyLimit: number;
  /** Clock for "try again in N minutes" (tests fix it). Default `Date.now`. */
  now?: () => number;
}

/** A successful answer: the commit's diagram is ready, or a job is on its way. */
export type AnalyzeSuccess =
  | { status: "done"; owner: string; repo: string; sha: string }
  | { status: "queued"; jobId: string; owner: string; repo: string; sha: string };

/** Error codes `/api/analyze` returns, each with a fixed message for the visitor. */
export type AnalyzeErrorCode = "INVALID_URL" | ResolveFailure | "RATE_LIMITED" | "UNAVAILABLE";

export interface AnalyzeError {
  error: AnalyzeErrorCode;
  message: string;
  /** With `RATE_LIMITED`: when the window resets (ISO 8601). */
  retryAt?: string;
}

/** An HTTP answer, independent of Next.js so it can be tested directly. */
export interface AnalyzeResponse {
  status: number;
  body: AnalyzeSuccess | AnalyzeError;
  headers?: Record<string, string>;
}

/** UX.md's words for the worker being down. */
export const UNAVAILABLE_MESSAGE =
  "Analysis is temporarily unavailable. Already-analyzed repos still work.";

const RESOLVE_ERRORS: Record<ResolveFailure, { status: number; message: string }> = {
  REPO_NOT_FOUND: {
    status: 404,
    message:
      "We couldn't find a public GitHub repo with that name. Private repos aren't supported yet.",
  },
  REPO_EMPTY: {
    status: 422,
    message: "That repo has no commits yet, so there's nothing to analyze.",
  },
  REPO_UNAVAILABLE: { status: 451, message: "GitHub has blocked access to that repo." },
  GITHUB_RATE_LIMITED: {
    status: 503,
    message: "GitHub is limiting our requests right now. Try again in a few minutes.",
  },
  GITHUB_UNAVAILABLE: { status: 503, message: "We couldn't reach GitHub. Try again in a minute." },
};

/** Start (or find) the analysis of the repo at `url` for a caller at `address`. */
export async function requestAnalysis(
  url: string,
  address: string,
  deps: AnalyzeDeps,
): Promise<AnalyzeResponse> {
  const parsed = parseRepoUrl(url);
  if (!parsed.ok) return { status: 400, body: { error: "INVALID_URL", message: parsed.error } };

  const resolved = await resolveRepo(parsed, deps.github);
  if (!resolved.ok) {
    const { status, message } = RESOLVE_ERRORS[resolved.code];
    return { status, body: { error: resolved.code, message } };
  }
  const { repo } = resolved;
  const commit = { owner: repo.owner, repo: repo.name, sha: repo.sha };

  const existing = await findAnalysis(deps.db, {
    providerRepoId: repo.providerRepoId,
    sha: repo.sha,
    analyzerVersion: deps.analyzerVersion,
  });
  if (existing?.status === "done") return { status: 200, body: { status: "done", ...commit } };

  const inFlight = existing?.status === "queued" || existing?.status === "running";
  const key = rateLimitKey(deps.rateLimitSecret, address);
  let charged: Date | undefined;
  if (!inFlight) {
    const limit = await consumeRateLimit(deps.db, key, deps.hourlyLimit);
    if (!limit.allowed) return rateLimited(limit.resetAt, deps);
    charged = limit.windowStart;
  }

  let job: { id: string; created: boolean };
  try {
    job = await deps.worker.enqueue(commit);
  } catch (error) {
    if (!(error instanceof WorkerUnavailableError)) throw error;
    if (charged) await refundRateLimit(deps.db, key, charged);
    return { status: 503, body: { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE } };
  }
  if (job.created) {
    const { id: repoId } = await upsertRepo(deps.db, repo);
    await queueAnalysis(deps.db, { repoId, sha: repo.sha, analyzerVersion: deps.analyzerVersion });
  } else if (charged) {
    await refundRateLimit(deps.db, key, charged);
  }
  return { status: 202, body: { status: "queued", jobId: job.id, ...commit } };
}

function rateLimited(resetAt: Date, deps: AnalyzeDeps): AnalyzeResponse {
  const seconds = Math.max(1, Math.ceil((resetAt.getTime() - (deps.now ?? Date.now)()) / 1000));
  const minutes = Math.ceil(seconds / 60);
  const wait = minutes === 1 ? "a minute" : `${minutes} minutes`;
  return {
    status: 429,
    body: {
      error: "RATE_LIMITED",
      message: `You've analyzed ${deps.hourlyLimit} repos this hour. Try again in ${wait}.`,
      retryAt: resetAt.toISOString(),
    },
    headers: { "retry-after": String(seconds) },
  };
}
