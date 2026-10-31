import { parseGraph, stringifyGraph } from "@gitinside/schema";
import { buildHierarchy, buildView, DEFAULT_FILTERS } from "@gitinside/viewer";
import { describe, expect, it } from "vitest";
import { openToReach, SYNTHETIC_SERVICES, syntheticGraph } from "./renderGraphs.js";

describe("syntheticGraph", () => {
  it.each([500, 1000, 2000])("draws exactly %i boxes at its expansion", (visible) => {
    const synthetic = syntheticGraph(visible);
    expect(synthetic.nodes).toBe(visible);
    expect(synthetic.open).toHaveLength(SYNTHETIC_SERVICES);
    // Per entry: a handles or renders line, plus an HTTP line for every backend route.
    const entries = visible / SYNTHETIC_SERVICES - 2;
    expect(synthetic.lines).toBe(entries * SYNTHETIC_SERVICES * 1.5);
  });

  it("is a valid graph, the same bytes every time", () => {
    const { graph } = syntheticGraph(500);
    expect(() => parseGraph(graph)).not.toThrow();
    expect(stringifyGraph(syntheticGraph(500).graph)).toBe(stringifyGraph(graph));
  });

  it("draws every kind of line it makes, between services too", () => {
    const { graph, open } = syntheticGraph(100);
    const view = buildView(buildHierarchy(graph), open, { filters: DEFAULT_FILTERS });
    expect(new Set(view.edges.map((e) => e.kind))).toEqual(new Set(["handles", "renders", "http"]));
    expect(new Set(view.edges.map((e) => e.confidence))).toEqual(
      new Set(["exact", "pattern", "heuristic"]),
    );
  });

  it.each([0, 20, 505])("refuses %i visible boxes", (visible) => {
    expect(() => syntheticGraph(visible)).toThrow(/multiple of 10/);
  });
});

describe("openToReach", () => {
  it("opens every service when that's exactly the target", () => {
    const { graph, open } = syntheticGraph(500);
    const reached = openToReach(graph, 500);
    expect(reached.nodes).toBe(500);
    expect([...reached.open].sort()).toEqual([...open].sort());
  });

  it("stops at the largest level under the target that nothing more fits into", () => {
    const { graph } = syntheticGraph(500);
    const index = buildHierarchy(graph);
    const reached = openToReach(graph, 250);
    expect(reached.nodes).toBeLessThanOrEqual(250);
    const view = buildView(index, reached.open, { filters: DEFAULT_FILTERS });
    expect(view.nodes).toHaveLength(reached.nodes);
    expect(view.edges).toHaveLength(reached.lines);
    for (const n of view.nodes.filter((v) => !v.open && v.canOpen)) {
      const more = buildView(index, [...reached.open, n.id], { filters: DEFAULT_FILTERS });
      expect(more.nodes.length, n.id).toBeGreaterThan(250);
    }
    // Four services (4 × 49 boxes) plus their folders broken down to files: 210.
    expect(reached.nodes).toBe(210);
  });

  it("opens nothing when the first level is already over the target", () => {
    const { graph } = syntheticGraph(500);
    const reached = openToReach(graph, 5);
    expect(reached.open).toEqual([]);
    expect(reached.nodes).toBe(SYNTHETIC_SERVICES);
  });
});
