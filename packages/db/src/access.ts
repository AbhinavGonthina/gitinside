/**
 * Whether a signed-in user may view a private repo, as GitHub last answered (M8.4a, ADR-0009,
 * ADR-0231). The website asks GitHub and records the answer here, granted or refused, so a
 * private page and its graph cost one GitHub call per user and repo a minute at most. Every
 * time is on the database's clock, so serverless instances agree on when an answer is stale.
 */
import { and, eq, gt, sql } from "drizzle-orm";
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

/** Record GitHub's answer about `userId` viewing `repoId` now, replacing the last one. */
export async function recordAccess(
  db: AnyDatabase,
  userId: string,
  repoId: string,
  allowed: boolean,
): Promise<void> {
  await db
    .insert(accessCache)
    .values({ userId, repoId, allowed, checkedAt: sql`now()` })
    .onConflictDoUpdate({
      target: [accessCache.userId, accessCache.repoId],
      set: { allowed, checkedAt: sql`now()` },
    });
}
