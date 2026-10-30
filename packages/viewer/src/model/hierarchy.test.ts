// @vitest-environment node
import type { GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { shopDemo } from "../prototype/shopDemo.testkit.js";
import {
  ancestry,
  buildHierarchy,
  canOpen,
  compareEntries,
  countsInside,
  isEntry,
  isWithin,
  layerOf,
  nodeOf,
  type EntryNode,
} from "./hierarchy.js";

const index = buildHierarchy(shopDemo());

describe("buildHierarchy", () => {
  it("finds the root and keeps children in graph order", () => {
    expect(index.root.id).toBe("system:root");
    expect(index.children.get("system:root")?.map((n) => n.id)).toEqual([
      "datastore:infra/db",
      "external:ext/api.stripe.com",
      "service:api/",
      "service:web/",
    ]);
  });

  it("records each node's depth and service", () => {
    expect(index.depth.get("system:root")).toBe(0);
    expect(index.depth.get("service:api/")).toBe(1);
    expect(index.depth.get("route:api/POST /api/orders")).toBe(5);
    expect(index.service.get("route:api/POST /api/orders")).toBe("service:api/");
    expect(index.service.get("service:web/")).toBe("service:web/");
    expect(index.service.get("unresolved:web/lib/cms.ts:3:21")).toBe("service:web/");
    expect(index.service.has("datastore:infra/db")).toBe(false);
    expect(index.service.has("system:root")).toBe(false);
  });

  it("lists each service's routes and pages from anywhere inside it, by path", () => {
    expect(index.entries.get("service:api/")?.map((n) => n.id)).toEqual([
      "route:api/GET /api/orders",
      "route:api/POST /api/orders",
    ]);
    expect(index.entries.get("service:web/")?.map((n) => n.id)).toEqual([
      "page:web//",
      "page:web//checkout",
      "page:web//orders",
    ]);
  });

  it("counts what's inside each node, all the way down", () => {
    expect(countsInside(index, "service:api/")).toEqual({
      module: 5,
      file: 6,
      symbol: 5,
      route: 2,
      model: 1,
    });
    expect(countsInside(index, "service:web/")).toMatchObject({ page: 3, unresolved: 1 });
    expect(countsInside(index, "system:root").service).toBe(2);
    expect(countsInside(index, "datastore:infra/db")).toEqual({});
    // Every node but the root is counted once at the root.
    const total = Object.values(countsInside(index, "system:root")).reduce((a, b) => a + b, 0);
    expect(total).toBe(index.graph.nodes.length - 1);
  });

  it("rejects a graph without a root, nodes outside the root, and unknown IDs", () => {
    const g = shopDemo();
    expect(() =>
      buildHierarchy({ ...g, nodes: g.nodes.filter((n) => n.parentId !== null) }),
    ).toThrow(/no root/);
    const loop: GraphNode[] = [
      { id: "module:x/a", kind: "module", label: "a", parentId: "module:x/b", path: "a" },
      { id: "module:x/b", kind: "module", label: "b", parentId: "module:x/a", path: "b" },
    ];
    expect(() => buildHierarchy({ ...g, nodes: [...g.nodes, ...loop] })).toThrow(
      /module:x\/a is not under the root/,
    );
    expect(() => nodeOf(index, "service:nope/")).toThrow(/unknown node/);
  });
});

describe("lookups", () => {
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
    expect(isWithin(index, "model:api/Order", "model:api/Order")).toBe(true);
    expect(isWithin(index, "model:api/Order", "service:web/")).toBe(false);
    expect(isWithin(index, "service:api/", "module:api/src")).toBe(false);
    expect(isWithin(index, "model:api/Order", "service:nope/")).toBe(false);
    expect(canOpen(index, "service:api/")).toBe(true);
    expect(canOpen(index, "datastore:infra/db")).toBe(false);
  });

  it("orders entries by path, pages before routes, then by method", () => {
    const base = { label: "x", parentId: "file:a" } as const;
    const get: EntryNode = {
      ...base,
      id: "route:a/GET /a",
      kind: "route",
      method: "GET",
      path: "/a",
    };
    const post: EntryNode = {
      ...base,
      id: "route:a/POST /a",
      kind: "route",
      method: "POST",
      path: "/a",
    };
    const page: EntryNode = { ...base, id: "page:a//a", kind: "page", path: "/a" };
    const root: EntryNode = {
      ...base,
      id: "route:a/GET /",
      kind: "route",
      method: "GET",
      path: "/",
    };
    expect([post, get, page, root].sort(compareEntries).map((n) => n.id)).toEqual([
      "route:a/GET /",
      "page:a//a",
      "route:a/GET /a",
      "route:a/POST /a",
    ]);
    expect(isEntry(get) && isEntry(page)).toBe(true);
    expect(isEntry(nodeOf(index, "model:api/Order"))).toBe(false);
  });
});
