import { dangerouslyDeleteByTag } from "@vercel/functions";

/**
 * Dropping a repo's graphs from Vercel's CDN when it stops being public (M8.4d1, ADR-0238).
 *
 * - **Tagged by GitHub's ID:** every public graph answer (and its spelling redirect) carries
 *   {@link CACHE_TAG_HEADER} `repo-<id>` ({@link repoCacheTag}), so one purge reaches all of a
 *   repo's commits and spellings. By ID, so a rename or a reused name can't purge (or keep)
 *   another repo's graphs. Private answers are never cached, so they carry no tag.
 * - **Deleted, not invalidated:** an invalidated entry is served stale once more while the CDN
 *   asks again, which would hand out the graph of a repo that just went private.
 * - **Free on every plan,** rate limited at 50 calls a second on Hobby, one call per repo
 *   hidden ([Vercel](https://vercel.com/docs/caching/cdn-cache/purge)).
 * - **Outside Vercel** (tests, `next start`) there's no request context and Vercel's package
 *   does nothing, so a purge can't be seen to work locally; the deployed site is the check.
 */

/** The response header Vercel's CDN reads a cached answer's tags from. */
export const CACHE_TAG_HEADER = "vercel-cache-tag";

/** The cache tag of everything the CDN keeps for the repo GitHub knows as `providerRepoId`. */
export function repoCacheTag(providerRepoId: number): string {
  return `repo-${providerRepoId}`;
}

/** The part of `@vercel/functions` a purge uses; tests pass a fake. */
export interface CdnPurgeApi {
  dangerouslyDeleteByTag: (tag: string) => Promise<unknown>;
}

/**
 * Delete every CDN entry tagged with the repo's {@link repoCacheTag}, so the next request for
 * any of its graphs reaches the function. Rejects when Vercel refuses (e.g. a `429`).
 */
export async function purgeRepoCache(
  providerRepoId: number,
  api: CdnPurgeApi = { dangerouslyDeleteByTag },
): Promise<void> {
  await api.dangerouslyDeleteByTag(repoCacheTag(providerRepoId));
}
