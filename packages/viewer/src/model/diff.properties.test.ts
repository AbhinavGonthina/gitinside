// @vitest-environment node
import { diffGraphs } from "@gitinside/diff";
import { PAIR_RUNS, pairArb } from "@gitinside/diff/testkit";
import { compareStrings, parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildDiffOverlay, versionGraph, type DiffOverlay } from "./diff.js";

/**
 * Property tests (M6.11g, M6 review U7): the overlay accepts every diff that
 * `packages/diff` computes, on the random base/head pairs its own property
 * tests use. A legitimate pair it rejected would show an error card instead
 * of the diagram.
 */

const sorted = (ids: Iterable<string>) => [...ids].sort(compareStrings);

/** Every drawn node's parent and every drawn edge's ends are drawn in the same version. */
function expectTree(overlay: DiffOverlay, version: "base" | "head"): void {
  const drawn = overlay.nodesIn[version];
  const byId = new Map(overlay.graph.nodes.map((n) => [n.id, n]));
  for (const id of drawn) {
    const parentId = byId.get(id)?.parentId;
    if (parentId) expect(drawn.has(parentId), `${version}: ${id}'s parent`).toBe(true);
  }
  const edges = new Map(overlay.graph.edges.map((e) => [e.id, e]));
  for (const id of overlay.edgesIn[version]) {
    const edge = edges.get(id);
    expect(edge && drawn.has(edge.from) && drawn.has(edge.to), `${version}: ${id}`).toBe(true);
  }
}

/** Base's node IDs as the overlay names them: renamed nodes under their head ID. */
function baseIds(base: ArchitectureGraph, renamed: ReadonlyMap<string, string>): string[] {
  return base.nodes.map((n) => renamed.get(n.id) ?? n.id);
}

// 300 diffs and overlays take a few seconds, more under coverage on a loaded machine.
describe("buildDiffOverlay on every diffGraphs output (fast-check)", { timeout: 120_000 }, () => {
  it("never throws, keeps the graph valid and each version a tree, and draws each version's items", () => {
    let renames = 0;
    let broken = 0;
    fc.assert(
      fc.property(pairArb, ({ base, head, contents }) => {
        const diff = diffGraphs(base, head, contents === undefined ? {} : { contents });
        renames += diff.nodes.renamed.length;
        broken += diff.broken.length;
        const overlay = buildDiffOverlay(base, head, diff);

        expect(() => parseGraph(overlay.graph)).not.toThrow();
        for (const version of ["base", "head"] as const) {
          expectTree(overlay, version);
          expect(() => parseGraph(versionGraph(overlay, version))).not.toThrow();
        }
        expect(sorted(overlay.nodesIn.head)).toEqual(sorted(head.nodes.map((n) => n.id)));
        const renamed = new Map(diff.nodes.renamed.map((r) => [r.from, r.node.id]));
        // Base draws its own nodes, plus a head frame around a node moved into it (a tree).
        const fromBase = new Set(baseIds(base, renamed));
        for (const id of fromBase) expect(overlay.nodesIn.base.has(id), id).toBe(true);
        for (const id of overlay.nodesIn.base) {
          if (!fromBase.has(id)) expect(overlay.nodes.get(id), `${id} drawn in base`).toBe("added");
        }

        // Every added or removed node is listed once: as a row or folded into one.
        for (const status of ["added", "removed"] as const) {
          const rows = overlay.changes[status];
          const ids = [...overlay.nodes].filter(([, s]) => s === status).map(([id]) => id);
          expect(rows.reduce((n, r) => n + 1 + r.inside, 0)).toBe(ids.length);
          const rowIds = new Set(rows.map((r) => r.id));
          for (const id of ids) {
            expect(rowIds.has(id) || rowIds.has(overlay.foldedInto.get(id) ?? ""), id).toBe(true);
          }
        }
      }),
      PAIR_RUNS,
    );
    // Not vacuous: the pairs include renames and broken connections.
    expect(renames).toBeGreaterThan(0);
    expect(broken).toBeGreaterThan(0);
  });
});
