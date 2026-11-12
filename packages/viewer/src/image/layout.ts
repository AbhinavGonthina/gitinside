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
  /** No spot on the line kept its label clear of the others, so it's left off ({@link spreadLabels}). */
  hideLabel?: boolean;
}

/** A label pill's height (`labelMarkup`). */
export const LABEL_HEIGHT = 19;
/** Room kept between two pills, and between a pill and a box. */
export const LABEL_GAP = 4;
/** How far from either end of its line a pill's center stays, clear of the arrowhead. */
const LABEL_END = 12;
/** Most spots tried per line, so a busy image stays quick to draw. */
const LABEL_TRIES = 81;

/** The pill of `width` px centered on `at`. */
export function pillRect(at: Point, width: number): Rect {
  return { x: at.x - width / 2, y: at.y - LABEL_HEIGHT / 2, width, height: LABEL_HEIGHT };
}

/** Whether two rects come within `gap` px of each other. */
function near(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap &&
    b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap &&
    b.y < a.y + a.height + gap
  );
}

/** A polyline's length: its segments' lengths summed. */
function polylineLength(points: readonly Point[]): number {
  return points
    .slice(1)
    .reduce(
      (sum, b, i) => sum + Math.hypot(b.x - (points[i] as Point).x, b.y - (points[i] as Point).y),
      0,
    );
}

/** How far along a polyline (by length) the point on it nearest `at` is. */
function lengthAt(points: readonly Point[], at: Point): number {
  let best = Infinity;
  let bestLength = 0;
  let walked = 0;
  for (const [i, b] of points.slice(1).entries()) {
    const a = points[i] as Point;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const f =
      length > 0
        ? Math.min(
            Math.max(((at.x - a.x) * (b.x - a.x) + (at.y - a.y) * (b.y - a.y)) / length ** 2, 0),
            1,
          )
        : 0;
    const d = Math.hypot(a.x + (b.x - a.x) * f - at.x, a.y + (b.y - a.y) * f - at.y);
    if (d < best) {
      best = d;
      bestLength = walked + f * length;
    }
    walked += length;
  }
  return bestLength;
}

/**
 * Keeps line labels from covering each other or a box (M9.3d): in order,
 * each pill (`widths[i]` px for `edges[i]`) stays where routing put it when
 * that spot is clear ({@link LABEL_GAP}), else slides along its own line,
 * nearest spots first, to the first clear one. A line with no clear spot
 * keeps its line but loses its label (`hideLabel`), and the caller says how
 * many were left off. Earlier lines win, so the order is the caller's
 * (graph order for the README image) and the result is deterministic.
 *
 * Not handled: a pill isn't kept off other lines, so on a shared stretch it
 * can sit on a neighbor's line (the canvas's ELK layout keeps lines apart;
 * the image's arithmetic routing doesn't).
 */
export function spreadLabels(
  edges: readonly PlacedEdge[],
  widths: readonly number[],
  boxes: readonly Rect[],
): PlacedEdge[] {
  const taken: Rect[] = [];
  const clear = (r: Rect) =>
    !taken.some((t) => near(r, t, LABEL_GAP)) && !boxes.some((b) => near(r, b, LABEL_GAP));
  return edges.map((p, i) => {
    const width = widths[i] ?? 0;
    // Summed, not `lengthAt` its end: a line that passes its end point
    // earlier would measure short there (M9.7f).
    const total = polylineLength(p.points);
    const start = lengthAt(p.points, p.label);
    const room = total - 2 * LABEL_END;
    const step = Math.max(6, room / (LABEL_TRIES - 1));
    const spots = [p.label];
    for (let k = 1; k < LABEL_TRIES; k++) {
      const s = start + Math.ceil(k / 2) * step * (k % 2 === 1 ? 1 : -1);
      if (s >= LABEL_END && s <= total - LABEL_END && total > 0)
        spots.push(pointAlong(p.points, s / total));
    }
    const spot = spots.find((at) => clear(pillRect(at, width)));
    if (!spot) return { ...p, hideLabel: true };
    taken.push(pillRect(spot, width));
    return spot === p.label ? p : { ...p, label: spot };
  });
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
