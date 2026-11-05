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

/**
 * The worker's extraction limits (`DEFAULT_EXTRACT_LIMITS`; limits.test.ts keeps them equal):
 * the unpacked size in MB (MiB) and the files and folders in GitHub's download, sized for a
 * 4 GiB Cloud Run instance (ADR-0146).
 */
export const SUPPORTED_UNPACKED_MB = 400;
export const SUPPORTED_ENTRIES = 60_000;

/**
 * The analysis's time limit in production, in seconds: its guaranteed share of a Cloud Run
 * attempt (the worker's `guaranteedAnalysisMs(JOB_BUDGET_MS)`, 280 s less 20 s to publish and
 * 30 s for the download; limits.test.ts keeps them equal). `LIMIT_TIME` means it ran at least
 * this long; the child's own 5 minutes never fit in an attempt (ADR-0143's M5.14b3e amendment).
 */
export const ANALYSIS_TIME_LIMIT_SECONDS = 230;

/** A no-break space (U+00A0), written as a code so it can't pass for a plain one. */
export const NBSP = String.fromCharCode(0xa0);

/** "3 min 50 s", with no-break spaces inside each part. */
export const ANALYSIS_TIME_LIMIT = [
  `${String(Math.floor(ANALYSIS_TIME_LIMIT_SECONDS / 60))}${NBSP}min`,
  ...(ANALYSIS_TIME_LIMIT_SECONDS % 60 === 0
    ? []
    : [`${String(ANALYSIS_TIME_LIMIT_SECONDS % 60)}${NBSP}s`]),
].join(" ");

/** "50 MB" with a no-break space, so a wrapped line never leaves the unit on its own. */
export const SUPPORTED_SOURCE_SIZE = `${SUPPORTED_SOURCE_MB}${NBSP}MB`;

/** "up to 20,000 source files and 50 MB of source code", to follow "repos". */
export const SUPPORTED_SIZE = `up to ${SUPPORTED_SOURCE_FILES.toLocaleString("en-US")} source files and ${SUPPORTED_SOURCE_SIZE} of source code`;
