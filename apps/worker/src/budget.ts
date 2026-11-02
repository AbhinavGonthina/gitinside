import { DEFAULT_EXTRACT_LIMITS, type ExtractLimits } from "./extract.js";
import { DEFAULT_FACT_CACHE_BYTES } from "./factcache.js";
import { DEFAULT_RUNNER_LIMITS, type RunnerLimits } from "./runner.js";

/**
 * The worker's memory budget on Cloud Run (ADR-0111, ADR-0146).
 *
 * One instance has 4 GiB and runs one job at a time (concurrency 1, ADR-0143). Its `/tmp` is
 * an in-memory filesystem, so the unpacked repo counts against the same 4 GiB as the
 * processes. During the analysis, the busiest moment, these are all alive at once:
 * - the analysis child: its V8 heap cap (`maxHeapMb`) plus what V8 and Node hold outside it
 *   (young generation, code, buffers);
 * - the worker process itself;
 * - the unpacked tree: at most `maxBytes` of tar stream, each file and folder rounded up to a
 *   whole 4 KiB page (so at most a page more per entry);
 * - `architecture.json`, which the child writes before it exits;
 * - the fact cache folders (factcache.ts), which outlive the job, at their cap;
 * - spare room for the runtime and the kernel.
 *
 * After the child exits the worker reads and gzips the graph, which needs far less. The
 * allowances are about twice what bench/results/2026-11-01-capped-memory.md measured;
 * budget.test.ts checks that the defaults fit and that the VM's old limits don't.
 *
 * Not covered: a graph over {@link MEMORY_ALLOWANCES_MIB}'s `graphFile` (nothing caps it; the
 * largest measured, 53.5 MiB, came from 44.8 MiB of source against the 50 MB source limit).
 * Going over the instance's memory gets the instance killed, not a `LIMIT_MEMORY` failure.
 */

/** Memory of one Cloud Run instance, in MiB (ADR-0111). */
export const INSTANCE_MEMORY_MIB = 4096;

/** What the budget keeps for everything the limits don't bound, in MiB. */
export const MEMORY_ALLOWANCES_MIB = {
  /** The child's memory outside the old-space cap (measured ≤ 91 MiB over it). */
  childOutsideHeap: 256,
  /** The worker process (measured 96.8 MiB at rest). */
  parent: 256,
  /** `architecture.json` in `/tmp` (measured ≤ 53.5 MiB). */
  graphFile: 128,
  /**
   * The runtime, the kernel's bookkeeping for `/tmp`, and error. 192 MiB since the fact cache
   * took 64 MiB of the 256 here (ADR-0178).
   */
  spare: 192,
} as const;

/** What an in-memory filesystem rounds each file and folder up to. */
const PAGE_BYTES = 4096;
const MIB = 1024 * 1024;

/** The parts of {@link memoryBudget}, in MiB. */
export interface MemoryBudget {
  heap: number;
  childOutsideHeap: number;
  parent: number;
  graphFile: number;
  /** The unpacked repo in `/tmp`, at the extraction limits. */
  tree: number;
  /** The fact cache folders in `/tmp` at their cap (factcache.ts). */
  factCache: number;
  spare: number;
  /** All of the above. Must be at most {@link INSTANCE_MEMORY_MIB}. */
  total: number;
}

/** The most memory one job can use under these limits, by part (see the module comment). */
export function memoryBudget(
  runner: RunnerLimits = DEFAULT_RUNNER_LIMITS,
  extract: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
  factCacheBytes: number = DEFAULT_FACT_CACHE_BYTES,
): MemoryBudget {
  const heap = runner.maxHeapMb;
  const tree = (extract.maxBytes + extract.maxEntries * PAGE_BYTES) / MIB;
  const factCache = factCacheBytes / MIB;
  const { childOutsideHeap, parent, graphFile, spare } = MEMORY_ALLOWANCES_MIB;
  return {
    heap,
    childOutsideHeap,
    parent,
    graphFile,
    tree,
    factCache,
    spare,
    total: heap + childOutsideHeap + parent + graphFile + tree + factCache + spare,
  };
}
