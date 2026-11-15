import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  edgeId,
  parseGraph,
  SCHEMA_VERSION,
  SYSTEM_ID,
  type ArchitectureGraph,
  type Confidence,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { impactByService, impactIndex, impactOf, impactPath, type Impact } from "./impact.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

const fixture = (name: string): ArchitectureGraph =>
  parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));

/** Each entry as `id depth confidence`, in the engine's order. */
const listed = (entries: Impact["dependents"]) =>
  entries.map((e) => `${e.id} ${e.depth} ${e.confidence}`);

describe("shop-demo: a page → api → database chain across two services", () => {
  const graph = fixture("shop-demo");
  const index = impactIndex(graph);

  it("finds everything that depends on the database, through models, handlers, routes, and the web app's requests", () => {
    const impact = impactOf(index, "datastore:infra/db");
    expect(listed(impact.dependents)).toEqual([
      "model:api/Order 1 exact",
      "symbol:api/src/orders/handlers.ts#createOrder 2 exact",
      "symbol:api/src/orders/handlers.ts#listOrders 2 exact",
      "route:api/GET /api/orders 3 exact",
      "route:api/POST /api/orders 3 exact",
      "symbol:web/lib/orders.ts#listOrders 4 heuristic",
      "symbol:web/lib/orders.ts#placeOrder 4 heuristic",
      "symbol:web/app/checkout/page.tsx#Checkout 5 heuristic",
      "symbol:web/app/orders/page.tsx#Orders 5 heuristic",
      "page:web//checkout 6 heuristic",
      "page:web//orders 6 heuristic",
    ]);
    expect(impactPath(impact, "page:web//orders")).toEqual([
      "page:web//orders",
      "symbol:web/app/orders/page.tsx#Orders",
      "symbol:web/lib/orders.ts#listOrders",
      "route:api/GET /api/orders",
      "symbol:api/src/orders/handlers.ts#listOrders",
      "model:api/Order",
      "datastore:infra/db",
    ]);
    // The entry's step names the edge it takes toward the target.
    const order = impact.dependents.find((e) => e.id === "model:api/Order");
    expect(order).toMatchObject({
      next: "datastore:infra/db",
      edge: edgeId("stores", "model:api/Order", "datastore:infra/db"),
    });
    expect(impactByService(index, impact.dependents)).toEqual([
      { holder: "service:web/", count: 6 },
      { holder: "service:api/", count: 5 },
    ]);
  });

  it("lists an unmatched request's caller as one that may also reach a route, never as reaching it", () => {
    const impact = impactOf(index, "route:api/GET /api/orders");
    expect(listed(impact.dependents)).toEqual([
      "symbol:web/lib/orders.ts#listOrders 1 heuristic",
      "symbol:web/app/orders/page.tsx#Orders 2 heuristic",
      "page:web//orders 3 heuristic",
    ]);
    expect(listed(impact.maybe)).toEqual([
      "unresolved:web/lib/cms.ts:3:21 0 unresolved",
      "symbol:web/lib/cms.ts#latestPosts 1 unresolved",
      "symbol:web/app/page.tsx#Home 2 unresolved",
      "page:web// 3 unresolved",
    ]);
    expect(impact.maybe[0]).toMatchObject({ standsFor: "route" });
    expect(impact.maybe[0]?.next).toBeUndefined();
    expect(impactPath(impact, "page:web//")).toEqual([
      "page:web//",
      "symbol:web/app/page.tsx#Home",
      "symbol:web/lib/cms.ts#latestPosts",
      "unresolved:web/lib/cms.ts:3:21",
    ]);
  });

  it("reaches a route held anywhere downstream, so an unmatched request may reach a function behind it", () => {
    const impact = impactOf(index, "symbol:api/src/billing/stripe.ts#chargeOrder");
    expect(impact.dependents.map((e) => e.id)).toContain("route:api/POST /api/orders");
    expect(impact.maybe.map((e) => e.id)).toContain("page:web//");
  });

  it("starts from everything inside a file or service, and lists only what's outside it", () => {
    const file = impactOf(index, "file:api/src/db.ts");
    expect(listed(file.dependents)).toEqual([
      "file:api/src/orders/handlers.ts 1 exact",
      "file:api/src/routes/orders.ts 2 exact",
      "file:api/src/server.ts 3 exact",
    ]);

    const api = impactOf(index, "service:api/");
    expect(api.inside).toContain("route:api/GET /api/orders");
    expect(
      api.dependents.every((e) => e.id.startsWith("symbol:web/") || e.id.startsWith("page:web/")),
    ).toBe(true);
    expect(api.dependents.map((e) => e.id)).toEqual([
      "symbol:web/lib/orders.ts#listOrders",
      "symbol:web/lib/orders.ts#placeOrder",
      "symbol:web/app/checkout/page.tsx#Checkout",
      "symbol:web/app/orders/page.tsx#Orders",
      "page:web//checkout",
      "page:web//orders",
    ]);
  });

  it("follows imports from file to file", () => {
    const impact = impactOf(index, "file:api/src/billing/stripe.ts");
    expect(listed(impact.dependents)).toEqual([
      "file:api/src/orders/handlers.ts 1 exact",
      "symbol:api/src/orders/handlers.ts#createOrder 1 exact",
      "file:api/src/routes/orders.ts 2 exact",
      "route:api/POST /api/orders 2 exact",
      "file:api/src/server.ts 3 exact",
      "symbol:web/lib/orders.ts#placeOrder 3 heuristic",
      "symbol:web/app/checkout/page.tsx#Checkout 4 heuristic",
      "page:web//checkout 5 heuristic",
    ]);
  });

  it("has nothing depending on a page, and only callers depending on an outside API", () => {
    const page = impactOf(index, "page:web//orders");
    expect(page.dependents).toEqual([]);
    expect(page.maybe).toEqual([]);
    const stripe = impactOf(index, "external:ext/api.stripe.com");
    expect(stripe.dependents[0]?.id).toBe("symbol:api/src/billing/stripe.ts#chargeOrder");
  });

  it("refuses the system node and unknown IDs", () => {
    expect(() => impactOf(index, SYSTEM_ID)).toThrow(/system/);
    expect(() => impactOf(index, "symbol:nope#x")).toThrow(/unknown node/);
  });
});

describe("queues-bullmq: a job's producer depends on its consumer", () => {
  const index = impactIndex(fixture("queues-bullmq"));

  it("walks from the worker's processor to its queue and on to the code that adds jobs", () => {
    const impact = impactOf(index, "symbol:worker/src/main.ts#sendEmail");
    expect(listed(impact.dependents)).toEqual([
      "queue:infra/redis#email 1 exact",
      "symbol:web/src/signup.ts#signup 2 exact",
    ]);
  });

  it("counts the consumer and the producers as depending on the queue", () => {
    const impact = impactOf(index, "queue:infra/redis#email");
    expect(listed(impact.dependents)).toEqual([
      "symbol:web/src/signup.ts#signup 1 exact",
      "symbol:worker/src/main.ts#sendEmail 1 exact",
    ]);
    // signup's other queue name is computed at runtime: it may be this queue, but signup is already counted.
    expect(impact.maybe.map((e) => e.id)).toEqual(["unresolved:web/src/queues.ts:8:38"]);
    expect(impact.maybe[0]).toMatchObject({ standsFor: "queue", depth: 0 });
  });

  it("buckets nodes outside every service under themselves", () => {
    const impact = impactOf(index, "symbol:worker/src/main.ts#sendEmail");
    expect(impactByService(index, impact.dependents)).toEqual([
      { holder: "queue:infra/redis#email", count: 1 },
      { holder: "service:web/", count: 1 },
    ]);
  });
});

// A small hand-built graph for what the fixtures don't hold.
function graphOf(
  nodes: GraphNode[],
  edges: [EdgeKind, string, string, Confidence][],
): ArchitectureGraph {
  return parseGraph({
    schemaVersion: SCHEMA_VERSION,
    repo: { owner: "fixtures", name: "impact" },
    analyzerVersion: "test",
    nodes: [{ id: SYSTEM_ID, kind: "system", label: "impact", parentId: null }, ...nodes],
    edges: edges.map(
      ([kind, from, to, confidence]): GraphEdge => ({
        id: edgeId(kind, from, to),
        kind,
        from,
        to,
        confidence,
        sites: [],
      }),
    ),
    warnings: [],
  });
}

const service = (name: string): GraphNode => ({
  id: `service:${name}`,
  kind: "service",
  label: name,
  parentId: SYSTEM_ID,
  root: `apps/${name}`,
});
const symbol = (name: string, parent = "service:a"): GraphNode => ({
  id: `symbol:${name}`,
  kind: "symbol",
  label: name,
  parentId: parent,
  symbolKind: "function",
  exported: true,
});

describe("paths and confidence", () => {
  it("prefers the path whose weakest link is strongest, even when it's longer", () => {
    // a → t directly (heuristic), and a → b → c → t (exact).
    const graph = graphOf(
      [service("a"), symbol("t"), symbol("a"), symbol("b"), symbol("c")],
      [
        ["calls", "symbol:a", "symbol:t", "heuristic"],
        ["calls", "symbol:a", "symbol:b", "exact"],
        ["calls", "symbol:b", "symbol:c", "exact"],
        ["calls", "symbol:c", "symbol:t", "exact"],
      ],
    );
    const impact = impactOf(impactIndex(graph), "symbol:t");
    expect(listed(impact.dependents)).toEqual([
      "symbol:c 1 exact",
      "symbol:b 2 exact",
      "symbol:a 3 exact",
    ]);
    expect(impactPath(impact, "symbol:a")).toEqual([
      "symbol:a",
      "symbol:b",
      "symbol:c",
      "symbol:t",
    ]);
  });

  it("takes the shortest path among the strongest, and gives each node its path's weakest link", () => {
    // x → t (pattern); y → x (exact); y → t (heuristic): y's best is pattern, via x.
    const graph = graphOf(
      [service("a"), symbol("t"), symbol("x"), symbol("y"), symbol("z")],
      [
        ["calls", "symbol:x", "symbol:t", "pattern"],
        ["calls", "symbol:y", "symbol:x", "exact"],
        ["calls", "symbol:y", "symbol:t", "heuristic"],
        ["calls", "symbol:z", "symbol:y", "heuristic"],
      ],
    );
    const impact = impactOf(impactIndex(graph), "symbol:t");
    expect(listed(impact.dependents)).toEqual([
      "symbol:x 1 pattern",
      "symbol:y 2 pattern",
      "symbol:z 3 heuristic",
    ]);
  });

  it("ends at a cycle without looping, and never lists the target as its own dependent", () => {
    const graph = graphOf(
      [service("a"), symbol("t"), symbol("u")],
      [
        ["calls", "symbol:t", "symbol:u", "exact"],
        ["calls", "symbol:u", "symbol:t", "exact"],
      ],
    );
    const impact = impactOf(impactIndex(graph), "symbol:t");
    expect(listed(impact.dependents)).toEqual(["symbol:u 1 exact"]);
  });

  it("lists every caller of an unresolved node as may reach, since the edges to it are unresolved", () => {
    const unknown: GraphNode = {
      id: "unresolved:a#1",
      kind: "unresolved",
      label: "?",
      parentId: "service:a",
      reason: "DYNAMIC_URL",
      expression: "fetch(url)",
    };
    const graph = graphOf(
      [service("a"), unknown, symbol("p"), symbol("q")],
      [
        ["http", "symbol:p", "unresolved:a#1", "unresolved"],
        ["calls", "symbol:q", "symbol:p", "exact"],
      ],
    );
    const impact = impactOf(impactIndex(graph), "unresolved:a#1");
    expect(impact.dependents).toEqual([]);
    expect(listed(impact.maybe)).toEqual(["symbol:p 1 unresolved", "symbol:q 2 unresolved"]);
    expect(impactPath(impact, "symbol:q")).toEqual(["symbol:q", "symbol:p", "unresolved:a#1"]);
  });

  it("doesn't count a request to an outside host it couldn't name as one that may reach a route", () => {
    const route: GraphNode = {
      id: "route:a/GET /x",
      kind: "route",
      label: "GET /x",
      parentId: "service:a",
      method: "GET",
      path: "/x",
    };
    const outside: GraphNode = {
      id: "unresolved:b#1",
      kind: "unresolved",
      label: "?",
      parentId: "service:b",
      reason: "EXTERNAL_HOST",
      expression: "fetch(host)",
    };
    const graph = graphOf(
      [service("a"), service("b"), route, outside, symbol("p", "service:b")],
      [["http", "symbol:p", "unresolved:b#1", "unresolved"]],
    );
    expect(impactOf(impactIndex(graph), "route:a/GET /x").maybe).toEqual([]);
  });

  it("lets a stand-in found through another stand-in open its own kind (a raw query behind a route)", () => {
    // Target model m. A raw query in h may touch it; h handles route r; an unmatched request in p may reach r.
    const nodes: GraphNode[] = [
      service("a"),
      { id: "model:a/M", kind: "model", label: "M", parentId: "service:a", fields: [] },
      {
        id: "unresolved:a#raw",
        kind: "unresolved",
        label: "?",
        parentId: "service:a",
        reason: "RAW_QUERY",
        expression: "$queryRaw",
      },
      {
        id: "route:a/GET /r",
        kind: "route",
        label: "GET /r",
        parentId: "service:a",
        method: "GET",
        path: "/r",
      },
      {
        id: "unresolved:a#url",
        kind: "unresolved",
        label: "?",
        parentId: "service:a",
        reason: "DYNAMIC_URL",
        expression: "fetch(u)",
      },
      symbol("h"),
      symbol("p"),
    ];
    const graph = graphOf(nodes, [
      ["reads", "symbol:h", "unresolved:a#raw", "unresolved"],
      ["handles", "route:a/GET /r", "symbol:h", "exact"],
      ["http", "symbol:p", "unresolved:a#url", "unresolved"],
    ]);
    const impact = impactOf(impactIndex(graph), "model:a/M");
    expect(impact.dependents).toEqual([]);
    expect(listed(impact.maybe)).toEqual([
      "unresolved:a#raw 0 unresolved",
      "unresolved:a#url 0 unresolved",
      "symbol:h 1 unresolved",
      "symbol:p 1 unresolved",
      "route:a/GET /r 2 unresolved",
    ]);
    expect(impact.maybe.find((e) => e.id === "unresolved:a#raw")).toMatchObject({
      standsFor: "model",
    });
    expect(impact.maybe.find((e) => e.id === "unresolved:a#url")).toMatchObject({
      standsFor: "route",
    });
  });

  it("gives the same answer for the same graph, whatever order its edges come in", () => {
    const graph = fixture("shop-demo");
    const shuffled = {
      ...graph,
      edges: [...graph.edges].reverse(),
      nodes: [...graph.nodes].reverse(),
    };
    for (const target of ["datastore:infra/db", "route:api/GET /api/orders", "service:api/"]) {
      expect(impactOf(impactIndex(shuffled), target)).toEqual(impactOf(impactIndex(graph), target));
    }
  });
});
