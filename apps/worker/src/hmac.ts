import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Request signing for the enqueue API (docs/SECURITY.md T8, §4; ADR-0060).
 *
 * The web app signs every request with a shared secret; the worker checks it before it reads
 * anything else. The signed text binds the timestamp, method, path (with query), and the raw
 * body bytes, so a captured signature can't be replayed against another job ID or method, and
 * stops working after {@link MAX_CLOCK_SKEW_SECONDS}:
 *
 * ```text
 * v1\n<unix seconds>\n<METHOD>\n<path?query>\n<body bytes>
 * ```
 *
 * Headers: `X-GitInside-Timestamp: <unix seconds>` and `X-GitInside-Signature: v1=<hex>`
 * (HMAC-SHA256). Rotation without downtime: the worker accepts its current secret and,
 * during a rollover, the previous one. This module depends only on `node:crypto`, so the web
 * app can import it (`@gitinside/worker/hmac`) without loading the analyzer.
 */

/** Header carrying the request time in Unix seconds. */
export const TIMESTAMP_HEADER = "x-gitinside-timestamp";
/** Header carrying `v1=<64 lowercase hex>`. */
export const SIGNATURE_HEADER = "x-gitinside-signature";
/** A request is accepted up to 5 minutes either side of the worker's clock. */
export const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
/** Shortest secret accepted (ADR-0055 asks for 32 random bytes, 43 base64url characters). */
export const MIN_SECRET_LENGTH = 32;

const TIMESTAMP = /^[0-9]{1,12}$/;
const SIGNATURE = /^v1=([0-9a-f]{64})$/;

/** What is signed: the request as the worker receives it. */
export interface SignedParts {
  method: string;
  /** The request target exactly as sent (`/jobs/abc?x=1`), which the worker reads from `req.url`. */
  path: string;
  body: Uint8Array;
}

/** Why a request was refused. Safe to return to the caller: none of them reveal a secret. */
export type VerifyFailure =
  | "MISSING_SIGNATURE"
  | "BAD_TIMESTAMP"
  | "STALE_TIMESTAMP"
  | "BAD_SIGNATURE";

function mac(secret: string, timestamp: string, parts: SignedParts): Buffer {
  return createHmac("sha256", secret)
    .update(`v1\n${timestamp}\n${parts.method.toUpperCase()}\n${parts.path}\n`)
    .update(parts.body)
    .digest();
}

/**
 * Sign a request. Returns the two headers to send with it. `nowMs` defaults to the clock;
 * tests pass a fixed time.
 */
export function signRequest(
  secret: string,
  parts: SignedParts,
  nowMs: number = Date.now(),
): Record<typeof TIMESTAMP_HEADER | typeof SIGNATURE_HEADER, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: `v1=${mac(secret, timestamp, parts).toString("hex")}`,
  };
}

/**
 * Check a request's signature headers against every accepted secret, in constant time per
 * secret (`timingSafeEqual` on fixed 32-byte digests). Header values are the raw strings Node
 * gives (`undefined` when absent; a repeated header arrives as an array and is refused).
 */
export function verifyRequest(
  secrets: readonly string[],
  parts: SignedParts,
  headers: { timestamp: unknown; signature: unknown },
  nowMs: number = Date.now(),
): { ok: true } | { ok: false; reason: VerifyFailure } {
  const { timestamp, signature } = headers;
  if (timestamp === undefined || signature === undefined) {
    return { ok: false, reason: "MISSING_SIGNATURE" };
  }
  if (typeof timestamp !== "string" || !TIMESTAMP.test(timestamp)) {
    return { ok: false, reason: "BAD_TIMESTAMP" };
  }
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "STALE_TIMESTAMP" };
  }
  const hex = typeof signature === "string" ? SIGNATURE.exec(signature)?.[1] : undefined;
  if (hex === undefined) return { ok: false, reason: "BAD_SIGNATURE" };
  const given = Buffer.from(hex, "hex");
  let matched = false;
  for (const secret of secrets) {
    // No early exit: every secret is checked, so timing doesn't say which one matched.
    if (timingSafeEqual(mac(secret, timestamp, parts), given)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "BAD_SIGNATURE" };
}

/**
 * Read the accepted secrets from the environment: `ENQUEUE_HMAC_SECRET` (required, the one
 * the web app signs with) and `ENQUEUE_HMAC_SECRET_PREVIOUS` (optional, set only during a
 * rollover). Throws, naming the variable but never its value, if one is missing or short.
 */
export function secretsFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const secrets: string[] = [];
  for (const name of ["ENQUEUE_HMAC_SECRET", "ENQUEUE_HMAC_SECRET_PREVIOUS"]) {
    const value = env[name];
    if (value === undefined || value === "") {
      if (name === "ENQUEUE_HMAC_SECRET") throw new Error(`${name} is not set`);
      continue;
    }
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    secrets.push(value);
  }
  return secrets;
}
