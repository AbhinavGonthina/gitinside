/**
 * The reads and deletes behind the worker's hourly maintenance (`apps/worker/src/maintenance.ts`,
 * ADR-0078):
 *
 * - {@link databaseSizeBytes}: what the database occupies, for the quota check against the
 *   free plan's storage limit.
 * - {@link pruneRateLimits}: removes rate-limit windows that ended long ago. They are never
 *   read again, and without pruning the table grows by one row per caller per hour.
 */
import { sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { rateLimits } from "./schema.js";

/** postgres.js returns an array of rows, PGlite an object with `rows`. */
function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

/**
 * The current database's size in bytes (`pg_database_size`): its tables, indexes, and
 * TOAST data as Postgres stores them. Neon's storage figure also counts its history
 * retention, so this is a floor of what Neon reports, not the same number.
 */
export async function databaseSizeBytes(db: AnyDatabase): Promise<number> {
  const [row] = rowsOf<{ bytes: string | number }>(
    await db.execute(sql`select pg_database_size(current_database())::text as bytes`),
  );
  return Number(row?.bytes);
}

/**
 * Delete rate-limit windows that ended over an hour ago, by the database's clock; returns
 * how many went. The current and the previous window stay: `consumeRateLimit` relies on a
 * row never being deleted inside its own hour, and a refund may still name the window that
 * just ended.
 */
export async function pruneRateLimits(db: AnyDatabase): Promise<number> {
  const gone = await db
    .delete(rateLimits)
    .where(sql`${rateLimits.windowStart} < date_trunc('hour', now(), 'UTC') - interval '1 hour'`)
    .returning({ key: rateLimits.key });
  return gone.length;
}
