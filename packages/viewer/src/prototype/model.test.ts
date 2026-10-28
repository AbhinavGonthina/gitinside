// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ancestry,
  canOpen,
  connectionsOf,
  descendants,
  drawnEdge,
  frameCounts,
  indexGraph,
  isWithin,
  layerOf,
  liftEdges,
  nodeOf,
  visibleAncestor,
  visibleIds,
  weaker,
} from "./model.js";
import { shopDemo } from "./shopDemo.testkit.js";

const index = indexGraph(shopDemo());
const lifted = (open: string | null) =>
  liftEdges(index, visibleIds(index, open)).map(
    (e) => `${e.kind} ${e.from} -> ${e.to} ${e.confidence} ×${e.edges.length}`,
  );

describe("indexGraph", () => {
  it("finds the root and keeps children in graph order", () => {
    expect(index.root.id).toBe("system:root");
    expect(index.children.get("system:root")?.map((n) => n.id)).toEqual([
      "datastore:infra/db",
      "external:ext/api.stripe.com",
      "service:api/",
      "service:web/",
    ]);
  });

  it("rejects a graph without a root, and unknown IDs", () => {
    const g = shopDemo();
    expect(() => indexGraph({ ...g, nodes: g.nodes.filter((n) => n.parentId !== null) })).toThrow(
      /no root/,
    );
    expect(() => nodeOf(index, "service:nope/")).toThrow(/unknown node/);
  });

  it("walks ancestry, inherits layers, and checks containment", () => {
    expect(ancestry(index, "route:api/POST /api/orders").map((n) => n.id)).toEqual([
      "route:api/POST /api/orders",
      "file:api/src/routes/orders.ts",
      "module:api/src/routes",
      "module:api/src",
      "service:api/",
      "system:root",
    ]);
    expect(layerOf(index, "module:web/lib")).toBe("frontend");
    expect(layerOf(index, "system:root")).toBeUndefined();
    expect(isWithin(index, "model:api/Order", "service:api/")).toBe(true);
    expect(isWithin(index, "model:api/Order", "service:web/")).toBe(false);
    expect(canOpen(index, "service:api/")).toBe(true);
    expect(canOpen(index, "datastore:infra/db")).toBe(false);
  });
});

describe("visibility and lifting", () => {
  it("shows the root's children, plus the open node's children", () => {
    expect([...visibleIds(index, null)]).toHaveLength(4);
    expect([...visibleIds(index, "service:api/")]).toEqual([
      "datastore:infra/db",
      "external:ext/api.stripe.com",
      "service:api/",
      "service:web/",
      "module:api/prisma",
      "module:api/src",
    ]);
    // Only top-level nodes open in the prototype.
    expect(visibleIds(index, "module:api/src").size).toBe(4);
  });

  it("finds the innermost visible node holding an ID", () => {
    const visible = visibleIds(index, "service:api/");
    expect(visibleAncestor(index, "route:api/POST /api/orders", visible)).toBe("module:api/src");
    expect(visibleAncestor(index, "page:web//checkout", visible)).toBe("service:web/");
    expect(visibleAncestor(index, "system:root", visible)).toBeUndefined();
  });

  it("lifts edges to the system level, keeping the weakest confidence and dropping imports", () => {
    // In graph order (edges are sorted by ID); the unresolved CMS call stays inside web.
    expect(lifted(null)).toEqual([
      "external_call service:api/ -> external:ext/api.stripe.com exact ×1",
      "http service:web/ -> service:api/ heuristic ×2",
      "stores service:api/ -> datastore:infra/db exact ×1",
    ]);
  });

  it("lifts edges to the open service's modules", () => {
    expect(lifted("service:api/")).toEqual([
      "external_call module:api/src -> external:ext/api.stripe.com exact ×1",
      "http service:web/ -> module:api/src heuristic ×2",
      "reads module:api/src -> module:api/prisma exact ×1",
      "stores module:api/prisma -> datastore:infra/db exact ×1",
      "writes module:api/src -> module:api/prisma exact ×1",
    ]);
    expect(lifted("service:web/")).toContain(
      "http module:web/lib -> unresolved:web/lib/cms.ts:3:21 unresolved ×1",
    );
    expect(lifted("service:web/")).toContain("calls module:web/app -> module:web/lib exact ×3");
  });

  it("orders confidence from exact down to unresolved", () => {
    expect(weaker("exact", "heuristic")).toBe("heuristic");
    expect(weaker("unresolved", "pattern")).toBe("unresolved");
    expect(weaker("pattern", "pattern")).toBe("pattern");
  });

  it("draws one edge with its own label, an aggregate as a count", () => {
    const [, http, stores] = liftEdges(index, visibleIds(index, null));
    expect(stores && drawnEdge(stores)).toEqual({ edge: stores?.edges[0] });
    expect(http && drawnEdge(http)).toEqual({
      edge: { kind: "http", confidence: "heuristic" },
      count: 2,
    });
  });
});

describe("counts and connections", () => {
  it("counts what's inside a frame, unresolved calls in their own style", () => {
    expect(frameCounts(index, "service:web/")).toEqual([
      { value: 3, noun: "page" },
      { value: 1, noun: "unresolved call", unresolved: true },
    ]);
    expect(frameCounts(index, "service:api/")).toEqual([
      { value: 2, noun: "route" },
      { value: 1, noun: "model" },
    ]);
    expect(frameCounts(index, "datastore:infra/db")).toEqual([]);
    expect(descendants(index, "module:api/prisma").map((n) => n.id)).toEqual([
      "file:api/prisma/schema.prisma",
      "model:api/Order",
    ]);
  });

  it("lists what crosses a node's boundary, by direction", () => {
    const route = connectionsOf(index, "route:api/POST /api/orders");
    expect(route.incoming.map((c) => c.other.id)).toEqual(["symbol:web/lib/orders.ts#placeOrder"]);
    expect(route.outgoing.map((c) => c.other.id)).toEqual([
      "symbol:api/src/orders/handlers.ts#createOrder",
    ]);
    const api = connectionsOf(index, "service:api/");
    expect(api.incoming).toHaveLength(2);
    expect(api.outgoing.map((c) => c.edge.kind)).toEqual(["external_call", "stores"]);
  });
});
