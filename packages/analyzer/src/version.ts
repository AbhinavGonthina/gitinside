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
export const ANALYZER_VERSION = "0.3.8";

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
  "0.3.1": "30de0b2a7ff53f0482027501e3bee3a10a09ab31f8b90cf11b9679826a347439",
  "0.3.2": "e859bbcb61377e401d1d6a9883ef09873cfba5ee23d96baece444e5623c815bf",
  "0.3.3": "8dcdacbc1a4f043cfafb11c78d618787837c50d7fcaa1f9b5a6aa94c7b97c6bd",
  "0.3.4": "125852af5b441552ac87899e990cd402f526b9a81999d1d7afe4372b1d703b03",
  "0.3.5": "069dc931e5b15b24c1d0c2d083e6e6e5f85fc6e5440a13ed1e2013e34966dc1b",
  "0.3.6": "a7773897125d06d47aff257c65c8bb29d5fccb2c6b699d3c95768c4ad89bd2b8",
  "0.3.7": "a77def127f43a35596b92725ab61e4a70d3336cfaf198e1624c07fe3795706cd",
  "0.3.8": "3b92ffa15eea957c18cd11bfda5f033abc766d73db7742a03c919ac1d28de0f7",
};
