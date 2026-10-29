import { describe, expect, it } from "vitest";
import {
  GraphDiff,
  SCHEMA_VERSION,
  canonicalizeDiff,
  edgeId,
  nodeId,
  parseGraphDiff,
  stringifyDiff,
  summarizeDiff,
} from "./index.js";

const loc = (file: string, line: number) => ({ file, line, column: 1 });

const route = nodeId("route", "api", "POST /api/orders");
const renamedFrom = nodeId("file", "api", "src/order.ts");
const renamedTo = nodeId("file", "api", "src/orders.ts");
const model = nodeId("model", "api", "Order");
const page = nodeId("page", "web", "/checkout");
const handler = nodeId("symbol", "api", "src/orders.ts#create");
const hash = (c: string) => c.repeat(64);

/** A diff with one entry in every list: what a PR touching routes, files, and a model gives. */
function sampleDiff(): GraphDiff {
  const lists = {
    nodes: {
      added: [
        {
          id: route,
          kind: "route" as const,
          label: "POST /api/orders",
          parentId: renamedTo,
          method: "POST" as const,
          path: "/api/orders",
        },
      ],
      removed: [nodeId("route", "api", "GET /api/orders")],
      modified: [
        {
          node: {
            id: model,
            kind: "model" as const,
            label: "Order",
            parentId: "service:api/",
            fields: [{ name: "id", type: "String", optional: false }],
          },
          changes: ["fields"],
        },
      ],
      updated: [
        {
          node: {
            id: page,
            kind: "page" as const,
            label: "/checkout",
            parentId: "service:web/",
            path: "/checkout",
            source: loc("apps/web/app/checkout/page.tsx", 3),
          },
          changes: ["source"],
        },
      ],
      renamed: [
        {
          from: renamedFrom,
          node: {
            id: renamedTo,
            kind: "file" as const,
            label: "orders.ts",
            parentId: "service:api/",
            path: "apps/api/src/orders.ts",
            hash: hash("b"),
          },
          changes: ["label", "path"],
        },
      ],
    },
    edges: {
      added: [
        {
          id: edgeId("handles", route, handler),
          kind: "handles" as const,
          from: route,
          to: handler,
          confidence: "exact" as const,
          sites: [loc("apps/api/src/orders.ts", 9)],
        },
      ],
      removed: [edgeId("http", page, nodeId("route", "api", "GET /api/orders"))],
      modified: [
        {
          edge: {
            id: edgeId("writes", handler, model),
            kind: "writes" as const,
            from: handler,
            to: model,
            confidence: "exact" as const,
            fields: ["total"],
            sites: [loc("apps/api/src/orders.ts", 12)],
          },
          changes: ["fields"],
        },
      ],
      updated: [],
      renamed: [],
    },
    broken: [
      {
        edge: edgeId("http", page, nodeId("route", "api", "GET /api/orders")),
        from: page,
        to: nodeId("route", "api", "GET /api/orders"),
        reason: "TARGET_REMOVED" as const,
        detail: "GET /api/orders was removed, but /checkout still calls it",
        sites: [loc("apps/web/lib/api.ts", 14)],
      },
    ],
  };
  const diff = {
    schemaVersion: SCHEMA_VERSION,
    analyzerVersion: "0.1.0",
    base: { repo: { owner: "acme", name: "shop", sha: "a1b2c3f" } },
    head: { repo: { owner: "acme", name: "shop", sha: "d4e5f60" } },
    ...lists,
    warnings: {
      added: [{ code: "PARSE_ERROR", message: "unexpected token", file: "apps/api/src/x.ts" }],
      removed: [],
    },
  };
  return { ...diff, summary: summarizeDiff(diff) };
}

const messages = (value: unknown): string[] => {
  const result = GraphDiff.safeParse(value);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("GraphDiff", () => {
  it("accepts a diff with an entry in every kind of list", () => {
    expect(() => parseGraphDiff(sampleDiff())).not.toThrow();
  });

  it("counts every list in the summary", () => {
    expect(sampleDiff().summary).toEqual({
      nodes: { added: 1, removed: 1, modified: 1, updated: 1, renamed: 1 },
      edges: { added: 1, removed: 1, modified: 1, updated: 0, renamed: 0 },
      broken: 1,
    });
  });

  it("rejects a summary that disagrees with the lists", () => {
    const d = sampleDiff();
    d.summary = { ...d.summary, broken: 0 };
    expect(messages(d).some((m) => m.startsWith("summary does not match"))).toBe(true);
  });

  it("accepts a summary whose keys come in another order", () => {
    const d = sampleDiff();
    const { nodes, edges, broken } = d.summary;
    d.summary = { broken, edges, nodes };
    expect(messages(d)).toEqual([]);
  });

  it("rejects a node ID in two lists", () => {
    const d = sampleDiff();
    d.nodes.removed.push(model);
    d.summary = summarizeDiff(d);
    expect(messages(d)).toContain(`node ${model} appears more than once in the diff`);
  });

  it("rejects a rename whose base ID is also listed as removed", () => {
    const d = sampleDiff();
    d.nodes.removed.push(renamedFrom);
    d.summary = summarizeDiff(d);
    expect(messages(d)).toContain(`node ${renamedFrom} appears more than once in the diff`);
  });

  it("rejects an edge ID in two lists, and a connection broken twice", () => {
    const d = sampleDiff();
    d.edges.removed.push(d.edges.added[0]!.id);
    d.broken.push({ ...d.broken[0]!, reason: "ROUTE_CHANGED" });
    d.summary = summarizeDiff(d);
    const m = messages(d);
    expect(m).toContain(`edge ${d.edges.added[0]!.id} appears more than once in the diff`);
    expect(m).toContain(`broken edge ${d.broken[0]!.edge} appears more than once in the diff`);
  });

  it("requires modified and updated entries to name a change, and never `id`", () => {
    const d = sampleDiff();
    d.nodes.modified[0] = { ...d.nodes.modified[0]!, changes: [] };
    expect(GraphDiff.safeParse(d).success).toBe(false);
    const e = sampleDiff();
    e.nodes.renamed[0] = { ...e.nodes.renamed[0]!, changes: ["id"] };
    expect(messages(e)).toContain("`id` is never a change");
  });

  it("validates the records it carries as graph nodes and edges", () => {
    const d = sampleDiff();
    d.nodes.added[0] = { ...d.nodes.added[0]!, kind: "route", path: "no-slash" } as never;
    expect(GraphDiff.safeParse(d).success).toBe(false);
  });

  it("rejects another schema version and unknown fields", () => {
    expect(GraphDiff.safeParse({ ...sampleDiff(), schemaVersion: "2.0.0" }).success).toBe(false);
    expect(GraphDiff.safeParse({ ...sampleDiff(), extra: 1 }).success).toBe(false);
  });
});

describe("canonical diff serialization", () => {
  /** The sample with a second entry in the lists the test reorders. */
  function extended(): GraphDiff {
    const d = sampleDiff();
    d.nodes.removed.push(nodeId("route", "api", "DELETE /api/orders"));
    d.edges.added.push({ ...d.edges.added[0]!, id: "a-first", sites: [] });
    d.edges.added[0] = {
      ...d.edges.added[0]!,
      sites: [loc("b.ts", 1), loc("a.ts", 2)],
    };
    d.broken.push({ ...d.broken[0]!, edge: "a-first" });
    d.warnings.added.push({ code: "A_FIRST", message: "m" });
    d.summary = summarizeDiff(d);
    return d;
  }

  /** `extended()` with its lists, change lists, and site lists reversed. */
  function shuffled(): GraphDiff {
    const d = extended();
    const reverse = <T>(list: T[]): T[] => [...list].reverse();
    return {
      ...d,
      nodes: {
        ...d.nodes,
        removed: reverse(d.nodes.removed),
        renamed: d.nodes.renamed.map((r) => ({ ...r, changes: reverse(r.changes) })),
      },
      edges: { ...d.edges, added: reverse(d.edges.added) },
      broken: reverse(d.broken),
      warnings: { ...d.warnings, added: reverse(d.warnings.added) },
    };
  }

  it("is identical regardless of input order", () => {
    const sorted = canonicalizeDiff(shuffled());
    expect(sorted.nodes.removed).toEqual([
      nodeId("route", "api", "DELETE /api/orders"),
      nodeId("route", "api", "GET /api/orders"),
    ]);
    expect(sorted.nodes.renamed[0]!.changes).toEqual(["label", "path"]);
    expect(sorted.edges.added[0]!.id).toBe("a-first");
    expect(sorted.edges.added[1]!.sites.map((s) => s.file)).toEqual(["a.ts", "b.ts"]);
    expect(sorted.broken[0]!.edge).toBe("a-first");
    expect(sorted.warnings.added[0]!.code).toBe("A_FIRST");
    expect(stringifyDiff(shuffled())).toBe(stringifyDiff(extended()));
  });

  it("sorts object keys, ends with a newline, and round-trips through parseGraphDiff", () => {
    const out = stringifyDiff(sampleDiff());
    expect(out.endsWith("\n")).toBe(true);
    const top = Object.keys(JSON.parse(out) as object);
    expect(top).toEqual([...top].sort());
    expect(stringifyDiff(parseGraphDiff(JSON.parse(out)))).toBe(out);
  });
});
