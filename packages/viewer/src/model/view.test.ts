// @vitest-environment node
import { describe, expect, it } from "vitest";
import { shopDemo } from "../prototype/shopDemo.testkit.js";
import { buildHierarchy } from "./hierarchy.js";
import {
  buildView,
  DEFAULT_HIDDEN_KINDS,
  drawnEdge,
  effectiveOpen,
  viewTrail,
  visibleAncestor,
  weaker,
  type GraphView,
} from "./view.js";

const index = buildHierarchy(shopDemo());
const placed = (view: GraphView) =>
  view.nodes.map((n) => `${"  ".repeat(n.level)}${n.id}${n.open ? " (open)" : ""} [${n.section}]`);
const lifted = (view: GraphView) =>
  view.edges.map((e) => `${e.kind} ${e.from} -> ${e.to} ${e.confidence} ×${e.edges.length}`);

const API_FILE_OPEN = [
  "service:api/",
  "module:api/src",
  "module:api/src/routes",
  "file:api/src/routes/orders.ts",
];

describe("visibility", () => {
  it("shows the root's children when nothing is open", () => {
    const view = buildView(index, []);
    expect(placed(view)).toEqual([
      "datastore:infra/db [contents]",
      "external:ext/api.stripe.com [contents]",
      "service:api/ [contents]",
      "service:web/ [contents]",
    ]);
    expect(view.open).toEqual([]);
    expect(view.childrenOf.get("system:root")).toHaveLength(4);
  });

  it("leads an open service with its routes, then its folders", () => {
    expect(placed(buildView(index, ["service:api/"]))).toEqual([
      "datastore:infra/db [contents]",
      "external:ext/api.stripe.com [contents]",
      "service:api/ (open) [contents]",
      "  route:api/GET /api/orders [entries]",
      "  route:api/POST /api/orders [entries]",
      "  module:api/prisma [contents]",
      "  module:api/src [contents]",
      "service:web/ [contents]",
    ]);
  });

  it("leads with pages too, and keeps a service's unresolved calls after its folders", () => {
    const view = buildView(index, ["service:web/"]);
    expect(view.childrenOf.get("service:web/")).toEqual([
      "page:web//",
      "page:web//checkout",
      "page:web//orders",
      "module:web/app",
      "module:web/lib",
      "unresolved:web/lib/cms.ts:3:21",
    ]);
  });

  it("keeps entries at the service until their own file opens, then draws them there once", () => {
    const folderOpen = buildView(index, API_FILE_OPEN.slice(0, 3));
    expect(folderOpen.byId.get("route:api/GET /api/orders")?.parent).toBe("service:api/");
    expect(folderOpen.byId.get("file:api/src/routes/orders.ts")?.open).toBe(false);

    const fileOpen = buildView(index, API_FILE_OPEN);
    expect(placed(fileOpen).slice(2)).toEqual([
      "service:api/ (open) [contents]",
      "  module:api/prisma [contents]",
      "  module:api/src (open) [contents]",
      "    module:api/src/billing [contents]",
      "    module:api/src/orders [contents]",
      "    module:api/src/routes (open) [contents]",
      "      file:api/src/routes/orders.ts (open) [contents]",
      "        route:api/GET /api/orders [contents]",
      "        route:api/POST /api/orders [contents]",
      "        symbol:api/src/routes/orders.ts#orders [contents]",
      "    file:api/src/db.ts [contents]",
      "    file:api/src/server.ts [contents]",
      "service:web/ [contents]",
    ]);
    expect(fileOpen.nodes.filter((n) => n.id === "route:api/GET /api/orders")).toHaveLength(1);
    expect(fileOpen.nodes.some((n) => n.section === "entries")).toBe(false);
  });

  it("opens only what's visible and can open, and remembers the rest for later", () => {
    expect([...effectiveOpen(index, ["module:api/src"])]).toEqual([]);
    const view = buildView(index, [
      "service:api/",
      "module:api/src",
      "datastore:infra/db",
      "service:nope/",
      "module:web/app",
    ]);
    expect(view.open).toEqual(["module:api/src", "service:api/"]);
    expect(view.byId.get("datastore:infra/db")).toMatchObject({ open: false, canOpen: false });
    expect(view.byId.has("module:web/app")).toBe(false);
  });

  it("gives the same view for the same state, whatever the order it was asked in", () => {
    const a = buildView(index, API_FILE_OPEN);
    const b = buildView(index, [...API_FILE_OPEN].reverse());
    expect(b.nodes).toEqual(a.nodes);
    expect(b.edges).toEqual(a.edges);
    expect(b.open).toEqual(a.open);
  });

  it("traces a node's frames for breadcrumbs, an entry's through its service", () => {
    const view = buildView(index, ["service:api/", "module:api/src"]);
    expect(viewTrail(view, "route:api/POST /api/orders").map((n) => n.id)).toEqual([
      "service:api/",
      "route:api/POST /api/orders",
    ]);
    expect(viewTrail(view, "module:api/src/orders").map((n) => n.id)).toEqual([
      "service:api/",
      "module:api/src",
      "module:api/src/orders",
    ]);
    expect(viewTrail(view, "symbol:api/src/db.ts#prisma")).toEqual([]);
  });
});

describe("edge aggregation", () => {
  it("lifts edges to the system level, keeping the weakest confidence and leaving out imports", () => {
    // In graph order (edges are sorted by ID); the unresolved CMS call stays inside web.
    expect(lifted(buildView(index, []))).toEqual([
      "external_call service:api/ -> external:ext/api.stripe.com exact ×1",
      "http service:web/ -> service:api/ heuristic ×2",
      "stores service:api/ -> datastore:infra/db exact ×1",
    ]);
  });

  it("reaches a service's entries directly, so each route shows who calls it and what it runs", () => {
    expect(lifted(buildView(index, ["service:api/"]))).toEqual([
      "external_call module:api/src -> external:ext/api.stripe.com exact ×1",
      "handles route:api/GET /api/orders -> module:api/src exact ×1",
      "handles route:api/POST /api/orders -> module:api/src exact ×1",
      "http service:web/ -> route:api/GET /api/orders heuristic ×1",
      "http service:web/ -> route:api/POST /api/orders heuristic ×1",
      "reads module:api/src -> module:api/prisma exact ×1",
      "stores module:api/prisma -> datastore:infra/db exact ×1",
      "writes module:api/src -> module:api/prisma exact ×1",
    ]);
  });

  it("counts edges between folders, and shows hidden kinds when asked", () => {
    const view = buildView(index, ["service:web/"]);
    expect(lifted(view)).toContain("calls module:web/app -> module:web/lib exact ×3");
    expect(lifted(view)).toContain("renders page:web//checkout -> module:web/app exact ×1");
    expect(lifted(view)).toContain(
      "http module:web/lib -> unresolved:web/lib/cms.ts:3:21 unresolved ×1",
    );
    expect(lifted(view).some((e) => e.startsWith("imports"))).toBe(false);
    const withImports = buildView(index, ["service:web/"], { hiddenKinds: new Set() });
    expect(lifted(withImports)).toContain("imports module:web/app -> module:web/lib exact ×3");
    // The view records what it left off, sorted, for the layout cache's key.
    expect(view.hidden).toEqual(["imports"]);
    expect(withImports.hidden).toEqual([]);
    const twoHidden = buildView(index, [], { hiddenKinds: new Set(["stores", "calls"]) });
    expect(twoHidden.hidden).toEqual(["calls", "stores"]);
  });

  it("accounts for every graph edge: drawn once, or inside one visible node", () => {
    const all = index.graph.nodes.map((n) => n.id);
    for (const expanded of [[], ["service:api/"], ["service:web/"], API_FILE_OPEN, all]) {
      const view = buildView(index, expanded);
      const shown = index.graph.edges.filter((e) => !DEFAULT_HIDDEN_KINDS.has(e.kind));
      const drawn = view.edges.flatMap((e) => e.edges);
      expect(new Set(drawn).size).toBe(drawn.length);
      const inside = shown.filter(
        (e) => visibleAncestor(index, view, e.from) === visibleAncestor(index, view, e.to),
      );
      expect(drawn.length + inside.length).toBe(shown.length);
    }
    // With everything open, each drawn edge is one graph edge between its own ends.
    const open = buildView(index, all);
    expect(open.edges.every((e) => e.edges.length === 1 && e.from === e.edges[0]?.from)).toBe(true);
    expect(open.edges).toHaveLength(
      index.graph.edges.filter((e) => !DEFAULT_HIDDEN_KINDS.has(e.kind)).length,
    );
  });

  it("finds the innermost visible node holding an ID", () => {
    const view = buildView(index, ["service:api/"]);
    expect(visibleAncestor(index, view, "symbol:api/src/orders/handlers.ts#createOrder")).toBe(
      "module:api/src",
    );
    expect(visibleAncestor(index, view, "route:api/POST /api/orders")).toBe(
      "route:api/POST /api/orders",
    );
    expect(visibleAncestor(index, view, "page:web//checkout")).toBe("service:web/");
    expect(visibleAncestor(index, view, "system:root")).toBeUndefined();
  });

  it("orders confidence from exact down to unresolved", () => {
    expect(weaker("exact", "heuristic")).toBe("heuristic");
    expect(weaker("unresolved", "pattern")).toBe("unresolved");
    expect(weaker("pattern", "pattern")).toBe("pattern");
  });

  it("draws one edge with its own label, an aggregate as a count", () => {
    const [, http, stores] = buildView(index, []).edges;
    expect(stores && drawnEdge(stores)).toEqual({ edge: stores?.edges[0] });
    expect(http && drawnEdge(http)).toEqual({
      edge: { kind: "http", confidence: "heuristic" },
      count: 2,
    });
  });
});
