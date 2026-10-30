// @vitest-environment node
import { describe, expect, it } from "vitest";
import { shopDemo } from "../shopDemo.testkit.js";
import { connectionsOf } from "./connections.js";
import { buildHierarchy } from "./hierarchy.js";

const index = buildHierarchy(shopDemo());

describe("connectionsOf", () => {
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

  it("leaves out imports unless asked, like the canvas", () => {
    const file = "file:web/lib/orders.ts";
    const kinds = (hidden?: ReadonlySet<never>) => {
      const { incoming, outgoing } = connectionsOf(index, file, hidden);
      return [...incoming, ...outgoing].map((c) => c.edge.kind);
    };
    expect(kinds()).not.toContain("imports");
    expect(kinds(new Set())).toContain("imports");
  });
});
