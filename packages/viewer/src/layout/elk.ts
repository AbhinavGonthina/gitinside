import { compareStrings, type Layer } from "@gitinside/schema";
import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from "elkjs/lib/elk-api.js";
import type { Rect } from "../chrome/describe.js";
import type { Point } from "../edges/geometry.js";
import type { DiffMarks } from "../model/diff.js";
import { HOSTS_GROUP_PREFIX, isUnresolvedGroup } from "../model/groups.js";
import { layerOf, type HierarchyIndex } from "../model/hierarchy.js";
import { isCodeLine, type GraphView } from "../model/view.js";
import {
  FRAME_PAD,
  MORE_FOOT,
  openHeader,
  viewEdgeLabelSize,
  viewNodeSize,
  type Size,
} from "./size.js";

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
 * layout and related views keep their nodes in the same order. Big views
 * (over {@link MODEL_ORDER_LIMIT} nodes and edges) give that up: there it
 * cost minutes. They stay deterministic (fixed seed). A service's
 * routes and pages go in its first column (ELK's `FIRST` layer constraint;
 * partitions are ignored across levels of a compound graph), then its folders.
 * In the M10.3 prototype the top level's nodes are partitioned into bands
 * ({@link BANDS}); that works with nodes open, since they're all the root's.
 * Its "uses code" lines between top-level boxes are left out of ELK and
 * routed after it ({@link busRoute}), so imports and calls between packages
 * don't stretch the level into a long chain of columns (documenso: 4,317px
 * wide with them, 1,960px without).
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
  /** Open nodes leaving boxes out of a path-only view (M10.3d2): room below the children for "+ N more". */
  foot?: number;
  /** A route or page at its service's first level: kept in the service's first column. */
  entry?: boolean;
  /**
   * A broken-down service's calls out (M10.3d3, M10-design B3, prototype only): its unresolved
   * calls and imports, kept in its last column, right of its code.
   */
  exit?: boolean;
  /**
   * A top-level node's band, an index into {@link BANDS} (M10.3a, prototype only): ELK keeps
   * the bands in order left to right (`elk.partitioning`). Unset outside the prototype.
   */
  band?: number;
  /**
   * A host in a broken-down host group (M10.3d5, prototype only): its place in the group's grid of
   * {@link GRID_COLUMNS} columns, row by row, the host with the most connections first.
   */
  cell?: number;
}

/** How many columns a broken-down host group's hosts are laid out in (M10-design A6). */
export const GRID_COLUMNS = 4;

/**
 * The prototype's bands (M10.3a, M10-design A1), left to right as a request travels. A
 * top-level node's band is its layer's; a node without a layer goes to Backend.
 */
export const BANDS = [
  { layer: "frontend", label: "Frontend" },
  { layer: "backend", label: "Backend" },
  { layer: "infra", label: "Queues and jobs" },
  { layer: "data", label: "Data" },
  { layer: "external", label: "Outside" },
] as const satisfies readonly { layer: Layer; label: string }[];

/** The band of a node in `layer` (Backend without one). */
export function bandOf(layer: Layer | undefined): number {
  const band = BANDS.findIndex((b) => b.layer === (layer ?? "backend"));
  return band === -1 ? 1 : band;
}

/**
 * Whether a visible node is one of an open service's calls out (an `unresolved` node drawn
 * directly in it, or a group of them, `isUnresolvedGroup`), which the prototype keeps in the
 * service's last column: a broken-down service
 * reads entries, then code, then what it calls that isn't in the repo. ELK put unresolved
 * imports, whose lines are hidden by default, in the first column beside the routes.
 */
function callsOut(view: GraphView, n: GraphView["nodes"][number]): boolean {
  if ((n.node.kind !== "unresolved" && !isUnresolvedGroup(n.node)) || n.parent === null) {
    return false;
  }
  return view.byId.get(n.parent)?.node.kind === "service";
}

/**
 * Each host's cell in its broken-down host group's grid (`LayoutNode.cell`): the group's drawn
 * children by how many connections their lines stand for, most first, then by ID. ELK alone
 * stacked a group's hosts in one column, since nothing connects them (anything-llm's AI models:
 * 27 tall).
 */
function hostCells(view: GraphView): Map<string, number> {
  const cells = new Map<string, number>();
  const groups = view.nodes.filter((n) => n.open && n.id.startsWith(HOSTS_GROUP_PREFIX));
  if (groups.length === 0) return cells;
  const lines = new Map<string, number>();
  for (const e of view.edges) {
    for (const end of [e.from, e.to]) lines.set(end, (lines.get(end) ?? 0) + e.edges.length);
  }
  for (const group of groups) {
    const hosts = [...(view.childrenOf.get(group.id) ?? [])].sort(
      (a, b) => (lines.get(b) ?? 0) - (lines.get(a) ?? 0) || compareStrings(a, b),
    );
    for (const [i, id] of hosts.entries()) cells.set(id, i);
  }
  return cells;
}

/** Where a band starts on the canvas: the left edge of its leftmost top-level box. */
export interface PlacedBand {
  band: number;
  x: number;
}

/** Options for {@link layoutInput}. */
export interface LayoutInputOptions {
  /** Lay the top level out in {@link BANDS} (the M10.3 prototype's A1). */
  bands?: boolean | undefined;
  /**
   * Leave "uses code" lines (`isCodeLine`) out of ELK and route them with {@link busRoute}
   * (the M10.3 prototype's A2), so code dependency doesn't spread the system level out.
   */
  quietCode?: boolean | undefined;
  /** Size boxes as the prototype's cards draw them (M10.3b3, `cardLook`): names wrap, never cut. */
  cards?: boolean | undefined;
}

/** One drawn edge as the layout sees it, with its label's size. */
export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  label: Size;
  /** A "uses code" line left out of ELK and routed by {@link busRoute} (prototype only). */
  quiet?: boolean;
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
  /** Routed by {@link busRoute}, not ELK: a quiet "uses code" line, drawn behind the boxes. */
  quiet?: true;
}

/** A laid-out view, in absolute canvas coordinates (the diagram's top left is 0, 0). */
export interface LayoutResult {
  /** A box per input node, in input order. */
  boxes: (Rect & { id: string })[];
  /** A route per input edge, in input order. */
  edges: PlacedEdge[];
  width: number;
  height: number;
  /** The bands drawn, in order, when the input has them (prototype only). */
  bands?: PlacedBand[];
}

/** Space around the whole diagram. */
export const LAYOUT_PAD = 40;

/** Layout options for the root (ELK's IDs; values are strings), as a view up to {@link MODEL_ORDER_LIMIT} gets them. */
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
 * Above this many nodes plus edges, ELK lays out without model order
 * (M4b.13b2, ADR-0131). Its model-order sort grows steeply with the dummy
 * nodes long edges leave in each column: on cal.com's levels it took 0.2 s
 * at 164 nodes and edges, 0.9 s at 297, 13.6 s at 438, and 18 of 24 s at
 * 500 nodes (1,151 with edges). Smaller views (every story) keep it.
 */
export const MODEL_ORDER_LIMIT = 200;

/**
 * Above this many nodes plus edges, crossing minimization makes one pass
 * instead of ELK's default seven (ADR-0131): cal.com at 2,000 visible nodes
 * (4,328 with edges) went from 40 s to 15 s, at the cost of a few more
 * crossings on a level too big to read at once anyway.
 */
export const THOROUGHNESS_LIMIT = 3000;

/**
 * The root's options for an input: {@link ELK_OPTIONS}, made cheaper for a big view. A banded
 * input (the prototype) is partitioned; a banded system level with nothing open also places its
 * nodes by network simplex (M10.3b2), since ELK's default (Brandes–Köpf) put maxun's two
 * datastores with no lines below its six outside hosts, a level 1,262px tall where 988px holds it
 * (fitted at 44% instead of 57%). Only there: on a broken-down service it tripled the time
 * (documenso's remix, 0.8 s to 2.7 s).
 */
function rootOptions(input: LayoutInput): LayoutOptions {
  const items = input.nodes.length + input.edges.length;
  const banded = input.nodes.some((n) => n.band !== undefined);
  return {
    ...ELK_OPTIONS,
    ...(items > MODEL_ORDER_LIMIT ? { "elk.layered.considerModelOrder.strategy": "NONE" } : {}),
    ...(items > THOROUGHNESS_LIMIT ? { "elk.layered.thoroughness": "1" } : {}),
    ...(banded ? { "elk.partitioning.activate": "true" } : {}),
    ...(banded && input.nodes.every((n) => n.parent === null)
      ? { "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX" }
      : {}),
  };
}

/**
 * The layout's input for a view: each visible node's size measured from its
 * content (an open one's closed width and header as its minimum, ELK sizing
 * it around its children), and each edge's label size. In diff mode
 * (`marks`) a closed box makes room for its change badges and a pill for its
 * state's word or what broke, and both for what Base and Head draw instead.
 * With `options.bands` (the prototype), each top-level node gets its band; with
 * `options.quietCode`, each "uses code" line (`isCodeLine`) is marked `quiet`; with
 * `options.cards`, boxes are sized as the prototype's cards.
 */
export function layoutInput(
  index: HierarchyIndex,
  view: GraphView,
  marks?: DiffMarks | undefined,
  options: LayoutInputOptions = {},
): LayoutInput {
  const cells = options.bands ? hostCells(view) : new Map<string, number>();
  const nodes = view.nodes.map((n): LayoutNode => {
    const cell = cells.get(n.id);
    const size = viewNodeSize(index, n, marks, options.cards);
    const header = n.open ? openHeader(n.node, layerOf(index, n.id)) : undefined;
    return {
      id: n.id,
      parent: n.parent,
      width: size.width,
      height: header ?? size.height,
      ...(header === undefined ? {} : { header }),
      ...(header !== undefined && n.more ? { foot: MORE_FOOT } : {}),
      ...(n.section === "entries" ? { entry: true } : {}),
      ...(options.bands && n.parent === null ? { band: bandOf(n.node.layer) } : {}),
      ...(options.bands && callsOut(view, n) ? { exit: true } : {}),
      ...(cell === undefined ? {} : { cell }),
    };
  });
  const edges = view.edges.map(
    (e): LayoutEdge => ({
      id: e.id,
      from: e.from,
      to: e.to,
      label: viewEdgeLabelSize(e, marks),
      ...(options.quietCode && isCodeLine(view, e) ? { quiet: true } : {}),
    }),
  );
  return { nodes, edges };
}

/** ELK's graph for an input: compound nodes for open ones, every edge but the quiet ones on the root. */
export function elkGraph(input: LayoutInput): ElkNode {
  const root: ElkNode = { id: "__root", layoutOptions: rootOptions(input), children: [] };
  const byId = new Map<string, ElkNode>();
  for (const n of input.nodes) {
    const options: LayoutOptions = {};
    if (n.header !== undefined) {
      options["elk.padding"] =
        `[top=${n.header},left=${FRAME_PAD},bottom=${FRAME_PAD + (n.foot ?? 0)},right=${FRAME_PAD}]`;
      options["elk.nodeSize.constraints"] = "MINIMUM_SIZE";
      options["elk.nodeSize.minimum"] = `(${n.width},${n.height})`;
    }
    if (n.entry) options["elk.layered.layering.layerConstraint"] = "FIRST";
    if (n.exit) options["elk.layered.layering.layerConstraint"] = "LAST";
    if (n.band !== undefined) options["elk.partitioning.partition"] = String(n.band);
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
  root.edges = [...gridEdges(input, byId), ...edgesOf(input)];
  return root;
}

/** The ID prefix of {@link gridEdges}' edges, which {@link readLayout} never reads. */
const GRID_EDGE = "__grid:";

/**
 * A broken-down host group's grid (`LayoutNode.cell`): each row of {@link GRID_COLUMNS} cells
 * chained left to right by an edge nothing draws, so ELK's layers are the grid's columns and a
 * row's hosts go busiest first, left to right. ELK still stacks the rows (and staggers each a
 * little): in the order that keeps the lines coming in from crossing, with room between rows for
 * them, which isn't always cell order (anything-llm's AI models: the busiest row on top, the rest
 * mixed). Lining rows up afterwards ran lines through other hosts, and ELK's own ordering options
 * failed (model order inside the frame threw), so ELK's order stands.
 */
function gridEdges(input: LayoutInput, byId: ReadonlyMap<string, ElkNode>): ElkExtendedEdge[] {
  const rows = new Map<string, LayoutNode[]>();
  for (const n of input.nodes) {
    if (n.cell === undefined || n.parent === null) continue;
    rows.set(n.parent, [...(rows.get(n.parent) ?? []), n]);
  }
  const edges: ElkExtendedEdge[] = [];
  for (const [group, hosts] of rows) {
    hosts.sort((a, b) => (a.cell ?? 0) - (b.cell ?? 0));
    const frame = byId.get(group);
    if (frame) frame.children = hosts.flatMap((h) => byId.get(h.id) ?? []);
    for (const [i, host] of hosts.entries()) {
      const next = hosts[i + 1];
      if (!next || (i + 1) % GRID_COLUMNS === 0) continue;
      edges.push({ id: `${GRID_EDGE}${host.id}`, sources: [host.id], targets: [next.id] });
    }
  }
  return edges;
}

/** ELK's edges for an input's drawn lines, the quiet ones left out. */
function edgesOf(input: LayoutInput): ElkExtendedEdge[] {
  return input.edges.flatMap((e): ElkExtendedEdge[] =>
    e.quiet
      ? []
      : [
          {
            id: e.id,
            sources: [e.from],
            targets: [e.to],
            // ELK skips a label without text (it's left at 0, 0 and gets no room),
            // so the label carries a placeholder; only its size matters here.
            labels: [
              {
                id: `${e.id}#label`,
                text: " ",
                width: e.label.width,
                height: e.label.height,
                // The pill sits on its line (DESIGN_SYSTEM §3), so ELK routes the
                // line through the room it keeps (a label option, ignored on the
                // root). Placed beside the line and moved onto it, the pills of two
                // parallel edges 11px apart covered each other (M4b.2b).
                layoutOptions: { "elk.edgeLabels.inline": "true" },
              },
            ],
          },
        ],
  );
}

/** How far before its target a quiet line turns toward it (canvas px), clear of ELK's 64px column gap. */
export const BUS_GAP = 20;

/**
 * A quiet "uses code" line's route (M10.3b2, M10-design A2), source first: out of the source's
 * side facing the target at its middle, straight across to {@link BUS_GAP} short of the target's
 * near side, along to the target's middle, and in. A target in the source's column (their spans
 * overlap) is reached around the column's right side. Every line from one box leaves at one
 * point and runs together until its target's column, and every line into a box meets at one
 * point, so a box's code dependencies read as one bundle. Drawn behind the boxes, so a run that
 * crosses a box between the two is hidden by it.
 */
export function busRoute(from: Rect, to: Rect): Point[] {
  const fromY = from.y + from.height / 2;
  const toY = to.y + to.height / 2;
  const fromRight = from.x + from.width;
  const toRight = to.x + to.width;
  const route = (startX: number, turnX: number, endX: number): Point[] => {
    const points = [
      { x: startX, y: fromY },
      { x: turnX, y: fromY },
      { x: turnX, y: toY },
      { x: endX, y: toY },
    ].map(point);
    // A target level with the source needs no turn.
    return fromY === toY ? [points[0] as Point, points[3] as Point] : points;
  };
  if (to.x >= fromRight) return route(fromRight, Math.max(fromRight, to.x - BUS_GAP), to.x);
  if (toRight <= from.x) return route(from.x, Math.min(from.x, toRight + BUS_GAP), toRight);
  return route(fromRight, Math.max(fromRight, toRight) + BUS_GAP, toRight);
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
 * The point of a polyline nearest to `p`. Inline labels already sit on their
 * line, give or take ELK's rounding and a bend's jog; the pill is drawn on
 * the line, so it moves to the nearest point there.
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

  const boxById = new Map(boxes.map((b) => [b.id, b]));
  const edges = input.edges.map((e): PlacedEdge => {
    if (e.quiet) {
      const from = boxById.get(e.from);
      const to = boxById.get(e.to);
      if (!from || !to) throw new Error(`layout has no box for an end of edge ${e.id}`);
      const points = busRoute(from, to);
      return { id: e.id, points, label: midpoint(points), quiet: true };
    }
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

  const result: LayoutResult = {
    boxes,
    edges,
    width: round(out.width ?? 0),
    height: round(out.height ?? 0),
  };
  const starts = new Map<number, number>();
  for (const [i, n] of input.nodes.entries()) {
    const box = boxes[i];
    if (n.band === undefined || !box) continue;
    starts.set(n.band, Math.min(starts.get(n.band) ?? Infinity, box.x));
  }
  if (starts.size > 0)
    result.bands = [...starts].map(([band, x]) => ({ band, x })).sort((a, b) => a.band - b.band);
  return result;
}

/**
 * Lays out an input with an ELK instance: in a worker in the explorer, or
 * `elkjs/lib/elk.bundled.js` in tests and as the fallback (M4b.2b). Same
 * input, same result.
 */
export async function runLayout(elk: ELK, input: LayoutInput): Promise<LayoutResult> {
  return readLayout(input, await elk.layout(elkGraph(input)));
}
