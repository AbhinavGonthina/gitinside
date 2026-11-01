import { consumeRateLimit, peekRateLimit, type AnyDatabase } from "@gitinside/db";
import { TURNSTILE_ACTION } from "./turnstile";

/**
 * The bot check on Analyze (#11, ADR-0157): Cloudflare Turnstile in Managed mode (free, no
 * card), asked for only when traffic looks automated, so most visitors never see it.
 *
 * - **When:** before a new analysis (never for a finished diagram or a commit in flight),
 *   once the caller's address has started {@link CHALLENGE_AFTER_PER_ADDRESS} new analyses
 *   this hour, or the whole site has had {@link CHALLENGE_AFTER_SITE} requests for new
 *   analyses this hour (fixed UTC-hour windows in `rate_limits`, the address's being the
 *   hourly limit's own count).
 * - **How:** the answer is `403 CHALLENGE_REQUIRED` with the widget's public site key; the
 *   form shows the widget and sends its token back with the URL. The token is checked here
 *   with Cloudflare's `siteverify` (secret key, the widget's action); Cloudflare refuses a
 *   token used twice or older than 5 minutes.
 * - **Failing visibly:** a token that doesn't pass is `403 CHALLENGE_FAILED`; Cloudflare not
 *   answering is `503 CHALLENGE_UNAVAILABLE`. Both say what to do. Nothing goes through
 *   unchecked once a check is needed, since the check is only asked for under suspicious
 *   traffic.
 * - **Not checked:** the token's hostname (Cloudflare only issues the widget on the hostnames
 *   it's configured for) and the visitor's IP (not sent to Cloudflare).
 */

/** Cloudflare's server-side token check. */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Cloudflare's longest token. */
export const MAX_TOKEN_LENGTH = 2_048;
/** New analyses an address starts in an hour before the next one needs the check. */
export const CHALLENGE_AFTER_PER_ADDRESS = 2;
/** Requests for new analyses site-wide in an hour before everyone gets the check. */
export const CHALLENGE_AFTER_SITE = 20;
/** The site-wide count's `rate_limits` key (never a hashed address, which starts with `ip:`). */
export const SITE_ANALYZE_KEY = "site:analyze";
/** How long Cloudflare gets to answer. */
export const VERIFY_TIMEOUT_MS = 5_000;

/** What {@link BotCheck.verify} found. */
export type Verdict = "passed" | "failed" | "unavailable";

/** A configured Turnstile widget: its public site key and the server-side check. */
export interface BotCheck {
  siteKey: string;
  verify(token: string): Promise<Verdict>;
}

/** Cloudflare's answer codes that mean the fault is ours or theirs, not the visitor's. */
const NOT_THE_VISITORS = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "internal-error",
]);

/** A {@link BotCheck} on Cloudflare's `siteverify` with the widget's secret key. */
export function createTurnstile(options: {
  siteKey: string;
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): BotCheck {
  const { siteKey, secret, timeoutMs = VERIFY_TIMEOUT_MS } = options;
  return {
    siteKey,
    async verify(token) {
      const doFetch = options.fetch ?? fetch;
      let body: unknown;
      try {
        const response = await doFetch(TURNSTILE_VERIFY_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret, response: token }).toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return "unavailable";
        body = await response.json();
      } catch {
        return "unavailable";
      }
      if (typeof body !== "object" || body === null) return "unavailable";
      const answer = body as { success?: unknown; action?: unknown; "error-codes"?: unknown };
      // The action checked so a token from another form or site key isn't accepted.
      if (answer.success === true) return answer.action === TURNSTILE_ACTION ? "passed" : "failed";
      const codes = Array.isArray(answer["error-codes"]) ? answer["error-codes"] : [];
      return codes.some((code) => NOT_THE_VISITORS.has(String(code))) ? "unavailable" : "failed";
    },
  };
}

/** Why the check is asked for. */
export type ChallengeReason = "address" | "site";

/** A refusal from {@link passBotCheck}, shaped like `/api/analyze`'s other errors. */
export interface BotRefusal {
  status: 403 | 503;
  body: {
    error: "CHALLENGE_REQUIRED" | "CHALLENGE_FAILED" | "CHALLENGE_UNAVAILABLE";
    message: string;
    /** The widget's public site key, to show it (not with `CHALLENGE_UNAVAILABLE`). */
    siteKey?: string;
  };
}

const CONTINUES = "It usually passes on its own, and Analyze continues once it does.";

/** The message for `CHALLENGE_REQUIRED`, saying why. */
export function challengeMessage(reason: ChallengeReason): string {
  return reason === "address"
    ? `You've started several analyses this hour, so we're checking that you're a person. ${CONTINUES}`
    : `GitInside is busier than usual, so we're checking that you're a person. ${CONTINUES}`;
}

export const CHALLENGE_FAILED_MESSAGE =
  "The check that you're a person didn't pass. Press Analyze to try again.";
export const CHALLENGE_UNAVAILABLE_MESSAGE =
  "We couldn't reach Cloudflare to check that you're a person. Try again in a minute.";

/**
 * Decide whether this request for a new analysis needs the bot check and, if so, whether
 * `token` passes it. `key` is the caller's hourly rate-limit key. A request let through is
 * counted in the site-wide hour, so a burst from many addresses turns the check on for all.
 * `at` reads and counts the hour at a fixed moment instead of the database clock (tests).
 */
export async function passBotCheck(
  check: BotCheck,
  db: AnyDatabase,
  key: string,
  token: string | undefined,
  at?: Date,
): Promise<BotRefusal | undefined> {
  const [mine, site] = await Promise.all([
    peekRateLimit(db, key, at),
    peekRateLimit(db, SITE_ANALYZE_KEY, at),
  ]);
  const reason: ChallengeReason | undefined =
    mine >= CHALLENGE_AFTER_PER_ADDRESS
      ? "address"
      : site >= CHALLENGE_AFTER_SITE
        ? "site"
        : undefined;
  if (reason !== undefined) {
    const { siteKey } = check;
    if (token === undefined) {
      return {
        status: 403,
        body: { error: "CHALLENGE_REQUIRED", message: challengeMessage(reason), siteKey },
      };
    }
    const verdict = await check.verify(token);
    if (verdict === "failed") {
      return {
        status: 403,
        body: { error: "CHALLENGE_FAILED", message: CHALLENGE_FAILED_MESSAGE, siteKey },
      };
    }
    if (verdict === "unavailable") {
      return {
        status: 503,
        body: { error: "CHALLENGE_UNAVAILABLE", message: CHALLENGE_UNAVAILABLE_MESSAGE },
      };
    }
  }
  // A counter, not a limit: no request is refused on it.
  await consumeRateLimit(db, SITE_ANALYZE_KEY, 2_000_000_000, at);
  return undefined;
}
