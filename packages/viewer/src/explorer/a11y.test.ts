// @vitest-environment node
import type { ArchitectureGraph } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { nodeAccessibleName } from "../nodes/describe.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { ANNOUNCED_ENDS, nearestBox, selectionAnnouncement } from "./a11y.js";

const box = (id: string, x: number, y: number, width = 100, height = 40) => ({
  id,
  x,
  y,
  width,
  height,
});

describe("nearestBox", () => {
  // A 3 × 2 grid, 50px apart:   a b c
  //                             d e f
  const grid = [
    box("a", 0, 0),
    box("b", 150, 0),
    box("c", 300, 0),
    box("d", 0, 90),
    box("e", 150, 90),
    box("f", 300, 90),
  ];

  it("moves to the neighbor in each direction", () => {
    expect(nearestBox(grid, "e", "up")).toBe("b");
    expect(nearestBox(grid, "e", "left")).toBe("d");
    expect(nearestBox(grid, "e", "right")).toBe("f");
    expect(nearestBox(grid, "b", "down")).toBe("e");
    expect(nearestBox(grid, "a", "right")).toBe("b");
  });

  it("stays put at an edge, and for a box it doesn't know", () => {
    expect(nearestBox(grid, "a", "up")).toBeUndefined();
    expect(nearestBox(grid, "a", "left")).toBeUndefined();
    expect(nearestBox(grid, "f", "down")).toBeUndefined();
    expect(nearestBox(grid, "c", "right")).toBeUndefined();
    expect(nearestBox(grid, "nope", "right")).toBeUndefined();
  });

  it("prefers a box straight ahead to a nearer one off to the side", () => {
    // `near` is 20px to the right but 60px below; `ahead` is 100px to the right, level.
    const boxes = [box("from", 0, 0), box("near", 120, 100), box("ahead", 200, 0)];
    expect(nearestBox(boxes, "from", "right")).toBe("ahead");
    // Off to the side, but much nearer: 10px right and 5px below the bottom edge.
    const close = [box("from", 0, 0), box("near", 110, 45), box("far", 600, 0)];
    expect(nearestBox(close, "from", "right")).toBe("near");
  });

  it("breaks ties by the offset from the center line, then by order", () => {
    // Both overlap `from`'s rows, so both score their gap alone; `level` is centered.
    const boxes = [box("from", 0, 0), box("low", 150, 30), box("level", 150, 10)];
    expect(nearestBox(boxes, "from", "right")).toBe("level");
    const twins = [box("from", 0, 0), box("first", 150, -20), box("second", 150, 20)];
    expect(nearestBox(twins, "from", "right")).toBe("first");
  });

  it("moves between neighbors, not into or out of the frame around them", () => {
    // An open frame holding two children, and a sibling frame to its right.
    const boxes = [
      box("frame", 0, 0, 400, 200),
      box("child1", 20, 60),
      box("child2", 200, 60),
      box("other", 460, 0, 200, 200),
    ];
    expect(nearestBox(boxes, "child1", "right")).toBe("child2");
    // Past the last child, the frame next door, not the frame it's drawn in.
    expect(nearestBox(boxes, "child2", "right")).toBe("other");
    expect(nearestBox(boxes, "child1", "left")).toBeUndefined();
    // From the frame, its own children aren't "to the right" of it.
    expect(nearestBox(boxes, "frame", "right")).toBe("other");
    expect(nearestBox(boxes, "other", "left")).toBe("frame");
  });

  it("counts boxes touching within a pixel as beyond", () => {
    const boxes = [box("from", 0, 0), box("touching", 99.5, 0)];
    expect(nearestBox(boxes, "from", "right")).toBe("touching");
  });
});

describe("selectionAnnouncement", () => {
  const index = buildHierarchy(shopDemo());

  it("names the node, then what it calls and what calls it (UX.md)", () => {
    expect(selectionAnnouncement(index, "symbol:web/lib/orders.ts#placeOrder")).toBe(
      "placeOrder, function. Calls POST /api/orders. Called by Checkout.",
    );
    expect(selectionAnnouncement(index, "datastore:infra/db")).toBe(
      "db, datastore. Called by Order.",
    );
  });

  it("says just the name for a node with no connections", () => {
    expect(selectionAnnouncement(index, index.root.id)).toBe(`${nodeAccessibleName(index.root)}.`);
  });

  it("leaves out the kinds hidden on the canvas", () => {
    const db = "datastore:infra/db";
    expect(selectionAnnouncement(index, db, new Set(["stores"]))).toBe("db, datastore.");
  });

  it("names each end once", () => {
    const graph = shopDemo();
    const charge = graph.edges.find((e) => e.kind === "calls" && e.to.endsWith("#chargeOrder"));
    if (!charge) throw new Error("demo graph changed");
    // The same call twice more, from other lines.
    const twice = [1, 2].map((i) => ({ ...charge, id: `${charge.id}:${i}` }));
    const said = selectionAnnouncement(
      buildHierarchy({ ...graph, edges: [...graph.edges, ...twice] }),
      charge.from,
    );
    expect(said.match(/chargeOrder/g)).toHaveLength(1);
  });

  it("names the first few ends and counts the rest", () => {
    // The datastore's caller, Order, and as many models again plus three.
    const index2 = buildHierarchy(withCallers(shopDemo(), ANNOUNCED_ENDS + 3));
    const said = selectionAnnouncement(index2, "datastore:infra/db");
    expect(said).toMatch(
      new RegExp(`^db, datastore\\. Called by (\\w+, ){${ANNOUNCED_ENDS - 1}}\\w+ and 4 more\\.$`),
    );
  });
});

/** The demo graph with `n` more models stored in its datastore (each a distinct caller of `db`). */
function withCallers(graph: ArchitectureGraph, n: number): ArchitectureGraph {
  const order = graph.nodes.find((x) => x.kind === "model");
  const stores = graph.edges.find((e) => e.kind === "stores");
  if (!order || !stores) throw new Error("demo graph changed");
  const models = Array.from({ length: n }, (_, i) => ({
    ...order,
    id: `${order.id}${i}`,
    label: `Model${i}`,
  }));
  return {
    ...graph,
    nodes: [...graph.nodes, ...models],
    edges: [
      ...graph.edges,
      ...models.map((m) => ({ ...stores, id: `stores:${m.id}->${stores.to}`, from: m.id })),
    ],
  };
}
