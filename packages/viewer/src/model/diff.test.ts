// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffGraphs } from "@gitinside/diff";
import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import {
  baseRecord,
  buildDiffOverlay,
  DiffMismatchError,
  diffMarks,
  versionGraph,
  type DiffOverlay,
} from "./diff.js";

const FIXTURES = join(process.cwd(), "../../fixtures");
const fixture = (name: string): ArchitectureGraph =>
  parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));

/** A file's text from a fixture folder, for rename detection; absent files are `undefined`. */
const fromDisk =
  (name: string) =>
  (path: string): string | undefined => {
    try {
      return readFileSync(join(FIXTURES, name, path), "utf8");
    } catch {
      return undefined;
    }
  };

const pair = (name: string) => {
  const base = fixture(`${name}-base`);
  const head = fixture(`${name}-head`);
  const contents = { base: fromDisk(`${name}-base`), head: fromDisk(`${name}-head`) };
  return { base, head, diff: diffGraphs(base, head, { contents }) };
};

/** Every node's parent is drawn in the same version, so each version is a tree. */
function expectClosed(overlay: DiffOverlay, version: "base" | "head"): void {
  const byId = new Map(overlay.graph.nodes.map((n) => [n.id, n]));
  for (const id of overlay.nodesIn[version]) {
    const parentId = byId.get(id)?.parentId;
    if (parentId) expect(overlay.nodesIn[version], `${id}'s parent`).toContain(parentId);
  }
  for (const id of overlay.edgesIn[version]) {
    const edge = overlay.graph.edges.find((e) => e.id === id);
    expect(overlay.nodesIn[version]).toContain(edge?.from);
    expect(overlay.nodesIn[version]).toContain(edge?.to);
  }
}

describe("buildDiffOverlay on the diff-broken pair", () => {
  const { base, head, diff } = pair("diff-broken");
  const overlay = buildDiffOverlay(base, head, diff);
  const p = "diff-broken";

  it("holds both versions in one valid graph", () => {
    expect(() => parseGraph(overlay.graph)).not.toThrow();
    const ids = overlay.graph.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
    expect(overlay.graph.nodes).toHaveLength(head.nodes.length + diff.nodes.removed.length);
    expect(overlay.graph.edges).toHaveLength(head.edges.length + diff.edges.removed.length);
  });

  it("draws exactly head's items in head and base's in base", () => {
    expect([...overlay.nodesIn.head].sort()).toEqual(head.nodes.map((n) => n.id).sort());
    expect([...overlay.nodesIn.base].sort()).toEqual(base.nodes.map((n) => n.id).sort());
    expect([...overlay.edgesIn.head].sort()).toEqual(head.edges.map((e) => e.id).sort());
    expect([...overlay.edgesIn.base].sort()).toEqual(base.edges.map((e) => e.id).sort());
    expectClosed(overlay, "base");
    expectClosed(overlay, "head");
  });

  it("gives each version's graph on the overlay's IDs, valid and in order", () => {
    for (const version of ["base", "head"] as const) {
      const graph = versionGraph(overlay, version);
      expect(() => parseGraph(graph)).not.toThrow();
      expect(graph.nodes.map((n) => n.id)).toEqual(
        overlay.graph.nodes.filter((n) => overlay.nodesIn[version].has(n.id)).map((n) => n.id),
      );
      expect(new Set(graph.edges.map((e) => e.id))).toEqual(overlay.edgesIn[version]);
    }
    expect(versionGraph(overlay, "head")).toEqual(head);
  });

  it("gives each listed item its state and leaves the rest out", () => {
    for (const n of diff.nodes.added) expect(overlay.nodes.get(n.id)).toBe("added");
    for (const id of diff.nodes.removed) expect(overlay.nodes.get(id)).toBe("removed");
    for (const c of diff.nodes.modified) expect(overlay.nodes.get(c.node.id)).toBe("changed");
    for (const c of diff.nodes.updated) expect(overlay.nodes.has(c.node.id)).toBe(false);
    for (const e of diff.edges.added) expect(overlay.edges.get(e.id)).toBe("added");
    for (const id of diff.edges.removed) expect(overlay.edges.get(id)).toBe("removed");
    for (const c of diff.edges.updated) expect(overlay.edges.has(c.edge.id)).toBe(false);
    expect(overlay.nodes.size).toBe(
      diff.nodes.added.length +
        diff.nodes.removed.length +
        diff.nodes.modified.length +
        diff.nodes.renamed.length,
    );
  });

  it("keeps every broken connection, on the edge the canvas draws", () => {
    expect([...overlay.broken.values()].map((b) => b.detail).sort()).toEqual(
      diff.broken.map((b) => b.detail).sort(),
    );
    const removedRoute = [...overlay.broken.values()].find(
      (b) => b.to === `route:${p}/DELETE /api/orders/:id`,
    );
    expect(removedRoute).toMatchObject({
      from: `symbol:${p}/src/client.ts#cancelOrder`,
      reason: "TARGET_REMOVED",
    });
    // The base edge is drawn (removed), and it's the one marked broken.
    expect(overlay.edges.get(removedRoute?.edge ?? "")).toBe("removed");
    const args = [...overlay.broken.values()].find((b) => b.reason === "PARAMETERS_ADDED");
    expect(overlay.edgesIn.head).toContain(args?.edge);
  });

  it("folds a removed file's symbols into its row", () => {
    const legacy = overlay.changes.removed.find((r) => r.id === `file:${p}/src/legacy.ts`);
    expect(legacy).toMatchObject({ status: "removed", label: "legacy.ts", inside: 1 });
    expect(overlay.changes.removed.map((r) => r.id)).not.toContain(
      `symbol:${p}/src/legacy.ts#formatCents`,
    );
    const listed = overlay.changes.removed.reduce((n, r) => n + 1 + r.inside, 0);
    expect(listed).toBe(diff.nodes.removed.length);
  });

  it("lists broken connections by their source, with the diff's words", () => {
    expect(overlay.changes.broken).toHaveLength(diff.broken.length);
    const row = overlay.changes.broken.find((r) => r.broken?.reason === "ROUTE_CHANGED");
    expect(row).toMatchObject({
      id: `symbol:${p}/src/client.ts#placeOrder`,
      label: "placeOrder",
      broken: { detail: "POST /api/orders is now PUT /api/orders" },
    });
  });

  it("counts the changes below each ancestor", () => {
    const root = overlay.graph.nodes.find((n) => n.parentId === null);
    const counts = overlay.inside.get(root?.id ?? "");
    expect(counts).toEqual({
      added: diff.nodes.added.length,
      changed: diff.nodes.modified.length + diff.nodes.renamed.length,
      removed: diff.nodes.removed.length,
      broken: diff.broken.length,
    });
    expect(overlay.inside.get(`file:${p}/src/legacy.ts`)).toEqual({
      added: 0,
      changed: 0,
      removed: 1,
      broken: 0,
    });
  });

  it("is the same overlay every time", () => {
    const again = buildDiffOverlay(base, head, diffGraphs(base, head));
    expect(again.graph).toEqual(overlay.graph);
    expect(again.changes).toEqual(overlay.changes);
    expect([...again.nodes]).toEqual([...overlay.nodes]);
  });
});

describe("buildDiffOverlay on the diff-rename pair", () => {
  const { base, head, diff } = pair("diff-rename");
  const overlay = buildDiffOverlay(base, head, diff);
  const p = "diff-rename";

  it("draws a renamed node once, under its head ID, with its base record", () => {
    const file = `file:${p}/src/orders/routes.ts`;
    expect(overlay.nodes.get(file)).toBe("changed");
    expect(overlay.renamedFrom.get(file)?.id).toBe(`file:${p}/src/routes/orders.ts`);
    expect(overlay.graph.nodes.map((n) => n.id)).not.toContain(`file:${p}/src/routes/orders.ts`);
    expect(overlay.nodesIn.base).toContain(file);
    const row = overlay.changes.changed.find((r) => r.id === file);
    expect(row?.from?.id).toBe(`file:${p}/src/routes/orders.ts`);
  });

  it("gives Base a renamed node's base record, at its head ID and place", () => {
    const file = `file:${p}/src/orders/routes.ts`;
    const drawn = overlay.graph.nodes.find((n) => n.id === file);
    const inBase = versionGraph(overlay, "base").nodes.find((n) => n.id === file);
    expect(inBase).toEqual({
      ...overlay.renamedFrom.get(file),
      id: file,
      parentId: drawn?.parentId,
    });
    expect(inBase?.label).toBe("orders.ts");
    expect(() => parseGraph(versionGraph(overlay, "base"))).not.toThrow();
    expect(drawn && baseRecord(overlay, drawn)).toEqual(inBase);
    expect(versionGraph(overlay, "head").nodes.find((n) => n.id === file)).toBe(drawn);
    // Nodes that weren't renamed are the overlay's own records.
    const service = overlay.graph.nodes.find((n) => n.kind === "service");
    expect(service && baseRecord(overlay, service)).toBeUndefined();
    expect(diffMarks(overlay).baseNode(drawn!)).toEqual(inBase);
    expect(diffMarks(overlay).edgesIn).toBe(overlay.edgesIn);
  });

  it("keeps each version a tree and the graph valid", () => {
    expect(() => parseGraph(overlay.graph)).not.toThrow();
    expectClosed(overlay, "base");
    expectClosed(overlay, "head");
  });

  it("puts a removed node under its renamed parent's head ID", () => {
    // Head without one of the moved file's symbols: it's removed, from a renamed file.
    const gone = `symbol:${p}/src/orders/routes.ts#orders`;
    const trimmed: ArchitectureGraph = {
      ...head,
      nodes: head.nodes.filter((n) => n.id !== gone),
      edges: head.edges.filter((e) => e.from !== gone && e.to !== gone),
    };
    const contents = { base: fromDisk(`${p}-base`), head: fromDisk(`${p}-head`) };
    const moved = buildDiffOverlay(base, trimmed, diffGraphs(base, trimmed, { contents }));
    const was = `symbol:${p}/src/routes/orders.ts#orders`;
    expect(moved.nodes.get(was)).toBe("removed");
    expect(moved.graph.nodes.find((n) => n.id === was)?.parentId).toBe(
      `file:${p}/src/orders/routes.ts`,
    );
    expect(() => parseGraph(moved.graph)).not.toThrow();
    expectClosed(moved, "base");
  });

  it("orders the changes list shallow first, then by label", () => {
    const byId = new Map(overlay.graph.nodes.map((n) => [n.id, n]));
    const depth = (id: string): number => {
      const parentId = byId.get(id)?.parentId;
      return parentId ? 1 + depth(parentId) : 0;
    };
    const groups = Object.values(overlay.changes) as { id: string; label: string }[][];
    expect(groups.flat().length).toBeGreaterThan(1);
    for (const group of groups) {
      const keys = group.map((r) => [depth(r.id), r.label] as const);
      const sorted = [...keys].sort(
        (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0),
      );
      expect(keys).toEqual(sorted);
    }
  });
});

describe("buildDiffOverlay on a move the diff didn't pair (no file contents)", () => {
  const base = fixture("diff-rename-base");
  const head = fixture("diff-rename-head");
  const overlay = buildDiffOverlay(base, head, diffGraphs(base, head));
  const p = "diff-rename";

  it("draws the moved route's new file around it in base, so base stays a tree", () => {
    const route = `route:${p}/GET /api/orders`;
    expect(overlay.nodes.get(route)).toBe("changed");
    const parentId = overlay.graph.nodes.find((n) => n.id === route)?.parentId;
    expect(parentId).toBe(`file:${p}/src/orders/routes.ts`);
    expect(overlay.nodes.get(parentId ?? "")).toBe("added");
    expect(overlay.nodesIn.base).toContain(parentId);
    expectClosed(overlay, "base");
    expectClosed(overlay, "head");
  });

  it("still shows the old file as removed and the new one as added", () => {
    expect(overlay.changes.removed.map((r) => r.id)).toContain(`module:${p}/src/routes`);
    expect(overlay.changes.added.map((r) => r.id)).toContain(`module:${p}/src/orders`);
  });
});

describe("buildDiffOverlay with nothing changed", () => {
  it("is head's graph with no states", () => {
    const head = fixture("diff-broken-head");
    const overlay = buildDiffOverlay(head, head, diffGraphs(head, head));
    expect(overlay.graph.nodes).toEqual([...head.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(overlay.nodes.size + overlay.edges.size + overlay.broken.size).toBe(0);
    expect(overlay.inside.size).toBe(0);
    expect(overlay.changes).toEqual({ added: [], changed: [], removed: [], broken: [] });
  });
});

describe("diffMarks", () => {
  const { base, head, diff } = pair("diff-broken");
  const overlay = buildDiffOverlay(base, head, diff);
  const marks = diffMarks(overlay);
  const p = "diff-broken";
  const added = diff.edges.added[0]?.id ?? "";
  const removed = diff.edges.removed[0] ?? "";
  const plain = head.edges.find((e) => !overlay.edges.has(e.id) && !overlay.broken.has(e.id));
  const broken = [...overlay.broken.values()];

  it("gives nodes their state and closed boxes their counts", () => {
    expect(marks.node(`file:${p}/src/legacy.ts`)).toBe("removed");
    expect(marks.node(`service:${p}/`)).toBeUndefined();
    expect(marks.inside(`file:${p}/src/legacy.ts`)).toEqual(
      overlay.inside.get(`file:${p}/src/legacy.ts`),
    );
  });

  it("gives a line its edges' common state, or changed when they differ", () => {
    expect(marks.line([{ id: added }])).toEqual({ diff: "added" });
    expect(marks.line([{ id: added }, { id: diff.edges.added[1]?.id ?? "" }])).toEqual({
      diff: "added",
    });
    expect(marks.line([{ id: added }, { id: plain?.id ?? "" }])).toEqual({ diff: "changed" });
    expect(marks.line([{ id: added }, { id: removed }])).toEqual({ diff: "changed" });
    expect(marks.line([{ id: plain?.id ?? "" }])).toEqual({});
  });

  it("says what broke on a line, or how many connections broke", () => {
    const [one, two] = broken;
    expect(marks.line([{ id: one?.edge ?? "" }]).broken).toBe(one?.detail);
    expect(marks.line([{ id: one?.edge ?? "" }, { id: two?.edge ?? "" }]).broken).toBe(
      "2 connections broken",
    );
  });
});

describe("buildDiffOverlay refuses a diff of other graphs", () => {
  const { base, head, diff } = pair("diff-broken");

  it("when the commits differ", () => {
    const other = {
      ...head,
      repo: { ...head.repo, sha: "0123456789abcdef0123456789abcdef01234567" },
    };
    expect(() => buildDiffOverlay(base, other, diff)).toThrow(DiffMismatchError);
    expect(() => buildDiffOverlay(head, base, diff)).toThrow(/another pair of commits/);
  });

  it("when the analyzer versions differ", () => {
    expect(() => buildDiffOverlay(base, head, { ...diff, analyzerVersion: "0.0.0-other" })).toThrow(
      /analyzer versions/,
    );
  });

  it("when the diff names an item the graphs lack", () => {
    const trimmed = { ...head, nodes: head.nodes.filter((n) => n.id !== diff.nodes.added[0]?.id) };
    expect(() => buildDiffOverlay(base, trimmed, diff)).toThrow(/added node/);
    const noBase = { ...base, nodes: base.nodes.filter((n) => n.id !== diff.nodes.removed[0]) };
    expect(() => buildDiffOverlay(noBase, head, diff)).toThrow(/removed node/);
  });
});
