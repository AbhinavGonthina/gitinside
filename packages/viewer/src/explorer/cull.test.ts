import { describe, expect, it } from "vitest";
import type { LayoutResult } from "../layout/elk.js";
import { bounds, cull, CULL_FROM, CULL_TILE, cullWindow, intersects } from "./cull.js";

/** A grid of `count` 100×40 boxes, 10 a row, 200px apart, each joined to the next by a straight line. */
function grid(count: number): Pick<LayoutResult, "boxes" | "edges"> {
  const at = (i: number) => ({ x: (i % 10) * 200, y: Math.floor(i / 10) * 200 });
  const boxes = Array.from({ length: count }, (_, i) => ({
    id: `b${i}`,
    ...at(i),
    width: 100,
    height: 40,
  }));
  const edges = boxes.slice(1).map((b, i) => {
    const a = at(i);
    return {
      id: `e${i}`,
      points: [
        { x: a.x + 100, y: a.y + 20 },
        { x: b.x, y: b.y + 20 },
      ],
      label: { x: (a.x + 100 + b.x) / 2, y: (a.y + b.y) / 2 + 20 },
    };
  });
  return { boxes, edges };
}

describe("intersects", () => {
  it("is true for overlapping, touching, and nested rects, false for apart ones", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    expect(intersects(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(true);
    expect(intersects(a, { x: 100, y: 0, width: 10, height: 10 })).toBe(true);
    expect(intersects(a, { x: 10, y: 10, width: 10, height: 10 })).toBe(true);
    expect(intersects({ x: 10, y: 10, width: 10, height: 10 }, a)).toBe(true);
    expect(intersects(a, { x: 101, y: 0, width: 10, height: 10 })).toBe(false);
    expect(intersects(a, { x: 0, y: -11, width: 10, height: 10 })).toBe(false);
  });
});

describe("bounds", () => {
  it("holds every point of a route", () => {
    expect(
      bounds([
        { x: 10, y: 50 },
        { x: -5, y: 20 },
        { x: 30, y: 70 },
      ]),
    ).toEqual({ x: -5, y: 20, width: 35, height: 50 });
    expect(bounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("cullWindow", () => {
  it("grows the visible rect by half its size each side and snaps outward to tiles", () => {
    const visible = { x: 1000, y: 600, width: 1000, height: 800 };
    const w = cullWindow(visible);
    expect(w).toEqual({ x: 0, y: 0, width: 2560, height: 2048 });
    for (const n of [w.x, w.y, w.width, w.height]) expect(n % CULL_TILE).toBe(0);
    expect(w.x).toBeLessThanOrEqual(visible.x - visible.width / 2);
    expect(w.y + w.height).toBeGreaterThanOrEqual(visible.y + visible.height * 1.5);
  });

  it("gives the same window for small pans inside a tile, so the drawn set doesn't change each frame", () => {
    const at = (x: number) => cullWindow({ x, y: 300, width: 1000, height: 800 });
    expect(at(1100)).toEqual(at(1110));
    expect(at(1100)).toEqual(at(1500));
    expect(at(1100)).not.toEqual(at(1600));
  });
});

describe("cull", () => {
  const big = grid(500);
  const window = { x: 0, y: 0, width: 1000, height: 1000 };

  it("draws everything below the threshold or without a window", () => {
    const small = grid(20);
    const c = cull(small, window);
    expect(c.boxes.size).toBe(20);
    expect(c.edges.size).toBe(19);
    expect(big.boxes.length + big.edges.length).toBeGreaterThanOrEqual(CULL_FROM);
    expect(cull(big, undefined).boxes.size).toBe(500);
  });

  it("draws only the boxes and lines overlapping the window on a big level", () => {
    const c = cull(big, window);
    // Columns and rows 0–5 (x and y ≤ 1000; touching counts).
    expect(c.boxes.size).toBe(36);
    expect(c.boxes.has("b0")).toBe(true);
    expect(c.boxes.has("b45")).toBe(true);
    expect(c.boxes.has("b6")).toBe(false);
    expect(c.boxes.has("b60")).toBe(false);
    expect(c.boxes.has("b499")).toBe(false);
    expect(c.edges.has("e0")).toBe(true);
    expect(c.edges.has("e498")).toBe(false);
    expect(c.edges.size).toBeLessThan(60);
  });

  it("draws a frame that holds the whole window", () => {
    const frame = { id: "frame", x: -5000, y: -5000, width: 20000, height: 20000 };
    const c = cull({ boxes: [frame, ...big.boxes], edges: big.edges }, window);
    expect(c.boxes.has("frame")).toBe(true);
  });

  it("always draws kept boxes, wherever they are", () => {
    const c = cull(big, window, new Set(["b499"]));
    expect(c.boxes.has("b499")).toBe(true);
    expect(c.boxes.size).toBe(37);
  });

  it("draws a box gliding out of the window from where its glide starts", () => {
    const from = new Map([["b499", { x: 100, y: 100, width: 100, height: 40 }]]);
    expect(cull(big, window, new Set(), from).boxes.has("b499")).toBe(true);
  });

  it("draws a line passing through the window though both its ends are outside", () => {
    const across = {
      id: "across",
      points: [
        { x: -500, y: 500 },
        { x: 5000, y: 500 },
      ],
      label: { x: 3000, y: 500 },
    };
    const c = cull({ boxes: big.boxes, edges: [...big.edges, across] }, window);
    expect(c.edges.has("across")).toBe(true);
  });
});
