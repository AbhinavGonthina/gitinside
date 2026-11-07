import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Sign-in sessions (M8.2, ADR-0221): the cookies, and the keys `SESSION_SECRET` gives.
 *
 * - **The session cookie** holds 32 random bytes (base64url) and nothing else. The database
 *   stores only their SHA-256 ({@link hashToken}), so a leaked table signs nobody in, and
 *   signing out deletes the row, which ends the session everywhere at once.
 * - **The user's GitHub tokens** are sealed with AES-256-GCM before they're stored
 *   ({@link sealTokens}), under a key derived from `SESSION_SECRET` and bound to the
 *   session's hash, so a sealed value copied to another row doesn't open.
 * - **The sign-in state cookie** carries the OAuth `state`, the PKCE verifier, and where to
 *   return, signed (HMAC-SHA256 under a second derived key) and valid for 10 minutes.
 *
 * Both cookies are `__Host-` (Secure, `Path=/`, no `Domain`), `HttpOnly`, and
 * `SameSite=Lax`: GitHub's redirect back is a top-level navigation, which Lax lets through.
 */

/** The session cookie's name. */
export const SESSION_COOKIE = "__Host-gi_session";
/** The sign-in state cookie's name. */
export const STATE_COOKIE = "__Host-gi_signin";
/** How long a session lasts: 30 days, or less if GitHub's refresh token ends sooner. */
export const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
/** How long a sign-in may take between leaving for GitHub and coming back. */
export const STATE_LIFETIME_SECONDS = 10 * 60;

/** The two keys derived from `SESSION_SECRET`. */
export interface SessionKeys {
  /** AES-256-GCM key for the stored GitHub tokens. */
  seal: Buffer;
  /** HMAC-SHA256 key for the sign-in state cookie. */
  state: Buffer;
}

/** Derive {@link SessionKeys} from `SESSION_SECRET` (HKDF-SHA256, one label per use). */
export function sessionKeys(secret: string): SessionKeys {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", secret, "gitinside", info, 32));
  return { seal: derive("session tokens v1"), state: derive("sign-in state v1") };
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** A new random token: 32 bytes, base64url (43 characters). */
export function newToken(): string {
  return base64url(randomBytes(32));
}

/** A token as {@link newToken} makes it; anything else in a cookie is ignored unread. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 of a token, lowercase hex: what the database stores. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** PKCE's S256 challenge for `verifier` (RFC 7636). */
export function codeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** The value of the cookie `name` in a `Cookie` header, if present. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** The session token in a `Cookie` header, if it's well formed. */
export function sessionToken(cookieHeader: string | null): string | undefined {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  return token !== undefined && TOKEN.test(token) ? token : undefined;
}

/** A `Set-Cookie` value for `name`; `maxAge` 0 deletes it. */
export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** The user's GitHub tokens, as the code exchange gave them (M8.2c refreshes them). */
export interface GitHubTokens {
  accessToken: string;
  /** When the access token ends (ms since the epoch), or null if it doesn't. */
  accessExpiresAt: number | null;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
}

const SEALED = /^v1\.([A-Za-z0-9_-]+)$/;

/** Seal `tokens` for the session whose token hashes to `tokenHash`. */
export function sealTokens(keys: SessionKeys, tokenHash: string, tokens: GitHubTokens): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.seal, iv);
  cipher.setAAD(Buffer.from(tokenHash));
  const body = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return `v1.${base64url(Buffer.concat([iv, body, cipher.getAuthTag()]))}`;
}

/**
 * Open what {@link sealTokens} sealed for `tokenHash`; `undefined` if it was sealed under
 * another key or for another session, or changed.
 */
export function openTokens(
  keys: SessionKeys,
  tokenHash: string,
  sealed: string,
): GitHubTokens | undefined {
  const match = SEALED.exec(sealed);
  if (!match?.[1]) return undefined;
  const bytes = Buffer.from(match[1], "base64url");
  if (bytes.length < 12 + 16) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keys.seal, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(tokenHash));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const text = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(text) as GitHubTokens;
  } catch {
    return undefined;
  }
}

/** What the sign-in state cookie remembers between leaving for GitHub and coming back. */
export interface SignInState {
  /** OAuth `state`: GitHub sends it back, and it must match. */
  state: string;
  /** The PKCE verifier whose challenge went to GitHub. */
  verifier: string;
  /** Where to go once signed in: a path on this site ({@link safeReturnTo}). */
  returnTo: string;
  /** When sign-in started (ms since the epoch). */
  startedAt: number;
}

function mac(keys: SessionKeys, payload: string): Buffer {
  return createHmac("sha256", keys.state).update(payload).digest();
}

/** The state cookie's value: the JSON, base64url, then its MAC. */
export function signState(keys: SessionKeys, state: SignInState): string {
  const payload = base64url(Buffer.from(JSON.stringify(state), "utf8"));
  return `${payload}.${base64url(mac(keys, payload))}`;
}

/**
 * The state in a cookie {@link signState} made, if its MAC holds, it's well formed, and it
 * started at most {@link STATE_LIFETIME_SECONDS} before `now`.
 */
export function verifyState(
  keys: SessionKeys,
  value: string | undefined,
  now: number,
): SignInState | undefined {
  if (value === undefined || value.length > 2_048) return undefined;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  const given = Buffer.from(signature, "base64url");
  const expected = mac(keys, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let state: unknown;
  try {
    state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    typeof state !== "object" ||
    state === null ||
    !("state" in state && typeof state.state === "string" && TOKEN.test(state.state)) ||
    !("verifier" in state && typeof state.verifier === "string" && TOKEN.test(state.verifier)) ||
    !("returnTo" in state && typeof state.returnTo === "string") ||
    !("startedAt" in state && typeof state.startedAt === "number")
  ) {
    return undefined;
  }
  const age = now - state.startedAt;
  if (!(age >= 0 && age <= STATE_LIFETIME_SECONDS * 1000)) return undefined;
  return {
    state: state.state,
    verifier: state.verifier,
    returnTo: safeReturnTo(state.returnTo),
    startedAt: state.startedAt,
  };
}

/** Whether two strings are equal, in time that doesn't depend on where they differ. */
export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * `returnTo` if it's a path on this site, else `/`: it must start with one `/` (not `//`
 * or `/\`, which browsers read as another host), hold no control characters or backslashes,
 * and stay short. Never an absolute URL, so sign-in can't send anyone elsewhere.
 */
export function safeReturnTo(returnTo: string | null | undefined): string {
  if (
    typeof returnTo !== "string" ||
    returnTo.length > 512 ||
    !/^\/(?![/\\])/.test(returnTo) ||
    [...returnTo].some((c) => c === "\\" || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  ) {
    return "/";
  }
  return returnTo;
}
