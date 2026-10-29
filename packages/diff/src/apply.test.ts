import {
  SCHEMA_VERSION,
  SYSTEM_ID,
  edgeId,
  nodeId,
  parseGraphDiff,
  stringifyGraph,
  summarizeDiff,
  type ArchitectureGraph,
  type GraphDiff,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { applyDiff, DiffApplyError } from "./index.js";

const loc = (file: string, line: number) => ({ file, line, column: 1 });
const hash = (c: string) => c.repeat(64);

const api = nodeId("service", "api", "");
const oldFile = nodeId("file", "api", "src/order.ts");
const newFile = nodeId("file", "api", "src/orders.ts");
const oldCreate = nodeId("symbol", "api", "src/order.ts#create");
const newCreate = nodeId("symbol", "api", "src/orders.ts#create");
const getRoute = nodeId("route", "api", "GET /api/orders");
const postRoute = nodeId("route", "api", "POST /api/orders");
const model = nodeId("model", "api", "Order");

const system: GraphNode = { id: SYSTEM_ID, kind: "system", label: "acme/shop", parentId: null };
const service: GraphNode = {
  id: api,
  kind: "service",
  label: "api",
  parentId: SYSTEM_ID,
  root: "apps/api",
};
const file = (id: string, path: string, h: string): GraphNode => ({
  id,
  kind: "file",
  label: path.split("/").pop()!,
  parentId: api,
  path,
  hash: hash(h),
});
const create = (id: string, parentId: string, line: number): GraphNode => ({
  id,
  kind: "symbol",
  label: "create",
  parentId,
  symbolKind: "function",
  exported: true,
  source: loc("apps/api/src/orders.ts", line),
});
const route = (id: string, method: "GET" | "POST", parentId: string): GraphNode => ({
  id,
  kind: "route",
  label: `${method} /api/orders`,
  parentId,
  method,
  path: "/api/orders",
});
const orderModel = (fields: string[]): GraphNode => ({
  id: model,
  kind: "model",
  label: "Order",
  parentId: api,
  fields: fields.map((name) => ({ name, type: "String", optional: false })),
});
const handles = (from: string, to: string, line: number): GraphEdge => ({
  id: edgeId("handles", from, to),
  kind: "handles",
  from,
  to,
  confidence: "exact",
  sites: [loc("apps/api/src/orders.ts", line)],
});
const writes = (from: string, fields: string[]): GraphEdge => ({
  id: edgeId("writes", from, model),
  kind: "writes",
  from,
  to: model,
  confidence: "exact",
  fields,
  sites: [loc("apps/api/src/orders.ts", 12)],
});

const graph = (
  sha: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  warnings: ArchitectureGraph["warnings"],
): ArchitectureGraph => ({
  schemaVersion: SCHEMA_VERSION,
  repo: { owner: "acme", name: "shop", sha },
  analyzerVersion: "0.1.0",
  nodes,
  edges,
  warnings,
});

const parseWarning = { code: "PARSE_ERROR", message: "unexpected token", file: "apps/api/x.ts" };
const sizeWarning = { code: "FILE_TOO_LARGE", message: "skipped", file: "apps/api/big.ts" };

/** Base: GET /api/orders handled by `create` in order.ts, which writes Order. */
const base = graph(
  "a1b2c3f",
  [
    system,
    service,
    file(oldFile, "apps/api/src/order.ts", "a"),
    create(oldCreate, oldFile, 3),
    route(getRoute, "GET", oldFile),
    orderModel(["id", "total"]),
  ],
  [handles(getRoute, oldCreate, 9), writes(oldCreate, ["total"])],
  [parseWarning, parseWarning, sizeWarning],
);

/**
 * Head: order.ts moved to orders.ts (so `create` and its edges get new IDs), GET became
 * POST, Order lost `total`, and `create` moved down a line. One parse warning is fixed.
 */
const head = graph(
  "d4e5f60",
  [
    system,
    service,
    file(newFile, "apps/api/src/orders.ts", "b"),
    create(newCreate, newFile, 4),
    route(postRoute, "POST", newFile),
    orderModel(["id"]),
  ],
  [handles(postRoute, newCreate, 9), writes(newCreate, ["total"])],
  [sizeWarning, parseWarning],
);

/** The diff a correct `diffGraphs(base, head)` gives, written by hand. */
function handDiff(): GraphDiff {
  const lists = {
    nodes: {
      added: [route(postRoute, "POST", newFile)],
      removed: [getRoute],
      modified: [{ node: orderModel(["id"]), changes: ["fields"] }],
      updated: [],
      renamed: [
        {
          from: oldFile,
          node: file(newFile, "apps/api/src/orders.ts", "b"),
          changes: ["hash", "label", "path"],
        },
        { from: oldCreate, node: create(newCreate, newFile, 4), changes: ["parentId", "source"] },
      ],
    },
    edges: {
      added: [handles(postRoute, newCreate, 9)],
      removed: [edgeId("handles", getRoute, oldCreate)],
      modified: [],
      updated: [],
      renamed: [
        {
          from: edgeId("writes", oldCreate, model),
          edge: writes(newCreate, ["total"]),
          changes: [],
        },
      ],
    },
    broken: [],
  };
  const diff = {
    schemaVersion: SCHEMA_VERSION,
    analyzerVersion: "0.1.0",
    base: { repo: base.repo },
    head: { repo: head.repo },
    ...lists,
    warnings: { added: [], removed: [parseWarning] },
  };
  return parseGraphDiff({ ...diff, summary: summarizeDiff(diff) });
}

describe("applyDiff", () => {
  it("rebuilds head from base and their diff, byte for byte", () => {
    expect(stringifyGraph(applyDiff(base, handDiff()))).toBe(stringifyGraph(head));
  });

  it("replaces records of modified and updated items with the head records", () => {
    const moved = { ...create(oldCreate, oldFile, 30) };
    const later = graph(
      "d4e5f60",
      [...base.nodes.filter((n) => n.id !== oldCreate), moved],
      [
        ...base.edges.filter((e) => e.kind !== "writes"),
        { ...writes(oldCreate, ["total"]), confidence: "heuristic" },
      ],
      base.warnings,
    );
    const lists = {
      nodes: {
        added: [],
        removed: [],
        modified: [],
        updated: [{ node: moved, changes: ["source"] }],
        renamed: [],
      },
      edges: {
        added: [],
        removed: [],
        modified: [
          { edge: later.edges.find((e) => e.kind === "writes")!, changes: ["confidence"] },
        ],
        updated: [],
        renamed: [],
      },
      broken: [],
    };
    const diff = {
      ...handDiff(),
      ...lists,
      warnings: { added: [], removed: [] },
      summary: summarizeDiff(lists),
    };
    expect(stringifyGraph(applyDiff(base, diff))).toBe(stringifyGraph(later));
  });

  it("refuses a diff made from another commit or analyzer version", () => {
    const otherCommit = { ...base, repo: { ...base.repo, sha: "0000000" } };
    expect(() => applyDiff(otherCommit, handDiff())).toThrow(DiffApplyError);
    expect(() => applyDiff(otherCommit, handDiff())).toThrow(
      "the diff's base is acme/shop@a1b2c3f (analyzer 0.1.0), not acme/shop@0000000 (analyzer 0.1.0)",
    );
    expect(() => applyDiff({ ...base, analyzerVersion: "0.2.0" }, handDiff())).toThrow(
      DiffApplyError,
    );
  });

  it("refuses removed, renamed, or changed IDs the base doesn't have", () => {
    const without = (id: string) => ({ ...base, nodes: base.nodes.filter((n) => n.id !== id) });
    expect(() => applyDiff(without(getRoute), handDiff())).toThrow(
      `removed node ${getRoute} isn't in the base graph`,
    );
    expect(() => applyDiff(without(oldFile), handDiff())).toThrow(
      `renamed node ${oldFile} isn't in the base graph`,
    );
    expect(() => applyDiff(without(model), handDiff())).toThrow(
      `changed node ${model} isn't in the base graph`,
    );
  });

  it("refuses added or renamed IDs the base already has", () => {
    const withNode = (node: GraphNode) => ({ ...base, nodes: [...base.nodes, node] });
    expect(() => applyDiff(withNode(route(postRoute, "POST", oldFile)), handDiff())).toThrow(
      `added node ${postRoute} is already in the base graph`,
    );
    expect(() =>
      applyDiff(withNode(file(newFile, "apps/api/src/orders.ts", "c")), handDiff()),
    ).toThrow(`renamed node ${newFile} is already in the base graph`);
  });

  it("refuses a removed warning the base doesn't have, and removes one occurrence per entry", () => {
    expect(() => applyDiff({ ...base, warnings: [sizeWarning] }, handDiff())).toThrow(
      "removed warning PARSE_ERROR isn't in the base graph",
    );
    expect(applyDiff(base, handDiff()).warnings).toEqual([sizeWarning, parseWarning]);
  });

  it("refuses a result that isn't a valid graph", () => {
    // Removing the file but not its symbol leaves the symbol without a parent.
    const lists = {
      nodes: { added: [], removed: [oldFile], modified: [], updated: [], renamed: [] },
      edges: { added: [], removed: [], modified: [], updated: [], renamed: [] },
      broken: [],
    };
    const diff = { ...handDiff(), ...lists, summary: summarizeDiff(lists) };
    expect(() => applyDiff(base, diff)).toThrow(`node ${oldCreate} has missing parent ${oldFile}`);
  });
});
