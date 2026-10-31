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
  // The window is read from the clock once, in the statement that counts, and returned even
  // when the request is refused: a second `now()` for the refused path could land in the
  // next hour and find no row. Truncated in UTC, so connections with different session time
  // zones share one window.
  const result: unknown = await db.execute(sql`
    with w as (select date_trunc('hour', ${moment}, 'UTC') as window_start),
    counted as (
      insert into ${rateLimits} (key, window_start, count)
        select ${key}, window_start, 1 from w
      on conflict (key, window_start) do update set count = ${rateLimits}.count + 1
        where ${rateLimits}.count < ${limit}
      returning count)
    select extract(epoch from window_start)::text as window_start,
      (select count from counted)::text as count
    from w`);
  // postgres.js returns an array of rows, PGlite an object with `rows`.
  const [row] = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
    window_start: string;
    count: string | null;
  }[];
  if (row === undefined) throw new Error("the rate-limit count returned no row");
  const windowStart = new Date(Number(row.window_start) * 1000);
  const resetAt = hourAfter(windowStart);
  if (row.count !== null) return { allowed: true, count: Number(row.count), windowStart, resetAt };
  // Refused: the row exists (the conflict that skipped the update was on it, committed before
  // this next statement, and rows are never deleted inside their own hour or the next).
  const [full] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStart)));
  if (full === undefined) throw new Error("the full rate-limit window's row is missing");
  return { allowed: false, count: full.count, windowStart, resetAt };
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
