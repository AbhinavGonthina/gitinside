// @vitest-environment node
import type { ArchitectureGraph, GraphEdge, GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { canTraceFrom, TRACE_DEPTH, traceFrom, traceNodes } from "./trace.js";

const index = buildHierarchy(shopDemo());

const root: GraphNode = { id: "system:demo", kind: "system", label: "demo", parentId: null };
const svc: GraphNode = {
  id: "service:a/",
  kind: "service",
  label: "a",
  parentId: root.id,
  layer: "backend",
  root: "a",
};

const fn = (name: string): GraphNode => ({
  id: `symbol:a/x.ts#${name}`,
  kind: "symbol",
  label: name,
  parentId: svc.id,
  symbolKind: "function",
  exported: true,
});

/** One symbol per name, as a tuple of the same length. */
const fns = <const T extends readonly string[]>(...names: T) =>
  names.map(fn) as { [K in keyof T]: GraphNode };

const edge = (
  from: GraphNode,
  to: GraphNode,
  kind: GraphEdge["kind"] = "calls",
  line?: number,
): GraphEdge => ({
  id: `${kind}:${from.id}->${to.id}`,
  kind,
  from: from.id,
  to: to.id,
  confidence: "exact",
  sites: line === undefined ? [] : [{ file: "a/x.ts", line, column: 1 }],
});

function indexOf(nodes: GraphNode[], edges: GraphEdge[]) {
  const graph: ArchitectureGraph = {
    schemaVersion: shopDemo().schemaVersion,
    repo: { owner: "acme", name: "demo", sha: "0123456789abcdef0123456789abcdef01234567" },
    analyzerVersion: "0.1.0",
    nodes: [root, svc, ...nodes],
    edges,
    warnings: [],
  };
  return buildHierarchy(graph);
}

const titles = (i: ReturnType<typeof indexOf>, start: string) =>
  traceFrom(i, start).steps.map((s) => s.title);

describe("the request path on shop-demo", () => {
  it("follows checkout from the page to the database and Stripe, in call order", () => {
    const trace = traceFrom(index, "page:web//checkout");
    // The same hops M4a's hand-written script named, now computed.
    expect(trace.steps.map((s) => s.edge.id)).toEqual([
      "renders:page:web//checkout->symbol:web/app/checkout/page.tsx#Checkout",
      "calls:symbol:web/app/checkout/page.tsx#Checkout->symbol:web/lib/orders.ts#placeOrder",
      "http:symbol:web/lib/orders.ts#placeOrder->route:api/POST /api/orders",
      "handles:route:api/POST /api/orders->symbol:api/src/orders/handlers.ts#createOrder",
      "writes:symbol:api/src/orders/handlers.ts#createOrder->model:api/Order",
      "stores:model:api/Order->datastore:infra/db",
      "calls:symbol:api/src/orders/handlers.ts#createOrder->symbol:api/src/billing/stripe.ts#chargeOrder",
      "external_call:symbol:api/src/billing/stripe.ts#chargeOrder->external:ext/api.stripe.com",
    ]);
    expect(trace.steps.map((s) => s.title)).toEqual([
      "page /checkout renders Checkout",
      "Checkout calls placeOrder",
      "placeOrder requests POST /api/orders",
      "POST /api/orders handled by createOrder",
      "createOrder writes Order",
      "Order stored in db",
      "createOrder calls chargeOrder",
      "chargeOrder calls API api.stripe.com",
    ]);
    // Every hop says where it happens, from the edge's own site.
    expect(trace.steps.map((s) => s.site && `${s.site.file}:${s.site.line}`)).toEqual([
      "apps/web/app/checkout/page.tsx:5",
      "apps/web/app/checkout/page.tsx:6",
      "apps/web/lib/orders.ts:5",
      "apps/api/src/routes/orders.ts:7",
      "apps/api/src/orders/handlers.ts:11",
      "apps/api/prisma/schema.prisma:1",
      "apps/api/src/orders/handlers.ts:14",
      "apps/api/src/billing/stripe.ts:6",
    ]);
    expect(trace.steps[2]?.edge.confidence).toBe("heuristic");
    expect(trace.cutOff).toEqual([]);
  });

  it("collects every node on the path, and nothing off it", () => {
    const nodes = traceNodes(traceFrom(index, "page:web//checkout"));
    expect(nodes.size).toBe(9);
    expect(nodes.has("datastore:infra/db")).toBe(true);
    expect(nodes.has("external:ext/api.stripe.com")).toBe(true);
    expect(nodes.has("route:api/GET /api/orders")).toBe(false);
  });

  it("starts from a route, and ends visibly where a URL couldn't be resolved", () => {
    expect(traceFrom(index, "route:api/GET /api/orders").steps.map((s) => s.title)).toEqual([
      "GET /api/orders handled by listOrders",
      "listOrders reads Order",
      "Order stored in db",
    ]);
    const home = traceFrom(index, "page:web//").steps;
    expect(home.map((s) => s.edge.kind)).toEqual(["renders", "calls", "http"]);
    expect(home[2]?.to.kind).toBe("unresolved");
    expect(home[2]?.edge.confidence).toBe("unresolved");
  });

  it("offers a trace from pages and routes that go somewhere, nothing else", () => {
    const offered = index.graph.nodes.filter((n) => canTraceFrom(index, n)).map((n) => n.id);
    expect(offered).toEqual([
      "page:web//",
      "page:web//checkout",
      "page:web//orders",
      "route:api/GET /api/orders",
      "route:api/POST /api/orders",
    ]);
  });

  it("is deterministic and throws for an unknown start", () => {
    expect(traceFrom(index, "page:web//checkout")).toEqual(traceFrom(index, "page:web//checkout"));
    expect(() => traceFrom(index, "page:web//nope")).toThrow(/unknown node/);
  });
});

describe("the request path's rules", () => {
  it("orders a function's hops by call site, then sites before none, and skips imports", () => {
    const [a, b, c, d, e] = fns("a", "b", "c", "d", "e");
    const i = indexOf(
      [a, b, c, d, e],
      [edge(a, b, "calls", 9), edge(a, c, "calls", 3), edge(a, d), edge(a, e, "imports", 1)],
    );
    expect(titles(i, a.id)).toEqual(["a calls c", "a calls b", "a calls d"]);
  });

  it("follows each hop to its end before the next, and each node once", () => {
    const [a, b, c, d] = fns("a", "b", "c", "d");
    // a → b → d, a → c → d: d is followed once; c's hop to it is still a step.
    const i = indexOf(
      [a, b, c, d],
      [
        edge(a, b, "calls", 1),
        edge(a, c, "calls", 2),
        edge(b, d, "calls", 3),
        edge(c, d, "calls", 4),
      ],
    );
    expect(titles(i, a.id)).toEqual(["a calls b", "b calls d", "a calls c", "c calls d"]);
  });

  it("ends a cycle where it closes", () => {
    const [a, b] = [fn("a"), fn("b")];
    const i = indexOf(
      [a, b],
      [edge(a, b, "calls", 1), edge(b, a, "calls", 2), edge(a, a, "calls", 3)],
    );
    expect(titles(i, a.id)).toEqual(["a calls b", "b calls a", "a calls a"]);
  });

  it("goes from a queue to the code that consumes it", () => {
    const [producer, worker] = [fn("enqueue"), fn("work")];
    const queue: GraphNode = {
      id: "queue:infra/jobs",
      kind: "queue",
      label: "jobs",
      parentId: root.id,
      layer: "infra",
      engine: "bullmq",
    };
    const i = indexOf(
      [producer, worker, queue],
      [edge(producer, queue, "publishes", 1), edge(worker, queue, "consumes", 2)],
    );
    const steps = traceFrom(i, producer.id).steps;
    expect(steps.map((s) => s.title)).toEqual([
      "enqueue publishes to jobs",
      "jobs consumed by work",
    ]);
    expect(steps[1]?.from.id).toBe(queue.id);
    expect(steps[1]?.to.id).toBe(worker.id);
  });

  it(`stops ${TRACE_DEPTH} hops out and says where it stopped`, () => {
    const chain = Array.from({ length: TRACE_DEPTH + 3 }, (_, k) => fn(`f${k}`));
    const edges = chain.slice(1).map((n, k) => edge(chain[k] as GraphNode, n, "calls", k + 1));
    const i = indexOf(chain, edges);
    const long = traceFrom(i, "symbol:a/x.ts#f0");
    expect(long.steps).toHaveLength(TRACE_DEPTH);
    expect(long.steps.at(-1)?.title).toBe(`f${TRACE_DEPTH - 1} calls f${TRACE_DEPTH}`);
    expect(long.cutOff.map((n) => n.label)).toEqual([`f${TRACE_DEPTH}`]);

    // A shortcut f0 → f11 puts f14 4 hops out, so the whole chain is on the path,
    // walked the long way round first (the shortcut's call site comes last).
    const short = traceFrom(
      indexOf(chain, [...edges, edge(chain[0] as GraphNode, chain[11] as GraphNode, "calls", 99)]),
      "symbol:a/x.ts#f0",
    );
    expect(short.steps).toHaveLength(edges.length + 1);
    expect(short.cutOff).toEqual([]);
  });

  it("follows a 5,000-call chain without overflowing the stack", () => {
    const hub = fn("hub");
    const leaves = Array.from({ length: 5000 }, (_, k) => fn(`g${k}`));
    // Every leaf is one hop from the hub, and they also call each other in a chain,
    // so the depth-first walk goes 5,000 deep while every node is within depth 1.
    const edges = [
      ...leaves.map((n, k) => edge(hub, n, "calls", k + 1)),
      ...leaves.slice(1).map((n, k) => edge(leaves[k] as GraphNode, n, "calls", k + 1)),
    ];
    const trace = traceFrom(indexOf([hub, ...leaves], edges), hub.id);
    expect(trace.steps).toHaveLength(edges.length);
  });
});
