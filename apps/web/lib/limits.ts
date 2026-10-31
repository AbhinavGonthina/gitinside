/**
 * The repo size GitInside supports (M5.16c), said on the landing page and in the failure copy.
 * These are the analyzer's default inventory limits (`DEFAULT_LIMITS`, `MAX_SOURCE_MB`;
 * limits.test.ts keeps them equal), copied rather than imported so the landing page's client
 * bundle doesn't pull in the analyzer. Source means the files the inventory keeps (`.ts .tsx
 * .js .jsx .mjs .cjs .prisma`, without ignored, generated, or over-2 MB files). Measured in
 * bench/results/2026-10-31-capped-vscode.md (ADR-0137): the bytes are the limit large repos
 * meet first.
 */
export const SUPPORTED_SOURCE_FILES = 20_000;

/** The source-size limit in MB (MiB), the analyzer's `MAX_SOURCE_MB`. */
export const SUPPORTED_SOURCE_MB = 50;

/** A no-break space (U+00A0), written as a code so it can't pass for a plain one. */
export const NBSP = String.fromCharCode(0xa0);

/** "50 MB" with a no-break space, so a wrapped line never leaves the unit on its own. */
export const SUPPORTED_SOURCE_SIZE = `${SUPPORTED_SOURCE_MB}${NBSP}MB`;

/** "up to 20,000 source files and 50 MB of source code", to follow "repos". */
export const SUPPORTED_SIZE = `up to ${SUPPORTED_SOURCE_FILES.toLocaleString("en-US")} source files and ${SUPPORTED_SOURCE_SIZE} of source code`;
