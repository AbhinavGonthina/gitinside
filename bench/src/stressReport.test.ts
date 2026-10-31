import { describe, expect, it } from "vitest";
import type { RunResult } from "./report.js";
import {
  checkLimits,
  duration,
  renderStressReport,
  stageAt,
  stageTimeline,
  type ProductionLimits,
  type StressData,
  type StressMeta,
  type StressRun,
} from "./stressReport.js";

const MIB = 1024 * 1024;

const LIMITS: ProductionLimits = {
  maxTarBytes: 500 * MIB,
  maxEntries: 100_000,
  maxSourceFiles: 20_000,
  maxHeapMb: 3072,
  timeoutMs: 300_000,
};

const META: StressMeta = {
  date: "2026-10-31",
  repo: { name: "big", url: "https://github.com/x/big", sha: "abc" },
  gitinsideSha: "def",
  analyzerVersion: "0.1.0",
  heapMb: 12288,
  machine: { label: "dev", cpu: "CPU", cores: 8, ramGiB: 16, os: "linux 6", node: "v22" },
  limits: LIMITS,
};

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    totalMs: 400_000,
    stages: { inventory: 10_000, programs: 250_000, calls: 140_000 },
    maxRssBytes: 6000 * MIB,
    heapTotalBytes: 4000 * MIB,
    graphSha256: "a",
    counts: { "nodes.file": 30_000, "edges.calls": 5 },
    ...over,
  };
}

function data(runs: StressRun[], over: Partial<StressData> = {}): StressData {
  return {
    download: { compressedBytes: 90 * MIB, ms: 20_000 },
    extraction: {
      tarBytes: 700 * MIB,
      entries: 12_000,
      files: 10_000,
      directories: 1_999,
      skipped: 1,
      ms: 30_000,
    },
    inventory: { files: 9_000, sourceFiles: 25_000, warnings: 40, ms: 5_000 },
    runs,
    ...over,
  };
}

const byCode = (checks: ReturnType<typeof checkLimits>): Record<string, boolean | null> =>
  Object.fromEntries(checks.map((c) => [c.code, c.over]));

describe("duration", () => {
  it("prints seconds under a minute, minutes and seconds above", () => {
    expect(duration(12_345)).toBe("12.3 s");
    expect(duration(300_000)).toBe("5 min 0 s");
    expect(duration(419_600)).toBe("7 min 0 s");
    expect(duration(61_400)).toBe("1 min 1 s");
  });
});

describe("stageTimeline and stageAt", () => {
  const stages = { inventory: 10, programs: 50, calls: 40 };

  it("adds up when each stage ended, in pipeline order", () => {
    expect(stageTimeline(stages)).toEqual([
      ["inventory", 10, 10],
      ["programs", 50, 60],
      ["calls", 40, 100],
    ]);
  });

  it("names the stage running at a time, or null after the last", () => {
    expect(stageAt(stages, 0)).toBe("inventory");
    expect(stageAt(stages, 10)).toBe("programs");
    expect(stageAt(stages, 99)).toBe("calls");
    expect(stageAt(stages, 100)).toBeNull();
  });
});

describe("checkLimits", () => {
  it("checks the limits in the order a job meets them", () => {
    expect(checkLimits(LIMITS, data([{ ok: true, result: result() }])).map((c) => c.code)).toEqual([
      "LIMIT_SIZE",
      "LIMIT_ENTRIES",
      "LIMIT_FILES",
      "LIMIT_MEMORY",
      "LIMIT_TIME",
    ]);
  });

  it("flags each measurement over its limit", () => {
    expect(byCode(checkLimits(LIMITS, data([{ ok: true, result: result() }])))).toEqual({
      LIMIT_SIZE: true,
      LIMIT_ENTRIES: false,
      LIMIT_FILES: true,
      LIMIT_MEMORY: true,
      LIMIT_TIME: true,
    });
  });

  it("counts a value equal to the limit as within it", () => {
    const at = data([{ ok: true, result: result({ totalMs: 300_000 }) }], {
      inventory: { files: 1, sourceFiles: 20_000, warnings: 0, ms: 1 },
    });
    expect(byCode(checkLimits(LIMITS, at))).toMatchObject({
      LIMIT_FILES: false,
      LIMIT_TIME: false,
    });
  });

  it("checks source size after the file count when both the limit and the size are known", () => {
    const sized = (sourceBytes: number) =>
      data([{ ok: true, result: result() }], {
        inventory: { files: 1, sourceFiles: 1, sourceBytes, warnings: 0, ms: 1 },
      });
    const limits = { ...LIMITS, maxSourceBytes: 40 * MIB };
    const over = checkLimits(limits, sized(201 * MIB));
    expect(over.map((c) => c.code).slice(2, 4)).toEqual(["LIMIT_FILES", "LIMIT_SOURCE_SIZE"]);
    expect(over[3]).toEqual({
      code: "LIMIT_SOURCE_SIZE",
      where: "inventory",
      limit: "40 MiB of source",
      measured: "201 MiB of source",
      over: true,
    });
    expect(byCode(checkLimits(limits, sized(40 * MIB))).LIMIT_SOURCE_SIZE).toBe(false);
    // A report from before M5.16b has neither, so the row is left out.
    expect(byCode(checkLimits(LIMITS, sized(MIB)))).not.toHaveProperty("LIMIT_SOURCE_SIZE");
    expect(byCode(checkLimits(limits, data([])))).not.toHaveProperty("LIMIT_SOURCE_SIZE");
  });

  it("tells memory from RSS under the cap, a final heap over it, or not at all", () => {
    const memory = (r: RunResult): boolean | null =>
      byCode(checkLimits(LIMITS, data([{ ok: true, result: r }]))).LIMIT_MEMORY ?? null;
    expect(memory(result({ maxRssBytes: 3072 * MIB, heapTotalBytes: 2000 * MIB }))).toBe(false);
    expect(memory(result({ maxRssBytes: 5000 * MIB, heapTotalBytes: 3073 * MIB }))).toBe(true);
    expect(memory(result({ maxRssBytes: 5000 * MIB, heapTotalBytes: 2000 * MIB }))).toBeNull();
  });

  it("uses the first run that finished, and can't tell without one", () => {
    const failed: StressRun = { ok: false, error: "exit code 134: heap", wallMs: 9 };
    const fast = result({ totalMs: 1000, maxRssBytes: MIB, heapTotalBytes: MIB });
    expect(byCode(checkLimits(LIMITS, data([failed, { ok: true, result: fast }])))).toMatchObject({
      LIMIT_MEMORY: false,
      LIMIT_TIME: false,
    });
    expect(byCode(checkLimits(LIMITS, data([failed])))).toMatchObject({
      LIMIT_MEMORY: null,
      LIMIT_TIME: null,
    });
  });
});

describe("renderStressReport", () => {
  it("prints the limits table, the first limit hit, and the measured numbers", () => {
    const md = renderStressReport(META, data([{ ok: true, result: result() }]));
    expect(md).toContain("https://github.com/x/big at `abc`");
    expect(md).toContain("analyzed once in a fresh Node process per run");
    expect(md).toContain("heap 12,288 MB instead of 3,072 MB");
    expect(md).toContain("| `LIMIT_SIZE` | extraction | 500 MiB | 700 MiB | **over** |");
    expect(md).toContain("| `LIMIT_ENTRIES` | extraction | 100,000 | 12,000 | within |");
    expect(md).toContain("**First limit hit in production:** `LIMIT_SIZE`, during extraction.");
    expect(md).toContain("| `LIMIT_MEMORY` | analysis | 3,072 MB heap |");
    expect(md).toContain("| Tarball (gzipped) | 90 MiB (94.4 MB) |");
    expect(md).toContain("| Source files (`LIMIT_FILES` counts these) | 25,000 |");
    expect(md).toContain(
      "- Run 1: 400,000 ms (6 min 40 s), peak RSS 6,000 MiB, final heap 4,000 MiB",
    );
    expect(md).toContain("| programs | 250,000 ms | 4 min 20 s |");
    expect(md).toContain("At the 5 min 0 s limit the `calls` stage was running.");
    expect(md.indexOf("| edges.calls |")).toBeLessThan(md.indexOf("| nodes.file |"));
    // One run: nothing to compare graphs with.
    expect(md).not.toContain("Graphs identical");
  });

  it("names every limit passed in the earliest step, since their order there isn't measured", () => {
    const md = renderStressReport(
      META,
      data([{ ok: true, result: result() }], {
        extraction: { tarBytes: MIB, entries: 3, files: 2, directories: 1, skipped: 0, ms: 1 },
        inventory: { files: 2, sourceFiles: 2, warnings: 0, ms: 1 },
      }),
    );
    expect(md).toContain(
      "**First limit hit in production:** `LIMIT_MEMORY` or `LIMIT_TIME`, during analysis, whichever the job reaches first (these numbers don't say which).",
    );
  });

  it("reports failed runs and compares graphs across runs that finished", () => {
    const md = renderStressReport(
      META,
      data([
        { ok: false, error: "exit code 134: out of memory", wallMs: 1500 },
        { ok: true, result: result() },
        { ok: true, result: result({ graphSha256: "b" }) },
      ]),
    );
    expect(md).toContain("analyzed 3 times");
    expect(md).toContain("- Run 1: **failed** after 1,500 ms: exit code 134: out of memory");
    expect(md).toContain("Per stage (run 2)");
    expect(md).toContain("**Graphs identical across runs:** **NO**");
  });

  it("says when no limit is hit and every stage ended in time", () => {
    const small = result({
      totalMs: 1000,
      stages: { inventory: 1000 },
      maxRssBytes: MIB,
      heapTotalBytes: MIB,
    });
    const md = renderStressReport(
      META,
      data([{ ok: true, result: small }], {
        extraction: { tarBytes: MIB, entries: 3, files: 2, directories: 1, skipped: 0, ms: 1 },
        inventory: { files: 2, sourceFiles: 2, warnings: 0, ms: 1 },
      }),
    );
    expect(md).toContain("**First limit hit in production:** none of the limits above.");
    expect(md).toContain("Every stage ended within the 5 min 0 s limit.");
  });

  it("names the source size and its limit once both are measured", () => {
    const md = renderStressReport(
      { ...META, limits: { ...LIMITS, maxSourceBytes: 40 * MIB } },
      data([{ ok: true, result: result() }], {
        inventory: { files: 9, sourceFiles: 9, sourceBytes: 201 * MIB, warnings: 0, ms: 1 },
      }),
    );
    expect(md).toContain("production's limits lifted (size, entries, source files, source size;");
    expect(md).toContain(
      "| `LIMIT_SOURCE_SIZE` | inventory | 40 MiB of source | 201 MiB of source | **over** |",
    );
    expect(md).toContain("| Source size (`LIMIT_SOURCE_SIZE` counts this) | 201 MiB |");
    expect(renderStressReport(META, data([]))).not.toContain("Source size");
  });

  it("leaves out stages and graph size when no run finished", () => {
    const md = renderStressReport(META, data([{ ok: false, error: "x", wallMs: 1 }]));
    expect(md).toContain("| `LIMIT_TIME` | analysis | 5 min 0 s | no run finished | can't tell |");
    expect(md).not.toContain("## Graph size");
  });
});
