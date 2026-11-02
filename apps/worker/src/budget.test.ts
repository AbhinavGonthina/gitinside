import { describe, expect, it } from "vitest";
import { INSTANCE_MEMORY_MIB, MEMORY_ALLOWANCES_MIB, memoryBudget } from "./budget.js";
import { DEFAULT_EXTRACT_LIMITS } from "./extract.js";
import { DEFAULT_FACT_CACHE_BYTES } from "./factcache.js";
import { DEFAULT_RUNNER_LIMITS } from "./runner.js";

const MIB = 1024 * 1024;

describe("memoryBudget", () => {
  it("fits one job at the default limits in a 4 GiB instance whose /tmp is memory", () => {
    const budget = memoryBudget();
    expect(INSTANCE_MEMORY_MIB).toBe(4096);
    expect(budget).toEqual({
      heap: 2560,
      ...MEMORY_ALLOWANCES_MIB,
      // 400 MiB of tar stream, plus up to a 4 KiB page per entry: 60,000 × 4 KiB.
      tree: 400 + 234.375,
      factCache: 64,
      total: 2560 + 256 + 256 + 128 + 634.375 + 64 + 192,
    });
    expect(budget.total).toBeLessThanOrEqual(INSTANCE_MEMORY_MIB);
  });

  it("holds the cache's cap, and goes over the instance if the cache grows past its share", () => {
    expect(memoryBudget().factCache * MIB).toBe(DEFAULT_FACT_CACHE_BYTES);
    // Two cal.com-sized analyses' facts (25.2 MiB each, bench/results/2026-11-02-cache-sizes.md).
    expect(DEFAULT_FACT_CACHE_BYTES).toBeGreaterThan(2 * 26_472_448);
    expect(
      memoryBudget(DEFAULT_RUNNER_LIMITS, DEFAULT_EXTRACT_LIMITS, 128 * MIB).total,
    ).toBeGreaterThan(INSTANCE_MEMORY_MIB);
  });

  it("adds every part up", () => {
    const budget = memoryBudget(
      { ...DEFAULT_RUNNER_LIMITS, maxHeapMb: 1000 },
      { ...DEFAULT_EXTRACT_LIMITS, maxBytes: 100 * MIB, maxEntries: 256 },
      8 * MIB,
    );
    expect(budget.heap).toBe(1000);
    expect(budget.tree).toBe(101);
    expect(budget.factCache).toBe(8);
    const { total, ...parts } = budget;
    expect(total).toBe(Object.values(parts).reduce((sum, mib) => sum + mib, 0));
  });

  it("goes over the instance when the heap or the extraction limits grow back to their VM values", () => {
    // The Oracle VM's limits (ADR-0059, ADR-0058): 3 GB heap, 500 MiB, 100,000 entries.
    expect(memoryBudget({ ...DEFAULT_RUNNER_LIMITS, maxHeapMb: 3072 }).total).toBeGreaterThan(
      INSTANCE_MEMORY_MIB,
    );
    expect(
      memoryBudget(DEFAULT_RUNNER_LIMITS, {
        ...DEFAULT_EXTRACT_LIMITS,
        maxBytes: 500 * MIB,
        maxEntries: 100_000,
      }).total,
    ).toBeGreaterThan(INSTANCE_MEMORY_MIB);
  });

  it("allows more than the largest measured runs used (bench/results/2026-11-01-capped-memory.md)", () => {
    // Peak RSS over the heap cap under 2,048 MB: 2,138.9 (src/vs/platform), 1,993.1 (cal.com).
    expect(MEMORY_ALLOWANCES_MIB.childOutsideHeap).toBeGreaterThan(2 * (2138.9 - 2048));
    // The worker process at rest: 96.8 MiB.
    expect(MEMORY_ALLOWANCES_MIB.parent).toBeGreaterThan(2 * 96.8);
    // The largest graph: 53.5 MiB (src/vs/platform, 44.8 MiB of source).
    expect(MEMORY_ALLOWANCES_MIB.graphFile).toBeGreaterThan(2 * 53.5);
    // The heap cap is 25% over 2,048 MB, under which cal.com and src/vs/platform finished.
    expect(DEFAULT_RUNNER_LIMITS.maxHeapMb).toBe(2048 * 1.25);
  });
});
