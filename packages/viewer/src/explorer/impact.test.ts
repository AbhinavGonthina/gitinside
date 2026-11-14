// @vitest-environment node
import type { ArchitectureGraph, GraphEdge, GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { IMPACT_PATHS, impactCountText, impactOf } from "./impact.js";
import { shortWhere } from "./impactPanel.js";

const shop = buildHierarchy(shopDemo());

const root: GraphNode = { id: "system:demo", kind: "system", label: "demo", parentId: null };
const service = (name: string): GraphNode => ({
  id: `service:${name}/`,
  kind: "service",
  label: name,
  parentId: root.id,
  layer: "backend",
  root: name,
});
const a = service("a");
const b = service("b");

const fn = (name: string, parent: GraphNode = a): GraphNode => ({
  id: `symbol:${parent.label}/x.ts#${name}`,
  kind: "symbol",
  label: name,
  parentId: parent.id,
  symbolKind: "function",
  exported: true,
});

const route = (path: string, parent: GraphNode = b): GraphNode => ({
  id: `route:${parent.label}/GET ${path}`,
  kind: "route",
  label: `GET ${path}`,
  parentId: parent.id,
  method: "GET",
  path,
});

const unresolved = (name: string, reason: "DYNAMIC_URL" | "EXTERNAL_HOST"): GraphNode => ({
  id: `unresolved:a/${name}`,
  kind: "unresolved",
  label: name,
  parentId: a.id,
  reason,
  expression: name,
});

const edge = (
  from: GraphNode,
  to: GraphNode,
  kind: GraphEdge["kind"] = "calls",
  confidence: GraphEdge["confidence"] = "exact",
): GraphEdge => ({
  id: `${kind}:${from.id}->${to.id}`,
  kind,
  from: from.id,
  to: to.id,
  confidence,
  sites: [],
});

function indexOf(nodes: GraphNode[], edges: GraphEdge[]) {
  const graph: ArchitectureGraph = {
    schemaVersion: shopDemo().schemaVersion,
    repo: { owner: "acme", name: "demo", sha: "0123456789abcdef0123456789abcdef01234567" },
    analyzerVersion: "0.1.0",
    nodes: [root, a, b, ...nodes],
    edges,
    warnings: [],
  };
  return buildHierarchy(graph);
}

const sorted = (ids: Iterable<string>) => [...ids].sort();

describe("impactOf", () => {
  it("lists every node whose request path reaches the target, however far back", () => {
    const [x, y, z, other] = [fn("x"), fn("y"), fn("z"), fn("other")];
    const i = indexOf([x, y, z, other], [edge(x, y), edge(y, z), edge(other, x, "imports")]);
    expect(sorted(impactOf(i, z.id).dependents)).toEqual(sorted([x.id, y.id]));
    // Imports aren't requests: `other` only imports x.
    expect(impactOf(i, x.id).dependents.size).toBe(0);
  });

  it("walks a request across services, from the handler back to the page's code", () => {
    const [handler, caller] = [fn("handler", b), fn("caller")];
    const r = route("/orders");
    const i = indexOf(
      [handler, caller, r],
      [edge(r, handler, "handles"), edge(caller, r, "http", "pattern")],
    );
    const impact = impactOf(i, handler.id);
    expect(sorted(impact.dependents)).toEqual(sorted([r.id, caller.id]));
    expect(impact.groups.map((g) => [g.holder.id, g.nodes.map((n) => n.id)])).toEqual([
      [a.id, [caller.id]],
      [b.id, [r.id]],
    ]);
    // The route reaches the handler in one hop, at its own confidence.
    expect(impact.paths.map((p) => [p.nodes.map((n) => n.id), p.confidence])).toEqual([
      [[r.id, handler.id], "exact"],
    ]);
  });

  it("follows a queue from its worker back to the code publishing to it", () => {
    const [worker, producer] = [fn("worker", b), fn("producer")];
    const queue: GraphNode = {
      id: "queue:infra/jobs",
      kind: "queue",
      label: "jobs",
      parentId: root.id,
      engine: "bullmq",
    };
    const i = indexOf(
      [worker, producer, queue],
      [edge(worker, queue, "consumes"), edge(producer, queue, "publishes")],
    );
    expect(sorted(impactOf(i, worker.id).dependents)).toEqual(sorted([queue.id, producer.id]));
    expect(impactCountText(impactOf(i, worker.id))).toBe(
      "2 things, in 1 service and 1 other place",
    );
  });

  it("counts what reaches anything inside the target, but nothing inside it", () => {
    const [inner, inner2, outer] = [fn("inner", b), fn("inner2", b), fn("outer")];
    const i = indexOf([inner, inner2, outer], [edge(inner2, inner), edge(outer, inner2)]);
    expect([...impactOf(i, b.id).dependents]).toEqual([outer.id]);
  });

  it("stops at a cycle", () => {
    const [x, y, z] = [fn("x"), fn("y"), fn("z")];
    const i = indexOf([x, y, z], [edge(x, y), edge(y, x), edge(y, z)]);
    expect(sorted(impactOf(i, z.id).dependents)).toEqual(sorted([x.id, y.id]));
  });

  it("says a request that matched no route may reach a route, apart from its dependents", () => {
    const r = route("/orders");
    const [caller, page, exact, outside] = [fn("caller"), fn("page"), fn("exact"), fn("outside")];
    const [lost, host] = [unresolved("lost", "DYNAMIC_URL"), unresolved("host", "EXTERNAL_HOST")];
    const i = indexOf(
      [r, caller, page, exact, outside, lost, host],
      [
        edge(caller, lost, "http", "unresolved"),
        edge(page, caller),
        edge(exact, r, "http"),
        edge(outside, host, "http", "unresolved"),
      ],
    );
    const impact = impactOf(i, r.id);
    expect([...impact.dependents]).toEqual([exact.id]);
    // An outside host's request can't land on a route in the repo.
    expect(sorted(impact.maybe)).toEqual(sorted([lost.id, caller.id, page.id]));
    // A target that takes no request has nothing that may reach it.
    expect(impactOf(i, exact.id).maybe.size).toBe(0);
  });

  it("never counts as maybe what surely depends", () => {
    const r = route("/orders");
    const [both, lost] = [fn("both"), unresolved("lost", "DYNAMIC_URL")];
    const i = indexOf(
      [r, both, lost],
      [edge(both, r, "http"), edge(both, lost, "http", "unresolved")],
    );
    const impact = impactOf(i, r.id);
    expect([...impact.dependents]).toEqual([both.id]);
    expect([...impact.maybe]).toEqual([lost.id]);
  });

  it("lists the shortest paths from pages and routes, shortest first, with their weakest link", () => {
    const target = fn("target", b);
    const routes = ["/a", "/b", "/c", "/d", "/e", "/f"].map((p) => route(p));
    const middle = fn("middle", b);
    const i = indexOf(
      [target, middle, ...routes],
      [
        edge(middle, target, "calls", "heuristic"),
        // /a goes through `middle`; the rest call the target straight.
        edge(routes[0]!, middle, "handles"),
        ...routes.slice(1).map((r) => edge(r, target, "handles")),
      ],
    );
    const paths = impactOf(i, target.id).paths;
    expect(paths).toHaveLength(IMPACT_PATHS);
    expect(paths.map((p) => p.nodes.map((n) => n.label).join(" → "))).toEqual([
      "GET /b → target",
      "GET /c → target",
      "GET /d → target",
      "GET /e → target",
      "GET /f → target",
    ]);
    const all = impactOf(
      indexOf(
        [target, middle, routes[0]!],
        [edge(middle, target, "calls", "heuristic"), edge(routes[0]!, middle, "handles")],
      ),
      target.id,
    ).paths;
    expect(all.map((p) => [p.nodes.map((n) => n.label), p.confidence])).toEqual([
      [["GET /a", "middle", "target"], "heuristic"],
    ]);
  });

  it("shortens a dependent's path to its folder and file", () => {
    expect(shortWhere("packages/lib/jobs/emails/send.ts")).toBe("…/emails/send.ts");
    expect(shortWhere("lib/send.ts")).toBe("lib/send.ts");
    expect(shortWhere(undefined)).toBeUndefined();
  });

  it("says when nothing depends on a node", () => {
    const x = fn("x");
    const impact = impactOf(indexOf([x], []), x.id);
    expect(impactCountText(impact)).toBe("Nothing in the repo depends on this");
    expect(impact.groups).toEqual([]);
    expect(impact.paths).toEqual([]);
  });

  it("finds checkout's whole path back from shop-demo's Order model", () => {
    const impact = impactOf(shop, "model:api/Order");
    expect(impact.dependents.has("page:web//checkout")).toBe(true);
    expect(impact.dependents.has("route:api/POST /api/orders")).toBe(true);
    // Two hops from either route; GET sorts first.
    expect(impact.paths.slice(0, 2).map((p) => p.nodes.map((n) => n.id))).toEqual([
      [
        "route:api/GET /api/orders",
        "symbol:api/src/orders/handlers.ts#listOrders",
        "model:api/Order",
      ],
      [
        "route:api/POST /api/orders",
        "symbol:api/src/orders/handlers.ts#createOrder",
        "model:api/Order",
      ],
    ]);
    expect(impactCountText(impact)).toBe("10 things, in 2 services");
  });
});
