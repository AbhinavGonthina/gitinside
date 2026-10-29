import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  SYSTEM_ID,
  edgeId,
  nodeId,
  parseGraph,
  stringifyGraph,
  type ArchitectureGraph,
  type GraphEdge,
  type GraphNode,
  type HttpMethod,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import {
  applyDiff,
  detectBroken,
  diffGraphs,
  parseHttpLabel,
  relativeImportTargets,
} from "./index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const fixture = (name: string): ArchitectureGraph =>
  parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));

describe("broken connections in the diff-broken fixture pair", () => {
  const base = fixture("diff-broken-base");
  const head = fixture("diff-broken-head");
  const diff = diffGraphs(base, head);
  const p = "diff-broken";

  it("finds exactly the four connections the README lists, with their head call sites", () => {
    expect(
      diff.broken.map(({ from, to, reason, detail, sites }) => ({
        from,
        to,
        reason,
        detail,
        sites: sites.map((s) => `${s.file}:${s.line}:${s.column}`),
      })),
    ).toEqual([
      {
        from: `symbol:${p}/src/client.ts#cancelOrder`,
        to: `route:${p}/DELETE /api/orders/:id`,
        reason: "TARGET_REMOVED",
        detail: "DELETE /api/orders/:id was removed",
        sites: ["src/client.ts:12:10"],
      },
      {
        from: `symbol:${p}/src/client.ts#placeOrder`,
        to: `route:${p}/POST /api/orders`,
        reason: "ROUTE_CHANGED",
        detail: "POST /api/orders is now PUT /api/orders",
        sites: ["src/client.ts:8:10"],
      },
      {
        from: `file:${p}/src/client.ts`,
        to: `file:${p}/src/legacy.ts`,
        reason: "TARGET_REMOVED",
        detail: "src/legacy.ts was removed",
        sites: ["src/client.ts:1:29"],
      },
      {
        from: `symbol:${p}/src/handlers.ts#invoiceTotal`,
        to: `model:${p}/Invoice`,
        reason: "TARGET_REMOVED",
        detail: "model Invoice was removed",
        sites: ["src/handlers.ts:13:41"],
      },
    ]);
    expect(diff.summary.broken).toBe(4);
  });

  it("doesn't flag GET /api/health, removed together with its only caller", () => {
    expect(diff.nodes.removed).toContain(`route:${p}/GET /api/health`);
    expect(diff.broken.map((b) => b.to)).not.toContain(`route:${p}/GET /api/health`);
  });

  it("keeps the diff complete: applying it to base still rebuilds head", () => {
    expect(stringifyGraph(applyDiff(base, diff))).toBe(stringifyGraph(head));
  });

  it("finds nothing broken in the reverse direction or against itself", () => {
    expect(diffGraphs(head, base).broken).toEqual([]);
    expect(diffGraphs(base, base).broken).toEqual([]);
  });
});

// Hand-built graphs: one service `api` (root `apps/api`) with a client and a server file.
const svc = nodeId("service", "api", "");
const clientFile = nodeId("file", "api", "src/client.ts");
const serverFile = nodeId("file", "api", "src/server.ts");
const caller = nodeId("symbol", "api", "src/client.ts#load");
const handler = nodeId("symbol", "api", "src/server.ts#list");
const routeId = (method: HttpMethod, path: string) => nodeId("route", "api", `${method} ${path}`);

const loc = (file: string, line: number) => ({ file, line, column: 3 });
const hash = (c: string) => c.repeat(64);

const BASE_NODES: GraphNode[] = [
  { id: SYSTEM_ID, kind: "system", label: "acme/shop", parentId: null },
  { id: svc, kind: "service", label: "api", parentId: SYSTEM_ID, root: "apps/api" },
  {
    id: clientFile,
    kind: "file",
    label: "client.ts",
    parentId: svc,
    path: "apps/api/src/client.ts",
    hash: hash("a"),
  },
  {
    id: serverFile,
    kind: "file",
    label: "server.ts",
    parentId: svc,
    path: "apps/api/src/server.ts",
    hash: hash("b"),
  },
  {
    id: caller,
    kind: "symbol",
    label: "load",
    parentId: clientFile,
    symbolKind: "function",
    exported: true,
  },
  {
    id: handler,
    kind: "symbol",
    label: "list",
    parentId: serverFile,
    symbolKind: "function",
    exported: true,
  },
];

const route = (method: HttpMethod, path: string): GraphNode => ({
  id: routeId(method, path),
  kind: "route",
  label: `${method} ${path}`,
  parentId: serverFile,
  method,
  path,
});

const edge = (
  kind: GraphEdge["kind"],
  from: string,
  to: string,
  extra: Partial<GraphEdge> = {},
): GraphEdge => ({
  id: edgeId(kind, from, to),
  kind,
  from,
  to,
  confidence: "exact",
  sites: [loc("apps/api/src/client.ts", 4)],
  ...extra,
});

/** An unresolved node for a call at `line` of the client file, and the edge to it. */
const unresolvedCall = (
  kind: GraphEdge["kind"],
  from: string,
  line: number,
  node: { label: string; expression: string; reason: "NO_MATCHING_ROUTE" | "UNKNOWN_SYMBOL" },
): [GraphNode, GraphEdge] => {
  const id = nodeId("unresolved", "api", `src/client.ts:${line}:3`);
  return [
    { id, kind: "unresolved", parentId: svc, source: loc("apps/api/src/client.ts", line), ...node },
    edge(kind, from, id, {
      confidence: "unresolved",
      reason: node.reason,
      sites: [loc("apps/api/src/client.ts", line)],
    }),
  ];
};

const graph = (sha: string, nodes: GraphNode[], edges: GraphEdge[]): ArchitectureGraph =>
  parseGraph({
    schemaVersion: SCHEMA_VERSION,
    repo: { owner: "acme", name: "shop", sha },
    analyzerVersion: "0.1.0",
    nodes,
    edges,
    warnings: [],
  });

/** Base: `load` calls `method path`, served by `list`. Head: the route is gone and `load` makes `label`'s call instead. */
function routePair(method: HttpMethod, path: string, label: string | undefined) {
  const base = graph(
    "a1b2c3f",
    [...BASE_NODES, route(method, path)],
    [edge("http", caller, routeId(method, path)), edge("handles", routeId(method, path), handler)],
  );
  const calls =
    label === undefined
      ? []
      : [
          unresolvedCall("http", caller, 5, {
            label,
            expression: "fetch(x)",
            reason: "NO_MATCHING_ROUTE",
          }),
        ];
  const head = graph(
    "d4e5f60",
    [...BASE_NODES, ...calls.map(([n]) => n)],
    calls.map(([, e]) => e),
  );
  return { base, head };
}

const reasons = (base: ArchitectureGraph, head: ArchitectureGraph) =>
  diffGraphs(base, head).broken.map((b) => `${b.reason}: ${b.detail}`);

describe("detectBroken: HTTP calls re-resolved against base routes", () => {
  it.each([
    ["GET", "/api/orders", "GET /api/orders"],
    ["GET", "/api/orders/:id", "GET /api/orders/{}"],
    ["GET", "/api/orders/:id", "? /api/orders/7"],
    ["GET", "/api/orders", "HEAD /api/orders"],
    ["ALL", "/api/orders", "DELETE /api/orders"],
    ["GET", "/api/orders", "GET {env:API_URL}/api/orders"],
    ["GET", "/api/orders", "GET http://localhost:3000/api/orders"],
    ["GET", "/files/*", "GET /files/a/b"],
    ["GET", "/users/:name", "GET /users/user-{}"],
  ] as const)("%s %s still called by `%s` is broken", (method, path, label) => {
    const { base, head } = routePair(method, path, label);
    expect(reasons(base, head)).toEqual([`TARGET_REMOVED: ${method} ${path} was removed`]);
  });

  it.each([
    ["the caller no longer calls anything", undefined],
    ["the caller now calls another path", "GET /api/other"],
    ["the caller now uses another method", "POST /api/orders"],
    ["the caller now calls a remote host", "GET https://api.example.com/api/orders"],
    ["the label was clipped", "GET /api/orders/…"],
  ])("isn't broken when %s", (_why, label) => {
    const { base, head } = routePair("GET", "/api/orders", label);
    expect(reasons(base, head)).toEqual([]);
  });

  it("is ROUTE_CHANGED when the handler now serves another route, also after the handler moved", () => {
    const { base, head } = routePair("POST", "/api/orders", "POST /api/orders");
    const put = route("PUT", "/api/orders");
    const changed = graph(
      "d4e5f60",
      [...head.nodes, put],
      [...head.edges, edge("handles", put.id, handler)],
    );
    expect(reasons(base, changed)).toEqual([
      "ROUTE_CHANGED: POST /api/orders is now PUT /api/orders",
    ]);

    // The handler renamed in place (same body): the new route still points at its old self.
    const renamedHandler = nodeId("symbol", "api", "src/server.ts#listAll");
    const moved = graph(
      "d4e5f60",
      changed.nodes.map((n) =>
        n.id === handler ? { ...n, id: renamedHandler, label: "listAll" } : n,
      ),
      changed.edges.map((e) =>
        e.to === handler
          ? { ...e, id: edgeId("handles", e.from, renamedHandler), to: renamedHandler }
          : e,
      ),
    );
    const body =
      "export function list(req, res) { res.json(orders.filter((o) => o.open && o.total > 0)); }";
    const contents = {
      base: () => body,
      head: () => body.replace("list", "listAll"),
    };
    const withSource = (g: ArchitectureGraph) =>
      graph(
        g.repo.sha ?? "",
        g.nodes.map((n) =>
          n.kind === "symbol" && n.parentId === serverFile
            ? { ...n, source: { file: "apps/api/src/server.ts", line: 1, column: 1, endLine: 1 } }
            : n,
        ),
        g.edges,
      );
    const diff = diffGraphs(withSource(base), withSource(moved), { contents });
    expect(diff.nodes.renamed.map((r) => [r.from, r.node.id])).toEqual([[handler, renamedHandler]]);
    expect(diff.broken.map((b) => b.reason)).toEqual(["ROUTE_CHANGED"]);
  });

  it("reports the renamed caller as the source", () => {
    const { base, head } = routePair("GET", "/api/orders", "GET /api/orders");
    const renamed = nodeId("symbol", "api", "src/client.ts#loadAll");
    const moved = graph(
      "d4e5f60",
      head.nodes.map((n) => (n.id === caller ? { ...n, id: renamed, label: "loadAll" } : n)),
      head.edges.map((e) => ({ ...e, id: edgeId(e.kind, renamed, e.to), from: renamed })),
    );
    const renames = new Map([[caller, renamed]]);
    expect(detectBroken(base, moved, renames).map((b) => [b.from, b.edge])).toEqual([
      [renamed, edgeId("http", caller, routeId("GET", "/api/orders"))],
    ]);
  });

  it("lists every head site that still makes the call, once each, in order", () => {
    const { base } = routePair("GET", "/api/orders", undefined);
    const [n1, e1] = unresolvedCall("http", caller, 9, {
      label: "GET /api/orders",
      expression: "fetch(a)",
      reason: "NO_MATCHING_ROUTE",
    });
    const [n2, e2] = unresolvedCall("http", caller, 5, {
      label: "GET /api/orders",
      expression: "fetch(b)",
      reason: "NO_MATCHING_ROUTE",
    });
    const head = graph("d4e5f60", [...BASE_NODES, n1, n2], [e1, e2]);
    const [broken] = diffGraphs(base, head).broken;
    expect(broken?.sites.map((s) => s.line)).toEqual([5, 9]);
  });
});

describe("detectBroken: imports and Prisma models", () => {
  const legacy: GraphNode = {
    id: nodeId("file", "api", "src/lib/legacy.ts"),
    kind: "file",
    label: "legacy.ts",
    parentId: svc,
    path: "apps/api/src/lib/legacy.ts",
    hash: hash("c"),
  };
  const importPair = (specifier: string | undefined) => {
    const base = graph(
      "a1b2c3f",
      [...BASE_NODES, legacy],
      [edge("imports", clientFile, legacy.id)],
    );
    const calls =
      specifier === undefined
        ? []
        : [
            unresolvedCall("imports", clientFile, 1, {
              label: specifier,
              expression: specifier,
              reason: "UNKNOWN_SYMBOL",
            }),
          ];
    const head = graph(
      "d4e5f60",
      [...BASE_NODES, ...calls.map(([n]) => n)],
      calls.map(([, e]) => e),
    );
    return reasons(base, head);
  };

  it.each(["./lib/legacy.js", "./lib/legacy", "./lib/../lib/legacy.ts"])(
    "a file still imported as %s is broken",
    (specifier) => {
      expect(importPair(specifier)).toEqual([
        "TARGET_REMOVED: apps/api/src/lib/legacy.ts was removed",
      ]);
    },
  );

  it.each([
    ["no longer imported", undefined],
    ["importing another file", "./lib/other.js"],
    ["an alias the diff can't resolve", "@/lib/legacy"],
  ])("isn't broken when %s", (_why, specifier) => {
    expect(importPair(specifier)).toEqual([]);
  });

  it("a moved file whose importer followed it is renamed, not broken", () => {
    const moved = {
      ...legacy,
      id: nodeId("file", "api", "src/old/legacy.ts"),
      path: "apps/api/src/old/legacy.ts",
    };
    const base = graph(
      "a1b2c3f",
      [...BASE_NODES, legacy],
      [edge("imports", clientFile, legacy.id)],
    );
    const head = graph("d4e5f60", [...BASE_NODES, moved], [edge("imports", clientFile, moved.id)]);
    const diff = diffGraphs(base, head);
    expect(diff.nodes.renamed).toHaveLength(1);
    expect(diff.broken).toEqual([]);
  });

  const invoice: GraphNode = {
    id: nodeId("model", "api", "Invoice"),
    kind: "model",
    label: "Invoice",
    parentId: svc,
    fields: [{ name: "id", type: "Int", optional: false }],
  };
  const modelPair = (kind: "reads" | "writes", expression: string) => {
    const base = graph("a1b2c3f", [...BASE_NODES, invoice], [edge(kind, caller, invoice.id)]);
    const [n, e] = unresolvedCall(kind, caller, 6, {
      label: expression,
      expression,
      reason: "UNKNOWN_SYMBOL",
    });
    return reasons(base, graph("d4e5f60", [...BASE_NODES, n], [e]));
  };

  it("a model still read or written through its accessor is broken", () => {
    expect(modelPair("reads", "prisma.invoice.findMany")).toEqual([
      "TARGET_REMOVED: model Invoice was removed",
    ]);
    expect(modelPair("writes", "this.db.invoice.create")).toEqual([
      "TARGET_REMOVED: model Invoice was removed",
    ]);
  });

  it("another model's accessor, or a call of another kind, isn't", () => {
    expect(modelPair("reads", "prisma.order.findMany")).toEqual([]);
    const base = graph("a1b2c3f", [...BASE_NODES, invoice], [edge("reads", caller, invoice.id)]);
    const [n, e] = unresolvedCall("writes", caller, 6, {
      label: "prisma.invoice.create",
      expression: "prisma.invoice.create",
      reason: "UNKNOWN_SYMBOL",
    });
    expect(reasons(base, graph("d4e5f60", [...BASE_NODES, n], [e]))).toEqual([]);
  });

  it("calls to a removed function aren't detected (no head evidence; documented)", () => {
    const helper: GraphNode = {
      id: nodeId("symbol", "api", "src/server.ts#helper"),
      kind: "symbol",
      label: "helper",
      parentId: serverFile,
      symbolKind: "function",
      exported: true,
    };
    const base = graph("a1b2c3f", [...BASE_NODES, helper], [edge("calls", caller, helper.id)]);
    expect(reasons(base, graph("d4e5f60", BASE_NODES, []))).toEqual([]);
  });
});

describe("parseHttpLabel", () => {
  const text = (label: string) =>
    parseHttpLabel(label)?.segments.map((s) =>
      s.map((p) => (p.kind === "text" ? p.text : "{}")).join(""),
    );

  it.each([
    ["GET /api/users/{}", ["api", "users", "{}"]],
    ["POST ./users", ["users"]],
    ["GET {env:API_URL}/orders", ["orders"]],
    ["GET http://127.0.0.1:8080/a", ["a"]],
    ["GET //localhost/a", ["a"]],
    ["GET http://web.localhost/a", ["a"]],
    ["GET /", []],
    ["GET /users/user-{}-x", ["users", "user-{}-x"]],
  ])("reads %s", (label, segments) => {
    expect(text(label)).toEqual(segments);
  });

  it("reads `?` as an unknown method", () => {
    expect(parseHttpLabel("? /a")?.method).toBeNull();
    expect(parseHttpLabel("PATCH /a")?.method).toBe("PATCH");
  });

  it.each([
    "GET https://api.example.com/a",
    "GET /a…",
    "FETCH /a",
    "GET",
    "GET users",
    "GET fetch(url)",
  ])("refuses %s", (label) => {
    expect(parseHttpLabel(label)).toBeUndefined();
  });
});

describe("relativeImportTargets", () => {
  it("resolves like TypeScript without paths: extensions, .js as .ts, index files", () => {
    const targets = relativeImportTargets("src/a/b.ts", "../lib/x.js");
    expect(targets).toContain("src/lib/x.js");
    expect(targets).toContain("src/lib/x.ts");
    expect(targets).toContain("src/lib/x.tsx");
    expect(relativeImportTargets("src/a/b.ts", "./c")).toContain("src/a/c/index.ts");
    expect(relativeImportTargets("src/a/b.ts", "./m.mjs")).toContain("src/a/m.mts");
    expect(relativeImportTargets("src/a/b.ts", "./j.jsx")).toContain("src/a/j.tsx");
    expect(relativeImportTargets("src/a/b.ts", "./c.cjs")).toContain("src/a/c.cts");
  });

  it("refuses bare, aliased, and escaping specifiers", () => {
    expect(relativeImportTargets("src/a.ts", "express")).toBeUndefined();
    expect(relativeImportTargets("src/a.ts", "@/lib/x")).toBeUndefined();
    expect(relativeImportTargets("src/a.ts", "../../x")).toBeUndefined();
    expect(relativeImportTargets("a.ts", "./")).toBeUndefined();
  });
});
