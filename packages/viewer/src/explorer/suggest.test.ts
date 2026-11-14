import type { GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../shopDemo.testkit.js";
import {
  compareSuggestions,
  suggestionOf,
  suggestionStarts,
  suggestTraces,
  SUGGESTED,
  type Suggestion,
} from "./suggest.js";

const graph = shopDemo();
const index = buildHierarchy(graph);
const node = (id: string) => index.byId.get(id) as GraphNode;

describe("suggestTraces (M10.3d1, M10-design B11)", () => {
  it("leads with the page whose request the API answers, reaching the database", () => {
    const top = suggestTraces(index);
    expect(top).toHaveLength(SUGGESTED);
    expect(top.map((s) => [s.node.id, s.shape])).toEqual([
      // Both cross and reach db through 2 services; fewer steps first.
      ["page:web//orders", "page → API → db, 6 steps"],
      ["page:web//checkout", "page → API → db, 8 steps"],
      // Only reaches db, in 1 service.
      ["route:api/GET /api/orders", "route → db, 3 steps"],
    ]);
  });

  it("measures what the rank reads from the trace", () => {
    expect(suggestionOf(index, node("page:web//orders"))).toMatchObject({
      answered: true,
      reachesOut: true,
      services: 2,
      steps: 6,
      path: "apps/web/app/orders/page.tsx",
      layer: "frontend",
    });
    // The home page renders code but makes no request: no "API", nothing reached.
    expect(suggestionOf(index, node("page:web//"))).toMatchObject({
      shape: "page, 3 steps",
      answered: false,
      reachesOut: false,
      services: 1,
    });
  });

  it("counts a request its route answers inside one service too, with fewer services (maxun)", () => {
    const orders = "page:web//orders";
    // The same requests, every API route moved into the web service.
    const moved = buildHierarchy({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.kind === "route" && n.parentId?.startsWith("file:api/")
          ? { ...n, parentId: "service:web/" }
          : n,
      ),
    });
    const routes = graph.nodes.filter((n) => n.kind === "route").map((n) => n.id);
    for (const id of routes) expect(moved.service.get(id)).toBe("service:web/");
    const s = suggestionOf(moved, node(orders));
    expect(s.answered).toBe(true);
    expect(s.shape).toBe("page → API → db, 6 steps");
  });

  it("doesn't count a request to an unresolved target as answered", () => {
    const orders = "page:web//orders";
    const unresolved = graph.nodes.find((n) => n.kind === "unresolved");
    if (!unresolved) throw new Error("shop-demo has no unresolved node");
    const lost = buildHierarchy({
      ...graph,
      edges: graph.edges.map((e) => (e.kind === "http" ? { ...e, to: unresolved.id } : e)),
    });
    const s = suggestionOf(lost, node(orders));
    expect(s.answered).toBe(false);
    expect(s.shape).not.toContain("API");
  });

  it("starts in the code making a request when no page reaches it (wanderlust's UI has no pages)", () => {
    const pageless = buildHierarchy({
      ...graph,
      edges: graph.edges.filter((e) => !e.from.startsWith("page:")),
    });
    const starts = suggestionStarts(pageless).map((n) => n.id);
    // The code whose requests a route answers (not the one to an outside host).
    const callers = graph.edges
      .filter((e) => e.kind === "http" && e.to.startsWith("route:"))
      .map((e) => e.from);
    expect(callers.length).toBeGreaterThan(0);
    for (const id of callers) expect(starts).toContain(id);
    const [top] = suggestTraces(pageless);
    expect(callers).toContain(top?.node.id);
    expect(top?.shape).toMatch(/^function → API → db, \d+ steps$/);
    // With the pages' hops, a page reaches those callers, so they aren't starts of their own.
    const withPages = suggestionStarts(index).map((n) => n.id);
    for (const id of callers) expect(withPages).not.toContain(id);
  });

  it("says 1 step, not 1 steps", () => {
    const route = "route:api/GET /api/orders";
    // The route's first hop, and nothing after it.
    const one = buildHierarchy({
      ...graph,
      edges: graph.edges.filter((e) => e.from === route).slice(0, 1),
    });
    expect(suggestionOf(one, node(route)).shape).toMatch(/, 1 step$/);
  });

  it("suggests nothing when nothing can be traced, and at most `limit`", () => {
    expect(suggestTraces(buildHierarchy({ ...graph, edges: [] }))).toEqual([]);
    expect(suggestTraces(index, 1)).toHaveLength(1);
    expect(suggestTraces(index, 99).length).toBeGreaterThan(SUGGESTED);
  });
});

describe("compareSuggestions", () => {
  const base: Suggestion = {
    node: node("page:web//"),
    shape: "",
    answered: false,
    reachesOut: false,
    services: 1,
    steps: 5,
  };
  const ordered = (...list: Suggestion[]) => [...list].sort(compareSuggestions);

  it("ranks an answered request, then reaching out, then services, then fewer steps, then ID", () => {
    const answered = { ...base, answered: true };
    const out = { ...base, reachesOut: true, services: 9 };
    expect(ordered(out, answered)).toEqual([answered, out]);
    const wide = { ...base, services: 3, steps: 50 };
    expect(ordered(wide, out)).toEqual([out, wide]);
    const short = { ...base, steps: 2 };
    expect(ordered(short, wide)).toEqual([wide, short]);
    expect(ordered(base, short)).toEqual([short, base]);
    const later = { ...base, node: node("page:web//orders") };
    expect(ordered(later, base)).toEqual([base, later]);
  });
});
