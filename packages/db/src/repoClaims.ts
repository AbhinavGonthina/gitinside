/**
 * One new analysis per repo per period, whoever asks (#11, ADR-0155). The per-address limit
 * (`rateLimits.ts`) doesn't stop requests for one repo spread over many addresses, each
 * finding a new commit; this does. The claim lives on the repo's row:
 *
 * - **Claiming** is one `update` on the database's clock: the row's lock makes two racing
 *   requests for new commits see each other, so only one gets it. A claim that stands for
 *   a period blocks every other commit.
 * - **The same commit** isn't blocked by its own claim: a second request for it is a
 *   duplicate (it gets the same job) or a retry of a failed run, not a new commit, and the
 *   caller's hourly limit still counts it.
 * - **Released** when the request that claimed turned out not to start an analysis (someone
 *   else's job covered the commit, or the queue was down), like a refunded rate-limit slot.
 */
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { repos } from "./schema.js";

/** The outcome of {@link claimRepoAnalysis}. */
export type RepoClaim =
  /** This request holds the repo's claim from `claimedAt`; pass that to release it. */
  | { status: "claimed"; claimedAt: Date }
  /** A standing claim is for this very commit: let it through, nothing to release. */
  | { status: "same-commit" }
  /** Another commit holds the claim, made at `claimedAt`; it ends at `retryAt`. */
  | { status: "refused"; claimedAt: Date; retryAt: Date };

/** Claims retried when one is released or expires between the update and the read. */
const ATTEMPTS = 3;

/**
 * Claim the repo `repoId` (a `repos.id`) for a new analysis of `sha` unless another commit
 * claimed it less than `everySeconds` ago. The repo's row must exist (`upsertRepo`).
 */
export async function claimRepoAnalysis(
  db: AnyDatabase,
  repoId: string,
  sha: string,
  everySeconds: number,
): Promise<RepoClaim> {
  if (!Number.isFinite(everySeconds) || everySeconds <= 0) {
    throw new RangeError("everySeconds must be a finite number > 0");
  }
  const since = sql`now() - ${everySeconds} * interval '1 second'`;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // Whole milliseconds, so the `Date` read back names the claim exactly when released.
    const [won] = await db
      .update(repos)
      .set({ analysisClaimSha: sha, analysisClaimedAt: sql`date_trunc('milliseconds', now())` })
      .where(
        and(
          eq(repos.id, repoId),
          or(isNull(repos.analysisClaimedAt), lte(repos.analysisClaimedAt, since)),
        ),
      )
      .returning({ claimedAt: repos.analysisClaimedAt });
    if (won?.claimedAt) return { status: "claimed", claimedAt: won.claimedAt };

    // Refused, or no such row. Read the claim that stands, in a new statement: one that
    // committed while the update waited for the lock isn't in the update's snapshot.
    const [held] = await db
      .select({
        sha: repos.analysisClaimSha,
        claimedAt: repos.analysisClaimedAt,
        stands: sql<boolean>`${repos.analysisClaimedAt} > ${since}`,
      })
      .from(repos)
      .where(eq(repos.id, repoId));
    if (held === undefined) throw new Error(`no repo row ${repoId} to claim`);
    // Released or expired since the update: try again.
    if (held.claimedAt === null || held.stands !== true) continue;
    if (held.sha === sha) return { status: "same-commit" };
    const retryAt = new Date(held.claimedAt.getTime() + everySeconds * 1000);
    return { status: "refused", claimedAt: held.claimedAt, retryAt };
  }
  throw new Error(`the claim on repo ${repoId} kept changing`);
}

/**
 * Give back a claim {@link claimRepoAnalysis} made at `claimedAt`, when the request didn't
 * start an analysis after all. A claim made since by someone else is left alone.
 */
export async function releaseRepoAnalysis(
  db: AnyDatabase,
  repoId: string,
  claimedAt: Date,
): Promise<void> {
  await db
    .update(repos)
    .set({ analysisClaimSha: null, analysisClaimedAt: null })
    .where(and(eq(repos.id, repoId), eq(repos.analysisClaimedAt, claimedAt)));
}
