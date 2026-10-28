/**
 * The analyzer's version, on its own so callers that only need the cache key (apps/web's
 * `/api/analyze`) can import `@gitinside/analyzer/version` without loading the TypeScript
 * compiler.
 */

/** Version stamped into every graph. Part of the cache key, so bump it when output changes. */
export const ANALYZER_VERSION = "0.1.0";
