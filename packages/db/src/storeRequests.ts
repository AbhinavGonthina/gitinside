/**
 * Monthly counters of the requests GitInside makes to its snapshot bucket (ADR-0096).
 * Oracle Object Storage's Always Free tier allows 50,000 requests a month (SPEC §5), and
 * both the worker (puts, retention's listings and deletes) and the web app (graph reads)
 * spend them, from many processes. One `store_requests` row per month and source, counted
 * up in a single statement, so concurrent serverless instances never lose an increment.
 *
 * - **Months** start on the database clock's UTC calendar month (`date_trunc`), the same
 *   clock for every process. Oracle's own month boundary isn't documented; UTC is assumed.
 * - **Rows** are two a month, so none are ever pruned.
 */
import { sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { storeRequests } from "./schema.js";

/** Who made a bucket request. */
export type StoreRequestSource = "worker" | "web";

/** This month's count by {@link storeRequestsThisMonth}. */
export interface StoreRequestCount {
  /** When the UTC month began. */
  monthStart: Date;
  worker: number;
  web: number;
  /** `worker + web`: what the free tier counts. */
  total: number;
}

/** The current UTC month on the database clock. */
const MONTH = sql`date_trunc('month', now(), 'UTC')`;

/** Add `requests` (default 1) to this month's count for `source`. */
export async function countStoreRequests(
  db: AnyDatabase,
  source: StoreRequestSource,
  requests = 1,
): Promise<void> {
  if (!Number.isSafeInteger(requests) || requests < 1) {
    throw new Error("requests must be a positive integer");
  }
  await db
    .insert(storeRequests)
    .values({ monthStart: MONTH, source, count: requests })
    .onConflictDoUpdate({
      target: [storeRequests.monthStart, storeRequests.source],
      set: { count: sql`${storeRequests.count} + ${requests}` },
    });
}

/** The requests counted so far this UTC month, per source and in total (zero if none). */
export async function storeRequestsThisMonth(db: AnyDatabase): Promise<StoreRequestCount> {
  // One statement, so the month and its counts come from the same clock reading. An
  // aggregate without `group by` returns its row even when the month has none.
  const result: unknown = await db.execute(sql`
    select extract(epoch from ${MONTH})::text as month_start,
      coalesce(sum(${storeRequests.count}) filter (where ${storeRequests.source} = 'worker'), 0)::text as worker,
      coalesce(sum(${storeRequests.count}) filter (where ${storeRequests.source} = 'web'), 0)::text as web
    from ${storeRequests}
    where ${storeRequests.monthStart} = ${MONTH}`);
  // postgres.js returns an array of rows, PGlite an object with `rows`.
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
    month_start: string;
    worker: string;
    web: string;
  }[];
  const [row] = rows;
  if (row === undefined) throw new Error("the month's request count returned no row");
  const worker = Number(row.worker);
  const web = Number(row.web);
  return {
    monthStart: new Date(Number(row.month_start) * 1000),
    worker,
    web,
    total: worker + web,
  };
}
