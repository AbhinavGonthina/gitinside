import { COMPUTE_PAUSE_RATIO } from "@gitinside/db";
import { CHECK_RUN_NAME, type CheckRunText } from "@gitinside/diff";
import { CHECK_PERMISSIONS, mintInstallationToken, type AppCredentials } from "./githubApp";
import { GITHUB_API } from "./githubOAuth";

/**
 * The Check Run a pull request gets when the webhook holds its diff job back (I2.3, ADR-0296):
 * analyses are paused for the month's compute (`findComputePause`), or the repo has used its
 * diff jobs for the hour (`DIFFS_PER_HOUR`). The bot then says so on the head commit instead of
 * staying silent: completed, `neutral` (nothing is wrong with the pull request), with the time
 * it resumes and what to do then.
 *
 * Posted by the website, since no job runs: a token for that one repo with
 * {@link CHECK_PERMISSIONS} only (`checks: write`), minted from the App's key, then
 * `POST /repos/{owner}/{repo}/check-runs`. Not handled: retrying a failed post (the caller logs
 * it and answers GitHub anyway, since a redelivery would be held again), and a later Check Run
 * once the hold ends (the next push or a redelivery queues the diff normally, and the worker's
 * Check Run of the same name then replaces this one on GitHub's page).
 */

/** Why a pull request's diff job wasn't queued, and when that ends. */
export interface DiffHold {
  /** `paused`: the month's compute; `limited`: the repo's diff jobs this hour. */
  reason: "paused" | "limited";
  /** When new diff jobs are taken again: the next UTC month, or the next hour. */
  until: Date;
}

/** How long the post may take, per call. */
const TIMEOUT_MS = 10_000;

/** A time to the minute in UTC, as `2026-12-01 00:00 UTC`. */
function utcMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The held Check Run's text; `perHour` is the repo's hourly diff jobs, for `limited`. */
export function heldCheckRunText(hold: DiffHold, perHour: number): CheckRunText {
  const when = utcMinute(hold.until);
  const then = `Nothing is wrong with this pull request: push a new commit after ${when} for GitInside's review.`;
  if (hold.reason === "paused") {
    return {
      name: CHECK_RUN_NAME,
      conclusion: "neutral",
      title: `Paused until ${when}`,
      summary: `GitInside has used ${Math.round(COMPUTE_PAUSE_RATIO * 100)}% of this month's free compute, so it isn't diffing pull requests until the next month starts. ${then}`,
    };
  }
  return {
    name: CHECK_RUN_NAME,
    conclusion: "neutral",
    title: `Skipped: this repo's ${perHour} diffs this hour are used`,
    summary: `GitInside diffs at most ${perHour} pull request commits per repo an hour, and this repo's are used, so this commit wasn't diffed. ${then}`,
  };
}

/** Where the held Check Run goes: the repo, through its installation, and the head commit. */
export interface HeldCheckRunTarget {
  installationId: number;
  owner: string;
  name: string;
  headSha: string;
}

/** The post failed; `reason` holds no token or name. */
export class HeldCheckRunError extends Error {
  override name = "HeldCheckRunError";
}

/**
 * Create `text` as a completed Check Run on `target.headSha` (see the module comment). Throws
 * `InstallationTokenError` when no token can be had, {@link HeldCheckRunError} when the post fails.
 */
export async function postHeldCheckRun(
  app: AppCredentials,
  target: HeldCheckRunTarget,
  text: CheckRunText,
  now: number,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(target.headSha))
    throw new Error("a Check Run needs the full head SHA");
  const { owner, name } = target;
  const { token } = await mintInstallationToken(
    app,
    target.installationId,
    { owner, name },
    now,
    CHECK_PERMISSIONS,
  );
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs`;
  let response: Response;
  try {
    response = await (app.fetch ?? fetch)(new URL(path, app.fakeOrigin ?? GITHUB_API).href, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        name: text.name,
        head_sha: target.headSha,
        status: "completed",
        conclusion: text.conclusion,
        output: { title: text.title, summary: text.summary },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HeldCheckRunError("request failed");
  }
  await response.body?.cancel();
  if (response.status !== 201) throw new HeldCheckRunError(`HTTP ${response.status}`);
}
