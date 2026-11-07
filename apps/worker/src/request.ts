import { createHash } from "node:crypto";

/**
 * What a job asks for, and its ID: the light entry `@gitinside/worker/request` (only
 * `node:crypto`), so the web app names jobs with the worker's own code without loading the
 * queue, the runner, or the analyzer (ADR-0141). The worker checks every body it's given with
 * {@link parseJobRequest}.
 */

/** What a job does: analyze one commit, or diff two (M6/M8). */
export type JobKind = "analyze" | "diff";

/** A validated job body. */
export interface JobRequest {
  kind: JobKind;
  owner: string;
  repo: string;
  /** The commit to analyze (for `diff`, the head). 40 lowercase hex. */
  sha: string;
  /** Required for `diff`, refused for `analyze`. */
  baseSha?: string;
  /** Set for private repos (GitHub App installation, M8). */
  installationId?: number;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const KEYS = new Set(["kind", "owner", "repo", "sha", "baseSha", "installationId"]);

/** Thrown by {@link parseJobRequest}; the message names a field, never echoes its value. */
export class JobRequestError extends Error {
  override name = "JobRequestError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed job body. Owner and repo follow GitHub's name rules (the same as
 * apps/web's URL parser); SHAs are full lowercase hex; unknown keys are refused.
 */
export function parseJobRequest(value: unknown): JobRequest {
  if (!isRecord(value)) throw new JobRequestError("body must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!KEYS.has(key)) throw new JobRequestError(`unknown field ${JSON.stringify(key)}`);
  }
  const { kind, owner, repo, sha, baseSha, installationId } = value;
  if (kind !== "analyze" && kind !== "diff") {
    throw new JobRequestError('kind must be "analyze" or "diff"');
  }
  if (typeof owner !== "string" || !OWNER.test(owner)) {
    throw new JobRequestError("owner is not a GitHub owner name");
  }
  if (typeof repo !== "string" || !REPO.test(repo) || repo === "." || repo === "..") {
    throw new JobRequestError("repo is not a GitHub repo name");
  }
  if (typeof sha !== "string" || !SHA.test(sha)) {
    throw new JobRequestError("sha must be 40 lowercase hex characters");
  }
  if (kind === "diff") {
    if (typeof baseSha !== "string" || !SHA.test(baseSha)) {
      throw new JobRequestError("baseSha must be 40 lowercase hex characters");
    }
  } else if (baseSha !== undefined) {
    throw new JobRequestError("baseSha is only for diff jobs");
  }
  if (
    installationId !== undefined &&
    (typeof installationId !== "number" ||
      !Number.isSafeInteger(installationId) ||
      installationId < 1)
  ) {
    throw new JobRequestError("installationId must be a positive integer");
  }
  return {
    kind,
    owner,
    repo,
    sha,
    ...(kind === "diff" ? { baseSha: baseSha as string } : {}),
    ...(installationId === undefined ? {} : { installationId }),
  };
}

/**
 * The job ID for a request: `<kind>-<32 hex>`, a SHA-256 over the kind, the lowercased owner
 * and repo (GitHub names ignore case), the SHAs, and the analyzer version. The same commit is
 * therefore one job however often it's asked for (the dedupe in T9), and the ID can't be
 * guessed without knowing the repo.
 *
 * A job read through an installation adds its `installationId` (ADR-0227), so a private job
 * is never the same job as a public one for that commit, nor as another installation's (a
 * transfer). Installation IDs aren't secret, so this scopes the job; access checks stay the
 * website's (M8.4). It's appended only when set: a public job's ID stays what it was, so tasks queued before a deploy still
 * name their rows.
 */
export function jobIdFor(request: JobRequest, analyzerVersion: string): string {
  const key = JSON.stringify([
    request.kind,
    request.owner.toLowerCase(),
    request.repo.toLowerCase(),
    request.sha,
    request.baseSha ?? null,
    analyzerVersion,
    ...(request.installationId === undefined ? [] : [request.installationId]),
  ]);
  return `${request.kind}-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}
