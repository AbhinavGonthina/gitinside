import { ANALYSIS_STAGES } from "@gitinside/analyzer";
import { describe, expect, it } from "vitest";
import {
  ANALYZER_STEPS,
  FOUND_NAME_LENGTH,
  FOUND_NAMES_MAX,
  STAGE_PROGRESS,
  describeFound,
  describeProgress,
  formatCount,
  foundFacts,
  isAnalyzerStep,
  parseFoundFacts,
  stepProgress,
} from "./progress.js";

describe("foundFacts", () => {
  it("keeps the first names of each list with the full count, and the counts as they are", () => {
    const services = Array.from({ length: 10 }, (_, i) => `svc-${i}`);
    expect(
      foundFacts({ services, routes: 12, pages: 0, stores: [], externals: ["api.stripe.com"] }),
    ).toEqual({
      services: { count: 10, names: services.slice(0, FOUND_NAMES_MAX) },
      routes: 12,
      pages: 0,
      stores: { count: 0, names: [] },
      externals: { count: 1, names: ["api.stripe.com"] },
    });
    expect(foundFacts({})).toEqual({});
  });

  it("caps long names and replaces hidden characters, so what it makes always parses", () => {
    const long = "😀".repeat(FOUND_NAME_LENGTH + 1);
    const facts = foundFacts({ services: [long, "evil‮txt.exe", "tab\there"] });
    const names = facts.services?.names ?? [];
    expect(Array.from(names[0] ?? "")).toHaveLength(FOUND_NAME_LENGTH);
    expect(names[0]?.endsWith("😀…")).toBe(true);
    expect(names.slice(1)).toEqual(["evil�txt.exe", "tab�here"]);
    expect(parseFoundFacts(facts)).toEqual(facts);
  });
});

describe("parseFoundFacts", () => {
  it.each([
    null,
    [],
    "x",
    { routes: -1 },
    { routes: 1.5 },
    { pages: "3" },
    { other: 1 },
    { services: ["api"] },
    { services: { count: 1 } },
    { services: { count: 1, names: ["api"], extra: 1 } },
    { services: { count: 0, names: ["api"] } },
    { services: { count: 1, names: [""] } },
    { services: { count: 1, names: [3] } },
    { services: { count: 1, names: ["x".repeat(FOUND_NAME_LENGTH + 1)] } },
    { services: { count: 9, names: Array.from({ length: 9 }, (_, i) => `s${i}`) } },
    { stores: { count: 1, names: ["a\u0000b"] } },
    { externals: { count: 1, names: ["a​b"] } },
  ])("refuses %j", (value) => {
    expect(parseFoundFacts(value)).toBeUndefined();
  });

  it("copies a well-formed value", () => {
    const value = { services: { count: 3, names: ["a", "b"] }, routes: 0, pages: 2 };
    const parsed = parseFoundFacts(value);
    expect(parsed).toEqual(value);
    expect(parsed?.services?.names).not.toBe(value.services.names);
  });
});

describe("describeFound", () => {
  it("says what was found in a fixed order, with the rest counted", () => {
    expect(
      describeFound({
        externals: { count: 1, names: ["api.stripe.com"] },
        stores: { count: 2, names: ["postgres", "redis"] },
        pages: 3,
        routes: 1_204,
        services: { count: 11, names: ["a", "b", "c", "d", "e", "f", "g", "h"] },
      }),
    ).toEqual([
      { key: "services", label: "11 services", text: "a, b, c, d, e, f, g, h, and 3 more" },
      { key: "routes", label: "Entry points", text: "1,204 routes, 3 pages" },
      { key: "stores", label: "Data", text: "postgres, redis" },
      { key: "externals", label: "Outside services", text: "api.stripe.com" },
    ]);
  });

  it("leaves out what wasn't looked for yet or wasn't found, with singulars", () => {
    expect(describeFound({})).toEqual([]);
    expect(
      describeFound({
        services: { count: 1, names: ["app"] },
        routes: 0,
        pages: 1,
        stores: { count: 0, names: [] },
      }),
    ).toEqual([
      { key: "services", label: "Service", text: "app" },
      { key: "routes", label: "Entry points", text: "1 page" },
    ]);
  });
});

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
