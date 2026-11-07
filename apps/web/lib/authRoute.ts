import {
  createSession,
  deleteSession,
  findSession,
  upsertUser,
  type AnyDatabase,
} from "@gitinside/db";
import {
  authorizeUrl,
  exchangeCode,
  fetchIdentity,
  SignInError,
  type OAuthClient,
} from "./githubOAuth";
import {
  codeChallenge,
  cookie,
  hashToken,
  newToken,
  openTokens,
  readCookie,
  safeReturnTo,
  sameString,
  sealTokens,
  SESSION_COOKIE,
  SESSION_LIFETIME_SECONDS,
  sessionToken,
  signState,
  STATE_COOKIE,
  STATE_LIFETIME_SECONDS,
  verifyState,
  type GitHubTokens,
  type SessionKeys,
} from "./session";

/**
 * Sign-in with GitHub (M8.2, ADR-0221), apart from Next.js so tests call it with a plain
 * `Request`:
 *
 * - `GET /api/auth/github[?returnTo=/path]` sets the signed state cookie and sends the
 *   browser to GitHub's authorize page, with OAuth `state` and a PKCE challenge.
 * - `GET /api/auth/github/callback` checks the state cookie against GitHub's `state`,
 *   exchanges the code, reads who signed in, stores the user and a new session, sets the
 *   session cookie, and returns to `returnTo`. Any failure lands on `/?signin=<reason>`
 *   (`cancelled`, `expired`, `failed`, `unavailable`), signed out; the state cookie is
 *   cleared either way, so a callback can't be replayed.
 * - `POST /api/auth/signout` deletes the session's row and the cookie. Only a same-origin
 *   POST is honored (its `Origin` header must be this site's), so another site can't sign
 *   a visitor out.
 *
 * Every answer is `no-store`; errors are logged by kind only, never with a token or code.
 */

/** What sign-in needs; `undefined` deps mean sign-in isn't configured on this server. */
export interface AuthDeps {
  db: AnyDatabase;
  client: OAuthClient;
  keys: SessionKeys;
  /** The clock for the state cookie's age and token expiry; tests fix it. */
  now?: () => number;
}

/** The callback's path, registered as the app's callback URL (ADR-0220). */
export const CALLBACK_PATH = "/api/auth/github/callback";

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, ...NO_STORE });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status: 303, headers });
}

const clearState = () => cookie(STATE_COOKIE, "", 0);

/** Where a failed sign-in lands, with the reason the landing page explains (M8.2b). */
const failed = (reason: "cancelled" | "expired" | "failed" | "unavailable") =>
  redirect(`/?signin=${reason}`, [clearState()]);

function log(event: string, error?: unknown): void {
  const reason =
    error instanceof SignInError
      ? error.reason
      : error instanceof Error
        ? error.name // a driver's message can carry connection details
        : undefined;
  console.error(JSON.stringify({ event, ...(reason !== undefined && { error: reason }) }));
}

/** A host as a `Host` header carries it: a name or IPv4, or a bracketed IPv6, and a port. */
const HOST = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * The origin the browser used, for the callback URL and the sign-out `Origin` check:
 * `X-Forwarded-Host` (its first entry), else `Host`, with `X-Forwarded-Proto`, each used only
 * if well formed, else the request URL's own. Not `request.url` alone: `next start` gives
 * route handlers `http://localhost:<port>` whatever host was asked for (found in M8.2b's
 * browser check), and a proxy can rewrite it too. A client choosing these headers only
 * changes its own request: GitHub refuses an unregistered callback, and a cross-site form
 * can't set them.
 */
export function siteOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = [forwarded, request.headers.get("host")?.trim()].find(
    (candidate) => candidate !== undefined && HOST.test(candidate),
  );
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const scheme = proto === "http" || proto === "https" ? proto : url.protocol.slice(0, -1);
  return `${scheme}://${host ?? url.host}`;
}

/** `GET /api/auth/github`: start signing in. */
export function handleSignIn(request: Request, deps: AuthDeps | undefined): Response {
  if (deps === undefined) return failed("unavailable");
  const url = new URL(request.url);
  const state = newToken();
  const verifier = newToken();
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const now = (deps.now ?? Date.now)();
  const value = signState(deps.keys, { state, verifier, returnTo, startedAt: now });
  const redirectUri = new URL(CALLBACK_PATH, siteOrigin(request)).href;
  return redirect(authorizeUrl(deps.client.clientId, redirectUri, state, codeChallenge(verifier)), [
    cookie(STATE_COOKIE, value, STATE_LIFETIME_SECONDS),
  ]);
}

/** A code GitHub could have sent: short, URL-safe. */
const CODE = /^[A-Za-z0-9_-]{1,256}$/;

/** `GET /api/auth/github/callback`: finish signing in. */
export async function handleCallback(
  request: Request,
  deps: AuthDeps | undefined,
): Promise<Response> {
  if (deps === undefined) return failed("unavailable");
  const url = new URL(request.url);
  const now = (deps.now ?? Date.now)();
  const cookieValue = readCookie(request.headers.get("cookie"), STATE_COOKIE);
  const saved = verifyState(deps.keys, cookieValue, now);
  if (saved === undefined) return failed(cookieValue === undefined ? "failed" : "expired");
  const state = url.searchParams.get("state");
  if (state === null || !sameString(state, saved.state)) {
    log("signin_state_mismatch");
    return failed("failed");
  }
  if (url.searchParams.get("error") === "access_denied") return failed("cancelled");
  const code = url.searchParams.get("code");
  if (code === null || !CODE.test(code)) return failed("failed");

  try {
    const redirectUri = new URL(CALLBACK_PATH, siteOrigin(request)).href;
    const tokens = await exchangeCode(deps.client, code, redirectUri, saved.verifier, now);
    const identity = await fetchIdentity(deps.client, tokens.accessToken);
    const userId = await upsertUser(deps.db, identity);
    const token = newToken();
    const tokenHash = hashToken(token);
    const lifetime = sessionLifetime(tokens, now);
    await createSession(deps.db, {
      userId,
      tokenHash,
      githubTokens: sealTokens(deps.keys, tokenHash, tokens),
      lifetimeSeconds: lifetime,
    });
    return redirect(saved.returnTo, [cookie(SESSION_COOKIE, token, lifetime), clearState()]);
  } catch (error) {
    log("signin_failed", error);
    return failed("failed");
  }
}

/**
 * {@link SESSION_LIFETIME_SECONDS}, cut to when GitHub's refresh token ends if that's
 * sooner: past it the session couldn't get a new access token.
 */
function sessionLifetime(tokens: GitHubTokens, now: number): number {
  if (tokens.refreshExpiresAt === null) return SESSION_LIFETIME_SECONDS;
  const left = Math.floor((tokens.refreshExpiresAt - now) / 1000);
  return Math.max(1, Math.min(SESSION_LIFETIME_SECONDS, left));
}

/** `POST /api/auth/signout`: end this browser's session. */
export async function handleSignOut(
  request: Request,
  deps: AuthDeps | undefined,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin === null || origin !== siteOrigin(request)) {
    return new Response("Sign out from GitInside's own page.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
    });
  }
  const token = sessionToken(request.headers.get("cookie"));
  if (token !== undefined && deps !== undefined) {
    try {
      await deleteSession(deps.db, hashToken(token));
    } catch (error) {
      log("signout_failed", error);
      return redirect("/?signout=failed");
    }
  }
  return redirect("/", [cookie(SESSION_COOKIE, "", 0)]);
}

/** The signed-in user, as a page or route sees them. */
export interface SignedInUser {
  userId: string;
  githubUserId: number;
  login: string;
  /** The user's GitHub tokens, or `undefined` if they no longer open (a rotated secret). */
  tokens: () => GitHubTokens | undefined;
}

/**
 * Who sent `cookieHeader`, if it holds a live session; `undefined` when signed out, not
 * configured, or the database can't be read (a page then renders signed out, not broken).
 */
export async function readSession(
  cookieHeader: string | null,
  deps: AuthDeps | undefined,
): Promise<SignedInUser | undefined> {
  const token = sessionToken(cookieHeader);
  if (token === undefined || deps === undefined) return undefined;
  const tokenHash = hashToken(token);
  try {
    const found = await findSession(deps.db, tokenHash);
    if (found === undefined) return undefined;
    const { userId, githubUserId, login, githubTokens } = found;
    return {
      userId,
      githubUserId,
      login,
      tokens: () => openTokens(deps.keys, tokenHash, githubTokens),
    };
  } catch (error) {
    log("session_read_failed", error);
    return undefined;
  }
}
