import {
  findDiffJobToPost,
  findJobInstallation,
  type AnyDatabase,
  type PostingJob,
} from "@gitinside/db";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyRequest,
  type VerifyFailure,
} from "@gitinside/worker/hmac";
import { readBody } from "./body";
import {
  InstallationTokenError,
  JOB_PERMISSIONS,
  mintInstallationToken,
  POST_PERMISSIONS,
  type AppCredentials,
  type InstallationTokenCode,
} from "./githubApp";

/**
 * `POST /api/worker/installation-token` (M8.3c3a, ADR-0226, ADR-0228): the worker asks, at
 * the start of a job read through an installation, for that job's installation token. The
 * website holds the app's key and mints; the worker never does.
 *
 * - **Signed by the worker or refused.** The request carries the worker's `v1` signature
 *   (`@gitinside/worker/hmac`) made with a key derived from `ENQUEUE_HMAC_SECRET` for this
 *   purpose (`derivedSecret`, `TOKEN_REQUEST_PURPOSE`), checked against the current and, during
 *   a rotation, the previous secret's key, over the method, this path, and the raw body, at most
 *   5 minutes old, before anything is parsed. A signature the website makes for a job can't
 *   pass here, nor this one there. Not configured (database, app key, or secret): `503`.
 * - **Only for a live job, through its own installation.** The body is `{ jobId, installationId }`.
 *   The token is minted only if the newest `analyses` row with that job ID is `queued` or
 *   `running` (for a `diff-` job, ADR-0245: a pull request record names it and has no diff
 *   yet) and its repo is linked to that installation now; the repo's owner and name come from
 *   the row, never from the request. A stored suspension is refused without asking GitHub.
 * - **Posting asks for its own token** (M8.6e1, ADR-0245): a body with `access: "post"` (a
 *   `diff-` job only) gets a token with `POST_PERMISSIONS` (pull requests and checks written,
 *   no code read), minted only while a pull request record names the job, holds its diff, and
 *   has no Check Run (db `findDiffJobToPost`). That window starts where the read token's ends
 *   (the diff recorded), so neither token is minted outside its step, and a job retried after
 *   posting gets `JOB_NOT_FOUND`. The same installation checks apply. `access: "read"` or none is
 *   the read token, as before.
 * - **Answers** `200 { token, expiresAt }` (ISO), else `{ error }` with a code: `404`
 *   `JOB_NOT_FOUND`; `403` `INSTALLATION_SUSPENDED`, `INSTALLATION_NOT_FOUND` (the repo is
 *   linked to none now), or `REPO_NOT_INSTALLED` (linked to another, or GitHub says this one
 *   doesn't cover it), which a retry won't change; `503` `APP_AUTH_FAILED` and `502`
 *   `GITHUB_UNAVAILABLE`, which may pass. Every answer is `no-store`, and each outcome is logged
 *   with the job ID, never the token.
 *
 * Not handled: a replay of a captured request within its 5 minutes mints another token for the
 * same live job, readable only by whoever holds the TLS connection (the worker).
 */

/** The route's path, which the worker signs. */
export const TOKEN_ROUTE_PATH = "/api/worker/installation-token";
/** Largest body read: `{ jobId, installationId }` is under 100 bytes. */
export const MAX_TOKEN_REQUEST_BYTES = 1024;

/** What the token route needs. */
export interface TokenRouteDeps {
  db: AnyDatabase;
  app: AppCredentials;
  /** Signing keys derived for `TOKEN_REQUEST_PURPOSE`: the current secret's, then the previous. */
  keys: readonly string[];
  /** The clock (ms); tests pass a fixed one. */
  now?: () => number;
}

/** Why no token: a refusal a retry won't change, or a failure that may pass. */
export type TokenRouteCode = "JOB_NOT_FOUND" | InstallationTokenCode;

/** Each code's status. */
export const TOKEN_ROUTE_STATUS: Readonly<Record<TokenRouteCode, number>> = {
  JOB_NOT_FOUND: 404,
  INSTALLATION_SUSPENDED: 403,
  INSTALLATION_NOT_FOUND: 403,
  REPO_NOT_INSTALLED: 403,
  APP_AUTH_FAILED: 503,
  GITHUB_UNAVAILABLE: 502,
};

type Body =
  | { token: string; expiresAt: string }
  | {
      error:
        | TokenRouteCode
        | VerifyFailure
        | "UNAVAILABLE"
        | "BODY_TOO_LARGE"
        | "INVALID_REQUEST"
        | "INTERNAL";
    };

function json(status: number, body: Body): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const JOB_ID = /^(?:analyze|diff)-[0-9a-f]{32}$/;

/** What a token is for: the job's reads (the default) or a diff job's post. */
export type TokenAccess = "read" | "post";

interface TokenAsk {
  jobId: string;
  installationId: number;
  access: TokenAccess;
}

/**
 * The body's `{ jobId, installationId, access? }`, exactly those, or `undefined`. `access` is
 * `"read"` (also when left out) or `"post"`, which only a `diff-` job may ask.
 */
function parse(bytes: Uint8Array): TokenAsk | undefined {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { jobId, installationId, access = "read", ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return undefined;
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) return undefined;
  if (typeof installationId !== "number" || !Number.isSafeInteger(installationId)) {
    return undefined;
  }
  if (installationId < 1) return undefined;
  if (access !== "read" && access !== "post") return undefined;
  if (access === "post" && !jobId.startsWith("diff-")) return undefined;
  return { jobId, installationId, access };
}

/** The read token's outcome lines are unchanged; a post token's name its access. */
function log(asked: TokenAsk, outcome: string): void {
  const { jobId, access } = asked;
  console.log(
    JSON.stringify({
      event: "installation_token",
      jobId,
      ...(access === "post" && { access }),
      outcome,
    }),
  );
}

function refuse(asked: TokenAsk, code: TokenRouteCode): Response {
  log(asked, code);
  return json(TOKEN_ROUTE_STATUS[code], { error: code });
}

/** The job's repo and installation if it's live for `access`'s step, else `undefined`. */
async function liveJob(db: AnyDatabase, asked: TokenAsk): Promise<PostingJob | undefined> {
  if (asked.access === "post") return findDiffJobToPost(db, asked.jobId);
  const job = await findJobInstallation(db, asked.jobId);
  return job !== undefined && (job.status === "queued" || job.status === "running")
    ? job
    : undefined;
}

/** Answer one token request. `deps` is `undefined` when the route isn't configured. */
export async function handleTokenRequest(
  request: Request,
  deps: TokenRouteDeps | undefined,
): Promise<Response> {
  if (deps === undefined) return json(503, { error: "UNAVAILABLE" });
  const bytes = await readBody(request, MAX_TOKEN_REQUEST_BYTES);
  if (bytes === undefined) return json(413, { error: "BODY_TOO_LARGE" });
  const now = (deps.now ?? Date.now)();
  const url = new URL(request.url);
  const verified = verifyRequest(
    deps.keys,
    { method: request.method, path: url.pathname + url.search, body: bytes },
    {
      timestamp: request.headers.get(TIMESTAMP_HEADER) ?? undefined,
      signature: request.headers.get(SIGNATURE_HEADER) ?? undefined,
    },
    now,
  );
  if (!verified.ok) return json(401, { error: verified.reason });

  // Signed by the worker from here on; still checked.
  const asked = parse(bytes);
  if (asked === undefined) return json(400, { error: "INVALID_REQUEST" });
  const { jobId, installationId } = asked;
  try {
    const job = await liveJob(deps.db, asked);
    if (job === undefined) return refuse(asked, "JOB_NOT_FOUND");
    if (job.githubInstallationId === null) return refuse(asked, "INSTALLATION_NOT_FOUND");
    if (job.githubInstallationId !== installationId) return refuse(asked, "REPO_NOT_INSTALLED");
    if (job.suspendedAt !== null) return refuse(asked, "INSTALLATION_SUSPENDED");
    const { token, expiresAt } = await mintInstallationToken(
      deps.app,
      installationId,
      { owner: job.owner, name: job.name },
      now,
      asked.access === "post" ? POST_PERMISSIONS : JOB_PERMISSIONS,
    );
    log(asked, "issued");
    return json(200, { token, expiresAt: new Date(expiresAt).toISOString() });
  } catch (error) {
    if (error instanceof InstallationTokenError) return refuse(asked, error.code);
    // Name only: a driver error's message can carry connection details.
    console.error(
      JSON.stringify({
        event: "installation_token_failed",
        jobId,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return json(500, { error: "INTERNAL" });
  }
}
