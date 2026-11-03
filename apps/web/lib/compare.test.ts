import { BASE_PARAM as VIEWER_BASE_PARAM } from "@gitinside/viewer";
import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import renameBase from "../../../fixtures/diff-rename-base/expected.json";
import renameHead from "../../../fixtures/diff-rename-head/expected.json";
import { BASE_PARAM, baseNote, baseParam, COMMIT_SHA, compareGraphs } from "./compare";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

/** A fixture's graph recorded at `sha` (fixtures have none), as the worker stores it. */
const at = (json: unknown, sha: string): ArchitectureGraph => {
  const graph = parseGraph(json);
  return { ...graph, repo: { ...graph.repo, sha } };
};

describe("compareGraphs", () => {
  it("diffs base against head", () => {
    const base = at(renameBase, BASE);
    const head = at(renameHead, HEAD);
    const result = compareGraphs(base, head);
    if (!result.ok) throw new Error(result.note);
    expect(result.base).toBe(base);
    expect(result.diff.base.repo.sha).toBe(BASE);
    expect(result.diff.head.repo.sha).toBe(HEAD);
    const { nodes } = result.diff.summary;
    expect(nodes.added + nodes.removed + nodes.modified + nodes.renamed).toBeGreaterThan(0);
  });

  it("refuses graphs from two analyzer versions, saying why, and draws head alone", () => {
    const base = { ...at(renameBase, BASE), analyzerVersion: "0.0.9" };
    const head = at(renameHead, HEAD);
    expect(compareGraphs(base, head)).toEqual({
      ok: false,
      note: `Commit bbbbbbb was analyzed by GitInside 0.0.9 and this one by ${head.analyzerVersion}, so they aren't compared: the differences would be the analyzer's, not the code's. This is commit aaaaaaa alone.`,
    });
  });
});

describe("baseNote", () => {
  it("says nothing for a base that loads", () => {
    expect(baseNote({ status: "ready", sha: BASE, graphUrl: "/g" }, HEAD)).toBeUndefined();
  });

  it("says a base nobody analyzed, or a malformed one, isn't compared", () => {
    expect(baseNote({ status: "missing", sha: BASE }, HEAD)).toBe(
      "Commit bbbbbbb hasn't been analyzed, so there's nothing to compare with. This is commit aaaaaaa alone.",
    );
    expect(baseNote({ status: "invalid" }, HEAD)).toBe(
      "The link's base isn't a full commit SHA, so nothing was compared. This is commit aaaaaaa alone.",
    );
  });
});

describe("the base parameter", () => {
  it("is named as the explorer's codec names it", () => {
    expect(BASE_PARAM).toBe(VIEWER_BASE_PARAM);
  });

  it("takes the last of a repeated one, like the codec", () => {
    expect(baseParam(undefined)).toBeUndefined();
    expect(baseParam(BASE)).toBe(BASE);
    expect(baseParam(["x", BASE])).toBe(BASE);
  });

  it("is a full, lowercase SHA", () => {
    expect(COMMIT_SHA.test(BASE)).toBe(true);
    expect(COMMIT_SHA.test("bbbbbbb")).toBe(false);
    expect(COMMIT_SHA.test("B".repeat(40))).toBe(false);
    expect(COMMIT_SHA.test(`${BASE}0`)).toBe(false);
  });
});
