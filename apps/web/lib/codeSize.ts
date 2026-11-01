import { fetchCodeBytes, type GitHubOptions, type ResolvedRepo } from "./github";
import { SUPPORTED_SOURCE_MB } from "./limits";

/**
 * Refusing obviously huge repos before any download or compute (#11, ADR-0154). Before a new
 * analysis is queued, GitHub's count of the repo's TypeScript and JavaScript bytes
 * (`fetchCodeBytes`) is compared with {@link MAX_GITHUB_CODE_BYTES}, twice the analyzer's
 * source-size limit (`LIMIT_SOURCE_SIZE`, 50 MB). The margin is for the two counts not being
 * the same (Linguist's exclusions aren't the analyzer's), so a repo refused here would fail
 * that limit anyway; one between the two is still sent, and the worker's limits and the
 * week's hold (`sizeHold.ts`) stop it there.
 *
 * GitHub's repo `size` isn't used: it's mostly git history. cal.com (1.16 GB) analyzes in
 * 38 s, VS Code (1.66 GB) can't, so no `size` threshold tells them apart.
 *
 * Unknown (GitHub didn't answer, or answered something unreadable) ⇒ not refused: the
 * worker's limits still apply, and nothing is refused on a guess.
 */

const MIB = 1024 * 1024;

/** How many times the analyzer's source-size limit GitHub's count may be. */
export const CODE_SIZE_MARGIN = 2;

/** Above this many TypeScript and JavaScript bytes by GitHub's count, a repo is refused. */
export const MAX_GITHUB_CODE_BYTES = CODE_SIZE_MARGIN * SUPPORTED_SOURCE_MB * MIB;

/** GitHub's counts by commit, so a refused repo's page costs one lookup per new commit. */
export interface CodeSizeCache {
  get(key: string): number | undefined;
  set(key: string, bytes: number): void;
}

/** A {@link CodeSizeCache} in this process's memory, oldest dropped first. */
export function createCodeSizeCache(options: { maxEntries?: number } = {}): CodeSizeCache {
  const { maxEntries = 1_000 } = options;
  const entries = new Map<string, number>();
  return {
    get: (key) => entries.get(key),
    set(key, bytes) {
      entries.delete(key);
      entries.set(key, bytes);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
    },
  };
}

/**
 * GitHub's TypeScript and JavaScript bytes for `repo` (just resolved) when they're over
 * {@link MAX_GITHUB_CODE_BYTES}, else `undefined` (within it, or unknown). Known counts are
 * remembered in `cache` by repo and commit; unknown ones are asked again next time.
 */
export async function findTooMuchCode(
  repo: Pick<ResolvedRepo, "providerRepoId" | "owner" | "name" | "sha">,
  github: GitHubOptions,
  cache?: CodeSizeCache,
): Promise<number | undefined> {
  const key = `${repo.providerRepoId}@${repo.sha}`;
  let bytes = cache?.get(key);
  if (bytes === undefined) {
    bytes = await fetchCodeBytes(repo, github);
    if (bytes !== undefined) cache?.set(key, bytes);
  }
  return bytes !== undefined && bytes > MAX_GITHUB_CODE_BYTES ? bytes : undefined;
}
