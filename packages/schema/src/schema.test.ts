import { describe, expect, it } from "vitest";
import {
  ArchitectureGraph,
  SCHEMA_VERSION,
  SYSTEM_ID,
  canonicalize,
  edgeId,
  nodeId,
  parseGraph,
  stringifyGraph,
} from "./index.js";

const loc = (file: string, line: number) => ({ file, line, column: 1 });

/** A small but complete graph: web page calls an API route that writes a model. */
function sampleGraph(): ArchitectureGraph {
  const web = nodeId("service", "web", "");
  const api = nodeId("service", "api", "");
  const page = nodeId("page", "web", "/checkout");
  const route = nodeId("route", "api", "POST /api/orders");
  const model = nodeId("model", "api", "Order");
  const unresolved = nodeId("unresolved", "web", "app/blog/page.tsx:9");
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: { owner: "acme", name: "shop", sha: "a1b2c3f" },
    analyzerVersion: "0.1.0",
    nodes: [
      { id: SYSTEM_ID, kind: "system", label: "acme/shop", parentId: null },
      {
        id: web,
        kind: "service",
        label: "web",
        parentId: SYSTEM_ID,
        layer: "frontend",
        root: "apps/web",
        framework: "next",
      },
      {
        id: api,
        kind: "service",
        label: "api",
        parentId: SYSTEM_ID,
        layer: "backend",
        root: "apps/api",
        framework: "express",
      },
      {
        id: page,
        kind: "page",
        label: "/checkout",
        parentId: web,
        layer: "frontend",
        path: "/checkout",
        source: loc("apps/web/app/checkout/page.tsx", 1),
      },
      {
        id: route,
        kind: "route",
        label: "POST /api/orders",
        parentId: api,
        layer: "backend",
        method: "POST",
        path: "/api/orders",
        source: loc("apps/api/src/orders.ts", 42),
      },
      {
        id: model,
        kind: "model",
        label: "Order",
        parentId: api,
        layer: "data",
        fields: [{ name: "id", type: "String", optional: false }],
      },
      {
        id: unresolved,
        kind: "unresolved",
        label: "Unresolved call",
        parentId: web,
        reason: "DYNAMIC_URL",
        expression: "`${CMS_URL}/posts`",
      },
    ],
    edges: [
      {
        id: edgeId("http", page, route),
        kind: "http",
        from: page,
        to: route,
        confidence: "exact",
        label: "POST /api/orders",
        sites: [loc("apps/web/lib/api.ts", 14)],
      },
      {
        id: edgeId("writes", route, model),
        kind: "writes",
        from: route,
        to: model,
        confidence: "exact",
        fields: ["status", "total"],
        sites: [loc("apps/api/src/orders.ts", 51)],
      },
      {
        id: edgeId("http", page, unresolved),
        kind: "http",
        from: page,
        to: unresolved,
        confidence: "unresolved",
        reason: "DYNAMIC_URL",
        sites: [loc("apps/web/app/blog/page.tsx", 9)],
      },
    ],
    warnings: [],
  };
}

const messages = (value: unknown): string[] => {
  const result = ArchitectureGraph.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("ArchitectureGraph", () => {
  it("accepts a valid graph", () => {
    expect(() => parseGraph(sampleGraph())).not.toThrow();
  });

  it("rejects duplicate node ids", () => {
    const g = sampleGraph();
    g.nodes.push({ ...g.nodes[1]! });
    expect(messages(g)).toContain(`duplicate node id: ${g.nodes[1]!.id}`);
  });

  it("rejects edges that point at missing nodes", () => {
    const g = sampleGraph();
    g.edges[0] = { ...g.edges[0]!, to: "route:api/GET /nope" };
    expect(messages(g).some((m) => m.includes("missing target"))).toBe(true);
  });

  it("requires exactly one system root", () => {
    const g = sampleGraph();
    g.nodes.push({ id: "system:other", kind: "system", label: "x", parentId: null });
    expect(messages(g)).toContain("expected exactly one system node, found 2");
  });

  it("rejects non-root nodes without a parent and missing parents", () => {
    const g = sampleGraph();
    g.nodes[1] = { ...g.nodes[1]!, parentId: null } as ArchitectureGraph["nodes"][number];
    g.nodes[2] = {
      ...g.nodes[2]!,
      parentId: "service:gone/",
    } as ArchitectureGraph["nodes"][number];
    const m = messages(g);
    expect(m.some((x) => x.startsWith("node has no parent"))).toBe(true);
    expect(m.some((x) => x.includes("missing parent"))).toBe(true);
  });

  it("detects parent cycles", () => {
    const g = sampleGraph();
    const a = g.nodes[3]!;
    const b = g.nodes[4]!;
    g.nodes[3] = { ...a, parentId: b.id } as ArchitectureGraph["nodes"][number];
    g.nodes[4] = { ...b, parentId: a.id } as ArchitectureGraph["nodes"][number];
    expect(messages(g).some((m) => m.startsWith("parent cycle"))).toBe(true);
  });

  it("ties unresolved confidence to unresolved targets", () => {
    const g = sampleGraph();
    g.edges[0] = { ...g.edges[0]!, confidence: "unresolved" };
    expect(messages(g).some((m) => m.includes('confidence "unresolved"'))).toBe(true);
  });

  it("rejects empty field names on reads/writes edges", () => {
    const g = sampleGraph();
    g.edges[1] = { ...g.edges[1]!, fields: [""] };
    expect(ArchitectureGraph.safeParse(g).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const g = sampleGraph() as unknown as { extra: number };
    g.extra = 1;
    expect(ArchitectureGraph.safeParse(g).success).toBe(false);
  });
});

describe("ids", () => {
  it("builds readable, stable ids", () => {
    expect(nodeId("symbol", "api", "src/routes/orders.ts#createOrder")).toBe(
      "symbol:api/src/routes/orders.ts#createOrder",
    );
    expect(edgeId("calls", "a", "b")).toBe("calls:a->b");
  });
});

describe("canonical serialization", () => {
  it("is identical regardless of input order", () => {
    const a = sampleGraph();
    const b = sampleGraph();
    b.nodes.reverse();
    b.edges.reverse();
    expect(stringifyGraph(b)).toBe(stringifyGraph(a));
  });

  it("sorts object keys and ends with a newline", () => {
    const out = stringifyGraph(sampleGraph());
    expect(out.endsWith("\n")).toBe(true);
    const top = Object.keys(JSON.parse(out) as object);
    expect(top).toEqual([...top].sort());
  });

  it("sorts edge sites by location", () => {
    const g = sampleGraph();
    g.edges[0] = { ...g.edges[0]!, sites: [loc("b.ts", 1), loc("a.ts", 9), loc("a.ts", 2)] };
    const sites = canonicalize(g).edges.find((e) => e.id === g.edges[0]!.id)!.sites;
    expect(sites.map((s) => `${s.file}:${s.line}`)).toEqual(["a.ts:2", "a.ts:9", "b.ts:1"]);
  });

  it("round-trips through parseGraph", () => {
    const g = sampleGraph();
    expect(stringifyGraph(parseGraph(JSON.parse(stringifyGraph(g))))).toBe(stringifyGraph(g));
  });
});
