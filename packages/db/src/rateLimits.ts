/**
 * Fixed-window rate limits for new analyses (SPEC §3: 5 per hour per IP signed out, 30
 * signed in; ADR-0066). One `rate_limits` row per key and window, counted up in a single
 * statement, so two requests racing for the last slot can't both get it.
 *
 * - **Windows** start on the database clock's UTC hour (`date_trunc`), the same clock for
 *   every serverless instance; a window's counter resets when the next hour starts.
 * - **Keys** are opaque here. Callers pass a keyed hash of the IP or a user ID, never a raw
 *   address.
 */
import { and, eq, sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { rateLimits } from "./schema.js";

/** The outcome of {@link consumeRateLimit}. */
export interface RateLimitResult {
  /** Whether this request got a slot (it was counted). */
  allowed: boolean;
  /** Requests counted in the window, including this one if it was allowed. */
  count: number;
  /** When the window began (the `rate_limits` row's `window_start`, to pass to {@link refundRateLimit}). */
  windowStart: Date;
  /** When the window ends and the count starts again from zero. */
  resetAt: Date;
}

/**
 * Count one request against `key` in the current hour, unless `limit` requests are already
 * counted there. The insert-or-increment only increments below the limit, so a refused
 * request changes nothing.
 *
 * `at` counts at a fixed moment instead of the database clock's `now()`, for tests whose
 * requests must share one window (or straddle two) whenever they run. Callers in production
 * leave it out.
 */
export async function consumeRateLimit(
  db: AnyDatabase,
  key: string,
  limit: number,
  at?: Date,
): Promise<RateLimitResult> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  const moment = at === undefined ? sql`now()` : sql`${at.toISOString()}::timestamptz`;
  // Truncated in UTC, so connections with different session time zones share one window.
  const window = sql`date_trunc('hour', ${moment}, 'UTC')`;
  const [counted] = await db
    .insert(rateLimits)
    .values({ key, windowStart: window, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
      setWhere: sql`${rateLimits.count} < ${limit}`,
    })
    .returning({ count: rateLimits.count, windowStart: rateLimits.windowStart });
  if (counted !== undefined) {
    return { allowed: true, ...counted, resetAt: hourAfter(counted.windowStart) };
  }
  const [full] = await db
    .select({ count: rateLimits.count, windowStart: rateLimits.windowStart })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, window)));
  // The row exists: the conflict that skipped the update was on it, and rows are never
  // deleted inside their own hour.
  const row = full as { count: number; windowStart: Date };
  return { allowed: false, ...row, resetAt: hourAfter(row.windowStart) };
}

/**
 * Give back a slot {@link consumeRateLimit} counted, when the request turned out not to start
 * a new analysis (someone else's job already covered the commit, or the queue was down).
 * Never goes below zero.
 */
export async function refundRateLimit(
  db: AnyDatabase,
  key: string,
  windowStart: Date,
): Promise<void> {
  await db
    .update(rateLimits)
    .set({ count: sql`${rateLimits.count} - 1` })
    .where(
      and(
        eq(rateLimits.key, key),
        eq(rateLimits.windowStart, windowStart),
        sql`${rateLimits.count} > 0`,
      ),
    );
}

function hourAfter(start: Date): Date {
  return new Date(start.getTime() + 60 * 60 * 1000);
}
