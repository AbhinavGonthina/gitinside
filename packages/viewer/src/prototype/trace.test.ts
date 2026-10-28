// @vitest-environment node
import { describe, expect, it } from "vitest";
import { indexGraph } from "./model.js";
import { shopDemo } from "./shopDemo.testkit.js";
import { CHECKOUT_TRACE, checkTrace, traceNodes } from "./trace.js";

const index = indexGraph(shopDemo());

describe("the scripted checkout trace", () => {
  it("names only real edges, each continuing the path from the page", () => {
    const steps = checkTrace(index, CHECKOUT_TRACE);
    expect(steps.map((s) => s.title)).toEqual([
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
    expect(steps.map((s) => s.site && `${s.site.file}:${s.site.line}`)).toEqual([
      "apps/web/app/checkout/page.tsx:5",
      "apps/web/app/checkout/page.tsx:6",
      "apps/web/lib/orders.ts:5",
      "apps/api/src/routes/orders.ts:7",
      "apps/api/src/orders/handlers.ts:11",
      "apps/api/prisma/schema.prisma:1",
      "apps/api/src/orders/handlers.ts:14",
      "apps/api/src/billing/stripe.ts:6",
    ]);
    expect(steps[2]?.edge.confidence).toBe("heuristic");
  });

  it("collects every node on the path", () => {
    const nodes = traceNodes(checkTrace(index, CHECKOUT_TRACE), CHECKOUT_TRACE.start);
    expect(nodes.size).toBe(9);
    expect(nodes.has("datastore:infra/db")).toBe(true);
    expect(nodes.has("external:ext/api.stripe.com")).toBe(true);
    expect(nodes.has("route:api/GET /api/orders")).toBe(false);
  });

  it("rejects a missing edge, a hop that skips ahead, and an unknown start", () => {
    const [first, ...rest] = CHECKOUT_TRACE.hops;
    expect(() => checkTrace(index, { ...CHECKOUT_TRACE, hops: ["calls:a->b"] })).toThrow(
      /missing edge/,
    );
    expect(() => checkTrace(index, { ...CHECKOUT_TRACE, hops: rest })).toThrow(/doesn't continue/);
    expect(() => checkTrace(index, { start: "page:web//nope", hops: [first ?? ""] })).toThrow(
      /unknown node/,
    );
  });
});
