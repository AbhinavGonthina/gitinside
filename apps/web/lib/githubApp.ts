import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { field, GITHUB_API, LOGIN } from "./githubOAuth";

/**
 * The GitHub App acting as itself (M8.3c1, ADR-0226): a JSON Web Token signed with the app's
 * private key, traded for a short-lived **installation token** that a private job's download
 * uses. The key stays in Vercel (ADR-0220); the worker asks the website for one token per job
 * (M8.3c3) and never holds the key.
 *
 * Handled:
 * - **The app's JWT** ({@link appJwt}): RS256, `iss` the App ID, issued 60 s in the past (GitHub's
 *   advice for clock drift) and expiring 9 minutes later (GitHub refuses more than 10).
 * - **One token per repo** ({@link mintInstallationToken}): `POST
 *   /app/installations/{id}/access_tokens` asks for that one repository with `contents: read`
 *   and `metadata: read` only ({@link JOB_PERMISSIONS}), so a token that leaks reads one repo for
 *   at most an hour, even on an installation granting more. The PR bot's post asks for its own
 *   set instead ({@link POST_PERMISSIONS}, M8.6e1): pull requests and checks written, metadata
 *   read, and no code. The answer must name exactly that repository and grant nothing beyond
 *   what was asked, else it's refused rather than used.
 * - **Refusals named** ({@link InstallationTokenError}): a suspended installation (a `403`, then
 *   `GET /app/installations/{id}` reads `suspended_at`, since GitHub's message text isn't a
 *   contract), an installation that's gone (`404`), a repo it doesn't cover (`422`), the app's
 *   own credentials refused (`401`), and GitHub unreachable or out of shape. GitHub also answers
 *   `422` when the installation hasn't granted a permission asked for (an owner who hasn't
 *   accepted the bot's write permissions); that is `REPO_NOT_INSTALLED` too, refused either way.
 *
 * Not handled: caching tokens (each private job asks once, and a cached token would outlive a
 * repo's removal from the installation by up to an hour); tokens for several repos at once.
 */

/** How long one call to GitHub may take. */
const TIMEOUT_MS = 10_000;
/** The JWT's `iat` is set this far in the past (GitHub's advice for clock drift). */
export const JWT_BACKDATE_SECONDS = 60;
/** The JWT's lifetime from `iat`; GitHub refuses more than 10 minutes. */
export const JWT_LIFETIME_SECONDS = 10 * 60 - 60;
/** A set of permissions to ask a token for: GitHub's permission names and levels. */
export type TokenPermissions = Readonly<Record<string, "read" | "write">>;
/** The only permissions a job's read token asks for. */
export const JOB_PERMISSIONS = { contents: "read", metadata: "read" } as const;
/**
 * The only permissions a diff job's post token asks for (M8.6e1, SPEC §3): the comment needs
 * `pull_requests: write` (GitHub accepts it for a pull request's issue comments), the Check Run
 * `checks: write`; `metadata: read` is granted with any token. No `contents`: posting reads no code.
 */
export const POST_PERMISSIONS = {
  pull_requests: "write",
  checks: "write",
  metadata: "read",
} as const;

/** The app's own credentials, from `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. */
export interface AppCredentials {
  /** GitHub's App ID, digits only. */
  appId: string;
  /** The app's RSA private key. */
  privateKey: KeyObject;
  /** Tests pass a fake GitHub; production uses the global `fetch`. */
  fetch?: typeof fetch;
  /** The E2E's loopback fake GitHub instead of `api.github.com` (`fakeOrigin`, ADR-0223). */
  fakeOrigin?: string;
}

/** Why an installation token couldn't be had. */
export type InstallationTokenCode =
  /** The account's owner suspended the installation; GitHub issues no tokens for it. */
  | "INSTALLATION_SUSPENDED"
  /** No such installation (uninstalled, or never ours). */
  | "INSTALLATION_NOT_FOUND"
  /** The installation exists but doesn't cover this repo (removed from its selection). */
  | "REPO_NOT_INSTALLED"
  /** GitHub refused the app's own JWT: a wrong App ID or key (a configuration error). */
  | "APP_AUTH_FAILED"
  /** GitHub couldn't be reached, timed out, failed, or answered out of shape. */
  | "GITHUB_UNAVAILABLE";

/** Thrown by {@link mintInstallationToken}; `reason` is for logs and holds no token or name. */
export class InstallationTokenError extends Error {
  override name = "InstallationTokenError";
  constructor(
    readonly code: InstallationTokenCode,
    readonly reason: string,
  ) {
    super(`installation token: ${code} (${reason})`);
  }
}

/** A token for one repo of one installation. */
export interface InstallationToken {
  token: string;
  /** When GitHub says it stops working (ms since the epoch); at most an hour away. */
  expiresAt: number;
}

/** A repo by owner and name, as a job names it. */
export interface RepoName {
  owner: string;
  name: string;
}

/** `GITHUB_APP_ID`'s form: GitHub's App IDs are positive integers. */
const APP_ID = /^[1-9]\d{0,15}$/;
/** A repo name as GitHub allows it. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The app's credentials from its env values, or `undefined` if either is missing, the ID
 * isn't a positive integer, or the key isn't an RSA private key in PEM (GitHub issues RSA keys
 * only). A key pasted with literal `\n` sequences and no line breaks (one-line env editors) is
 * read with them as line breaks.
 */
export function appCredentials(
  appId: string | undefined,
  pem: string | undefined,
): Omit<AppCredentials, "fetch" | "fakeOrigin"> | undefined {
  if (!appId || !APP_ID.test(appId) || !pem) return undefined;
  const text = pem.includes("\n") ? pem : pem.replaceAll("\\n", "\n");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: text, format: "pem" });
  } catch {
    return undefined;
  }
  if (privateKey.asymmetricKeyType !== "rsa") return undefined;
  return { appId, privateKey };
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The app's JWT at `now` (ms): RS256 over `{ iat, exp, iss }`. */
export function appJwt(app: Pick<AppCredentials, "appId" | "privateKey">, now: number): string {
  const iat = Math.floor(now / 1000) - JWT_BACKDATE_SECONDS;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat, exp: iat + JWT_LIFETIME_SECONDS, iss: app.appId }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), app.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** One call to GitHub's API as the app; the response, or a `GITHUB_UNAVAILABLE` throw. */
async function appCall(
  app: AppCredentials,
  path: string,
  now: number,
  init: { method: "GET" } | { method: "POST"; body: unknown },
): Promise<Response> {
  const url = new URL(path, app.fakeOrigin ?? GITHUB_API).href;
  try {
    return await (app.fetch ?? fetch)(url, {
      method: init.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt(app, now)}`,
        "x-github-api-version": "2022-11-28",
        ...(init.method === "POST" && { "content-type": "application/json" }),
      },
      ...(init.method === "POST" && { body: JSON.stringify(init.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new InstallationTokenError("GITHUB_UNAVAILABLE", `${init.method} request failed`);
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new InstallationTokenError("GITHUB_UNAVAILABLE", "not JSON");
  }
}

/** Why GitHub answered `403` to a token request: a suspension, or something else. */
async function forbiddenCode(
  app: AppCredentials,
  installationId: number,
  now: number,
): Promise<InstallationTokenError> {
  const response = await appCall(app, `/app/installations/${installationId}`, now, {
    method: "GET",
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return new InstallationTokenError("INSTALLATION_NOT_FOUND", "HTTP 404 after 403");
  }
  if (!response.ok) {
    await response.body?.cancel();
    return new InstallationTokenError("GITHUB_UNAVAILABLE", `HTTP ${response.status} after 403`);
  }
  const suspended = field(await json(response), "suspended_at");
  return typeof suspended === "string"
    ? new InstallationTokenError("INSTALLATION_SUSPENDED", "suspended_at set")
    : new InstallationTokenError("GITHUB_UNAVAILABLE", "HTTP 403, not suspended");
}

const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Whether `permissions` grants something and nothing beyond `asked`: each granted name asked
 * for, at the level asked (a `write` where `read` was asked is more, a `read` where `write` was
 * asked is GitHub granting less than the token needs).
 */
function onlyAsked(permissions: unknown, asked: TokenPermissions): boolean {
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return false;
  }
  const granted = Object.entries(permissions as Record<string, unknown>);
  return (
    granted.length > 0 &&
    granted.every(([name, level]) => Object.hasOwn(asked, name) && level === asked[name])
  );
}

/**
 * An installation token for `repo` alone with `permissions` (default {@link JOB_PERMISSIONS},
 * reading only; {@link POST_PERMISSIONS} for the PR bot's post), from installation
 * `installationId`. Throws {@link InstallationTokenError} naming why not.
 */
export async function mintInstallationToken(
  app: AppCredentials,
  installationId: number,
  repo: RepoName,
  now: number,
  permissions: TokenPermissions = JOB_PERMISSIONS,
): Promise<InstallationToken> {
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw new Error("installationId must be a positive integer");
  }
  if (
    !LOGIN.test(repo.owner) ||
    !REPO_NAME.test(repo.name) ||
    repo.name === "." ||
    repo.name === ".."
  ) {
    throw new Error("repo is not a GitHub owner and name");
  }
  const response = await appCall(app, `/app/installations/${installationId}/access_tokens`, now, {
    method: "POST",
    body: { repositories: [repo.name], permissions },
  });
  if (response.status !== 201) {
    await response.body?.cancel();
    switch (response.status) {
      case 401:
        throw new InstallationTokenError("APP_AUTH_FAILED", "HTTP 401");
      case 403:
        throw await forbiddenCode(app, installationId, now);
      case 404:
        throw new InstallationTokenError("INSTALLATION_NOT_FOUND", "HTTP 404");
      case 422:
        throw new InstallationTokenError("REPO_NOT_INSTALLED", "HTTP 422");
      default:
        throw new InstallationTokenError("GITHUB_UNAVAILABLE", `HTTP ${response.status}`);
    }
  }
  const body = await json(response);
  const token = field(body, "token");
  const expiresAt = Date.parse(String(field(body, "expires_at")));
  const repositories = field(body, "repositories");
  if (typeof token !== "string" || token === "" || token.length > 1_024) {
    throw new InstallationTokenError("GITHUB_UNAVAILABLE", "no token");
  }
  if (Number.isNaN(expiresAt) || expiresAt <= now) {
    throw new InstallationTokenError("GITHUB_UNAVAILABLE", "no future expires_at");
  }
  // GitHub narrows to what's asked; anything else means the token isn't the one asked for.
  const only = Array.isArray(repositories) && repositories.length === 1 ? repositories[0] : null;
  if (
    !same(field(only, "name"), repo.name) ||
    !same(field(field(only, "owner"), "login"), repo.owner)
  ) {
    throw new InstallationTokenError("GITHUB_UNAVAILABLE", "token for other repositories");
  }
  if (!onlyAsked(field(body, "permissions"), permissions)) {
    throw new InstallationTokenError("GITHUB_UNAVAILABLE", "token grants other than asked");
  }
  return { token, expiresAt };
}
