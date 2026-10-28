/**
 * Pure geometry for drawing an edge from its route points (the start point,
 * bend points, and end point ELK gives each edge section in M4b). Everything
 * is rounded to 0.01px so the same points always give the same SVG text.
 */

/** A point in canvas pixels. */
export interface Point {
  x: number;
  y: number;
}

/** Arrowhead length along the line, and half its width, in pixels. */
export const ARROW = { length: 8, halfWidth: 4 } as const;

/** How far the pattern-confidence dot sits from the source end, in pixels. */
export const DOT_OFFSET = 7;

/** Everything needed to draw one edge. */
export interface EdgeGeometry {
  /** The line, ending at the arrowhead's base so the stroke never pokes through its tip. */
  d: string;
  /** The arrowhead: a closed triangle whose tip is the last point (shorter if the last segment is). */
  arrow: string;
  /** The arrowhead as an open chevron (unresolved edges), same tip and base. */
  chevron: string;
  /** Where the pattern-confidence dot goes: just off the source end, along the first segment. */
  dot: Point;
  /** Halfway along the line's length, where its label is centered. */
  mid: Point;
  /** The full line to the tip, for flow particles (`offset-path`). */
  flowPath: string;
}

/** Corner radius for bends, in pixels; ELK routes are orthogonal, so bends are right angles. */
export const CORNER_RADIUS = 10;

function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

function pt(p: Point): string {
  return `${fmt(p.x)} ${fmt(p.y)}`;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Unit vector from `a` towards `b` (the two must differ). */
function direction(a: Point, b: Point): Point {
  const len = distance(a, b);
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

function along(p: Point, dir: Point, by: number): Point {
  return { x: p.x + dir.x * by, y: p.y + dir.y * by };
}

/** Drops points that repeat the previous one, so every segment has a direction. */
function distinct(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || distance(last, p) > 1e-6) out.push(p);
  }
  return out;
}

/**
 * A path through `points` with each bend rounded (radius {@link CORNER_RADIUS},
 * shrunk to half the shorter neighboring segment so short jogs stay sharp).
 */
function roundedPath(points: readonly Point[]): string {
  const [first, ...rest] = points as [Point, ...Point[]];
  let d = `M ${pt(first)}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const prev = points[i] as Point;
    const corner = rest[i] as Point;
    const next = rest[i + 1] as Point;
    const r = Math.min(CORNER_RADIUS, distance(prev, corner) / 2, distance(corner, next) / 2);
    const a = along(corner, direction(corner, prev), r);
    const b = along(corner, direction(corner, next), r);
    d += ` L ${pt(a)} Q ${pt(corner)} ${pt(b)}`;
  }
  return `${d} L ${pt(rest[rest.length - 1] as Point)}`;
}

/** The point halfway along a polyline's length (bends counted as sharp). */
function midpoint(points: readonly Point[]): Point {
  const lengths = points.slice(1).map((p, i) => distance(points[i] as Point, p));
  let left = lengths.reduce((sum, l) => sum + l, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i] as number;
    if (left <= l) {
      const from = points[i] as Point;
      return along(from, direction(from, points[i + 1] as Point), left);
    }
    left -= l;
  }
  return points[points.length - 1] as Point;
}

/**
 * The SVG for an edge through `points`, source first. Throws if fewer than two
 * distinct points are given, since such an edge has no direction to draw.
 */
export function edgeGeometry(points: readonly Point[]): EdgeGeometry {
  const route = distinct(points);
  if (route.length < 2) throw new Error("an edge needs at least two distinct points");
  const tip = route[route.length - 1] as Point;
  const beforeTip = route[route.length - 2] as Point;
  const dir = direction(beforeTip, tip);
  // The arrow takes at most the last segment's length, so a very short last
  // segment still ends at a sensible base.
  const length = Math.min(ARROW.length, distance(beforeTip, tip));
  const base = along(tip, dir, -length);
  const normal = { x: -dir.y, y: dir.x };
  const left = along(base, normal, ARROW.halfWidth);
  const right = along(base, normal, -ARROW.halfWidth);
  const start = route[0] as Point;
  const second = route[1] as Point;
  const dot = along(
    start,
    direction(start, second),
    Math.min(DOT_OFFSET, distance(start, second) / 2),
  );
  // When the arrow fills the whole edge, the line is a single point.
  const line = distinct([...route.slice(0, -1), base]);
  return {
    d: line.length > 1 ? roundedPath(line) : `M ${pt(start)} L ${pt(start)}`,
    arrow: `M ${pt(tip)} L ${pt(left)} L ${pt(right)} Z`,
    chevron: `M ${pt(left)} L ${pt(tip)} L ${pt(right)}`,
    dot: rounded(dot),
    mid: rounded(midpoint(route)),
    flowPath: roundedPath(route),
  };
}

function rounded({ x, y }: Point): Point {
  return { x: Number(fmt(x)), y: Number(fmt(y)) };
}
