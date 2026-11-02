import { describe, expect, it } from "vitest";
import {
  renderIncrementalReport,
  summarizeCase,
  type IncrementalCase,
  type IncrementalMeta,
} from "./incrementalReport.js";
import type { RunResult } from "./report.js";

function run(
  totalMs: number,
  sha: string,
  cache?: { hits: number; misses: number },
  stages: Record<string, number> = { inventory: totalMs / 4, programs: totalMs / 2 },
): RunResult {
  return {
    totalMs,
    stages,
    maxRssBytes: totalMs * 1024 * 1024,
    graphSha256: sha,
    counts: {},
    ...(cache
      ? { cache: { ...cache, writes: cache.misses, evictions: 0, errors: 0, bytes: 0, entries: 0 } }
      : {}),
  };
}

const META: IncrementalMeta = {
  date: "2026-11-02",
  repo: { name: "demo", url: "https://github.com/x/demo", sha: "abc" },
  gitinsideSha: "def",
  analyzerVersion: "0.1.0",
  warmupRuns: 1,
  machine: { label: "dev", cpu: "CPU", cores: 8, ramGiB: 16, os: "linux 6", node: "v22" },
  fill: {
    ...run(1200, "a"),
    cache: {
      hits: 0,
      misses: 3,
      writes: 3,
      evictions: 0,
      errors: 0,
      bytes: 5 * 1024 * 1024,
      entries: 3,
    },
  },
};

const UNCHANGED: IncrementalCase = {
  title: "Nothing changed",
  cold: [run(1000, "a"), run(1200, "a"), run(1100, "a")],
  warm: [
    run(100, "a", { hits: 3, misses: 0 }, { inventory: 50, programs: 10 }),
    run(120, "a", { hits: 3, misses: 0 }, { inventory: 60, programs: 12 }),
    run(110, "a", { hits: 3, misses: 0 }, { inventory: 55, programs: 11 }),
  ],
};

const EDIT: IncrementalCase = {
  title: "One app",
  edit: "apps/api/main.ts",
  cold: [run(1000, "b1"), run(1000, "b2")],
  warm: [run(400, "b1", { hits: 2, misses: 1 }), run(600, "b2", { hits: 1, misses: 2 })],
};

describe("summarizeCase", () => {
  it("compares warm with cold medians and checks each pair's bytes", () => {
    const s = summarizeCase(UNCHANGED);
    expect(s.runs).toBe(3);
    expect(s.cold).toEqual({ median: 1100, min: 1000, max: 1200 });
    expect(s.warm).toEqual({ median: 110, min: 100, max: 120 });
    expect(s.ratio).toBeCloseTo(0.1);
    expect(s.hits).toEqual({ median: 3, min: 3, max: 3 });
    expect(s.sameBytes).toBe(true);
    expect(s.warmStages).toEqual([
      ["inventory", 55],
      ["programs", 11],
    ]);
  });

  it("pairs runs by position: a warm graph matching another pair's cold one doesn't count", () => {
    expect(summarizeCase(EDIT).sameBytes).toBe(true);
    expect(summarizeCase({ ...EDIT, warm: [...EDIT.warm].reverse() }).sameBytes).toBe(false);
  });

  it("rejects a case with no runs or unpaired runs", () => {
    expect(() => summarizeCase({ title: "x", cold: [], warm: [] })).toThrow(/same non-zero/);
    expect(() => summarizeCase({ ...EDIT, warm: EDIT.warm.slice(1) })).toThrow(/same non-zero/);
  });
});

describe("renderIncrementalReport", () => {
  it("prints the repo, machine, cache fill, and each case as measured", () => {
    const md = renderIncrementalReport(META, [summarizeCase(UNCHANGED), summarizeCase(EDIT)]);
    expect(md).toContain("https://github.com/x/demo at `abc`");
    expect(md).toContain("CPU (8 logical cores), 16 GiB RAM, linux 6, Node v22");
    expect(md).toContain("**Filling the cache:** 1,200 ms, 3 entries written, 5 MiB on disk.");
    expect(md).toContain("**Warm graphs identical to cold:** yes, in every pair");
    expect(md).toContain(
      "| Nothing changed | none | 1,100 ms (1,000 ms to 1,200 ms) | 110 ms (100 ms to 120 ms) | 10% | 3 / 0 | yes |",
    );
    expect(md).toContain(
      "| One app | `apps/api/main.ts` | 1,000 ms (1,000 ms to 1,000 ms) | 500 ms (400 ms to 600 ms) | 50% | 1.5 (1 to 2) / 1.5 (1 to 2) | yes |",
    );
    expect(md).toContain("| Nothing changed | 1100 MiB (1000 MiB to 1200 MiB) |");
    expect(md).toContain("| programs | 550 ms | 11 ms | 500 ms | 250 ms |");
  });

  it("says when a stage wasn't reported, and calls out differing bytes loudly", () => {
    const partial: IncrementalCase = {
      ...EDIT,
      warm: [run(400, "b1", { hits: 2, misses: 1 }, { inventory: 9 }), run(600, "zz")],
    };
    const md = renderIncrementalReport(META, [summarizeCase(partial)]);
    expect(md).toContain("| programs | 500 ms | not reported |");
    expect(md).toContain("**Warm graphs identical to cold:** **NO**");
    expect(md).toMatch(/\| One app .*\| \*\*NO\*\* \|/);
  });
});
