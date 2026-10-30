// @vitest-environment node
import type { EdgeKind } from "@gitinside/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { connectionsOf } from "../model/connections.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { connectionSentences, listText, namesText, summaryOf } from "./summary.js";

const index = buildHierarchy(shopDemo());

/** A node's summary as text, with `<code>` marked by backticks. */
function summary(id: string): string {
  const node = index.byId.get(id);
  if (!node) throw new Error(`no node ${id}`);
  return renderToStaticMarkup(<>{summaryOf(index, node)}</>)
    .replace(/<\/?code>/g, "`")
    .replace(/&#x27;/g, "'");
}

describe("summaryOf", () => {
  it("leads with the kind's own facts, for every kind", () => {
    expect(summary("system:root")).toBe(
      "2 services, 1 datastore and 1 outside API, with 3 pages, 2 routes, 1 model and 1 unresolved call inside.",
    );
    expect(summary("service:api/")).toMatch(
      /^Express service in `apps\/api` with 2 routes and 1 model\./,
    );
    expect(summary("module:web/app")).toMatch(/^Folder `apps\/web\/app` with 3 pages\./);
    expect(summary("file:api/src/routes/orders.ts")).toMatch(/^File with 2 routes\./);
    expect(summary("route:api/POST /api/orders")).toMatch(
      /^Handles `POST \/api\/orders` requests\./,
    );
    expect(summary("page:web//checkout")).toMatch(/^Page at `\/checkout`\./);
    expect(summary("model:api/Order")).toMatch(/^Model with 4 fields\./);
    // The engine by the name the node's subtitle uses.
    expect(summary("datastore:infra/db")).toMatch(/^Datastore running PostgreSQL\./);
    expect(summary("external:ext/api.stripe.com")).toMatch(/^Outside API at `api\.stripe\.com`\./);
    expect(summary("symbol:api/src/orders/handlers.ts#createOrder")).toMatch(
      /^Exported function, called with at least 2 arguments\./,
    );
  });

  it("says what a node does and what uses it, in the order a request flows", () => {
    expect(summary("route:api/POST /api/orders")).toBe(
      "Handles `POST /api/orders` requests. Runs createOrder. Requested by placeOrder in @shop/web.",
    );
    expect(summary("symbol:api/src/orders/handlers.ts#createOrder")).toBe(
      "Exported function, called with at least 2 arguments. Calls chargeOrder. Writes Order. Handles POST /api/orders.",
    );
    expect(summary("model:api/Order")).toBe(
      "Model with 4 fields. Stored in db. Read by listOrders. Written by createOrder.",
    );
    expect(summary("datastore:infra/db")).toBe(
      "Datastore running PostgreSQL. Holds Order in @shop/api.",
    );
    expect(summary("page:web//checkout")).toBe("Page at `/checkout`. Renders Checkout.");
  });

  it("names another service's nodes with their service, grouped", () => {
    expect(summary("service:api/")).toContain(
      "Requested by listOrders and placeOrder in @shop/web.",
    );
    // The web app's listOrders requests the API; the API's own listOrders isn't named with a service.
    expect(summary("symbol:web/lib/orders.ts#listOrders")).toContain(
      "Requests GET /api/orders in @shop/api.",
    );
    expect(summary("module:web/lib")).toContain(
      "Requests GET {env:CMS_URL}/posts, plus GET /api/orders and POST /api/orders in @shop/api.",
    );
  });

  it("says a frame keeps data in a datastore, and a model is stored there", () => {
    expect(summary("module:api/prisma")).toContain("Keeps data in db.");
    expect(summary("model:api/Order")).toContain("Stored in db.");
  });

  it("skips an argument count of zero and says when nothing connects", () => {
    expect(summary("symbol:web/app/checkout/page.tsx#Checkout")).toBe(
      "Exported function. Calls placeOrder. Rendered by /checkout.",
    );
    expect(summary("symbol:api/src/db.ts#prisma")).toBe(
      "Exported value. Nothing else in the repo connects to it.",
    );
  });

  it("explains an unresolved call from its reason, capitalized, and what made it", () => {
    expect(summary("unresolved:web/lib/cms.ts:3:21")).toBe(
      "The env var CMS_URL isn't named like an API base URL (*_API_URL, *_BASE_URL), so it can't be linked. It's shown, not dropped. Requested by latestPosts.",
    );
  });
});

describe("connectionSentences", () => {
  it("names each node once per kind and caps the list", () => {
    const node = index.byId.get("module:web/lib");
    if (!node) throw new Error("missing");
    const { incoming } = connectionsOf(index, node.id);
    const verbs: Record<EdgeKind, string> = {
      imports: "imports",
      calls: "calls",
      http: "http",
      handles: "handles",
      renders: "renders",
      reads: "reads",
      writes: "writes",
      stores: "stores",
      publishes: "publishes",
      consumes: "consumes",
      external_call: "external_call",
    };
    expect(connectionSentences(index, node, [...incoming, ...incoming], verbs)).toEqual([
      "calls Checkout, Orders and Home.",
    ]);
    const first = incoming[0];
    if (!first) throw new Error("no incoming connection");
    const many = ["a", "b", "c", "d"].map((label, i) => ({
      edge: { ...first.edge, id: `e${i}` },
      other: { ...first.other, id: `symbol:web/x#${label}`, label },
    }));
    expect(connectionSentences(index, node, many, verbs)).toEqual(["calls a, b, c and 1 more."]);
  });

  it("lists in words", () => {
    expect(listText([])).toBe("");
    expect(listText(["a"])).toBe("a");
    expect(listText(["a", "b"])).toBe("a and b");
    expect(listText(["a", "b", "c"])).toBe("a, b and c");
    expect(namesText(["a", "b", "c"])).toBe("a, b and c");
    expect(namesText(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });
});
