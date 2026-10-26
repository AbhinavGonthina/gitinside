import { describe, expect, it } from "vitest";
import {
  stringifyGraph,
  type ArchitectureGraph,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { assembleGraph, serializeGraph, type GraphPart } from "./assemble.js";

const system: GraphNode = { id: "system:root", kind: "system", label: "shop", parentId: null };
const service: GraphNode = {
  id: "service:api/",
  kind: "service",
  label: "api",
  parentId: "system:root",
  root: "",
};
const file = (path: string): GraphNode => ({
  id: `file:api/${path}`,
  kind: "file",
  label: path,
  parentId: "service:api/",
  path,
  hash: "0".repeat(64),
});
const route = (parent: string, line: number): GraphNode => ({
  id: "route:api/GET /health",
  kind: "route",
  label: "GET /health",
  parentId: `file:api/${parent}`,
  method: "GET",
  path: "/health",
  source: { file: parent, line, column: 1 },
});
const model: GraphNode = {
  id: "model:api/Order",
  kind: "model",
  label: "Order",
  parentId: "file:api/schema.prisma",
  fields: [],
};
const reads = (
  confidence: GraphEdge["confidence"],
  line: number,
  fields?: string[],
): GraphEdge => ({
  id: "reads:route:api/GET /health->model:api/Order",
  kind: "reads",
  from: "route:api/GET /health",
  to: "model:api/Order",
  confidence,
  ...(fields ? { fields } : {}),
  sites: [{ file: "server.ts", line, column: 3 }],
});

function assemble(...parts: GraphPart[]): ArchitectureGraph {
  return assembleGraph({
    repo: { owner: "acme", name: "shop" },
    analyzerVersion: "0.0.0-test",
    parts: [
      { source: "workspace", nodes: [system, service] },
      { source: "files", nodes: [file("server.ts"), file("app.ts"), file("schema.prisma")] },
      ...parts,
    ],
  });
}

describe("assembleGraph", () => {
  it("keeps the first part's node and warns about a different duplicate", () => {
    const graph = assemble(
      { source: "express", nodes: [route("server.ts", 4), model] },
      { source: "next", nodes: [route("app.ts", 1)] },
    );
    expect(graph.nodes.filter((n) => n.kind === "route")).toEqual([route("server.ts", 4)]);
    expect(graph.warnings).toEqual([
      {
        code: "DUPLICATE_NODE",
        file: "app.ts",
        message: "route:api/GET /health is produced by both express and next; keeping express's",
      },
    ]);
  });

  it("merges identical nodes silently", () => {
    const graph = assemble({ source: "a", nodes: [model] }, { source: "b", nodes: [{ ...model }] });
    expect(graph.nodes.filter((n) => n.id === model.id)).toHaveLength(1);
    expect(graph.warnings).toEqual([]);
  });

  it("omits the file from a duplicate warning when the node has no source", () => {
    const graph = assemble(
      { source: "a", nodes: [model] },
      { source: "b", nodes: [{ ...model, label: "O" }] },
    );
    expect(graph.warnings).toEqual([
      {
        code: "DUPLICATE_NODE",
        message: "model:api/Order is produced by both a and b; keeping a's",
      },
    ]);
  });

  it("merges duplicate edges: sites and fields unioned, strongest confidence kept", () => {
    const graph = assemble(
      {
        source: "express",
        nodes: [route("server.ts", 4), model],
        edges: [reads("heuristic", 9, ["status"])],
      },
      { source: "prisma", edges: [reads("exact", 7, ["id", "status"]), reads("pattern", 9)] },
    );
    expect(graph.edges).toEqual([
      {
        ...reads("exact", 9, ["id", "status"]),
        sites: [
          { file: "server.ts", line: 9, column: 3 },
          { file: "server.ts", line: 7, column: 3 },
        ],
      },
    ]);
    expect(stringifyGraph(graph)).toContain('"line": 7');
  });

  it("leaves fields off a merged edge when neither side has them", () => {
    const graph = assemble(
      { source: "a", nodes: [route("server.ts", 4), model], edges: [reads("exact", 1)] },
      { source: "b", edges: [reads("heuristic", 2)] },
    );
    expect(graph.edges[0]).not.toHaveProperty("fields");
    expect(graph.edges[0]?.confidence).toBe("exact");
  });

  it("removes exact duplicate warnings and sorts by file, code, message", () => {
    const warnings = [
      { code: "B", message: "m", file: "z.ts" },
      { code: "A", message: "m" },
      { code: "B", message: "m", file: "z.ts" },
      { code: "A", message: "m", file: "a.ts" },
      { code: "A", message: "l", file: "a.ts" },
    ];
    const graph = assemble({ source: "x", warnings });
    expect(graph.warnings).toEqual([
      { code: "A", message: "m" },
      { code: "A", message: "l", file: "a.ts" },
      { code: "A", message: "m", file: "a.ts" },
      { code: "B", message: "m", file: "z.ts" },
    ]);
  });

  it("throws INVALID_GRAPH with readable issues when the result breaks the schema", () => {
    const dangling = { ...reads("exact", 1), to: "model:api/Missing" };
    expect(() =>
      assemble({ source: "x", nodes: [route("server.ts", 4)], edges: [dangling] }),
    ).toThrowError(
      /^INVALID_GRAPH: analyzer produced an invalid graph: edge reads:.* has missing target model:api\/Missing$/,
    );
  });

  it("caps the listed issues", () => {
    const orphans = [1, 2, 3, 4, 5, 6, 7].map((i) => ({
      ...model,
      id: `model:api/M${i}`,
      parentId: "nope",
    }));
    expect(() => assemble({ source: "x", nodes: orphans })).toThrowError(/; and 2 more$/);
  });

  it("reports the path of field-level problems", () => {
    const bad = { ...model, fields: [{ name: "", type: "Int", optional: false }] };
    expect(() => assemble({ source: "x", nodes: [bad] })).toThrowError(
      /nodes\.5\.fields\.0\.name: /,
    );
  });
});

describe("serializeGraph", () => {
  it("returns the canonical text of a valid graph", () => {
    const graph = assemble();
    expect(serializeGraph(graph)).toBe(stringifyGraph(graph));
  });

  it("refuses values that JSON can't carry faithfully", () => {
    const graph = assemble({ source: "x", nodes: [route("server.ts", 4)] });
    const broken = structuredClone(graph);
    const node = broken.nodes.find((n) => n.kind === "route");
    if (node?.source) node.source.line = Number.NaN;
    expect(() => serializeGraph(broken)).toThrowError(/^INVALID_GRAPH: .*nodes\.\d+\.source\.line/);
  });
});
