import { JobFailure } from "./failure.js";
import { derivedSecret, signRequest, TOKEN_REQUEST_PURPOSE } from "./hmac.js";

/**
 * The worker's side of a private job's installation token (M8.3c3b; ADR-0226, ADR-0228). At
 * the start of a job read through an installation, the worker asks the website's
 * `POST /api/worker/installation-token` for `{ jobId, installationId }`, signed with the `v1`
 * scheme (hmac.ts) under a key derived from its current `ENQUEUE_HMAC_SECRET` for
 * {@link TOKEN_REQUEST_PURPOSE}; a `401` to that is asked once more with the previous secret's
 * key, if one is set (a rollover reaches the worker before the website). The website mints a one-repo, read-only token from the job's
 * row; the worker uses it for GitHub's facts and the tarball only, never in the analysis child.
 *
 * - **Never redirected:** the request is sent with `redirect: "error"`, so the signed request
 *   and the token only ever travel between the worker and the configured origin.
 * - **Answers mapped to job failures** (failure.ts):
 *   - `200 { token, expiresAt }` → the token (checked: opaque, visible ASCII, at most
 *     {@link MAX_TOKEN_LENGTH} characters),
 *     with `appId` when the answer has one (a positive safe integer; a post token's, M8.10d).
 *   - `403` `INSTALLATION_SUSPENDED`, `INSTALLATION_NOT_FOUND`, `REPO_NOT_INSTALLED` → the
 *     same code, permanent (the website words each).
 *   - `404` `JOB_NOT_FOUND` → `JOB_NOT_LIVE`, permanent: the row isn't queued or running, so
 *     nothing is left to do for it.
 *   - `5xx` (the app's credentials refused, GitHub down, the route unconfigured or failing) or
 *     no answer at all → `TOKEN_UNAVAILABLE`, retried.
 *   - anything else (a `401` signature refusal, a `400`, an unexpected `403` code, a malformed
 *     `200`) → `TOKEN_REFUSED`, permanent: a retry sends the same request.
 * - When the signal fires, its reason is rethrown; the caller turns it into `CANCELLED` or
 *   `DOWNLOAD_TIMEOUT`.
 *
 * The token is never logged; failure details name only the status and code.
 */

/** The route's path, which is signed with the request. */
export const TOKEN_ROUTE_PATH = "/api/worker/installation-token";
/** The longest token taken; GitHub's stateless ones are ~520 characters (M8.10g). */
export const MAX_TOKEN_LENGTH = 2048;
/** The answer is a token plus under 100 bytes; anything far larger isn't one. */
const MAX_ANSWER_BYTES = 4096;
/**
 * An opaque token: visible ASCII only, so never a header break. GitHub's stateless tokens
 * (`ghs_<app ID>_<JWT>`) hold dots and `-`, and it asks clients not to match its format
 * (M8.10g: the old `[A-Za-z0-9_]{1,255}` refused every one).
 */
const TOKEN = new RegExp(`^[\\x21-\\x7e]{1,${String(MAX_TOKEN_LENGTH)}}$`);
const PERMANENT_403 = new Set([
  "INSTALLATION_SUSPENDED",
  "INSTALLATION_NOT_FOUND",
  "REPO_NOT_INSTALLED",
]);

/** Where and how to ask. */
export interface TokenClientOptions {
  /** The website's origin (`https://gitinside.abhinavgonthina.dev`). */
  origin: string;
  /** The worker's accepted secrets, current first (config.ts); the previous signs only after a `401`. */
  secrets: readonly string[];
  /** The fetch to use (tests). Default the global `fetch`. */
  fetch?: typeof fetch;
  /** The clock (ms) for the signature's timestamp. Default `Date.now`. */
  now?: () => number;
}

/** What a job asks for. */
export interface TokenAsk {
  jobId: string;
  installationId: number;
  /**
   * `"post"` asks for a diff job's write token (M8.6e1): pull requests and checks written, no
   * code read, minted only once the job's diff is recorded and until its Check Run is. Left out,
   * the job's read token, as before (the body then has no `access`).
   */
  access?: "post";
}

/** A token the website minted. */
export interface IssuedToken {
  token: string;
  /**
   * The App's ID, answered with a post token (M8.10d): the comment search accepts only a
   * comment this App wrote (post.ts). Absent from a read token's answer, or from a website
   * older than it.
   */
  appId?: number;
}

/** Asks the website for one job's token; throws a {@link JobFailure} or the signal's reason. */
export type InstallationTokenSource = (ask: TokenAsk, signal: AbortSignal) => Promise<IssuedToken>;

/** A {@link InstallationTokenSource} for the website at `options.origin`. */
export function createTokenClient(options: TokenClientOptions): InstallationTokenSource {
  const [current, ...previous] = options.secrets.map((secret) =>
    derivedSecret(secret, TOKEN_REQUEST_PURPOSE),
  );
  if (current === undefined) throw new Error("a token client needs the signing secret");
  const url = new URL(TOKEN_ROUTE_PATH, options.origin);
  const doFetch = options.fetch ?? fetch;

  /** One signed request with `key`: its status and parsed answer. */
  const ask = async (key: string, body: Uint8Array, signal: AbortSignal) => {
    const headers = signRequest(
      key,
      { method: "POST", path: url.pathname, body },
      (options.now ?? Date.now)(),
    );
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
        redirect: "error",
        signal,
      });
      const text = await response.text();
      const answer = text.length > MAX_ANSWER_BYTES ? undefined : parseJson(text);
      return { status: response.status, answer };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new JobFailure("TOKEN_UNAVAILABLE", "the token request failed", { cause: error });
    }
  };

  return async (job, signal) => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        jobId: job.jobId,
        installationId: job.installationId,
        ...(job.access === "post" && { access: "post" }),
      }),
    );
    // During a rollover the worker may hold the new secret before the website does: a `401`
    // with the current key is tried once more with the previous one.
    let reply = await ask(current, body, signal);
    for (const key of previous) {
      if (reply.status !== 401) break;
      reply = await ask(key, body, signal);
    }
    const { status, answer } = reply;
    if (status === 200) {
      const token = answer?.token;
      if (typeof token !== "string" || !TOKEN.test(token)) {
        throw new JobFailure("TOKEN_REFUSED", "malformed token answer");
      }
      const appId = answer?.appId;
      return typeof appId === "number" && Number.isSafeInteger(appId) && appId > 0
        ? { token, appId }
        : { token };
    }
    const code = typeof answer?.error === "string" ? answer.error : undefined;
    const detail = `the website answered ${String(status)}${code === undefined ? "" : ` ${code}`}`;
    if (status === 403 && code !== undefined && PERMANENT_403.has(code)) {
      throw new JobFailure(code, detail);
    }
    if (status === 404 && code === "JOB_NOT_FOUND") throw new JobFailure("JOB_NOT_LIVE", detail);
    if (status >= 500) throw new JobFailure("TOKEN_UNAVAILABLE", detail);
    throw new JobFailure("TOKEN_REFUSED", detail);
  };
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
