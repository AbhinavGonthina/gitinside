/**
 * The reads and writes behind the worker's hourly maintenance (`apps/worker/src/maintenance.ts`,
 * ADR-0078, ADR-0147):
 *
 * - {@link claimMaintenance}: decides which worker instance runs it, and when, by the
 *   database's clock.
 * - {@link databaseSizeBytes}: what the database occupies, for the quota check against the
 *   free plan's storage limit.
 * - {@link pruneRateLimits}: removes rate-limit windows that ended long ago. They are never
 *   read again, and without pruning the table grows by one row per caller per hour.
 */
import { lte, sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { maintenanceRuns, rateLimits } from "./schema.js";

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
 * Claim the maintenance task `name` if it last started at least `everySeconds` ago (or
 * never), recording now as its start; returns whether this caller won. One statement on
 * the database's clock: two instances asking at once both reach the row's lock, and the
 * second sees the first's new start time and gets `false`. A claim is a start, not a
 * finish, so a run that dies midway waits out the period like one that finished.
 */
export async function claimMaintenance(
  db: AnyDatabase,
  name: string,
  everySeconds: number,
): Promise<boolean> {
  if (!Number.isFinite(everySeconds) || everySeconds < 0) {
    throw new RangeError("everySeconds must be a finite number ≥ 0");
  }
  const rows = await db
    .insert(maintenanceRuns)
    .values({ name, startedAt: sql`now()` })
    .onConflictDoUpdate({
      target: maintenanceRuns.name,
      set: { startedAt: sql`now()` },
      setWhere: lte(maintenanceRuns.startedAt, sql`now() - ${everySeconds} * interval '1 second'`),
    })
    .returning({ name: maintenanceRuns.name });
  return rows.length > 0;
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
