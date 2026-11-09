/**
 * Whether a signed-in user may view a private repo, as GitHub last answered (M8.4a, ADR-0009,
 * ADR-0231). The website asks GitHub and records the answer here, granted or refused, so a
 * private page and its graph cost one GitHub call per user and repo a minute at most. Every
 * time is on the database's clock, so serverless instances agree on when an answer is stale.
 */
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { accessCache } from "./schema.js";

/** How long a recorded answer is trusted: access removed on GitHub is refused within this. */
export const ACCESS_TTL_SECONDS = 60;

/**
 * GitHub's answer about `userId` viewing `repoId` (our row IDs) if it was recorded less than
 * {@link ACCESS_TTL_SECONDS} ago, else `undefined` (ask GitHub again).
 */
export async function findAccess(
  db: AnyDatabase,
  userId: string,
  repoId: string,
): Promise<boolean | undefined> {
  const [row] = await db
    .select({ allowed: accessCache.allowed })
    .from(accessCache)
    .where(
      and(
        eq(accessCache.userId, userId),
        eq(accessCache.repoId, repoId),
        gt(accessCache.checkedAt, sql`now() - ${ACCESS_TTL_SECONDS} * interval '1 second'`),
      ),
    );
  return row?.allowed;
}

/**
 * Record GitHub's answer about `userId` viewing `repoId`, dated when GitHub was asked:
 * `askedMsAgo` before the database's `now()` (M8.10f1, F13), so a slow answer is trusted no
 * longer than {@link ACCESS_TTL_SECONDS} from the ask. It replaces the last answer only if that
 * one was asked earlier: a slow grant finishing after a newer refusal leaves the refusal.
 */
export async function recordAccess(
  db: AnyDatabase,
  userId: string,
  repoId: string,
  allowed: boolean,
  options: { askedMsAgo?: number } = {},
): Promise<void> {
  const askedMs = Math.max(0, Math.ceil(options.askedMsAgo ?? 0));
  const askedAt = sql`now() - ${askedMs} * interval '1 millisecond'`;
  await db
    .insert(accessCache)
    .values({ userId, repoId, allowed, checkedAt: askedAt })
    .onConflictDoUpdate({
      target: [accessCache.userId, accessCache.repoId],
      set: { allowed, checkedAt: sql`excluded.checked_at` },
      setWhere: lt(accessCache.checkedAt, sql`excluded.checked_at`),
    });
}
