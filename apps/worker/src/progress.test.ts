import { ANALYSIS_STAGES } from "@gitinside/analyzer";
import { describe, expect, it } from "vitest";
import {
  ANALYZER_STEPS,
  STAGE_PROGRESS,
  describeProgress,
  formatCount,
  isAnalyzerStep,
  stepProgress,
} from "./progress.js";

describe("ANALYZER_STEPS", () => {
  it("is the analyzer's stage list, in order", () => {
    expect([...ANALYZER_STEPS]).toEqual([...ANALYSIS_STAGES]);
  });

  it.each([
    ["programs", true],
    ["download", false],
    ["toString", false],
    [7, false],
    [undefined, false],
  ])("isAnalyzerStep(%s) is %s", (value, expected) => {
    expect(isAnalyzerStep(value)).toBe(expected);
  });
});

describe("stepProgress", () => {
  it("spreads the steps over the analyze span, rising and below upload", () => {
    const values = ANALYZER_STEPS.map(stepProgress);
    expect(values[0]).toBe(STAGE_PROGRESS.analyze);
    expect(values.at(-1)).toBe(86);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1] as number);
    }
    expect(values.every((value) => Number.isInteger(value))).toBe(true);
    expect(Math.max(...values)).toBeLessThan(STAGE_PROGRESS.upload);
  });
});

describe("formatCount", () => {
  it.each([
    [0, "0"],
    [7, "7"],
    [999, "999"],
    [1000, "1,000"],
    [1204, "1,204"],
    [20000, "20,000"],
    [1234567, "1,234,567"],
  ])("formats %i as %s", (count, text) => {
    expect(formatCount(count)).toBe(text);
  });
});

describe("describeProgress", () => {
  it("uses UX.md's words for the counted steps, with singulars", () => {
    expect(describeProgress("analyze", "programs", 1204)).toBe("Parsing 1,204 files");
    expect(describeProgress("analyze", "programs", 1)).toBe("Parsing 1 file");
    expect(describeProgress("analyze", "http", 87)).toBe("Linking 87 calls to routes");
    expect(describeProgress("analyze", "http", 1)).toBe("Linking 1 call to routes");
    expect(describeProgress("analyze", "http", 0)).toBe("Linking 0 calls to routes");
  });

  it("falls back to the step's own words without a count", () => {
    expect(describeProgress("analyze", "programs")).toBe("Parsing files");
    expect(describeProgress("analyze", "http")).toBe("Finding HTTP calls");
    expect(describeProgress("analyze", "assemble")).toBe("Assembling the diagram");
  });

  it("ignores counts on steps that don't have one", () => {
    expect(describeProgress("analyze", "calls", 5)).toBe("Linking function calls");
  });

  it("describes every step and stage in a few words", () => {
    for (const step of ANALYZER_STEPS) {
      expect(describeProgress("analyze", step)).toMatch(/^[A-Z][\w .,-]{2,40}$/);
    }
    expect(describeProgress("download")).toBe("Downloading");
    expect(describeProgress("extract")).toBe("Unpacking");
    expect(describeProgress("analyze")).toBe("Analyzing");
    expect(describeProgress("upload", "programs", 3)).toBe("Saving the diagram");
  });
});
