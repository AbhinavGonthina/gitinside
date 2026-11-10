/**
 * The analyzer's version, on its own so callers that only need the cache key (apps/web's
 * `/api/analyze`) can import `@gitinside/analyzer/version` without loading the TypeScript
 * compiler.
 */

/**
 * Version stamped into every graph. Part of the website's and worker's cache key (repo, commit,
 * version), so a commit already analyzed is never analyzed again under the same version: bump
 * it whenever the output changes, or production keeps serving the old code's graphs as current
 * (M9.1b2a, ADR-0256). `version.test.ts` enforces it for the fixtures ({@link OUTPUT_DIGESTS}).
 */
export const ANALYZER_VERSION = "0.3.0";

/**
 * The SHA-256 of every fixture's golden graph (`fixtures/<name>/expected.json`, each without
 * its `analyzerVersion`), per {@link ANALYZER_VERSION} since the guard began (M9.1b2a). A
 * change to any fixture's graph fails `version.test.ts` until the version is bumped and the
 * digest it prints is added under the new version, as `FACTS_DIGESTS` does for `KEY_FORMAT`.
 * The test also fails if the newest entry isn't the current version's, if versions aren't in
 * ascending order, or if two share a digest. Entries are append-only: never change one. A new
 * fixture changes the digest too; a needless bump only costs one re-analysis per commit
 * viewed. A change to the output only for code no fixture has still needs a bump by hand.
 */
export const OUTPUT_DIGESTS: Readonly<Record<string, string>> = {
  "0.3.0": "da45a313463e569285e96a55ad0224acc41a7e7b4892e0341c39298271ab7695",
};
