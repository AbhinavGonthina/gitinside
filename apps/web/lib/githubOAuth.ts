import type { GitHubIdentity } from "@gitinside/db";
import type { GitHubTokens } from "./session";

/**
 * GitHub's user authorization for the GitHub App (ADR-0220, ADR-0221): the web flow with PKCE.
 * Sign-in asks for identity only: a GitHub App's user token has no scopes, and the app
 * requests no account permission, so the token can read the user's profile and what the app
 * itself may see, nothing more.
 *
 * Handled: the authorize URL, the code exchange (`POST /login/oauth/access_token`, JSON),
 * refreshing an expired token (the same endpoint, `grant_type=refresh_token`; M8.2c), and
 * `GET /user`. Not handled here: the install flow's `installation_id` on the callback (M8.3).
 */

export const GITHUB_WEB = "https://github.com";
export const GITHUB_API = "https://api.github.com";

/** How long one call to GitHub may take before sign-in gives up. */
const TIMEOUT_MS = 10_000;

/** The app's OAuth client, as Vercel's `GITHUB_APP_CLIENT_*` give it. */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  /** Tests pass a fake GitHub; production uses the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Where the server's own calls go instead of `github.com` and `api.github.com`: the E2E's
   * fake GitHub (`e2e/github.ts`). Only a loopback origin is accepted ({@link fakeOrigin});
   * the browser is still sent to the real authorize page.
   */
  fakeOrigin?: string;
}

/**
 * `value` if it's an `http://127.0.0.1:<port>` or `http://localhost:<port>` origin, else
 * `undefined`: a misconfigured server can't send the client secret or a user's token anywhere
 * but its own machine.
 */
export function fakeOrigin(value: string | undefined): string | undefined {
  return value !== undefined && /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(value)
    ? value
    : undefined;
}

/** `path` on GitHub's site (`web`) or API (`api`), or on the client's fake GitHub. */
export function githubUrl(client: OAuthClient, host: "web" | "api", path: string): string {
  return new URL(path, client.fakeOrigin ?? (host === "web" ? GITHUB_WEB : GITHUB_API)).href;
}

/** The headers of a REST call to GitHub's API with the user's token. */
export function apiHeaders(accessToken: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "x-github-api-version": "2022-11-28",
  };
}

/** Where to send the browser to sign in (GitHub's authorize page). */
export function authorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const url = new URL("/login/oauth/authorize", GITHUB_WEB);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

/** A failed call to GitHub during sign-in; `reason` is logged, never shown with a value. */
export class SignInError extends Error {
  constructor(readonly reason: string) {
    super(`GitHub sign-in failed: ${reason}`);
    this.name = "SignInError";
  }
}

/**
 * GitHub refused the user's token or refresh token (a 401, or the token endpoint's `error`
 * for a refresh): it won't work again, so the session holding it has ended. Every other
 * {@link SignInError} (a timeout, a 5xx) may pass, and a page says to try again.
 */
export class TokenRefusedError extends SignInError {
  constructor(reason: string) {
    super(reason);
    this.name = "TokenRefusedError";
  }
}

/** One call to GitHub, read as JSON; any failure throws a {@link SignInError}. */
export async function call(client: OAuthClient, url: string, init: RequestInit): Promise<unknown> {
  const response = await (client.fetch ?? fetch)(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401) throw new TokenRefusedError("HTTP 401");
  if (!response.ok) throw new SignInError(`HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new SignInError("not JSON");
  }
}

/** `value[name]` when `value` is an object, else `undefined`. */
export const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;

/** Seconds from now as an absolute time, or null when GitHub didn't give a positive number. */
function expiry(seconds: unknown, now: number): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? now + seconds * 1000
    : null;
}

/**
 * Exchange the callback's `code` for the user's tokens. GitHub answers a bad code with 200
 * and an `error` field, which throws like any other failure.
 */
export async function exchangeCode(
  client: OAuthClient,
  code: string,
  redirectUri: string,
  verifier: string,
  now: number,
): Promise<GitHubTokens> {
  const body = await call(client, githubUrl(client, "web", "/login/oauth/access_token"), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const error = field(body, "error");
  if (typeof error === "string") throw new SignInError(`exchange refused (${error.slice(0, 64)})`);
  return readTokens(body, now);
}

/**
 * Trade the user's refresh token for new tokens (M8.2c). GitHub's refresh tokens are single
 * use: the answer carries a new one. A refusal (`bad_refresh_token`, or the app's
 * authorization revoked) throws {@link TokenRefusedError}.
 */
export async function refreshTokens(
  client: OAuthClient,
  refreshToken: string,
  now: number,
): Promise<GitHubTokens> {
  const body = await call(client, githubUrl(client, "web", "/login/oauth/access_token"), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const error = field(body, "error");
  if (typeof error === "string") {
    throw new TokenRefusedError(`refresh refused (${error.slice(0, 64)})`);
  }
  return readTokens(body, now);
}

/** The tokens in a token endpoint's answer. */
function readTokens(body: unknown, now: number): GitHubTokens {
  const accessToken = field(body, "access_token");
  if (typeof accessToken !== "string" || accessToken === "" || accessToken.length > 1_024) {
    throw new SignInError("no access token");
  }
  const refreshToken = field(body, "refresh_token");
  const hasRefresh = typeof refreshToken === "string" && refreshToken !== "";
  return {
    accessToken,
    accessExpiresAt: expiry(field(body, "expires_in"), now),
    refreshToken: hasRefresh ? refreshToken : null,
    refreshExpiresAt: hasRefresh ? expiry(field(body, "refresh_token_expires_in"), now) : null,
  };
}

/** GitHub logins: letters, digits, and single hyphens inside, at most 39 characters. */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Who the token belongs to (`GET /user`): GitHub's user ID and login. */
export async function fetchIdentity(
  client: OAuthClient,
  accessToken: string,
): Promise<GitHubIdentity> {
  const body = await call(client, githubUrl(client, "api", "/user"), {
    headers: apiHeaders(accessToken),
  });
  const id = field(body, "id");
  const login = field(body, "login");
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new SignInError("no user ID");
  }
  if (typeof login !== "string" || !LOGIN.test(login)) throw new SignInError("no login");
  return { githubUserId: id, login };
}
