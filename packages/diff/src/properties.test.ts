import {
  compareStrings,
  stringifyDiff,
  stringifyGraph,
  type ArchitectureGraph,
  type GraphDiff,
} from "@gitinside/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyDiff, diffGraphs, type FileContents } from "./index.js";
import { graphArb, pairArb, PAIR_RUNS as RUNS } from "./testkit.js";

/**
 * Property tests (DESIGN.md §8, TESTING.md) on the random base/head pairs of
 * `testkit.ts`, which the viewer's diff-mode tests share (M6.11g).
 */

const options = (contents: FileContents | undefined) =>
  contents === undefined ? {} : { contents };

const ids = (list: readonly { id: string }[]) => list.map((r) => r.id).sort(compareStrings);
const sorted = (list: readonly string[]) => [...list].sort(compareStrings);

/** Renames as sorted `from => to` strings; `flip` reads them backwards. */
const pairs = (list: readonly { from: string; to: string }[]) =>
  list.map(({ from, to }) => `${from} => ${to}`).sort(compareStrings);
const renamedNodes = (d: GraphDiff, flip = false) =>
  pairs(
    d.nodes.renamed.map((r) =>
      flip ? { from: r.node.id, to: r.from } : { from: r.from, to: r.node.id },
    ),
  );
const renamedEdges = (d: GraphDiff, flip = false) =>
  pairs(
    d.edges.renamed.map((r) =>
      flip ? { from: r.edge.id, to: r.from } : { from: r.from, to: r.edge.id },
    ),
  );

const reversed = (g: ArchitectureGraph): ArchitectureGraph => ({
  ...g,
  nodes: [...g.nodes].reverse(),
  edges: g.edges.map((e) => ({ ...e, sites: [...e.sites].reverse() })).reverse(),
  warnings: [...g.warnings].reverse(),
});

// 300 diffs per property take a few seconds, more under coverage on a loaded machine.
describe("diff properties (fast-check)", { timeout: 60_000 }, () => {
  // Guards against vacuous properties: the pairs below must include each case at least once.
  it("the generator reaches renames, broken edges of every reason, and warnings", () => {
    const counts = new Map<string, number>();
    const seen = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);
    for (const { base, head, contents } of fc.sample(pairArb, RUNS)) {
      const d = diffGraphs(base, head, options(contents));
      if (d.nodes.renamed.length > 0) seen(contents === undefined ? "rename" : "rename+contents");
      if (d.edges.renamed.length > 0) seen("edge rename");
      if (d.nodes.modified.length > 0) seen("modified");
      if (d.nodes.updated.length > 0) seen("updated");
      if (d.warnings.added.length > 0) seen("warning");
      for (const reason of new Set(d.broken.map((b) => b.reason))) seen(reason);
      // A removed symbol head still imports by name (M7.2e): the only `calls` case removed.
      if (d.broken.some((b) => b.edge.startsWith("calls:") && b.reason === "TARGET_REMOVED")) {
        seen("calls TARGET_REMOVED");
      }
    }
    expect([...counts.keys()].sort(compareStrings)).toEqual(
      [
        "FIELD_REMOVED",
        "calls TARGET_REMOVED",
        "PARAMETERS_ADDED",
        "ROUTE_CHANGED",
        "TARGET_MOVED",
        "TARGET_REMOVED",
        "edge rename",
        "modified",
        "rename",
        "rename+contents",
        "updated",
        "warning",
      ].sort(compareStrings),
    );
  });

  it("diff(g, g) is empty", () => {
    fc.assert(
      fc.property(graphArb, fc.boolean(), ({ graph, texts }, withContents) => {
        const read = (p: string) => texts.get(p);
        const d = diffGraphs(
          graph,
          graph,
          withContents ? { contents: { base: read, head: read } } : {},
        );
        const empty = { added: [], removed: [], modified: [], updated: [], renamed: [] };
        expect(d.nodes).toEqual(empty);
        expect(d.edges).toEqual(empty);
        expect(d.broken).toEqual([]);
        expect(d.warnings).toEqual({ added: [], removed: [] });
      }),
      RUNS,
    );
  });

  it("apply(base, diff(base, head)) equals head", () => {
    fc.assert(
      fc.property(pairArb, ({ base, head, contents }) => {
        const d = diffGraphs(base, head, options(contents));
        expect(stringifyGraph(applyDiff(base, d))).toBe(stringifyGraph(head));
      }),
      RUNS,
    );
  });

  it("added(diff(a, b)) equals removed(diff(b, a)), and renames invert", () => {
    fc.assert(
      fc.property(pairArb, ({ base, head, contents }) => {
        const flipped =
          contents === undefined ? undefined : { base: contents.head, head: contents.base };
        const forward = diffGraphs(base, head, options(contents));
        const backward = diffGraphs(head, base, options(flipped));
        expect(ids(forward.nodes.added)).toEqual(sorted(backward.nodes.removed));
        expect(sorted(forward.nodes.removed)).toEqual(ids(backward.nodes.added));
        expect(ids(forward.edges.added)).toEqual(sorted(backward.edges.removed));
        expect(sorted(forward.edges.removed)).toEqual(ids(backward.edges.added));
        expect(renamedNodes(forward)).toEqual(renamedNodes(backward, true));
        expect(renamedEdges(forward)).toEqual(renamedEdges(backward, true));
        expect(forward.warnings.added).toEqual(backward.warnings.removed);
        expect(forward.warnings.removed).toEqual(backward.warnings.added);
      }),
      RUNS,
    );
  });

  it("broken edges never point to nodes that exist unchanged in head", () => {
    fc.assert(
      fc.property(pairArb, ({ base, head, contents }) => {
        const d = diffGraphs(base, head, options(contents));
        const baseEdges = new Map(base.edges.map((e) => [e.id, e]));
        const headIds = new Set(head.nodes.map((n) => n.id));
        const modified = new Set(d.nodes.modified.map((m) => m.node.id));
        const gone = new Set([...d.nodes.removed, ...d.nodes.renamed.map((r) => r.from)]);
        for (const broken of d.broken) {
          expect(baseEdges.get(broken.edge)?.to).toBe(broken.to);
          expect(headIds.has(broken.from)).toBe(true);
          if (headIds.has(broken.to)) expect(modified.has(broken.to)).toBe(true);
          else expect(gone.has(broken.to)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("the diff doesn't depend on input order", () => {
    fc.assert(
      fc.property(pairArb, ({ base, head, contents }) => {
        expect(stringifyDiff(diffGraphs(reversed(base), reversed(head), options(contents)))).toBe(
          stringifyDiff(diffGraphs(base, head, options(contents))),
        );
      }),
      RUNS,
    );
  });
});
