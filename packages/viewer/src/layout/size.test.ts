// @vitest-environment node
import type { GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { textWidth } from "../image/markup.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView, type ViewEdge } from "../model/view.js";
import { countText } from "../nodes/describe.js";
import { shopDemo } from "../prototype/shopDemo.testkit.js";
import {
  closedSize,
  countsRowWidth,
  EDGE_LABEL_HEIGHT,
  edgeLabelSize,
  FRAME_COUNTS_INSET,
  FRAME_HEADER,
  frameCounts,
  MAX_CARD_WIDTH,
  MAX_EDGE_LABEL_WIDTH,
  MAX_FRAME_WIDTH,
  MAX_ICON_WIDTH,
  MIN_CARD_WIDTH,
  MIN_FRAME_WIDTH,
  MIN_ICON_WIDTH,
  openHeader,
  viewNodeSize,
  WINDOW_BAND,
} from "./size.js";

const index = buildHierarchy(shopDemo());
const node = (id: string): GraphNode => {
  const n = index.byId.get(id);
  if (!n) throw new Error(`no ${id} in shop-demo`);
  return n;
};
/** The node with this ID, which must be of `kind`. */
function ofKind<K extends GraphNode["kind"]>(id: string, kind: K): Extract<GraphNode, { kind: K }> {
  const n = node(id);
  if (n.kind !== kind) throw new Error(`${id} isn't a ${kind}`);
  return n as Extract<GraphNode, { kind: K }>;
}

const route = (path: string): GraphNode => ({
  ...ofKind("route:api/POST /api/orders", "route"),
  id: `route:api/POST ${path}`,
  label: `POST ${path}`,
  path,
});
const file = (label: string): GraphNode => ({ ...node("file:api/src/db.ts"), label });

describe("frameCounts", () => {
  it("counts pages, routes, models, and unresolved calls anywhere inside", () => {
    expect(frameCounts(index, "service:web/")).toEqual([
      { value: 3, noun: "page" },
      { value: 1, noun: "unresolved call", unresolved: true },
    ]);
    expect(frameCounts(index, "service:api/")).toEqual([
      { value: 2, noun: "route" },
      { value: 1, noun: "model" },
    ]);
    expect(frameCounts(index, "file:api/src/db.ts")).toEqual([]);
  });
});

describe("closedSize", () => {
  it("keeps short names at the floor of their tier", () => {
    expect(closedSize(file("db.ts")).width).toBe(MIN_CARD_WIDTH);
    expect(closedSize(node("datastore:infra/db")).width).toBe(MIN_ICON_WIDTH);
    expect(closedSize(node("service:api/"), { counts: [] }).width).toBe(MIN_FRAME_WIDTH);
  });

  it("grows a card with its name, up to the ceiling", () => {
    const short = closedSize(route("/api/orders")).width;
    const long = closedSize(route("/api/orders/:orderId/items/:itemId")).width;
    expect(long).toBeGreaterThan(short);
    // The path is mono at 95% of 13px; the box holds it with the chip, tile, and padding.
    expect(long).toBeGreaterThan(textWidth("/api/orders/:orderId/items/:itemId", 13 * 0.95, true));
    expect(closedSize(route(`/api/${"segment/".repeat(20)}`)).width).toBe(MAX_CARD_WIDTH);
  });

  it("gives a route room for its method chip and the capsule's round ends", () => {
    const path = "/api/orders/:orderId/items";
    const capsule = closedSize(route(path));
    const card = closedSize({
      ...node("symbol:api/src/orders/handlers.ts#createOrder"),
      label: path,
    });
    expect(capsule.height).toBe(52);
    // The chip (POST, 12px of padding and borders) and its 6px gap, plus 8px more inset.
    const extra = textWidth("POST", 11, true) + 12 + 6 + 8;
    expect(Math.abs(capsule.width - card.width - extra)).toBeLessThanOrEqual(1);
  });

  it("widens a table to show its fields", () => {
    const model = node("model:api/Order");
    if (model.kind !== "model") throw new Error("expected a model");
    const few = closedSize(model);
    const many = closedSize({
      ...model,
      fields: ["id", "customerEmail", "shippingAddress", "billingAddress", "createdAt"].map(
        (name) => ({ name, type: "String", optional: false }),
      ),
    });
    expect(few.height).toBe(80);
    expect(many.width).toBeGreaterThan(few.width);
  });

  it("adds the window band to pages and frontend services", () => {
    expect(closedSize(node("page:web//checkout")).height).toBe(52 + WINDOW_BAND.card);
    const counts = frameCounts(index, "service:web/");
    expect(closedSize(node("service:web/"), { counts }).height).toBe(94 + WINDOW_BAND.frame);
    expect(closedSize(node("service:api/"), { counts: [] }).height).toBe(62);
  });

  it("grows a frame with its name up to the ceiling, and past it only for badges", () => {
    const service = node("service:api/");
    const named = (label: string) => closedSize({ ...service, label }, { counts: [] }).width;
    expect(named("@acme/an-unusually-long-service-name")).toBeGreaterThan(MIN_FRAME_WIDTH);
    expect(named(`@acme/${"x".repeat(200)}`)).toBe(MAX_FRAME_WIDTH);
    const counts = [
      { value: 1204, noun: "page" },
      { value: 3301, noun: "route" },
      { value: 512, noun: "model" },
      { value: 98, noun: "unresolved call", unresolved: true },
    ];
    const width = closedSize(service, { counts }).width;
    expect(width).toBe(countsRowWidth(counts));
    expect(width).toBeGreaterThan(MAX_FRAME_WIDTH);
    expect(width).toBeGreaterThan(
      FRAME_COUNTS_INSET + counts.reduce((w, c) => w + textWidth(countText(c), 12), 0),
    );
  });

  it("grows an icon-first node with a long host, up to the ceiling", () => {
    const stripe = ofKind("external:ext/api.stripe.com", "external");
    const host = (h: string) => closedSize({ ...stripe, label: h, host: h }).width;
    expect(host("api.example-payments-provider.io")).toBeGreaterThan(MIN_ICON_WIDTH);
    expect(host(`${"very-long-".repeat(10)}.example.com`)).toBe(MAX_ICON_WIDTH);
    expect(closedSize(stripe).height).toBe(128);
  });

  it("measures a view node with its service's layer and its badges", () => {
    const view = buildView(index, []);
    const web = view.byId.get("service:web/");
    if (!web) throw new Error("web isn't visible");
    expect(viewNodeSize(index, web)).toEqual(
      closedSize(web.node, { counts: frameCounts(index, "service:web/") }),
    );
  });
});

describe("openHeader", () => {
  it("is the frame header, plus the band for a window", () => {
    expect(openHeader(node("service:api/"))).toBe(FRAME_HEADER);
    expect(openHeader(node("service:web/"))).toBe(FRAME_HEADER + WINDOW_BAND.frame);
    expect(openHeader(node("module:api/src"), "backend")).toBe(FRAME_HEADER);
  });

  it("is a card's own row for an opened file", () => {
    expect(openHeader(node("file:api/src/db.ts"))).toBe(52);
  });
});

describe("edgeLabelSize", () => {
  const view = buildView(index, ["service:web/", "service:api/"]);
  const edge = (kind: string): ViewEdge => {
    const found = view.edges.find((e) => e.kind === kind && e.confidence !== "unresolved");
    if (!found) throw new Error(`no ${kind} edge`);
    return found;
  };

  it("fits the label's words in a pill", () => {
    const http = edgeLabelSize(edge("http"));
    expect(http.height).toBe(EDGE_LABEL_HEIGHT);
    expect(http.width).toBeGreaterThan(textWidth("/api/orders", 12, true) + textWidth("HTTP", 12));
    expect(edgeLabelSize(edge("renders")).width).toBeLessThan(http.width);
  });

  it("caps a long label at the pill's maximum", () => {
    const http = edge("http");
    const [first] = http.edges;
    if (!first) throw new Error("empty view edge");
    const long = { ...first, label: `GET /${"segment/".repeat(40)}` };
    expect(edgeLabelSize({ ...http, edges: [long] }).width).toBe(MAX_EDGE_LABEL_WIDTH);
  });
});
