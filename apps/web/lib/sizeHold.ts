import { findLimitFailure, type AnyDatabase } from "@gitinside/db";
import type { ResolvedRepo } from "./github";

/**
 * "Too big" remembered per repo, not per commit (#11, ADR-0153). After an analysis of a repo
 * fails at one of the worker's limits (`LIMIT_*`: files, size, entries, time, memory), new
 * analyses of that repo are refused for {@link SIZE_HOLD_DAYS} days, whoever asks and for
 * whatever commit, so a bot asking for a busy, huge repo every few minutes costs one GitHub
 * lookup per ask instead of minutes of compute. The hold ends early when:
 *
 * - GitHub's `size` for the repo is at most half what it was when the failed analysis was
 *   queued (a big cleanup may well fit now); both sizes must be known, so nothing is guessed;
 * - an analysis of the repo finishes after the failure (`findLimitFailure` skips it then).
 *
 * A commit already analyzed is still served, and one already in flight keeps its job: the
 * hold only stops new work.
 */

/** How long a `LIMIT_*` failure holds the repo. */
export const SIZE_HOLD_DAYS = 7;

/** A hold on new analyses of a repo. */
export interface SizeHold {
  /** The failure's `LIMIT_*` code, for its reason. */
  errorCode: string;
  /** When new analyses are accepted again. */
  until: Date;
}

/** Whether the repo, now `nowKb`, is at most half its size at the failure, `thenKb`. */
export function shrankByHalf(thenKb: number | null, nowKb: number | undefined): boolean {
  return thenKb !== null && nowKb !== undefined && nowKb * 2 <= thenKb;
}

/** The hold on new analyses of `repo` (GitHub's facts, just resolved), if one applies. */
export async function findSizeHold(
  db: AnyDatabase,
  repo: Pick<ResolvedRepo, "providerRepoId" | "sizeKb">,
): Promise<SizeHold | undefined> {
  const failure = await findLimitFailure(db, repo.providerRepoId, SIZE_HOLD_DAYS);
  if (failure === undefined || shrankByHalf(failure.repoSizeKb, repo.sizeKb)) return undefined;
  return { errorCode: failure.errorCode, until: failure.until };
}
