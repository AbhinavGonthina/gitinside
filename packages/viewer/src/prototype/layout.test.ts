// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Rect } from "../chrome/describe.js";
import {
  CHILD_GAP,
  FRAME_HEADER,
  FRAME_PAD,
  fitScale,
  layout,
  nodeSize,
  PAD,
  PARALLEL_GAP,
  pointAlong,
  route,
} from "./layout.js";
import { indexGraph, liftEdges, visibleIds } from "./model.js";
import { shopDemo } from "./shopDemo.testkit.js";

const index = indexGraph(shopDemo());
const laidOut = (open: string | null) =>
  layout(index, open, liftEdges(index, visibleIds(index, open)));

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

describe("layout", () => {
  it("is deterministic", () => {
    expect(JSON.stringify([...laidOut("service:api/").boxes])).toBe(
      JSON.stringify([...laidOut("service:api/").boxes]),
    );
  });

  it("reads left to right by layer: web, then api, then data and Stripe", () => {
    const { boxes, width, height } = laidOut(null);
    const x = (id: string) => boxes.get(id)?.x ?? NaN;
    expect(x("service:web/")).toBe(PAD);
    expect(x("service:api/")).toBeGreaterThan(x("service:web/"));
    expect(x("datastore:infra/db")).toBeGreaterThan(x("service:api/"));
    expect(x("external:ext/api.stripe.com")).toBe(x("datastore:infra/db"));
    for (const b of boxes.values()) {
      expect(b.x + b.width).toBeLessThanOrEqual(width - PAD);
      expect(b.y + b.height).toBeLessThanOrEqual(height - PAD);
    }
  });

  it("never overlaps top-level boxes, and keeps children inside the open frame", () => {
    for (const open of [null, "service:api/", "service:web/"]) {
      const { boxes } = laidOut(open);
      const top = (index.children.get("system:root") ?? []).map((n) => boxes.get(n.id) as Rect);
      for (const [i, a] of top.entries()) {
        for (const b of top.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
      }
      if (!open) continue;
      const frame = boxes.get(open) as Rect;
      const children = (index.children.get(open) ?? []).map((n) => boxes.get(n.id) as Rect);
      expect(children[0]?.y).toBe(frame.y + FRAME_HEADER);
      for (const c of children) expect(inside(c, frame)).toBe(true);
      for (const [i, c] of children.slice(1).entries()) {
        const above = children[i] as Rect;
        expect(c.y - (above.y + above.height)).toBe(CHILD_GAP);
      }
      expect(frame.width).toBe(nodeSize(index, open).width + 2 * FRAME_PAD);
    }
  });

  it("sizes nodes by tier, giving frames with counts a second row", () => {
    expect(nodeSize(index, "service:web/")).toEqual({ width: 248, height: 94 });
    expect(nodeSize(index, "module:web/lib")).toEqual({ width: 248, height: 62 });
    expect(nodeSize(index, "datastore:infra/db")).toEqual({ width: 136, height: 112 });
    expect(nodeSize(index, "unresolved:web/lib/cms.ts:3:21")).toEqual({ width: 232, height: 52 });
  });

  it("routes an edge to each visible edge, spreading parallel ones with their labels", () => {
    const { edges } = laidOut("service:api/");
    expect(edges).toHaveLength(5);
    const reads = edges.find((e) => e.view.kind === "reads");
    const writes = edges.find((e) => e.view.kind === "writes");
    expect(Math.abs((reads?.points[0]?.x ?? 0) - (writes?.points[0]?.x ?? 0))).toBe(PARALLEL_GAP);
    expect(reads?.label.y).not.toBe(writes?.label.y);
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

  it("runs vertically between stacked boxes, up or down, offset for parallel edges", () => {
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

describe("pointAlong and fitScale", () => {
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

  it("fits the diagram in the canvas, between 40% and 100%", () => {
    expect(fitScale({ width: 1000, height: 500 }, { width: 0, height: 0 })).toBe(1);
    expect(fitScale({ width: 500, height: 300 }, { width: 2000, height: 2000 })).toBe(1);
    expect(fitScale({ width: 1048, height: 400 }, { width: 1000, height: 900 })).toBe(0.9);
    expect(fitScale({ width: 10000, height: 400 }, { width: 1000, height: 900 })).toBe(0.4);
  });
});
