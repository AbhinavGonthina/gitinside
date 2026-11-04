import { isAnalyzerStep, parseFoundFacts, type FoundFacts, type StepProgress } from "./progress.js";

/**
 * The contract between the worker and the analysis child process (`child.ts`).
 *
 * The parent passes one {@link ChildJob} as JSON in `argv[2]`; the child writes the graph to
 * `job.out` and prints to stdout zero or more progress lines (`{"progress":{"step":…}}`, see
 * {@link progressLine}) and found lines (`{"found":{…}}`, {@link foundLine}), followed by
 * exactly one {@link ChildReport} line, the last. This
 * module has no dependency on the analyzer, so the runner can import it without loading
 * TypeScript.
 */

/** What the child analyzes and where it writes the graph. */
export interface ChildJob {
  /** The extracted repo (read-only for the child). */
  src: string;
  /** Where the child writes `architecture.json` (the only path it may write). */
  out: string;
  owner: string;
  name: string;
  sha?: string;
  /**
   * The fact cache folder the child may read and write, and its cap there (factcache.ts).
   * Without it the analysis runs cold and stores nothing.
   */
  cache?: { dir: string; maxBytes: number };
}

/** What the child's fact cache did during one analysis (`openDiskCache`'s counters). */
export interface CacheCounts {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  errors: number;
}

/** Counts and timings from a finished analysis; they feed `analyses.stats`. */
export interface AnalysisStats {
  /** Source files analyzed: the graph's `file` nodes. */
  files: number;
  nodes: number;
  edges: number;
  /** Nodes of kind `unresolved` (requests, imports, and calls shown with a reason). */
  unresolved: number;
  warnings: number;
  /** Size of the serialized graph written to `job.out`. */
  graphBytes: number;
  /** Wall-clock milliseconds per analyzer stage, rounded, in stage order. */
  stageMs: Record<string, number>;
  /**
   * The child's peak resident memory (`process.resourceUsage().maxRSS`) and V8's heap once the
   * graph is serialized (`heapTotal`), in bytes: what the memory budget is sized from
   * (budget.ts). The child always reports them; test fakes may leave them out.
   */
  peakRssBytes?: number;
  heapBytes?: number;
  /**
   * Time the child's main thread spent paused in V8's collector, in rounded ms by kind
   * (`minor`, `major`, `incremental`, `weakcb`; `gc` performance entries, M5.13a5). Work on
   * V8's helper threads isn't in it. The child always reports it; test fakes may leave it out.
   */
  gcMs?: Record<string, number>;
  /** The fact cache's counters, when the job had a cache. */
  cache?: CacheCounts;
}

const CACHE_COUNTS = ["hits", "misses", "writes", "evictions", "errors"] as const;

/** Only the {@link CacheCounts} fields of `counts` (a cache's stats hold more). */
export function cacheCounts(counts: CacheCounts): CacheCounts {
  const { hits, misses, writes, evictions, errors } = counts;
  return { hits, misses, writes, evictions, errors };
}

/** The child's one-line answer. A failure here is a known analyzer failure (`LIMIT_FILES`). */
export type ChildReport =
  | { ok: true; stats: AnalysisStats }
  | { ok: false; code: string; message: string };

/** Error codes are short upper-case identifiers, never free text from the repo. */
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Parse the child's argument. Throws on anything but a well-formed job. */
export function parseChildJob(text: string): ChildJob {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("job must be an object");
  const { src, out, owner, name, sha, cache } = value;
  for (const [key, field] of Object.entries({ src, out, owner, name })) {
    if (typeof field !== "string" || field === "") throw new Error(`job.${key} must be a string`);
  }
  if (sha !== undefined && typeof sha !== "string") throw new Error("job.sha must be a string");
  if (
    cache !== undefined &&
    (!isRecord(cache) ||
      typeof cache.dir !== "string" ||
      cache.dir === "" ||
      !isCount(cache.maxBytes) ||
      cache.maxBytes === 0)
  ) {
    throw new Error("job.cache must have a folder and a positive cap");
  }
  return {
    src: src as string,
    out: out as string,
    owner: owner as string,
    name: name as string,
    ...(sha === undefined ? {} : { sha }),
    ...(cache === undefined
      ? {}
      : { cache: { dir: cache.dir as string, maxBytes: cache.maxBytes as number } }),
  };
}

/** The stdout line (with its newline) the child prints for one progress event. */
export function progressLine(progress: StepProgress): string {
  const { step, count } = progress;
  return `${JSON.stringify({ progress: count === undefined ? { step } : { step, count } })}\n`;
}

/**
 * Parse a stdout line as a progress event, or return `undefined` if it isn't one (it may be
 * the report). Only a known step and a non-negative integer count pass.
 */
export function parseProgressLine(text: string): StepProgress | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.progress)) return undefined;
  const { step, count } = value.progress;
  if (!isAnalyzerStep(step)) return undefined;
  if (count === undefined) return { step };
  return isCount(count) ? { step, count } : undefined;
}

/** The stdout line (with its newline) the child prints for what the analysis has found. */
export function foundLine(found: FoundFacts): string {
  return `${JSON.stringify({ found })}\n`;
}

/**
 * Parse a stdout line as what was found, or return `undefined` if it isn't one. Only the
 * capped shape passes ({@link parseFoundFacts}): the names come from the repo.
 */
export function parseFoundLine(text: string): FoundFacts | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
  return parseFoundFacts(value.found);
}

/**
 * Parse the child's stdout line, or return `undefined` if it isn't a valid report. The
 * child is our code, but its output is checked like input: a crash can leave half a line.
 */
export function parseChildReport(text: string): ChildReport | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.ok === false) {
    const { code, message } = value;
    if (typeof code !== "string" || !CODE.test(code) || typeof message !== "string") {
      return undefined;
    }
    return { ok: false, code, message };
  }
  if (value.ok !== true || !isRecord(value.stats)) return undefined;
  const { files, nodes, edges, unresolved, warnings, graphBytes, stageMs } = value.stats;
  const { peakRssBytes, heapBytes, gcMs, cache } = value.stats;
  if (![files, nodes, edges, unresolved, warnings, graphBytes].every(isCount)) return undefined;
  if (!isRecord(stageMs) || !Object.values(stageMs).every(isCount)) return undefined;
  if (gcMs !== undefined && (!isRecord(gcMs) || !Object.values(gcMs).every(isCount))) {
    return undefined;
  }
  if (![peakRssBytes, heapBytes].every((bytes) => bytes === undefined || isCount(bytes))) {
    return undefined;
  }
  if (
    cache !== undefined &&
    (!isRecord(cache) || !CACHE_COUNTS.every((key) => isCount(cache[key])))
  ) {
    return undefined;
  }
  return {
    ok: true,
    stats: {
      files: files as number,
      nodes: nodes as number,
      edges: edges as number,
      unresolved: unresolved as number,
      warnings: warnings as number,
      graphBytes: graphBytes as number,
      stageMs: stageMs as Record<string, number>,
      ...(peakRssBytes === undefined ? {} : { peakRssBytes: peakRssBytes as number }),
      ...(heapBytes === undefined ? {} : { heapBytes: heapBytes as number }),
      ...(gcMs === undefined ? {} : { gcMs: gcMs as Record<string, number> }),
      ...(cache === undefined
        ? {}
        : { cache: cacheCounts(cache as Record<(typeof CACHE_COUNTS)[number], number>) }),
    },
  };
}
