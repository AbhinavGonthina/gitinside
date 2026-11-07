import type { GitHubIdentity } from "@gitinside/db";
import type { GitHubTokens } from "./session";

/**
 * GitHub's user authorization for the GitHub App (ADR-0220, ADR-0221): the web flow with PKCE.
 * Sign-in asks for identity only: a GitHub App's user token has no scopes, and the app
 * requests no account permission, so the token can read the user's profile and what the app
 * itself may see, nothing more.
 *
 * Handled: the authorize URL, the code exchange (`POST /login/oauth/access_token`, JSON), and
 * `GET /user`. Not handled here: refreshing an expired token (the dashboard, M8.2c) and the
 * install flow's `installation_id` on the callback (M8.3).
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

async function call(client: OAuthClient, url: string, init: RequestInit): Promise<unknown> {
  const response = await (client.fetch ?? fetch)(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new SignInError(`HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new SignInError("not JSON");
  }
}

const field = (value: unknown, name: string): unknown =>
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
  const body = await call(client, new URL("/login/oauth/access_token", GITHUB_WEB).href, {
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
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Who the token belongs to (`GET /user`): GitHub's user ID and login. */
export async function fetchIdentity(
  client: OAuthClient,
  accessToken: string,
): Promise<GitHubIdentity> {
  const body = await call(client, new URL("/user", GITHUB_API).href, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  const id = field(body, "id");
  const login = field(body, "login");
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new SignInError("no user ID");
  }
  if (typeof login !== "string" || !LOGIN.test(login)) throw new SignInError("no login");
  return { githubUserId: id, login };
}
