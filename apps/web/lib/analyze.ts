import {
  claimRepoAnalysis,
  consumeRateLimit,
  findComputePause,
  refundRateLimit,
  releaseRepoAnalysis,
  upsertRepo,
} from "@gitinside/db";
import { passBotCheck, type BotCheck, type BotRefusal } from "./botCheck";
import { rateLimitKey, userRateLimitKey } from "./clientIp";
import {
  InstallationRefusedError,
  enqueueAnalysis,
  findAnalysisToQueue,
  storeQueueRepo,
  type EnqueueDeps,
  type EnqueueResult,
  type InstallationRefusal,
  type QueueRepo,
} from "./enqueue";
import { findTooMuchCode, type CodeSizeCache } from "./codeSize";
import {
  failureView,
  pausedMessage,
  permanentFailure,
  sizeHoldMessage,
  tooMuchCodeMessage,
} from "./jobs";
import { UNAVAILABLE_MESSAGE } from "./messages";
import { resolveRepo, type GitHubOptions, type ResolveFailure } from "./github";
import type { PrivateResult } from "./privateRepo";
import { parseRepoUrl, type RepoRef } from "./repoUrl";
import { findSizeHold, type SizeHold } from "./sizeHold";

/**
 * What `POST /api/analyze` does once the body is read (docs/DESIGN.md §11, ADR-0066):
 *
 * 1. **Parse** the pasted URL with GitHub's name rules (`parseRepoUrl`).
 * 2. **Resolve** the repo and its default branch's latest commit on GitHub, public by the
 *    server's token. A name it doesn't find is asked again for a signed-in caller with their
 *    own token (`resolvePrivateRepo`, M8.4c2b, ADR-0235): a private repo they can see through
 *    an installation of the app is queued through that installation (its code counted with
 *    their token), and anything else is the same `404 REPO_NOT_FOUND` everyone gets.
 * 3. **Cache:** a `done` analysis of that commit by this analyzer version is returned as is
 *    (the repo row refreshed from GitHub's facts). Viewing and re-asking are never
 *    rate-limited.
 * 4. **Dedupe:** a commit already `queued` or `running` gets the same job back (the job ID
 *    is derived from the commit), again without counting against the limit; one `queued`
 *    with no task coming any more is a new analysis instead (`findAnalysisToQueue`, R10).
 *    A commit whose
 *    analysis failed in a way that would fail again (`permanentFailure`: a limit, an
 *    unreadable download) isn't queued again: `422 ANALYSIS_FAILED` with the job page's
 *    reason, like check-on-view (R8). A GitHub access failure is retried, since step 2 just
 *    found the repo public.
 * 5. **Too big:** a repo whose analysis hit a `LIMIT_*` limit in the past week is refused
 *    (`422 REPO_TOO_BIG`, saying why and until when) unless it has shrunk to half its size
 *    (`findSizeHold`, #11); so is one with over twice the supported source size of TypeScript
 *    and JavaScript by GitHub's count (`422 REPO_TOO_BIG`, no `retryAt`: `findTooMuchCode`,
 *    ADR-0154). No slot is used.
 * 6. **Paused:** while the month's Google compute is at 80% of the free allowance, no new
 *    analysis starts (`503 ANALYSIS_PAUSED`, until the next UTC month: `findComputePause`,
 *    ADR-0156). Finished diagrams and jobs already in flight are unaffected.
 * 7. **Rate limit:** a new analysis takes a slot in the caller's hourly window (5 per
 *    address signed out, 30 per user signed in), or is refused with `429 RATE_LIMITED`. Taken first, in one statement, so the bot
 *    check can decide on the count it was taken at (R6). Every later refusal gives it back,
 *    and so does an answer that queued nothing new (the queue was down, or someone else's
 *    request queued it first) or a throw.
 * 8. **Bot check:** when the caller's address or the whole site is asking for more new
 *    analyses this hour than people usually do, the request needs a Turnstile token that
 *    Cloudflare accepts (`passBotCheck`, ADR-0157): `403 CHALLENGE_REQUIRED` with the
 *    widget's site key, `403 CHALLENGE_FAILED`, or `503 CHALLENGE_UNAVAILABLE`. No claim is
 *    taken.
 * 9. **Per repo:** one new analysis per repo every {@link REPO_ANALYSIS_MINUTES} minutes,
 *    whoever asks (`claimRepoAnalysis`, #11, ADR-0155): another commit is refused with
 *    `429 REPO_RATE_LIMITED` and when to try again. The claiming commit itself still goes
 *    through (a duplicate, or a retry of its failed run). The claim is given back when the
 *    queue was down or `enqueueAnalysis` threw (R7).
 * 10. **Enqueue** on Cloud Tasks (`enqueueAnalysis`): the `queued` row first, then the task
 *    named from it; a row whose task can't be created is failed, and the answer is `503`.
 */

/** Everything {@link requestAnalysis} talks to (`analyzerVersion` is part of the cache key). */
export interface AnalyzeDeps extends EnqueueDeps {
  github: GitHubOptions;
  /** Server secret the rate-limit keys are derived from (`rateLimitKey`). */
  rateLimitSecret: string;
  /** New analyses per hour for a signed-out address. */
  hourlyLimit: number;
  /** New analyses per hour for a signed-in user (M8.2b). */
  signedInHourlyLimit: number;
  /** Whether sign-in is set up, so a signed-out caller at the limit is told it helps. */
  signInAvailable?: boolean;
  /** The Turnstile check (`passBotCheck`, ADR-0157); without it, nobody is asked. */
  botCheck?: BotCheck;
  /**
   * The hour the caller's slots and the bot check's counts are in, at a fixed moment (tests);
   * default the database clock.
   */
  rateLimitClock?: () => Date;
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
  | "ANALYSIS_FAILED"
  | "REPO_TOO_BIG"
  | "REPO_RATE_LIMITED"
  | "ANALYSIS_PAUSED"
  | BotRefusal["body"]["error"]
  | "RATE_LIMITED"
  | InstallationRefusal
  | "UNAVAILABLE";

/**
 * A repo gets at most one new analysis this often, whoever asks (#11, ADR-0155), on top of
 * each address's hourly limit.
 */
export const REPO_ANALYSIS_MINUTES = 30;

/**
 * Permanent failures about GitHub's access to the repo, not its code: this request's lookup
 * just found it public, so another try can pass. An installation's refusal (a private job's,
 * ADR-0227) is one too: a public job needs no installation.
 */
const ACCESS_FAILURES: ReadonlySet<string> = new Set([
  "REPO_NOT_FOUND",
  "REPO_NOT_PUBLIC",
  "REPO_UNAVAILABLE",
  "INSTALLATION_NOT_FOUND",
  "INSTALLATION_SUSPENDED",
  "REPO_NOT_INSTALLED",
]);

export interface AnalyzeError {
  error: AnalyzeErrorCode;
  message: string;
  /**
   * With `RATE_LIMITED`: when the window resets; with `REPO_RATE_LIMITED`: when the repo's
   * claim ends; with `REPO_TOO_BIG` after a `LIMIT_*` failure: when the hold ends; with
   * `ANALYSIS_PAUSED`: when the next UTC month begins (ISO 8601).
   * None when the repo is refused on GitHub's count.
   */
  retryAt?: string;
  /** With `CHALLENGE_REQUIRED` and `CHALLENGE_FAILED`: the Turnstile widget's public site key. */
  siteKey?: string;
}

/** An HTTP answer, independent of Next.js so it can be tested directly. */
export interface AnalyzeResponse {
  status: number;
  body: AnalyzeSuccess | AnalyzeError;
  headers?: Record<string, string>;
}

export { UNAVAILABLE_MESSAGE };

/** A repo nobody can see by that name, said the same to everyone (signed in or out). */
export const NOT_FOUND_MESSAGE = "We couldn't find a public GitHub repo with that name.";
/** Added to {@link NOT_FOUND_MESSAGE} where sign-in is set up (the same for everyone). */
export const PRIVATE_HINT =
  "For a private repo, sign in with a GitHub account that can see it and install GitInside on it.";

/** Each resolve failure's answer; `REPO_NOT_FOUND` mentions private repos where sign-in exists. */
function resolveErrors(
  deps: Pick<AnalyzeDeps, "signInAvailable">,
): Record<ResolveFailure, { status: number; message: string }> {
  return {
    REPO_NOT_FOUND: {
      status: 404,
      message:
        deps.signInAvailable === true ? `${NOT_FOUND_MESSAGE} ${PRIVATE_HINT}` : NOT_FOUND_MESSAGE,
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
    GITHUB_UNAVAILABLE: {
      status: 503,
      message: "We couldn't reach GitHub. Try again in a minute.",
    },
  };
}

/**
 * Who asks for an analysis: a signed-out request's address (`clientAddress`), or a
 * signed-in user by their `users` row's ID (M8.2b), whose address then doesn't count.
 * `privateRepos` looks a name up as the user sees it on GitHub (`resolvePrivateRepo`,
 * M8.4c2b), for a repo the public lookup didn't find.
 */
export type Caller =
  | string
  | { userId: string; privateRepos?: (ref: RepoRef) => Promise<PrivateResult> };

/**
 * The repo `ref` names and how to read GitHub for it: public by the server's token, else, for
 * a signed-in caller, private as they see it (ADR-0235). Refused there, it's the public
 * lookup's own `REPO_NOT_FOUND`.
 */
async function findRepo(
  ref: RepoRef,
  caller: Caller,
  deps: AnalyzeDeps,
): Promise<
  { ok: true; repo: QueueRepo; github: GitHubOptions } | { ok: false; code: ResolveFailure }
> {
  const resolved = await resolveRepo(ref, deps.github);
  if (resolved.ok) return { ok: true, repo: resolved.repo, github: deps.github };
  if (resolved.code !== "REPO_NOT_FOUND" || typeof caller === "string") return resolved;
  return caller.privateRepos === undefined ? resolved : caller.privateRepos(ref);
}

/** A private repo's installation refused at enqueue (ADR-0227), in the job page's words. */
function installationRefused(code: InstallationRefusal): AnalyzeResponse {
  return { status: 403, body: { error: code, message: failureView(code).message } };
}

/**
 * Start (or find) the analysis of the repo at `url` for `caller`. `challengeToken` is the
 * Turnstile widget's token, once the visitor was asked for it.
 */
export async function requestAnalysis(
  url: string,
  caller: Caller,
  deps: AnalyzeDeps,
  challengeToken?: string,
): Promise<AnalyzeResponse> {
  const parsed = parseRepoUrl(url);
  if (!parsed.ok) return { status: 400, body: { error: "INVALID_URL", message: parsed.error } };

  const found = await findRepo(parsed, caller, deps);
  if (!found.ok) {
    const { status, message } = resolveErrors(deps)[found.code];
    return { status, body: { error: found.code, message } };
  }
  const { repo, github } = found;
  const commit = { owner: repo.owner, repo: repo.name, sha: repo.sha };

  const existing = await findAnalysisToQueue(deps.db, {
    providerRepoId: repo.providerRepoId,
    sha: repo.sha,
    analyzerVersion: deps.analyzerVersion,
  });
  if (existing?.status === "done") {
    // GitHub's facts again: a repo hidden when it went private is served once it's public.
    if (repo.visibility === "public") await upsertRepo(deps.db, repo);
    return { status: 200, body: { status: "done", ...commit } };
  }

  if (existing?.status === "failed") {
    const code = existing.errorCode ?? "";
    // Would fail the same way again, unless it was GitHub's access, just answered afresh.
    if (permanentFailure(code) !== undefined && !ACCESS_FAILURES.has(code)) {
      return {
        status: 422,
        body: { error: "ANALYSIS_FAILED", message: failureView(code).message },
      };
    }
  }

  const inFlight = existing?.status === "queued" || existing?.status === "running";
  if (!inFlight) {
    const hold = await findSizeHold(deps.db, repo);
    if (hold !== undefined) return tooBig(hold, deps);
    const codeBytes = await findTooMuchCode(repo, github, deps.codeSizes);
    if (codeBytes !== undefined) {
      return {
        status: 422,
        body: { error: "REPO_TOO_BIG", message: tooMuchCodeMessage(codeBytes) },
      };
    }
    const pause = await findComputePause(deps.db);
    if (pause !== undefined) return paused(pause.until, deps);
  }
  const signedIn = typeof caller !== "string";
  const key = signedIn
    ? userRateLimitKey(caller.userId)
    : rateLimitKey(deps.rateLimitSecret, caller);
  const hourlyLimit = signedIn ? deps.signedInHourlyLimit : deps.hourlyLimit;
  let charged: Date | undefined;
  let claimed: { repoId: string; claimedAt: Date } | undefined;
  if (!inFlight) {
    // The slot first, in one statement: the bot check decides on the count it was taken at,
    // so a parallel burst can't all read the same count (R6).
    const at = deps.rateLimitClock?.();
    const limit = await consumeRateLimit(deps.db, key, hourlyLimit, at);
    if (!limit.allowed) return rateLimited(limit.resetAt, hourlyLimit, signedIn, deps);
    charged = limit.windowStart;
    if (deps.botCheck) {
      // A signed-in user is asked only when the whole site is busy: their GitHub account is
      // who they are, and their hourly limit bounds them (ADR-0222).
      const started = signedIn ? 0 : limit.count - 1;
      const refusal = await passBotCheck(deps.botCheck, deps.db, started, challengeToken, at);
      if (refusal) {
        await refundRateLimit(deps.db, key, charged);
        return refusal;
      }
    }
    let repoId: string;
    try {
      ({ id: repoId } = await storeQueueRepo(deps.db, repo));
    } catch (error) {
      if (!(error instanceof InstallationRefusedError)) throw error;
      await refundRateLimit(deps.db, key, charged);
      return installationRefused(error.code);
    }
    const claim = await claimRepoAnalysis(deps.db, repoId, repo.sha, REPO_ANALYSIS_MINUTES * 60);
    if (claim.status === "refused") {
      await refundRateLimit(deps.db, key, charged);
      return repoLimited(claim.retryAt, deps);
    }
    if (claim.status === "claimed") claimed = { repoId, claimedAt: claim.claimedAt };
  }

  let queued: EnqueueResult;
  try {
    queued = await enqueueAnalysis(repo, deps);
  } catch (error) {
    // Nothing was queued (R7): give both back, then answer the original error.
    await Promise.allSettled([
      charged && refundRateLimit(deps.db, key, charged),
      claimed && releaseRepoAnalysis(deps.db, claimed.repoId, claimed.claimedAt),
    ]);
    // Uninstalled or suspended since the repo was stored (a private repo): said, not a 500.
    if (error instanceof InstallationRefusedError) return installationRefused(error.code);
    throw error;
  }
  // Only a new analysis this request queued keeps the slot. The repo's claim stays whenever
  // the commit is analyzed, even if a racing request for it queued the job.
  const isNew = queued.status === "queued" && queued.entered;
  if (charged && !isNew) await refundRateLimit(deps.db, key, charged);
  if (claimed && queued.status === "unavailable") {
    await releaseRepoAnalysis(deps.db, claimed.repoId, claimed.claimedAt);
  }
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

function paused(until: Date, deps: AnalyzeDeps): AnalyzeResponse {
  const { seconds } = waitUntil(until, deps);
  return {
    status: 503,
    body: { error: "ANALYSIS_PAUSED", message: pausedMessage(until), retryAt: until.toISOString() },
    headers: { "retry-after": String(seconds) },
  };
}

function rateLimited(
  resetAt: Date,
  limit: number,
  signedIn: boolean,
  deps: AnalyzeDeps,
): AnalyzeResponse {
  const { seconds, wait } = waitUntil(resetAt, deps);
  // UX.md "Rate limited": a signed-out caller is told signing in raises the limit.
  const more = !signedIn && deps.signInAvailable === true ? ", or sign in for a higher limit" : "";
  return {
    status: 429,
    body: {
      error: "RATE_LIMITED",
      message: `You've analyzed ${limit} repos this hour. Try again in ${wait}${more}.`,
      retryAt: resetAt.toISOString(),
    },
    headers: { "retry-after": String(seconds) },
  };
}

function repoLimited(retryAt: Date, deps: AnalyzeDeps): AnalyzeResponse {
  const { seconds, wait } = waitUntil(retryAt, deps);
  const every = `${REPO_ANALYSIS_MINUTES} minutes`;
  return {
    status: 429,
    body: {
      error: "REPO_RATE_LIMITED",
      message: `Someone asked for a new analysis of this repo in the past ${every}, and each repo gets one every ${every}. Try again in ${wait}.`,
      retryAt: retryAt.toISOString(),
    },
    headers: { "retry-after": String(seconds) },
  };
}

/** Seconds until `at` (at least 1, for `Retry-After`) and the wait in words. */
function waitUntil(at: Date, deps: AnalyzeDeps): { seconds: number; wait: string } {
  const seconds = Math.max(1, Math.ceil((at.getTime() - (deps.now ?? Date.now)()) / 1000));
  const minutes = Math.ceil(seconds / 60);
  return { seconds, wait: minutes === 1 ? "a minute" : `${minutes} minutes` };
}
