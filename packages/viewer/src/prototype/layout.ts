import type { Layer } from "@gitinside/schema";
import type { Point } from "../edges/geometry.js";
import type { Rect } from "../chrome/describe.js";
import {
  BADGE_CHROME,
  BADGE_GAP,
  COUNTS_SLACK,
  countsRowWidth,
  FRAME_COUNTS_INSET,
  MIN_FRAME_WIDTH,
  WINDOW_BAND,
} from "../layout/size.js";
import { nodeShape, nodeTier } from "../nodes/describe.js";
import { frameCounts, layerOf, nodeOf, type GraphIndex, type ViewEdge } from "./model.js";

/**
 * A fixed, deterministic layout for the prototype (M4a.7): top-level nodes in
 * columns by layer, read left to right as a request travels (frontend →
 * backend → data and outside APIs), and the open node's children stacked
 * inside its frame. Edges leave a box's side facing the other box and bend
 * once, halfway. M4b.2 replaces all of this with ELK; this only has to be
 * stable and readable for one small graph.
 */

/** Space around the diagram. */
export const PAD = 40;
/** Horizontal gap between columns: room for an edge label such as `POST /api/orders · HTTP`. */
export const COLUMN_GAP = 184;
/** Vertical gap between boxes in a column. */
export const ROW_GAP = 48;
/** Vertical gap between children in an open frame: room for two stacked labels between them. */
export const CHILD_GAP = 84;
/** An open frame's header height and inner padding. */
export const FRAME_HEADER = 60;
export const FRAME_PAD = 16;
/** How far apart parallel edges between the same two boxes run. */
export const PARALLEL_GAP = 18;

const COLUMN: Readonly<Record<Layer, number>> = {
  frontend: 0,
  backend: 1,
  data: 2,
  infra: 2,
  external: 2,
};

// The count row's measurements are shared with the explorer's layout (M4b.2).
export {
  BADGE_CHROME,
  BADGE_GAP,
  COUNTS_SLACK,
  countsRowWidth,
  FRAME_COUNTS_INSET,
  MIN_FRAME_WIDTH,
  WINDOW_BAND,
};

/**
 * Height of an open frame's header: {@link FRAME_HEADER}, plus the title band
 * for a window (a frontend service).
 */
export function frameHeader(index: GraphIndex, id: string): number {
  const node = nodeOf(index, id);
  return FRAME_HEADER + (nodeShape(node, layerOf(index, id)) === "window" ? WINDOW_BAND.frame : 0);
}

/**
 * The box a closed node takes, by tier and shape. Frames with count badges
 * get a second row, and grow wider when the badges need it, so they never
 * wrap out of the box (design gate, DESIGN_SYSTEM.md §1.1); windows add their
 * title band, and a model's table adds its fields row.
 */
export function nodeSize(index: GraphIndex, id: string): { width: number; height: number } {
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

/** A laid-out edge: the view edge, its route points (source first), and where its label sits. */
export interface PlacedEdge {
  view: ViewEdge;
  points: Point[];
  label: Point;
}

/** The whole layout: a box per visible node, routed edges, and the canvas size. */
export interface Layout {
  boxes: ReadonlyMap<string, Rect>;
  /**
   * Visible node IDs in reading order: columns left to right, top to bottom
   * within a column, an open frame's children right after the frame. The
   * explorer renders nodes in this order so Tab follows it (UX.md).
   */
  order: readonly string[];
  edges: readonly PlacedEdge[];
  width: number;
  height: number;
}

/**
 * Lays out the visible nodes. `top` are the root's children in graph order;
 * `open` (one of them, or null) is drawn as a frame around its children.
 */
export function layout(index: GraphIndex, open: string | null, edges: readonly ViewEdge[]): Layout {
  const top = index.children.get(index.root.id) ?? [];
  const sizes = new Map<string, { width: number; height: number }>();
  const inner = open ? (index.children.get(open) ?? []) : [];

  for (const n of top) sizes.set(n.id, nodeSize(index, n.id));
  if (open) {
    const childWidth = Math.max(...inner.map((c) => nodeSize(index, c.id).width), 0);
    const closed = nodeSize(index, open);
    const width = Math.max(childWidth + 2 * FRAME_PAD, closed.width);
    const stacked = inner.reduce((h, c) => h + nodeSize(index, c.id).height, 0);
    const height =
      frameHeader(index, open) + stacked + CHILD_GAP * Math.max(inner.length - 1, 0) + FRAME_PAD;
    sizes.set(open, { width, height });
  }

  // Columns by layer; services without a layer read as backend.
  const columns: string[][] = [[], [], []];
  for (const n of top) columns[COLUMN[n.layer ?? "backend"]]?.push(n.id);
  const used = columns.filter((c) => c.length > 0);
  const heights = used.map((c) =>
    c.reduce((h, id, i) => h + (sizes.get(id)?.height ?? 0) + (i > 0 ? ROW_GAP : 0), 0),
  );
  const tallest = Math.max(...heights, 0);

  const boxes = new Map<string, Rect>();
  let x = PAD;
  used.forEach((column, i) => {
    const width = Math.max(...column.map((id) => sizes.get(id)?.width ?? 0));
    let y = PAD + (tallest - (heights[i] ?? 0)) / 2;
    for (const id of column) {
      const size = sizes.get(id) ?? { width: 0, height: 0 };
      boxes.set(id, { x: x + (width - size.width) / 2, y, ...size });
      y += size.height + ROW_GAP;
    }
    x += width + COLUMN_GAP;
  });

  if (open) {
    const frame = boxes.get(open);
    if (frame) {
      const innerWidth = frame.width - 2 * FRAME_PAD;
      let y = frame.y + frameHeader(index, open);
      for (const c of inner) {
        const size = nodeSize(index, c.id);
        const icon = nodeTier(c) === "icon";
        const width = icon ? size.width : innerWidth;
        boxes.set(c.id, {
          x: frame.x + FRAME_PAD + (innerWidth - width) / 2,
          y,
          width,
          height: size.height,
        });
        y += size.height + CHILD_GAP;
      }
    }
  }

  const order = used.flat().flatMap((id) => (id === open ? [id, ...inner.map((c) => c.id)] : [id]));

  return {
    boxes,
    order,
    edges: routeEdges(edges, boxes),
    width: x - COLUMN_GAP + PAD,
    height: tallest + 2 * PAD,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The point `t` (0–1) of the way along a polyline, by length. Parallel edges
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
 * Routes every edge between its boxes. Parallel edges between the same pair
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
 * `offset` shifts the line sideways for parallel edges.
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
