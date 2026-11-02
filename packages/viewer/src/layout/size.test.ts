// @vitest-environment node
import type { GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { textWidth } from "../image/markup.js";
import type { DiffMarks } from "../model/diff.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView, type ViewEdge } from "../model/view.js";
import { countText } from "../nodes/describe.js";
import { shopDemo } from "../shopDemo.testkit.js";
import {
  changeCounts,
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
  viewNodeCounts,
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

  it("makes room for a diff state's word and dot, or sizes a broken pill by what broke", () => {
    const http = edge("http");
    const plain = edgeLabelSize(http).width;
    // The dot, its gap, the word, and the gap before the label.
    const added = edgeLabelSize(http, { diff: "added" }).width;
    expect(Math.abs(added - plain - (6 + 5 + textWidth("Added", 12) + 6))).toBeLessThanOrEqual(1);
    const detail = "DELETE /api/orders/:id was removed";
    const broken = edgeLabelSize(http, { diff: "removed", broken: detail }).width;
    expect(broken).toBeGreaterThan(textWidth(detail, 12) + 6 + 6);
    expect(edgeLabelSize(http, {}).width).toBe(plain);
  });
});

describe("changeCounts and viewNodeCounts", () => {
  it("lists the changes inside, leaving out zeros", () => {
    expect(changeCounts(undefined)).toEqual([]);
    expect(changeCounts({ added: 2, changed: 0, removed: 1, broken: 3 })).toEqual([
      { value: 2, noun: "added", plural: "added", diff: "added" },
      { value: 1, noun: "removed", plural: "removed", diff: "removed" },
      { value: 3, noun: "broken", plural: "broken", diff: "broken" },
    ]);
  });

  it("adds a closed box's change badges after its counts, and none once it's open", () => {
    const inside = { added: 1, changed: 2, removed: 0, broken: 0 };
    const marks: DiffMarks = { node: () => undefined, inside: () => inside, line: () => ({}) };
    const closed = buildView(index, []).byId.get("service:api/");
    const open = buildView(index, ["service:api/"]).byId.get("service:api/");
    if (!closed || !open) throw new Error("api isn't visible");
    const counts = frameCounts(index, "service:api/");
    expect(viewNodeCounts(index, closed)).toEqual(counts);
    expect(viewNodeCounts(index, closed, marks)).toEqual([...counts, ...changeCounts(inside)]);
    expect(viewNodeCounts(index, open, marks)).toEqual(counts);
    // Each change badge has its dot: wider than the same words without.
    const width = viewNodeSize(index, closed, marks).width;
    const words = changeCounts(inside).map((c) => ({ value: c.value, noun: c.noun }));
    expect(width).toBeGreaterThan(closedSize(closed.node, { counts: [...counts, ...words] }).width);
  });
});
