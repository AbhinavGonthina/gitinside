import {
  createSession,
  DeletedInstallationError,
  deleteSession,
  findSession,
  replaceSessionTokens,
  upsertInstallation,
  upsertUser,
  type AnyDatabase,
} from "@gitinside/db";
import {
  authorizeUrl,
  exchangeCode,
  fetchIdentity,
  refreshTokens,
  SignInError,
  TokenRefusedError,
  type OAuthClient,
} from "./githubOAuth";
import { findUserInstallation } from "./installations";
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
 *   cleared either way, so a callback can't be replayed. GitHub's return from installing the
 *   app comes here too (`setup_action`), handled apart: {@link handleInstallReturn}.
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
  /** The app's URL name (`GITHUB_APP_SLUG`), for "Install on more repos"; unset hides it. */
  appSlug?: string;
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
  if (url.searchParams.has("setup_action")) return handleInstallReturn(request, url, deps);
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

/** Sign-in's start (`handleSignIn`), as the site header links it. */
const SIGN_IN_PATH = "/api/auth/github";

/** An installation ID as GitHub writes it: a positive integer, no leading zero. */
const INSTALLATION_ID = /^[1-9][0-9]{0,15}$/;

/**
 * GitHub's return from installing the app or changing an installation (M8.3b, ADR-0225).
 * With "Request user authorization during installation" on (ADR-0220), GitHub comes back to
 * the callback with `installation_id`, `setup_action` (`install`, `update`, or `request` when
 * an organization member asked its owners), and a `code`, but never our `state`: the flow
 * started on GitHub. Anyone can link to such a URL, so nothing in it is trusted:
 *
 * - The `code` is never exchanged. Without our state it could be anyone's, and redeeming it
 *   would sign the visitor in as that account (login CSRF; ADR-0221 checks state for this).
 * - Signed out, the visitor signs in through our own flow (state, PKCE) and comes back here
 *   with `after=signin`; still signed out then, sign-in failed, and that's said, not looped.
 * - Signed in, the installation counts only if GitHub lists it among the user's own
 *   (`GET /user/installations` with their token), and it's stored from that answer: account
 *   ID, login, type, suspension. One the user can't see changes nothing, and neither does one
 *   uninstalled since GitHub answered (its tombstone, M8.10e2a): both are `unverified`.
 *
 * Every outcome lands on `/dashboard?install=<outcome>` (`installed`/`updated` name the
 * installation for the note), except an ended GitHub sign-in (`/?signin=ended`, as the
 * dashboard does) and an unconfigured server (`/?signin=unavailable`, by the caller).
 */
async function handleInstallReturn(request: Request, url: URL, deps: AuthDeps): Promise<Response> {
  const action = url.searchParams.get("setup_action");
  if (action === "request") return redirect("/dashboard?install=requested");
  const idText = url.searchParams.get("installation_id") ?? "";
  const installationId = Number(idText);
  if (
    (action !== "install" && action !== "update") ||
    !INSTALLATION_ID.test(idText) ||
    !Number.isSafeInteger(installationId)
  ) {
    return redirect("/dashboard");
  }

  const user = await readSession(request.headers.get("cookie"), deps);
  if (user === undefined) {
    if (url.searchParams.get("after") === "signin") return failed("failed");
    const back = `${CALLBACK_PATH}?installation_id=${installationId}&setup_action=${action}&after=signin`;
    return redirect(`${SIGN_IN_PATH}?returnTo=${encodeURIComponent(back)}`);
  }
  const access = await userAccessToken(user, deps);
  if ("ended" in access) return redirect("/?signin=ended");
  if ("error" in access) return redirect("/dashboard?install=failed");
  try {
    const facts = await findUserInstallation(deps.client, access.token, installationId);
    if (facts === undefined) {
      log("install_return_unverified");
      return redirect("/dashboard?install=unverified");
    }
    await upsertInstallation(deps.db, facts);
    const outcome = action === "install" ? "installed" : "updated";
    return redirect(`/dashboard?install=${outcome}&installation=${installationId}`);
  } catch (error) {
    if (error instanceof DeletedInstallationError) {
      // Uninstalled since GitHub answered (M8.10e2a): it isn't the user's any more.
      log("install_return_deleted");
      return redirect("/dashboard?install=unverified");
    }
    if (error instanceof TokenRefusedError) {
      // Revoked on GitHub (the user removed the app's authorization): the session is over.
      const ended = await endUserSession(user, deps, "session_token_refused");
      return redirect("ended" in ended ? "/?signin=ended" : "/dashboard?install=failed");
    }
    log("install_return_failed", error);
    return redirect("/dashboard?install=failed");
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
  /** The session's token hash and sealed tokens as read, for {@link userAccessToken}. */
  session: { tokenHash: string; sealedTokens: string };
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
      session: { tokenHash, sealedTokens: githubTokens },
    };
  } catch (error) {
    log("session_read_failed", error);
    return undefined;
  }
}

/** A user token renewed this close to its end is refreshed first, so a call can't outlive it. */
export const REFRESH_MARGIN_MS = 60_000;

/**
 * What {@link userAccessToken} found: a token to call GitHub with; `ended` when the session
 * can't get one any more (it has been deleted, so the visitor is signed out); or `error` when
 * GitHub or the database couldn't be reached, which may pass.
 */
export type AccessTokenResult = { token: string } | { ended: true } | { error: true };

/**
 * The user's GitHub access token, refreshed first when it ends within
 * {@link REFRESH_MARGIN_MS} (ADR-0223). A refreshed pair replaces the stored one only if the
 * session still holds what was read ({@link replaceSessionTokens}): of two requests refreshing
 * at once, the one that loses reads the winner's tokens instead of signing the user out with
 * an already spent refresh token. The session ends ({@link endUserSession}) when its tokens
 * don't open (a rotated `SESSION_SECRET`), the refresh token has ended, or GitHub refuses it.
 */
export async function userAccessToken(
  user: SignedInUser,
  deps: AuthDeps,
): Promise<AccessTokenResult> {
  const now = (deps.now ?? Date.now)();
  const { tokenHash, sealedTokens } = user.session;
  const tokens = openTokens(deps.keys, tokenHash, sealedTokens);
  if (tokens === undefined) return endUserSession(user, deps, "session_tokens_unreadable");
  if (tokens.accessExpiresAt === null || tokens.accessExpiresAt - now > REFRESH_MARGIN_MS) {
    return { token: tokens.accessToken };
  }
  if (
    tokens.refreshToken === null ||
    (tokens.refreshExpiresAt !== null && tokens.refreshExpiresAt <= now)
  ) {
    return endUserSession(user, deps, "session_refresh_ended");
  }
  try {
    const fresh = await refreshTokens(deps.client, tokens.refreshToken, now);
    const sealed = sealTokens(deps.keys, tokenHash, fresh);
    if (await replaceSessionTokens(deps.db, tokenHash, sealedTokens, sealed)) {
      return { token: fresh.accessToken };
    }
    return await storedToken(user, deps, now);
  } catch (error) {
    if (!(error instanceof TokenRefusedError)) {
      log("session_refresh_failed", error);
      return { error: true };
    }
    try {
      // Another request may have spent the refresh token first and stored the new pair.
      return await storedToken(user, deps, now);
    } catch (readError) {
      log("session_refresh_failed", readError);
      return { error: true };
    }
  }
}

/**
 * How long (ms) to wait before each re-read when a refresh was refused but the session still
 * holds the tokens it was read with: the request that spent the refresh token first may not
 * have stored the new pair yet. About a second in all, then the session ends.
 */
const REFRESH_RACE_WAITS = [0, 150, 300, 600];

/**
 * The access token the session now stores, if another request refreshed it since `user` was
 * read and it's still good; otherwise the session ends.
 */
async function storedToken(
  user: SignedInUser,
  deps: AuthDeps,
  now: number,
): Promise<AccessTokenResult> {
  const { tokenHash, sealedTokens } = user.session;
  for (const wait of REFRESH_RACE_WAITS) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const found = await findSession(deps.db, tokenHash);
    if (found === undefined) break; // signed out meanwhile
    if (found.githubTokens === sealedTokens) continue;
    const tokens = openTokens(deps.keys, tokenHash, found.githubTokens);
    if (
      tokens !== undefined &&
      (tokens.accessExpiresAt === null || tokens.accessExpiresAt - now > REFRESH_MARGIN_MS)
    ) {
      return { token: tokens.accessToken };
    }
    break;
  }
  return endUserSession(user, deps, "session_refresh_refused");
}

/**
 * End `user`'s session because its GitHub tokens no longer work (`event` says why, logged):
 * the row goes, so every page reads the visitor as signed out from now on.
 */
export async function endUserSession(
  user: SignedInUser,
  deps: AuthDeps,
  event: string,
): Promise<AccessTokenResult> {
  log(event);
  try {
    await deleteSession(deps.db, user.session.tokenHash);
  } catch (error) {
    log("session_end_failed", error);
    return { error: true };
  }
  return { ended: true };
}
