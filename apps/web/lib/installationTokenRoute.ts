import { findJobInstallation, type AnyDatabase } from "@gitinside/db";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyRequest,
  type VerifyFailure,
} from "@gitinside/worker/hmac";
import { readBody } from "./body";
import {
  InstallationTokenError,
  mintInstallationToken,
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
 *   `running` and its repo is linked to that installation now; the repo's owner and name come
 *   from the row, never from the request. A stored suspension is refused without asking GitHub.
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

const JOB_ID = /^analyze-[0-9a-f]{32}$/;

/** The body's `{ jobId, installationId }`, exactly those, or `undefined`. */
function parse(bytes: Uint8Array): { jobId: string; installationId: number } | undefined {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { jobId, installationId, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return undefined;
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) return undefined;
  if (typeof installationId !== "number" || !Number.isSafeInteger(installationId)) {
    return undefined;
  }
  if (installationId < 1) return undefined;
  return { jobId, installationId };
}

function log(jobId: string, outcome: string): void {
  console.log(JSON.stringify({ event: "installation_token", jobId, outcome }));
}

function refuse(jobId: string, code: TokenRouteCode): Response {
  log(jobId, code);
  return json(TOKEN_ROUTE_STATUS[code], { error: code });
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
    const job = await findJobInstallation(deps.db, jobId);
    if (job === undefined || (job.status !== "queued" && job.status !== "running")) {
      return refuse(jobId, "JOB_NOT_FOUND");
    }
    if (job.githubInstallationId === null) return refuse(jobId, "INSTALLATION_NOT_FOUND");
    if (job.githubInstallationId !== installationId) return refuse(jobId, "REPO_NOT_INSTALLED");
    if (job.suspendedAt !== null) return refuse(jobId, "INSTALLATION_SUSPENDED");
    const { token, expiresAt } = await mintInstallationToken(
      deps.app,
      installationId,
      { owner: job.owner, name: job.name },
      now,
    );
    log(jobId, "issued");
    return json(200, { token, expiresAt: new Date(expiresAt).toISOString() });
  } catch (error) {
    if (error instanceof InstallationTokenError) return refuse(jobId, error.code);
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
