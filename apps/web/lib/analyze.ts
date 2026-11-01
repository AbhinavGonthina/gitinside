import { consumeRateLimit, findAnalysis, refundRateLimit, upsertRepo } from "@gitinside/db";
import { rateLimitKey } from "./clientIp";
import { enqueueAnalysis, type EnqueueDeps } from "./enqueue";
import { findTooMuchCode, type CodeSizeCache } from "./codeSize";
import { sizeHoldMessage, tooMuchCodeMessage } from "./jobs";
import { UNAVAILABLE_MESSAGE } from "./messages";
import { resolveRepo, type GitHubOptions, type ResolveFailure } from "./github";
import { parseRepoUrl } from "./repoUrl";
import { findSizeHold, type SizeHold } from "./sizeHold";

/**
 * What `POST /api/analyze` does once the body is read (docs/DESIGN.md §11, ADR-0066):
 *
 * 1. **Parse** the pasted URL with GitHub's name rules (`parseRepoUrl`).
 * 2. **Resolve** the repo and its default branch's latest commit on GitHub (public only).
 * 3. **Cache:** a `done` analysis of that commit by this analyzer version is returned as is
 *    (the repo row refreshed from GitHub's facts). Viewing and re-asking are never
 *    rate-limited.
 * 4. **Dedupe:** a commit already `queued` or `running` gets the same job back (the job ID
 *    is derived from the commit), again without counting against the limit.
 * 5. **Too big:** a repo whose analysis hit a `LIMIT_*` limit in the past week is refused
 *    (`422 REPO_TOO_BIG`, saying why and until when) unless it has shrunk to half its size
 *    (`findSizeHold`, #11); so is one with over twice the supported source size of TypeScript
 *    and JavaScript by GitHub's count (`422 REPO_TOO_BIG`, no `retryAt`: `findTooMuchCode`,
 *    ADR-0154). No slot is used.
 * 6. **Rate limit** anything else: a new analysis counts against the caller's hourly
 *    window (5 signed out). The slot is given back unless this request queued the commit
 *    (the queue was down, or someone else's request queued it first).
 * 7. **Enqueue** on Cloud Tasks (`enqueueAnalysis`): the `queued` row first, then the task
 *    named from it; a row whose task can't be created is failed, and the answer is `503`.
 */

/** Everything {@link requestAnalysis} talks to (`analyzerVersion` is part of the cache key). */
export interface AnalyzeDeps extends EnqueueDeps {
  github: GitHubOptions;
  /** Server secret the rate-limit keys are derived from (`rateLimitKey`). */
  rateLimitSecret: string;
  /** New analyses per hour for a signed-out address. */
  hourlyLimit: number;
  /** GitHub's code counts by commit (`findTooMuchCode`); without it, asked every time. */
  codeSizes?: CodeSizeCache;
  /** Clock for "try again in N minutes" (tests fix it). Default `Date.now`. */
  now?: () => number;
}

/** A successful answer: the commit's diagram is ready, or a job is on its way. */
export type AnalyzeSuccess =
  | { status: "done"; owner: string; repo: string; sha: string }
  | { status: "queued"; jobId: string; owner: string; repo: string; sha: string };

/** Error codes `/api/analyze` returns, each with a message for the visitor. */
export type AnalyzeErrorCode =
  | "INVALID_URL"
  | ResolveFailure
  | "REPO_TOO_BIG"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export interface AnalyzeError {
  error: AnalyzeErrorCode;
  message: string;
  /**
   * With `RATE_LIMITED`: when the window resets; with `REPO_TOO_BIG` after a `LIMIT_*`
   * failure: when the hold ends (ISO 8601). None when the repo is refused on GitHub's count.
   */
  retryAt?: string;
}

/** An HTTP answer, independent of Next.js so it can be tested directly. */
export interface AnalyzeResponse {
  status: number;
  body: AnalyzeSuccess | AnalyzeError;
  headers?: Record<string, string>;
}

export { UNAVAILABLE_MESSAGE };

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
  if (existing?.status === "done") {
    // GitHub's facts again: a repo hidden when it went private is served once it's public.
    await upsertRepo(deps.db, repo);
    return { status: 200, body: { status: "done", ...commit } };
  }

  const inFlight = existing?.status === "queued" || existing?.status === "running";
  if (!inFlight) {
    const hold = await findSizeHold(deps.db, repo);
    if (hold !== undefined) return tooBig(hold, deps);
    const codeBytes = await findTooMuchCode(repo, deps.github, deps.codeSizes);
    if (codeBytes !== undefined) {
      return {
        status: 422,
        body: { error: "REPO_TOO_BIG", message: tooMuchCodeMessage(codeBytes) },
      };
    }
  }
  const key = rateLimitKey(deps.rateLimitSecret, address);
  let charged: Date | undefined;
  if (!inFlight) {
    const limit = await consumeRateLimit(deps.db, key, deps.hourlyLimit);
    if (!limit.allowed) return rateLimited(limit.resetAt, deps);
    charged = limit.windowStart;
  }

  const queued = await enqueueAnalysis(repo, deps);
  // Only a new analysis this request queued keeps the slot.
  const isNew = queued.status === "queued" && queued.entered;
  if (charged && !isNew) await refundRateLimit(deps.db, key, charged);
  switch (queued.status) {
    case "done":
      return { status: 200, body: { status: "done", ...commit } };
    case "unavailable":
      return { status: 503, body: { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE } };
    default:
      return { status: 202, body: { status: "queued", jobId: queued.jobId, ...commit } };
  }
}

function tooBig(hold: SizeHold, deps: AnalyzeDeps): AnalyzeResponse {
  const seconds = Math.max(1, Math.ceil((hold.until.getTime() - (deps.now ?? Date.now)()) / 1000));
  return {
    status: 422,
    body: {
      error: "REPO_TOO_BIG",
      message: sizeHoldMessage(hold.errorCode, hold.until),
      retryAt: hold.until.toISOString(),
    },
    headers: { "retry-after": String(seconds) },
  };
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
