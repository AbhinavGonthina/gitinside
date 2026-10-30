// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Rect } from "../chrome/describe.js";
import { countsRowWidth, frameCounts, MIN_FRAME_WIDTH, WINDOW_BAND } from "../layout/size.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { imageNodeSize, PARALLEL_GAP, pointAlong, route, routeEdges } from "./layout.js";

const index = buildHierarchy(shopDemo());

describe("imageNodeSize", () => {
  it("sizes nodes by tier, giving frames with counts a second row", () => {
    expect(imageNodeSize(index, "service:api/")).toEqual({ width: 248, height: 94 });
    expect(imageNodeSize(index, "module:web/lib")).toEqual({ width: 248, height: 62 });
    expect(imageNodeSize(index, "datastore:infra/db")).toEqual({ width: 136, height: 128 });
    expect(imageNodeSize(index, "unresolved:web/lib/cms.ts:3:21")).toEqual({
      width: 232,
      height: 52,
    });
  });

  it("adds a window's title band and a table's fields row to the box (design gate)", () => {
    const pages = [...index.byId.values()].filter((n) => n.kind === "page");
    const models = [...index.byId.values()].filter((n) => n.kind === "model");
    expect(pages.length).toBeGreaterThan(0);
    expect(models.length).toBeGreaterThan(0);
    for (const p of pages) expect(imageNodeSize(index, p.id).height).toBe(52 + WINDOW_BAND.card);
    for (const m of models) expect(imageNodeSize(index, m.id).height).toBe(80);
  });

  it("widens a closed frame until its count badges fit on one row", () => {
    // `@shop/web` has "3 pages" and "1 unresolved call": they wrapped out of a 248px frame (design gate).
    const counts = frameCounts(index, "service:web/");
    const { width, height } = imageNodeSize(index, "service:web/");
    expect(height).toBe(94 + WINDOW_BAND.frame);
    expect(width).toBeGreaterThan(248);
    expect(width).toBe(Math.max(MIN_FRAME_WIDTH, countsRowWidth(counts)));
  });
});

describe("routeEdges", () => {
  it("spreads parallel lines between one pair, with their labels", () => {
    const { edges } = buildView(index, ["service:api/"]);
    const reads = edges.filter((e) => e.kind === "reads" || e.kind === "writes");
    const [a, b] = reads;
    expect(a?.from).toBe(b?.from);
    const boxes = new Map<string, Rect>([
      [a?.from ?? "", { x: 0, y: 0, width: 100, height: 100 }],
      [a?.to ?? "", { x: 300, y: 0, width: 100, height: 100 }],
    ]);
    const [p, q] = routeEdges(reads, boxes);
    expect(Math.abs((p?.points[0]?.y ?? 0) - (q?.points[0]?.y ?? 0))).toBe(PARALLEL_GAP);
    expect(p?.label.x).not.toBe(q?.label.x);
  });

  it("skips an edge whose box isn't placed", () => {
    const { edges } = buildView(index, []);
    expect(routeEdges(edges, new Map())).toEqual([]);
  });
});

describe("route", () => {
  const a: Rect = { x: 0, y: 0, width: 100, height: 40 };

  it("goes straight across between level boxes, from either side", () => {
    expect(route(a, { x: 200, y: 0, width: 100, height: 40 })).toEqual([
      { x: 100, y: 20 },
      { x: 200, y: 20 },
    ]);
    expect(route({ x: 200, y: 0, width: 100, height: 40 }, a)).toEqual([
      { x: 200, y: 20 },
      { x: 100, y: 20 },
    ]);
  });

  it("bends once, halfway, when side-by-side boxes aren't level", () => {
    expect(route(a, { x: 200, y: 100, width: 100, height: 40 })).toEqual([
      { x: 100, y: 20 },
      { x: 150, y: 20 },
      { x: 150, y: 120 },
      { x: 200, y: 120 },
    ]);
  });

  it("runs vertically between stacked boxes, up or down, offset for parallel lines", () => {
    const below: Rect = { x: 0, y: 100, width: 100, height: 40 };
    expect(route(a, below)).toEqual([
      { x: 50, y: 40 },
      { x: 50, y: 100 },
    ]);
    expect(route(below, a, 9)).toEqual([
      { x: 59, y: 100 },
      { x: 59, y: 40 },
    ]);
    expect(route(a, { x: 40, y: 100, width: 100, height: 40 })).toEqual([
      { x: 50, y: 40 },
      { x: 50, y: 70 },
      { x: 90, y: 70 },
      { x: 90, y: 100 },
    ]);
  });
});

describe("pointAlong", () => {
  it("finds a point by length along a polyline, clamped to its ends", () => {
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 30 },
    ];
    expect(pointAlong(line, 0.5)).toEqual({ x: 10, y: 10 });
    expect(pointAlong(line, 0.125)).toEqual({ x: 5, y: 0 });
    expect(pointAlong(line, 2)).toEqual({ x: 10, y: 30 });
    expect(pointAlong([{ x: 3, y: 4 }], 0.5)).toEqual({ x: 3, y: 4 });
    expect(() => pointAlong([], 0.5)).toThrow();
  });
});
