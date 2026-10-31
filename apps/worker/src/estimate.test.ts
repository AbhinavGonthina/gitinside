import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BENCH_MODEL,
  BENCH_SAMPLE,
  MIN_SAMPLES,
  expectedMs,
  timeLeft,
  timingModel,
  type TimingSample,
} from "./estimate.js";
import { ANALYZER_STEPS } from "./progress.js";

const sample = (files: number, programs: number, upload?: number): TimingSample => ({
  files,
  stageMs: { inventory: files, programs, calls: files * 2 },
  ...(upload === undefined ? {} : { jobMs: { upload } }),
});

describe("BENCH_SAMPLE", () => {
  it("is the committed cal.com benchmark: each step's median, rounded, and its file nodes", () => {
    const report = JSON.parse(
      readFileSync(
        new URL("../../../bench/results/2026-10-26-analysis-calcom.json", import.meta.url),
        "utf8",
      ),
    ) as {
      summary: { stages: [string, { median: number }][]; counts: Record<string, number> };
    };
    expect(BENCH_SAMPLE.files).toBe(report.summary.counts["nodes.file"]);
    expect(BENCH_SAMPLE.stageMs).toEqual(
      Object.fromEntries(
        report.summary.stages.map(([step, { median }]) => [step, Math.round(median)]),
      ),
    );
    // Every benchmarked stage is one the worker streams.
    for (const step of Object.keys(BENCH_SAMPLE.stageMs ?? {})) {
      expect(ANALYZER_STEPS).toContain(step);
    }
  });
});

describe("timingModel", () => {
  it("uses the benchmark until enough analyses have finished", () => {
    const few = Array.from({ length: MIN_SAMPLES - 1 }, () => sample(100, 500, 300));
    expect(timingModel(few)).toBe(BENCH_MODEL);
    expect(BENCH_MODEL.source).toBe("bench");
    expect(BENCH_MODEL.uploadMs).toBeUndefined();
    expect(BENCH_MODEL.msPerFile.programs).toBeCloseTo(32686 / 5041);
  });

  it("takes the median per-file rate of each step and the median upload from past jobs", () => {
    // programs per file: 2, 4, 5, 10, 20 ⇒ median 5. Uploads 100…500 ⇒ 300.
    const samples = [
      sample(100, 200, 100),
      sample(50, 200, 500),
      sample(10, 50, 200),
      sample(10, 100, 400),
      sample(5, 100, 300),
    ];
    const model = timingModel(samples);
    expect(model.source).toBe("jobs");
    expect(model.msPerFile).toEqual({ inventory: 1, programs: 5, calls: 2 });
    expect(model.uploadMs).toBe(300);
  });

  it("averages the middle two of an even count", () => {
    const samples = [1, 2, 3, 4, 5, 6].map((n) => sample(10, n * 10));
    expect(timingModel(samples).msPerFile.programs).toBe(3.5);
  });

  it("skips analyses with no files or no step timings, and timings that aren't times", () => {
    const usable = Array.from({ length: MIN_SAMPLES - 1 }, () => sample(10, 10));
    const unusable: TimingSample[] = [
      { files: 0, stageMs: { programs: 1 } },
      { files: 10 },
      { files: 1.5, stageMs: { programs: 1 } },
    ];
    expect(timingModel([...usable, ...unusable])).toBe(BENCH_MODEL);
    const odd = { files: 10, stageMs: { programs: Number.NaN, calls: -1 } };
    const model = timingModel([...usable, odd]);
    expect(model.source).toBe("jobs");
    expect(model.msPerFile.programs).toBe(1);
    expect(model.msPerFile.calls).toBe(2);
    expect(model.uploadMs).toBeUndefined();
  });
});

describe("expectedMs", () => {
  const model = {
    msPerFile: { inventory: 1, programs: 5, calls: 2 },
    uploadMs: 300,
    source: "jobs" as const,
  };

  it("adds this step, every later one, and saving", () => {
    expect(expectedMs(model, { stage: "analyze", step: "programs" }, 100)).toBe(500 + 200 + 300);
    expect(expectedMs(model, { stage: "analyze", step: "imports" }, 100)).toBe(200 + 300);
    expect(expectedMs(model, { stage: "analyze", step: "assemble" }, 100)).toBe(300);
    expect(expectedMs(model, { stage: "upload" }, undefined)).toBe(300);
  });

  it("has nothing to say without a file count, with no files, or for an unmeasured upload", () => {
    expect(expectedMs(model, { stage: "analyze", step: "programs" }, undefined)).toBeUndefined();
    expect(expectedMs(model, { stage: "analyze", step: "programs" }, 0)).toBeUndefined();
    expect(expectedMs(BENCH_MODEL, { stage: "upload" }, 100)).toBeUndefined();
  });

  it("estimates cal.com's analysis from the benchmark as the benchmark measured it", () => {
    const { inventory = 0, workspace = 0, ...rest } = BENCH_SAMPLE.stageMs ?? {};
    const fromParsing = Object.values(rest).reduce((a, b) => a + b, 0);
    expect(inventory + workspace).toBeGreaterThan(0);
    expect(expectedMs(BENCH_MODEL, { stage: "analyze", step: "programs" }, 5041)).toBe(fromParsing);
  });
});

describe("timeLeft", () => {
  it("counts down from the expectation and stops at 0", () => {
    expect(timeLeft(10_000, 1_000, 1_000)).toBe(10_000);
    expect(timeLeft(10_000, 1_000, 4_500)).toBe(6_500);
    expect(timeLeft(10_000, 1_000, 11_000)).toBe(0);
    expect(timeLeft(10_000, 1_000, 99_000)).toBe(0);
  });

  it("treats a clock that went back as no time passed", () => {
    expect(timeLeft(10_000, 5_000, 1_000)).toBe(10_000);
  });
});
