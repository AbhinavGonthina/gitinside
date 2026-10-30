import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from "elkjs/lib/elk-api.js";
import type { Rect } from "../chrome/describe.js";
import type { Point } from "../edges/geometry.js";
import { layerOf, type HierarchyIndex } from "../model/hierarchy.js";
import type { GraphView } from "../model/view.js";
import { edgeLabelSize, FRAME_PAD, openHeader, viewNodeSize, type Size } from "./size.js";

/**
 * The explorer's layout (M4b.2): ELK's layered algorithm over the visible
 * nodes of a view, read left to right as a request travels (pages → routes →
 * handlers → data and outside APIs). Open nodes are compound nodes laid out
 * in the same run (`INCLUDE_CHILDREN`), so an edge from inside one service to
 * inside another is routed once, around everything in between.
 *
 * Two steps, so the slow one can run in a Web Worker (M4b.2b):
 * - {@link layoutInput} (main thread) turns a view into plain, serializable
 *   data: each node's measured size, the frame it's in, and the edges with
 *   their label sizes, all in the view's drawing order.
 * - {@link runLayout} (anywhere ELK runs) builds ELK's graph, lays it out,
 *   and reads back absolute boxes and edge routes.
 *
 * Stable ordering: ELK keeps the input's order where the edges leave it a
 * choice (`considerModelOrder`), and the input follows the view's drawing
 * order (graph order, routes first), so the same view always gets the same
 * layout and related views keep their nodes in the same order. A service's
 * routes and pages go in its first column (ELK's `FIRST` layer constraint;
 * partitions are ignored across levels of a compound graph), then its folders.
 */

/** One visible node as the layout sees it. */
export interface LayoutNode {
  id: string;
  /** The open node it's drawn inside; null at the top level. */
  parent: string | null;
  /** Closed: its size. Open: the least it may shrink to (its closed width, its header). */
  width: number;
  height: number;
  /** Open nodes only: the header's height above the children. */
  header?: number;
  /** A route or page at its service's first level: kept in the service's first column. */
  entry?: boolean;
}

/** One drawn edge as the layout sees it, with its label's size. */
export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  label: Size;
}

/** Everything the layout needs, as plain data a worker can receive. */
export interface LayoutInput {
  /** Visible nodes in drawing order: a frame, then its children. */
  nodes: readonly LayoutNode[];
  edges: readonly LayoutEdge[];
}

/** A laid-out edge: route points, source first, and its label's center. */
export interface PlacedEdge {
  id: string;
  points: Point[];
  label: Point;
}

/** A laid-out view, in absolute canvas coordinates (the diagram's top left is 0, 0). */
export interface LayoutResult {
  /** A box per input node, in input order. */
  boxes: (Rect & { id: string })[];
  /** A route per input edge, in input order. */
  edges: PlacedEdge[];
  width: number;
  height: number;
}

/** Space around the whole diagram. */
export const LAYOUT_PAD = 40;

/** Layout options for the root (ELK's IDs; values are strings). */
export const ELK_OPTIONS: Readonly<LayoutOptions> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  // Absolute coordinates for every box and edge, whatever it's nested in.
  "elk.json.shapeCoords": "ROOT",
  "elk.json.edgeCoords": "ROOT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.edgeLabels.placement": "CENTER",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  "elk.randomSeed": "1",
  "elk.padding": `[top=${LAYOUT_PAD},left=${LAYOUT_PAD},bottom=${LAYOUT_PAD},right=${LAYOUT_PAD}]`,
  // Gaps: 28px between boxes in a column, 64px between columns (labels
  // get their own room on top), and room for parallel lines to read apart.
  "elk.spacing.nodeNode": "28",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.edgeNode": "16",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.spacing.edgeEdge": "14",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.edgeLabel": "6",
};

/**
 * The layout's input for a view: each visible node's size measured from its
 * content (an open one's closed width and header as its minimum, ELK sizing
 * it around its children), and each edge's label size.
 */
export function layoutInput(index: HierarchyIndex, view: GraphView): LayoutInput {
  const nodes = view.nodes.map((n): LayoutNode => {
    const size = viewNodeSize(index, n);
    const header = n.open ? openHeader(n.node, layerOf(index, n.id)) : undefined;
    return {
      id: n.id,
      parent: n.parent,
      width: size.width,
      height: header ?? size.height,
      ...(header === undefined ? {} : { header }),
      ...(n.section === "entries" ? { entry: true } : {}),
    };
  });
  const edges = view.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    label: edgeLabelSize(e),
  }));
  return { nodes, edges };
}

/** ELK's graph for an input: compound nodes for open ones, every edge on the root. */
export function elkGraph(input: LayoutInput): ElkNode {
  const root: ElkNode = { id: "__root", layoutOptions: { ...ELK_OPTIONS }, children: [] };
  const byId = new Map<string, ElkNode>();
  for (const n of input.nodes) {
    const options: LayoutOptions = {};
    if (n.header !== undefined) {
      options["elk.padding"] =
        `[top=${n.header},left=${FRAME_PAD},bottom=${FRAME_PAD},right=${FRAME_PAD}]`;
      options["elk.nodeSize.constraints"] = "MINIMUM_SIZE";
      options["elk.nodeSize.minimum"] = `(${n.width},${n.height})`;
    }
    if (n.entry) options["elk.layered.layering.layerConstraint"] = "FIRST";
    const node: ElkNode = {
      id: n.id,
      width: n.width,
      height: n.height,
      ...(Object.keys(options).length > 0 ? { layoutOptions: options } : {}),
    };
    byId.set(n.id, node);
    const parent = n.parent === null ? root : byId.get(n.parent);
    if (!parent) throw new Error(`layout input lists ${n.id} before its parent ${n.parent}`);
    (parent.children ??= []).push(node);
  }
  root.edges = input.edges.map(
    (e): ElkExtendedEdge => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
      // ELK skips a label without text (it's left at 0, 0 and gets no room),
      // so the label carries a placeholder; only its size matters here.
      labels: [{ id: `${e.id}#label`, text: " ", width: e.label.width, height: e.label.height }],
    }),
  );
  return root;
}

const round = (n: number) => Math.round(n * 100) / 100;
const point = (p: Point): Point => ({ x: round(p.x), y: round(p.y) });

/** The point halfway along a polyline by length, for an edge ELK gave no label position. */
function midpoint(points: readonly Point[]): Point {
  const segments = points.slice(1).map((b, i) => {
    const a = points[i] as Point;
    return { a, b, length: Math.hypot(b.x - a.x, b.y - a.y) };
  });
  let left = segments.reduce((sum, s) => sum + s.length, 0) / 2;
  for (const { a, b, length } of segments) {
    if (left <= length && length > 0) {
      const f = left / length;
      return point({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
    left -= length;
  }
  return point(points[0] as Point);
}

/**
 * The point of a polyline nearest to `p`. ELK places a label beside its line
 * (with room kept for it); the pill is drawn on the line, so it moves to the
 * nearest point there.
 */
function nearestOnLine(points: readonly Point[], p: Point): Point {
  let best = points[0] as Point;
  let bestDistance = Infinity;
  for (const [i, b] of points.slice(1).entries()) {
    const a = points[i] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const t =
      length2 === 0 ? 0 : Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, 0), 1);
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const distance = Math.hypot(p.x - q.x, p.y - q.y);
    if (distance < bestDistance) {
      best = q;
      bestDistance = distance;
    }
  }
  return point(best);
}

/**
 * Reads ELK's output back in the input's order. Coordinates are rounded to
 * hundredths so results compare exactly across runs and machines. An edge's
 * sections are joined into one polyline, source first.
 */
export function readLayout(input: LayoutInput, out: ElkNode): LayoutResult {
  const shapes = new Map<string, ElkNode>();
  const stack = [...(out.children ?? [])];
  for (let n = stack.pop(); n; n = stack.pop()) {
    shapes.set(n.id, n);
    stack.push(...(n.children ?? []));
  }
  const routes = new Map<string, ElkExtendedEdge>();
  for (const e of out.edges ?? []) routes.set(e.id, e as ElkExtendedEdge);

  const boxes = input.nodes.map((n) => {
    const s = shapes.get(n.id);
    if (!s) throw new Error(`layout lost node ${n.id}`);
    return {
      id: n.id,
      x: round(s.x ?? 0),
      y: round(s.y ?? 0),
      width: round(s.width ?? n.width),
      height: round(s.height ?? n.height),
    };
  });

  const edges = input.edges.map((e): PlacedEdge => {
    const route = routes.get(e.id);
    const points: Point[] = [];
    for (const section of route?.sections ?? []) {
      for (const p of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) {
        const q = point(p);
        const last = points.at(-1);
        if (!last || last.x !== q.x || last.y !== q.y) points.push(q);
      }
    }
    if (points.length < 2) throw new Error(`layout gave edge ${e.id} no route`);
    const label = route?.labels?.[0];
    return {
      id: e.id,
      points,
      label:
        label?.x === undefined || label.y === undefined
          ? midpoint(points)
          : nearestOnLine(points, {
              x: label.x + e.label.width / 2,
              y: label.y + e.label.height / 2,
            }),
    };
  });

  return { boxes, edges, width: round(out.width ?? 0), height: round(out.height ?? 0) };
}

/**
 * Lays out an input with an ELK instance: in a worker in the explorer, or
 * `elkjs/lib/elk.bundled.js` in tests and as the fallback (M4b.2b). Same
 * input, same result.
 */
export async function runLayout(elk: ELK, input: LayoutInput): Promise<LayoutResult> {
  return readLayout(input, await elk.layout(elkGraph(input)));
}
