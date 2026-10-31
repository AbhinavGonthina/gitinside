import type { Rect } from "../chrome/describe.js";
import type { LayoutResult } from "../layout/elk.js";

/**
 * Viewport culling (M4b.13a, ADR-0129): on a big level the canvas draws only
 * the boxes, lines, and pills near the camera's view, so panning a 2,000-node
 * diagram keeps a few hundred elements in the page instead of all of them.
 *
 * Below {@link CULL_FROM} drawn items nothing is culled: a level that small
 * costs less to draw whole than to recompute as the camera moves, and every
 * box stays a Tab stop.
 */
export const CULL_FROM = 400;

/**
 * The culling window is snapped outward to tiles this many diagram px wide,
 * so a pan changes what's drawn only when the window crosses a tile edge,
 * not on every frame.
 */
export const CULL_TILE = 512;

/** How far past a pill's anchor its text can reach, in diagram px (the widest pill is under this). */
const PILL_REACH = 240;

/** Whether two rects overlap or touch. */
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

/** The smallest rect holding every point (an empty rect at 0,0 for none). */
export function bounds(points: readonly { x: number; y: number }[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The smallest rect holding both rects. */
export function span(a: Rect, b: Rect): Rect {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The part of the diagram to draw for a visible rect (`visibleRect`): grown
 * by half its size on every side, so a quick pan or a zoom out doesn't
 * uncover empty canvas before the next render, then snapped outward to
 * {@link CULL_TILE}. Visible rects within one tile give the same window.
 */
export function cullWindow(visible: Rect, tile = CULL_TILE): Rect {
  const growX = visible.width / 2;
  const growY = visible.height / 2;
  const left = Math.floor((visible.x - growX) / tile) * tile;
  const top = Math.floor((visible.y - growY) / tile) * tile;
  const right = Math.ceil((visible.x + visible.width + growX) / tile) * tile;
  const bottom = Math.ceil((visible.y + visible.height + growY) / tile) * tile;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** What a culled level draws: box IDs and edge IDs (a line and its pill go together). */
export interface Culled {
  boxes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

/**
 * The boxes and edges of `layout` to draw in `window`: a box overlapping it
 * (an open frame holding the whole window counts), one listed in `keep`
 * whatever its place (the selection, the focused box: their elements must
 * exist to take focus), and one whose glide starts inside it (`from`, where
 * a moving box is drawn when the glide begins, so it slides out rather than
 * vanishing); an edge whose route or pill overlaps it. Without a window,
 * or with fewer than `from` boxes and edges together, everything is drawn.
 */
export function cull(
  layout: Pick<LayoutResult, "boxes" | "edges">,
  window: Rect | undefined,
  keep: ReadonlySet<string> = new Set(),
  from: ReadonlyMap<string, Rect> = new Map(),
  threshold = CULL_FROM,
): Culled {
  if (window === undefined || layout.boxes.length + layout.edges.length < threshold) {
    return {
      boxes: new Set(layout.boxes.map((b) => b.id)),
      edges: new Set(layout.edges.map((e) => e.id)),
    };
  }
  const boxes = new Set<string>();
  for (const b of layout.boxes) {
    const start = from.get(b.id);
    if (keep.has(b.id) || intersects(b, window) || (start && intersects(start, window))) {
      boxes.add(b.id);
    }
  }
  const edges = new Set<string>();
  for (const e of layout.edges) {
    const pill = {
      x: e.label.x - PILL_REACH,
      y: e.label.y - PILL_REACH,
      width: 2 * PILL_REACH,
      height: 2 * PILL_REACH,
    };
    if (intersects(bounds(e.points), window) || intersects(pill, window)) edges.add(e.id);
  }
  return { boxes, edges };
}
