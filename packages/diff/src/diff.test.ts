import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GraphEdge as GraphEdgeSchema,
  GraphNode as GraphNodeSchema,
  SCHEMA_VERSION,
  SYSTEM_ID,
  canonicalize,
  edgeId,
  nodeId,
  parseGraph,
  stringifyDiff,
  stringifyGraph,
  type ArchitectureGraph,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import {
  applyDiff,
  diffGraphs,
  EDGE_FINGERPRINT,
  EDGE_INCIDENTAL,
  IncompatibleGraphsError,
  NODE_FINGERPRINTS,
  NODE_INCIDENTAL,
} from "./index.js";

const loc = (file: string, line: number) => ({ file, line, column: 1 });
const hash = (c: string) => c.repeat(64);

const api = nodeId("service", "api", "");
const ordersFile = nodeId("file", "api", "src/orders.ts");
const create = nodeId("symbol", "api", "src/orders.ts#create");
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
const file = (h: string): GraphNode => ({
  id: ordersFile,
  kind: "file",
  label: "orders.ts",
  parentId: api,
  path: "apps/api/src/orders.ts",
  hash: hash(h),
});
const createFn = (line: number, exported = true): GraphNode => ({
  id: create,
  kind: "symbol",
  label: "create",
  parentId: ordersFile,
  symbolKind: "function",
  exported,
  source: loc("apps/api/src/orders.ts", line),
});
const route = (id: string, method: "GET" | "POST"): GraphNode => ({
  id,
  kind: "route",
  label: `${method} /api/orders`,
  parentId: ordersFile,
  method,
  path: "/api/orders",
});
const orderModel = (fields: [string, string][]): GraphNode => ({
  id: model,
  kind: "model",
  label: "Order",
  parentId: api,
  fields: fields.map(([name, type]) => ({ name, type, optional: false })),
});
const handles = (from: string, line: number): GraphEdge => ({
  id: edgeId("handles", from, create),
  kind: "handles",
  from,
  to: create,
  confidence: "exact",
  sites: [loc("apps/api/src/orders.ts", line)],
});
const writes = (confidence: GraphEdge["confidence"]): GraphEdge => ({
  id: edgeId("writes", create, model),
  kind: "writes",
  from: create,
  to: model,
  confidence,
  fields: ["total"],
  sites: [loc("apps/api/src/orders.ts", 12)],
});

const graph = (
  sha: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  warnings: ArchitectureGraph["warnings"] = [],
): ArchitectureGraph => ({
  schemaVersion: SCHEMA_VERSION,
  repo: { owner: "acme", name: "shop", sha },
  analyzerVersion: "0.1.0",
  nodes,
  edges,
  warnings,
});

const idAndTotal: [string, string][] = [
  ["id", "String"],
  ["total", "Int"],
];

const base = graph(
  "a1b2c3f",
  [system, service, file("a"), createFn(3), route(getRoute, "GET"), orderModel(idAndTotal)],
  [handles(getRoute, 9), writes("exact")],
);

const empty = { added: [], removed: [], modified: [], updated: [], renamed: [] };
const zero = { added: 0, removed: 0, modified: 0, updated: 0, renamed: 0 };

describe("diffGraphs", () => {
  it("finds nothing between a graph and itself", () => {
    const diff = diffGraphs(base, base);
    expect(diff.nodes).toEqual(empty);
    expect(diff.edges).toEqual(empty);
    expect(diff.broken).toEqual([]);
    expect(diff.warnings).toEqual({ added: [], removed: [] });
    expect(diff.summary).toEqual({ nodes: zero, edges: zero, broken: 0 });
  });

  it("ignores collection order, key order, and undefined fields", () => {
    const shuffled = graph(
      "a1b2c3f",
      [...base.nodes].reverse().map((node) => {
        const reversed = Object.fromEntries(Object.entries(node).reverse()) as GraphNode;
        return node.kind === "service" ? { ...reversed, framework: undefined } : reversed;
      }),
      [...base.edges].reverse(),
    );
    const diff = diffGraphs(base, shuffled);
    expect(diff.summary).toEqual({ nodes: zero, edges: zero, broken: 0 });
  });

  it("classifies added, removed, modified, and updated nodes and edges", () => {
    const head = graph(
      "d4e5f60",
      [
        system,
        service,
        file("b"),
        createFn(4),
        route(postRoute, "POST"),
        orderModel([["id", "String"]]),
      ],
      [handles(postRoute, 9), writes("heuristic")],
    );
    const diff = diffGraphs(base, head);

    expect(diff.base.repo.sha).toBe("a1b2c3f");
    expect(diff.head.repo.sha).toBe("d4e5f60");
    expect(diff.nodes).toEqual({
      added: [route(postRoute, "POST")],
      removed: [getRoute],
      modified: [
        { node: file("b"), changes: ["hash"] },
        { node: orderModel([["id", "String"]]), changes: ["fields"] },
      ],
      updated: [{ node: createFn(4), changes: ["source"] }],
      renamed: [],
    });
    expect(diff.edges).toEqual({
      added: [handles(postRoute, 9)],
      removed: [edgeId("handles", getRoute, create)],
      modified: [{ edge: writes("heuristic"), changes: ["confidence"] }],
      updated: [],
      renamed: [],
    });
    expect(diff.summary.nodes).toEqual({
      added: 1,
      removed: 1,
      modified: 2,
      updated: 1,
      renamed: 0,
    });
    expect(stringifyGraph(applyDiff(base, diff))).toBe(stringifyGraph(head));
  });

  it("counts an edge whose call sites moved as updated", () => {
    const head = graph("d4e5f60", base.nodes, [handles(getRoute, 20), writes("exact")]);
    const diff = diffGraphs(base, head);
    expect(diff.edges.updated).toEqual([{ edge: handles(getRoute, 20), changes: ["sites"] }]);
    expect(diff.edges.modified).toEqual([]);
  });

  it("counts a symbol that stopped being exported as modified", () => {
    const head = graph(
      "d4e5f60",
      base.nodes.map((n) => (n.id === create ? createFn(3, false) : n)),
      base.edges,
    );
    expect(diffGraphs(base, head).nodes.modified).toEqual([
      { node: createFn(3, false), changes: ["exported"] },
    ]);
  });

  it("compares a model's fields as a set: reordering is updated, a type change modified", () => {
    const withNodes = (m: GraphNode) =>
      graph(
        "d4e5f60",
        base.nodes.map((n) => (n.id === model ? m : n)),
        base.edges,
      );
    const reordered = orderModel([
      ["total", "Int"],
      ["id", "String"],
    ]);
    const reorderDiff = diffGraphs(base, withNodes(reordered));
    expect(reorderDiff.nodes.updated).toEqual([{ node: reordered, changes: ["fields"] }]);
    expect(reorderDiff.nodes.modified).toEqual([]);

    const retyped = orderModel([
      ["id", "String"],
      ["total", "Decimal"],
    ]);
    expect(diffGraphs(base, withNodes(retyped)).nodes.modified).toEqual([
      { node: retyped, changes: ["fields"] },
    ]);
  });

  it("diffs warnings as a multiset", () => {
    const parse = { code: "PARSE_ERROR", message: "unexpected token", file: "apps/api/x.ts" };
    const size = { code: "FILE_TOO_LARGE", message: "skipped", file: "apps/api/big.ts" };
    const tsconfig = { code: "NO_TSCONFIG", message: "defaults used" };
    const before = graph("a1b2c3f", base.nodes, base.edges, [parse, parse, size]);
    const after = graph("d4e5f60", base.nodes, base.edges, [size, parse, tsconfig, tsconfig]);
    const diff = diffGraphs(before, after);
    expect(diff.warnings).toEqual({ added: [tsconfig, tsconfig], removed: [parse] });
    expect(applyDiff(before, diff).warnings).toEqual(canonicalize(after).warnings);
  });

  it("gives byte-identical output whatever order the inputs come in", () => {
    const head = graph(
      "d4e5f60",
      [...base.nodes.filter((n) => n.id !== getRoute), route(postRoute, "POST")].reverse(),
      [handles(postRoute, 9), writes("pattern")],
    );
    const reordered = { ...base, nodes: [...base.nodes].reverse() };
    expect(stringifyDiff(diffGraphs(reordered, head))).toBe(stringifyDiff(diffGraphs(base, head)));
  });

  it("refuses graphs from two analyzer versions", () => {
    expect(() => diffGraphs(base, { ...base, analyzerVersion: "0.2.0" })).toThrow(
      IncompatibleGraphsError,
    );
  });

  it("diffs a fixture's golden graph: nothing against itself, a dropped column as modified", () => {
    const golden = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../fixtures/prisma-relations/expected.json",
    );
    const fixture = parseGraph(JSON.parse(readFileSync(golden, "utf8")));
    expect(diffGraphs(fixture, fixture).summary).toEqual({ nodes: zero, edges: zero, broken: 0 });

    const target = fixture.nodes.find(
      (n): n is Extract<GraphNode, { kind: "model" }> => n.kind === "model" && n.fields.length > 1,
    )!;
    const dropped = { ...target, fields: target.fields.slice(1) };
    const head = {
      ...fixture,
      nodes: fixture.nodes.map((n) => (n.id === target.id ? dropped : n)),
    };
    const diff = diffGraphs(fixture, head);
    expect(diff.nodes.modified).toEqual([{ node: dropped, changes: ["fields"] }]);
    expect(diff.summary.nodes.modified + diff.summary.nodes.updated).toBe(1);
    expect(stringifyGraph(applyDiff(fixture, diff))).toBe(stringifyGraph(head));
  });
});

describe("fingerprints", () => {
  it("classify every field of every node kind exactly once", () => {
    for (const option of GraphNodeSchema.options) {
      const kind = option.shape.kind.value;
      const fingerprint: readonly string[] = NODE_FINGERPRINTS[kind];
      const classified = ["id", ...NODE_INCIDENTAL, ...fingerprint];
      expect(new Set(classified).size, kind).toBe(classified.length);
      expect([...classified].sort(), kind).toEqual(Object.keys(option.shape).sort());
    }
  });

  it("classify every edge field exactly once", () => {
    const classified = ["id", ...EDGE_INCIDENTAL, ...EDGE_FINGERPRINT];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(Object.keys(GraphEdgeSchema.shape).sort());
  });

  it("make a node modified for each fingerprint field and updated for label or source", () => {
    const getNode = route(getRoute, "GET") as Extract<GraphNode, { kind: "route" }>;
    const createNode = createFn(3) as Extract<GraphNode, { kind: "symbol" }>;
    const changed: [GraphNode, GraphNode, "modified" | "updated"][] = [
      [service, { ...service, root: "services/api" }, "modified"],
      [service, { ...service, framework: "express" }, "modified"],
      [service, { ...service, layer: "backend" }, "modified"],
      [getNode, { ...getNode, path: "/api/order" }, "modified"],
      [getNode, { ...getNode, label: "orders" }, "updated"],
      [getNode, { ...getNode, source: loc("apps/api/src/orders.ts", 30) }, "updated"],
      [createNode, { ...createNode, parentId: api }, "modified"],
      [createNode, { ...createNode, symbolKind: "variable" }, "modified"],
    ];
    for (const [before, after, list] of changed) {
      const swap = (n: GraphNode) => (n.id === before.id ? after : n);
      const diff = diffGraphs(base, graph("d4e5f60", base.nodes.map(swap), base.edges));
      expect(
        diff.nodes[list].map((c) => c.node),
        JSON.stringify(after),
      ).toEqual([after]);
      expect(diff.summary.nodes.modified + diff.summary.nodes.updated).toBe(1);
    }
  });

  it("make an edge modified for a label, reason, or fields change", () => {
    const edge = writes("exact");
    for (const after of [
      { ...edge, label: "save" },
      { ...edge, confidence: "pattern" as const },
      { ...edge, fields: ["id", "total"] },
      { ...edge, reason: "RAW_QUERY" as const },
    ]) {
      const head = graph("d4e5f60", base.nodes, [handles(getRoute, 9), after]);
      expect(diffGraphs(base, head).edges.modified.map((c) => c.edge)).toEqual([after]);
    }
  });
});
