// @vitest-environment node
import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { buildDiffOverlay, regroupOverlay } from "../model/diff.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { tourBreak } from "./tourBreak.js";

// The tour's canned PR (M10.3f2b, M10-design §3.1 step 4).

const graph = shopDemo();
const GET = "route:api/GET /api/orders";
const POST = "route:api/POST /api/orders";

describe("tourBreak", () => {
  it("removes a route another service calls, and the diff finds the call broken", () => {
    const found = tourBreak(graph);
    // Both order routes have one caller in web: the first by ID.
    expect(found?.route.id).toBe(GET);
    expect(found?.caller.id).toBe("symbol:web/lib/orders.ts#listOrders");
    expect(found?.detail).toBe("GET /api/orders was removed");
    expect(found?.diff.broken).toEqual([
      {
        edge: "http:symbol:web/lib/orders.ts#listOrders->route:api/GET /api/orders",
        from: "symbol:web/lib/orders.ts#listOrders",
        to: GET,
        reason: "TARGET_REMOVED",
        detail: "GET /api/orders was removed",
        sites: [{ file: "apps/web/lib/orders.ts", line: 13, column: 21 }],
      },
    ]);
    // Only the route went; nothing else in the repo changed.
    expect(found?.diff.nodes.removed).toEqual([GET]);
    expect(found?.diff.nodes.modified).toEqual([]);
  });

  it("draws head as the analyzer draws a call to a missing route", () => {
    const head = tourBreak(graph)?.head as ArchitectureGraph;
    // A valid graph: no edge left pointing at the route, every node's parent there.
    expect(() => parseGraph(head)).not.toThrow();
    expect(head.nodes.some((n) => n.id === GET)).toBe(false);
    expect(head.edges.filter((e) => e.from === GET || e.to === GET)).toEqual([]);
    const call = head.nodes.find((n) => n.id === "unresolved:web/lib/orders.ts:13:21");
    expect(call).toEqual({
      id: "unresolved:web/lib/orders.ts:13:21",
      kind: "unresolved",
      label: "GET {env:NEXT_PUBLIC_API_URL}/api/orders",
      parentId: "file:web/lib/orders.ts",
      reason: "NO_MATCHING_ROUTE",
      expression: "GET {env:NEXT_PUBLIC_API_URL}/api/orders",
      source: { file: "apps/web/lib/orders.ts", line: 13, column: 21 },
    });
    expect(head.edges.find((e) => e.to === "unresolved:web/lib/orders.ts:13:21")).toMatchObject({
      kind: "http",
      from: "symbol:web/lib/orders.ts#listOrders",
      confidence: "unresolved",
      reason: "NO_MATCHING_ROUTE",
    });
  });

  it("takes a route on the preferred path first", () => {
    expect(tourBreak(graph, [POST])?.route.id).toBe(POST);
    // The first of them on the path, whatever their IDs.
    expect(tourBreak(graph, ["page:web//orders", POST, GET])?.route.id).toBe(POST);
    expect(tourBreak(graph, [GET, POST])?.route.id).toBe(GET);
  });

  it("takes the route with the fewest callers before the first by ID", () => {
    // A second caller of GET from web: POST, with one, goes first.
    const call = graph.edges.find((e) => e.to === POST);
    if (!call) throw new Error("shop-demo lost its POST call");
    const more: ArchitectureGraph = {
      ...graph,
      edges: [
        ...graph.edges,
        {
          ...call,
          id: "http:symbol:web/lib/orders.ts#placeOrder->route:api/GET /api/orders",
          to: GET,
        },
      ],
    };
    expect(tourBreak(more)?.route.id).toBe(POST);
  });

  it("finds nothing when no service calls another's route, so the tour leaves the step out", () => {
    const alone: ArchitectureGraph = {
      ...graph,
      edges: graph.edges.filter((e) => !(e.kind === "http" && e.to.startsWith("route:"))),
    };
    expect(tourBreak(alone)).toBeUndefined();
  });
});

describe("regroupOverlay", () => {
  it("puts the prototype's groups in each version and counts changes through them", () => {
    const found = tourBreak(graph);
    if (!found) throw new Error("no break");
    const overlay = buildDiffOverlay(graph, found.head, found.diff);
    // shop-demo's api has too few routes to group, so put a group over each order route, as the
    // summary does past 12 (one route per group, so each lives in one version only).
    const group = (route: string) => `module:api/${route}`;
    const grouped: ArchitectureGraph = {
      ...overlay.graph,
      nodes: overlay.graph.nodes.flatMap((n) =>
        n.id === GET || n.id === POST
          ? [
              { id: group(n.id), kind: "module", label: "orders", parentId: n.parentId, path: "" },
              { ...n, parentId: group(n.id) },
            ]
          : [n],
      ),
    };
    const regrouped = regroupOverlay(overlay, grouped);
    expect(regrouped.graph).toBe(grouped);
    // The removed route's group is in base only; the kept one's in both.
    expect(regrouped.nodesIn.base.has(group(GET))).toBe(true);
    expect(regrouped.nodesIn.head.has(group(GET))).toBe(false);
    expect(regrouped.nodesIn.base.has(group(POST))).toBe(true);
    expect(regrouped.nodesIn.head.has(group(POST))).toBe(true);
    expect(regrouped.inside.get(group(GET))).toEqual({
      added: 0,
      changed: 0,
      removed: 1,
      broken: 0,
    });
    expect(regrouped.inside.has(group(POST))).toBe(false);
    // The service counts what's below it as before.
    expect(regrouped.inside.get("service:api/")).toEqual(overlay.inside.get("service:api/"));
  });
});
