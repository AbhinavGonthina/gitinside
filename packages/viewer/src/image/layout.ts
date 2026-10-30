import type { Rect } from "../chrome/describe.js";
import type { Point } from "../edges/geometry.js";
import { layerOf, nodeOf, type HierarchyIndex } from "../model/hierarchy.js";
import type { ViewEdge } from "../model/view.js";
import { countsRowWidth, frameCounts, MIN_FRAME_WIDTH, WINDOW_BAND } from "../layout/size.js";
import { nodeShape, nodeTier } from "../nodes/describe.js";

/**
 * The README image's box sizes and line routing (M5.9; from the M4a.7
 * prototype, M4b.3b2). The image is fixed arithmetic so the same graph
 * always gives the same bytes: boxes have a size per tier rather than the
 * canvas's measured ones (`layout/size.ts`), and lines leave a box's side
 * facing the other box and bend once, halfway.
 */

/** How far apart parallel lines between the same two boxes run. */
export const PARALLEL_GAP = 18;

/**
 * The box a top-level node takes in the image, by tier and shape. Frames
 * with count badges get a second row, and grow wider when the badges need
 * it, so they never wrap out of the box (design gate, DESIGN_SYSTEM.md
 * §1.1); windows add their title band, and a model's table its fields row.
 */
export function imageNodeSize(
  index: HierarchyIndex,
  id: string,
): { width: number; height: number } {
  const node = nodeOf(index, id);
  const shape = nodeShape(node, layerOf(index, id));
  switch (nodeTier(node)) {
    case "frame": {
      const counts = frameCounts(index, id);
      const band = shape === "window" ? WINDOW_BAND.frame : 0;
      return {
        width: Math.max(MIN_FRAME_WIDTH, countsRowWidth(counts)),
        height: (counts.length > 0 ? 94 : 62) + band,
      };
    }
    case "icon":
      return { width: 136, height: 128 };
    case "card":
      return {
        width: 232,
        height: shape === "table" ? 80 : shape === "window" ? 52 + WINDOW_BAND.card : 52,
      };
  }
}

/** A routed line: the view edge, its route points (source first), and where its label sits. */
export interface PlacedEdge {
  view: ViewEdge;
  points: Point[];
  label: Point;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The point `t` (0–1) of the way along a polyline, by length. Parallel lines
 * put their labels at different `t`, so the pills stack along the lines
 * instead of covering each other.
 */
export function pointAlong(points: readonly Point[], t: number): Point {
  const lengths = points.slice(1).map((p, i) => {
    const q = points[i] as Point;
    return Math.hypot(p.x - q.x, p.y - q.y);
  });
  let left = lengths.reduce((a, b) => a + b, 0) * Math.min(Math.max(t, 0), 1);
  for (const [i, length] of lengths.entries()) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    if (left <= length && length > 0) {
      const f = left / length;
      return { x: round(a.x + (b.x - a.x) * f), y: round(a.y + (b.y - a.y) * f) };
    }
    left -= length;
  }
  const last = points.at(-1);
  if (!last) throw new Error("pointAlong needs at least one point");
  return last;
}

/**
 * Routes every edge between its boxes. Parallel lines between the same pair
 * run {@link PARALLEL_GAP} apart, with labels spread along their length.
 */
export function routeEdges(
  edges: readonly ViewEdge[],
  boxes: ReadonlyMap<string, Rect>,
): PlacedEdge[] {
  const pairs = new Map<string, ViewEdge[]>();
  for (const e of edges) {
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const list = pairs.get(key);
    if (list) list.push(e);
    else pairs.set(key, [e]);
  }
  const out: PlacedEdge[] = [];
  for (const e of edges) {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) continue;
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const group = pairs.get(key) ?? [e];
    const i = group.indexOf(e);
    const offset = (i - (group.length - 1) / 2) * PARALLEL_GAP;
    const points = route(a, b, offset).map((p) => ({ x: round(p.x), y: round(p.y) }));
    out.push({ view: e, points, label: pointAlong(points, (i + 1) / (group.length + 1)) });
  }
  return out;
}

/**
 * Points from box `a` to box `b`: out of the facing sides, one bend halfway
 * when the two aren't level. Side by side ⇒ horizontal; stacked ⇒ vertical.
 * `offset` shifts the line sideways for parallel lines.
 */
export function route(a: Rect, b: Rect, offset = 0): Point[] {
  const acx = a.x + a.width / 2;
  const bcx = b.x + b.width / 2;
  const acy = a.y + a.height / 2 + offset;
  const bcy = b.y + b.height / 2 + offset;
  const horizontal = b.x >= a.x + a.width || b.x + b.width <= a.x;
  if (horizontal) {
    const right = b.x >= a.x + a.width;
    const sx = right ? a.x + a.width : a.x;
    const tx = right ? b.x : b.x + b.width;
    if (Math.abs(acy - bcy) < 1)
      return [
        { x: sx, y: acy },
        { x: tx, y: acy },
      ];
    const mx = (sx + tx) / 2;
    return [
      { x: sx, y: acy },
      { x: mx, y: acy },
      { x: mx, y: bcy },
      { x: tx, y: bcy },
    ];
  }
  const down = b.y >= a.y + a.height;
  const sy = down ? a.y + a.height : a.y;
  const ty = down ? b.y : b.y + b.height;
  const ax = acx + offset;
  const bx = bcx + offset;
  if (Math.abs(ax - bx) < 1)
    return [
      { x: ax, y: sy },
      { x: ax, y: ty },
    ];
  const my = (sy + ty) / 2;
  return [
    { x: ax, y: sy },
    { x: ax, y: my },
    { x: bx, y: my },
    { x: bx, y: ty },
  ];
}
