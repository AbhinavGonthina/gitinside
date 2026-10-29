import {
  compareStrings,
  type ArchitectureGraph,
  type GraphNode,
  type Layer,
} from "@gitinside/schema";
import type { Rect } from "../chrome/describe.js";
import { edgeLabel, edgeLabelText, LINE_STYLE } from "../edges/describe.js";
import { edgeGeometry, type Point } from "../edges/geometry.js";
import type { Brand } from "../icons/brands.js";
import { iconFor, TILE_ICON_SIZE } from "../icons/Icon.js";
import { countText, nodeLabel, nodeSubtitle, nodeTier, type NodeText } from "../nodes/describe.js";
import { nodeSize, pointAlong, routeEdges, type PlacedEdge } from "../prototype/layout.js";
import {
  drawnEdge,
  frameCounts,
  indexGraph,
  liftEdges,
  type GraphIndex,
  type ViewEdge,
} from "../prototype/model.js";
import { scaleTokens } from "../tokens.js";
import { attrs, esc, fit, glyphMarkup, num, textWidth } from "./markup.js";
import { paletteCss, v, type ImageTheme } from "./palette.js";

/**
 * The live README image (SPEC §3 F1, DESIGN.md §11, M5.9): the top level of a
 * graph (services, datastores, queues, outside APIs, and the lines between
 * them) as one standalone SVG, drawn with the canvas's own words, icons, line
 * styles, and token colors.
 *
 * - **Same graph ⇒ same bytes.** No clock, no randomness, no measuring: the
 *   layout is fixed arithmetic and text is sized from estimates
 *   (`markup.ts`), so the image can be cached by commit.
 * - **Layout:** three columns by layer, read left to right as a request
 *   travels (frontend → backend → what the backend uses: datastores, then
 *   queues, then outside APIs). A column with more than {@link MAX_ROWS} boxes
 *   ({@link rowsFor} in big repos) wraps into balanced, top-aligned
 *   sub-columns, so a repo with ten
 *   datastores isn't one tall stripe and the rows of a wrapped column line up.
 * - **Lines** are the canvas's lifted edges (`liftEdges`: one per kind and
 *   pair, aggregates as counts, weakest confidence wins), routed so they don't
 *   cross boxes in the common cases: between neighbors as on the prototype;
 *   into or out of a wrapped sub-column through the gap between its rows (in
 *   at the top, out at the bottom); between two boxes of one sub-column that
 *   aren't neighbors, down a lane beside it.
 * - **Not handled** (M4b.2's ELK layout will): a frontend → data line passes
 *   the backend column at its source's height and can cross a box there;
 *   labels of busy columns can overlap.
 * - **Untrusted text:** every label, host, and path is escaped (`esc`), and
 *   nothing from the graph reaches an attribute name, a style, or a URL.
 */

/** Boxes per sub-column before a layer's column wraps, for up to 15 boxes. */
export const MAX_ROWS = 5;

/**
 * Rows of a layer column with `n` boxes: {@link MAX_ROWS}, or more for big
 * repos, so the column stays about 16:10 (a sub-column of frames is ~320px
 * wide with its gap, a row ~120px tall: rows ≈ √(n · 320 / 192)) instead of
 * a strip dozens of sub-columns long.
 */
export function rowsFor(n: number): number {
  return Math.max(MAX_ROWS, Math.ceil(Math.sqrt((n * 5) / 3)));
}
const PAD = 32;
/** Room between layers for a label such as `POST /api/orders · HTTP`. */
const LAYER_GAP = 160;
const WRAP_GAP = 72;
const ROW_GAP = 40;
const LANE_GAP = 14;
const FOOTER = 44;
const LABEL_MAX = LAYER_GAP - 24;
/** Narrow diagrams still leave room for the footer. */
const MIN_WIDTH = 480;

const COLUMN: Readonly<Record<Layer, number>> = {
  frontend: 0,
  backend: 1,
  data: 2,
  infra: 2,
  external: 2,
};

/** Order inside a column: services, then datastores, queues, and outside APIs (graph order within each). */
const KIND_ORDER: Partial<Record<GraphNode["kind"], number>> = {
  datastore: 1,
  queue: 2,
  external: 3,
};

const SANS = scaleTokens["font-sans"];
const MONO = scaleTokens["font-mono"];

/** Options for {@link renderDiagram}. */
export interface DiagramImageOptions {
  /** Default `auto`: dark, or light when the reader's system prefers it. */
  theme?: ImageTheme;
}

/** How many of each top-level kind a graph has, in drawing order, kinds with none left out. */
export function topLevelCounts(
  graph: ArchitectureGraph,
): { value: number; noun: string; plural?: string }[] {
  const index = indexGraph(graph);
  const top = index.children.get(index.root.id) ?? [];
  const kinds: { kind: GraphNode["kind"]; noun: string; plural?: string }[] = [
    { kind: "service", noun: "service" },
    { kind: "datastore", noun: "datastore" },
    { kind: "queue", noun: "queue" },
    { kind: "external", noun: "outside API" },
  ];
  return kinds.flatMap(({ kind, ...words }) => {
    const value = top.filter((n) => n.kind === kind).length;
    return value === 0 ? [] : [{ value, ...words }];
  });
}

/** Longest {@link badgeMessage}: kinds that don't fit are left off the end. */
export const BADGE_MESSAGE_MAX = 40;

/**
 * The README badge's message for a graph: "3 services · 2 datastores", in
 * drawing order, as many kinds as fit in {@link BADGE_MESSAGE_MAX} characters
 * (the first always does). "no services found" for an empty top level.
 */
export function badgeMessage(graph: ArchitectureGraph): string {
  const parts = topLevelCounts(graph).map(countText);
  if (parts.length === 0) return "no services found";
  let message = parts[0] as string;
  for (const part of parts.slice(1)) {
    const next = `${message} · ${part}`;
    if (next.length > BADGE_MESSAGE_MAX) break;
    message = next;
  }
  return message;
}

/** "3 services, 2 datastores and 1 outside API" (the image's description). */
function summary(graph: ArchitectureGraph): string {
  const parts = topLevelCounts(graph).map(countText);
  if (parts.length === 0) return "No services found.";
  const last = parts.pop() as string;
  return `${parts.length > 0 ? `${parts.join(", ")} and ${last}` : last}.`;
}

interface Slot {
  /** Which layer column (0–2, empty ones skipped). */
  group: number;
  /** Which sub-column, counted across the whole image. */
  column: number;
  row: number;
}

interface Column {
  group: number;
  left: number;
  right: number;
  /** Whether it's the first or last sub-column of its layer column. */
  first: boolean;
  last: boolean;
}

interface Placement {
  boxes: Map<string, Rect>;
  slots: Map<string, Slot>;
  columns: Column[];
  width: number;
  height: number;
}

/** Places the top-level nodes in layer columns, wrapping tall ones. */
function place(index: GraphIndex, top: readonly GraphNode[]): Placement {
  const layers: GraphNode[][] = [[], [], []];
  for (const n of top) layers[COLUMN[n.layer ?? "backend"]]?.push(n);
  const rank = (n: GraphNode) => KIND_ORDER[n.kind] ?? 0;
  // Array.prototype.sort is stable, so graph order holds within a kind.
  const groups = layers
    .filter((l) => l.length > 0)
    .map((l) => [...l].sort((a, b) => rank(a) - rank(b)).map((n) => n.id));

  const subs: { ids: string[]; group: number; width: number; height: number; gapAfter: number }[] =
    [];
  groups.forEach((ids, group) => {
    const count = Math.ceil(ids.length / rowsFor(ids.length));
    const rows = Math.ceil(ids.length / count);
    for (let i = 0; i < count; i++) {
      const chunk = ids.slice(i * rows, (i + 1) * rows);
      const sizes = chunk.map((id) => nodeSize(index, id));
      subs.push({
        ids: chunk,
        group,
        width: Math.max(...sizes.map((s) => s.width)),
        height: sizes.reduce((h, s, j) => h + s.height + (j > 0 ? ROW_GAP : 0), 0),
        gapAfter: i < count - 1 ? WRAP_GAP : LAYER_GAP,
      });
    }
  });
  const groupHeight = groups.map((_, g) =>
    Math.max(...subs.filter((s) => s.group === g).map((s) => s.height)),
  );
  const tallest = Math.max(...groupHeight, 0);

  const boxes = new Map<string, Rect>();
  const slots = new Map<string, Slot>();
  const columns: Column[] = [];
  let x = PAD;
  subs.forEach((sub, column) => {
    // A layer column is centered; its sub-columns share its top, so their rows line up.
    let y = PAD + (tallest - (groupHeight[sub.group] ?? 0)) / 2;
    sub.ids.forEach((id, row) => {
      const size = nodeSize(index, id);
      boxes.set(id, { x: x + (sub.width - size.width) / 2, y, ...size });
      slots.set(id, { group: sub.group, column, row });
      y += size.height + ROW_GAP;
    });
    columns.push({
      group: sub.group,
      left: x,
      right: x + sub.width,
      first: subs[column - 1]?.group !== sub.group,
      last: subs[column + 1]?.group !== sub.group,
    });
    x += sub.width + sub.gapAfter;
  });
  const last = subs.at(-1);
  const width = last ? x - last.gapAfter + PAD : 0;
  return { boxes, slots, columns, width, height: tallest + 2 * PAD };
}

/**
 * A forward line between layer columns when either end is in a wrapped
 * sub-column: out of the source's bottom (or its right side, from the last
 * sub-column) into the gap below it, across to the middle of the gap before
 * the target's layer column, then along the gap above the target and into
 * its top (or its left side, in the first sub-column).
 */
function gapRoute(from: Rect, to: Rect, a: Column, b: Column, before: number): Point[] {
  const start: Point[] = a.last
    ? [{ x: from.x + from.width, y: from.y + from.height / 2 }]
    : [
        { x: from.x + from.width / 2, y: from.y + from.height },
        { x: from.x + from.width / 2, y: from.y + from.height + ROW_GAP / 2 },
      ];
  const end: Point[] = b.first
    ? [{ x: to.x, y: to.y + to.height / 2 }]
    : [
        { x: to.x + to.width / 2, y: to.y - ROW_GAP / 2 },
        { x: to.x + to.width / 2, y: to.y },
      ];
  const mx = before - LAYER_GAP / 2;
  const sy = (start.at(-1) as Point).y;
  const ty = (end[0] as Point).y;
  return [...start, { x: mx, y: sy }, { x: mx, y: ty }, ...end];
}

/**
 * Routes the lifted edges (see the module comment): lanes beside a
 * sub-column (one per edge, outwards), {@link gapRoute} into and out of
 * wrapped sub-columns, and the prototype's routing for the rest.
 */
function routeAll(edges: readonly ViewEdge[], placement: Placement): PlacedEdge[] {
  const { boxes, slots, columns } = placement;
  const lanes = new Map<number, number>();
  const direct: ViewEdge[] = [];
  const placed = new Map<ViewEdge, PlacedEdge>();
  const firstLeft = (group: number) => columns.find((c) => c.group === group)?.left ?? 0;
  for (const e of edges) {
    const a = slots.get(e.from);
    const b = slots.get(e.to);
    const from = boxes.get(e.from);
    const to = boxes.get(e.to);
    const ca = a && columns[a.column];
    const cb = b && columns[b.column];
    if (!a || !b || !from || !to || !ca || !cb) continue;
    let points: Point[];
    if (a.column === b.column && Math.abs(a.row - b.row) > 1) {
      const lane = lanes.get(a.column) ?? 0;
      lanes.set(a.column, lane + 1);
      const x = ca.right + LANE_GAP * (lane + 1);
      points = [
        { x: from.x + from.width, y: from.y + from.height / 2 },
        { x, y: from.y + from.height / 2 },
        { x, y: to.y + to.height / 2 },
        { x: to.x + to.width, y: to.y + to.height / 2 },
      ];
    } else if (a.group < b.group && (!ca.last || !cb.first)) {
      points = gapRoute(from, to, ca, cb, firstLeft(b.group));
    } else {
      direct.push(e);
      continue;
    }
    placed.set(e, { view: e, points, label: pointAlong(points, 0.5) });
  }
  for (const p of routeEdges(direct, boxes)) placed.set(p.view, p);
  // Graph order, so the drawing order (and the bytes) never depend on routing.
  return edges.flatMap((e) => {
    const p = placed.get(e);
    return p ? [p] : [];
  });
}

/** `var(--<prefix>-<layer>)`, or `var(--<fallback>)` for a node without a layer. */
function color(prefix: string, layer: Layer | undefined, fallback: string): string {
  return layer ? v(`${prefix}-${layer}`) : v(fallback);
}

/** The node's icon at `size` px with its top-left corner at (x, y). */
function iconMarkup(node: GraphNode, x: number, y: number, size: number): string {
  const choice = iconFor(node);
  if (choice.type === "brand") {
    // The same 3px inset as BrandLogo, so logos match the glyphs' optical size.
    const s = size / 30;
    return `<g transform="translate(${num(x)} ${num(y)}) scale(${num(s)}) translate(3 3)" style="fill:${v(`brand-${choice.brand.slug}`)}"><path d="${esc(choice.brand.path)}"/></g>`;
  }
  const s = size / 24;
  return `<g transform="translate(${num(x)} ${num(y)}) scale(${num(s)})" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="stroke:${v("muted")}">${glyphMarkup(choice.glyph)}</g>`;
}

function tile(
  node: GraphNode,
  x: number,
  y: number,
  size: number,
  iconSize: number,
  rx: number,
): string {
  const ring = color("ring", node.layer, "border");
  const inset = (size - iconSize) / 2;
  return (
    `<rect${attrs({ x: x + 0.5, y: y + 0.5, width: size - 1, height: size - 1, rx })} style="fill:${v("s1")};stroke:${ring}"/>` +
    iconMarkup(node, x + inset, y + inset, iconSize)
  );
}

/**
 * One line of node text: plain then code, as `<text>` with a mono `<tspan>`,
 * cut to `max` px. `anchor` is `start` or `middle`.
 */
function textLine(
  line: NodeText & { method?: string },
  at: Point,
  max: number,
  size: number,
  style: { weight?: number; muted?: boolean; anchor?: "start" | "middle" },
): string {
  const pieces: { text: string; mono: boolean }[] = [];
  if (line.method) pieces.push({ text: line.method, mono: true });
  if (line.text) pieces.push({ text: line.text, mono: false });
  if (line.code) pieces.push({ text: line.code, mono: true });
  if (pieces.length === 0) return "";
  let left = max;
  const out: string[] = [];
  for (const [i, piece] of pieces.entries()) {
    const gap = i > 0 ? textWidth(" ", size) : 0;
    if (left - gap <= size) break;
    const shown = fit(piece.text, left - gap, size, piece.mono);
    left -= gap + textWidth(shown, size, piece.mono);
    const text = `${i > 0 ? " " : ""}${esc(shown)}`;
    out.push(piece.mono ? `<tspan font-family="${esc(MONO)}">${text}</tspan>` : text);
    if (shown !== piece.text) break;
  }
  return `<text${attrs({
    x: at.x,
    y: at.y,
    "font-size": size,
    "font-weight": style.weight,
    "text-anchor": style.anchor === "middle" ? "middle" : undefined,
  })} style="fill:${v(style.muted ? "muted" : "text")}" xml:space="preserve">${out.join("")}</text>`;
}

function frameNode(index: GraphIndex, node: GraphNode, box: Rect): string {
  const { layer } = node;
  const border = color("frame-border", layer, "border");
  const { x, y, width: w, height: h } = box;
  const counts = frameCounts(index, node.id);
  const rx = node.kind === "module" ? 12 : 16;
  const out = [
    // The stacked edge (nodes.css `--gi-lip`): a sliver of border, then of tint, under the card.
    `<rect${attrs({ x: x + 3, y: y + 9, width: w - 6, height: h - 6, rx })} style="fill:${border}"/>`,
    `<rect${attrs({ x: x + 4, y: y + 10, width: w - 8, height: h - 8, rx })} style="fill:${color("lip", layer, "s1")}"/>`,
    `<rect${attrs({ x: x + 0.5, y: y + 0.5, width: w - 1, height: h - 1, rx })} style="fill:${color("frame", layer, "s1")};stroke:${border}"/>`,
    tile(node, x + 12, y + 15, 32, TILE_ICON_SIZE.sm, 6),
  ];
  const textX = x + 56;
  const max = w - 56 - 16;
  out.push(textLine(nodeLabel(node), { x: textX, y: y + 28 }, max, 14, { weight: 600 }));
  out.push(textLine(nodeSubtitle(node), { x: textX, y: y + 45 }, max, 12, { muted: true }));
  let px = textX;
  for (const count of counts) {
    const text = countText(count);
    const pw = Math.ceil(textWidth(text, 12)) + 14;
    if (px + pw > x + w - 12) break;
    out.push(
      `<rect${attrs({ x: px + 0.5, y: y + 62.5, width: pw - 1, height: 19, rx: 9.5 })}${count.unresolved ? ' stroke-dasharray="1.5 2"' : ""} style="fill:${v("s1")};stroke:${v(count.unresolved ? "muted" : "border")}"/>`,
      `<text${attrs({ x: px + 7, y: y + 76, "font-size": 12 })} style="fill:${v("muted")}">${esc(text)}</text>`,
    );
    px += pw + 4;
  }
  return out.join("");
}

function iconNode(node: GraphNode, box: Rect): string {
  const { x, y, width: w } = box;
  const cx = x + w / 2;
  return [
    tile(node, cx - 28, y, 56, TILE_ICON_SIZE.lg, 12),
    textLine(nodeLabel(node), { x: cx, y: y + 78 }, w, 13, { weight: 500, anchor: "middle" }),
    textLine(nodeSubtitle(node), { x: cx, y: y + 96 }, w, 12, { muted: true, anchor: "middle" }),
  ].join("");
}

function cardNode(node: GraphNode, box: Rect): string {
  const { x, y, width: w, height: h } = box;
  const unresolved = node.kind === "unresolved";
  return [
    `<rect${attrs({ x: x + 0.5, y: y + 0.5, width: w - 1, height: h - 1, rx: 10 })}${unresolved ? ' stroke-dasharray="1.5 2.5"' : ""} style="fill:${v(unresolved ? "canvas" : "s1")};stroke:${unresolved ? v("muted") : color("frame-border", node.layer, "border")}"/>`,
    tile(node, x + 10, y + 10, 32, TILE_ICON_SIZE.sm, 6),
    textLine(nodeLabel(node), { x: x + 52, y: y + 23 }, w - 64, 13, { weight: 500 }),
    textLine(nodeSubtitle(node), { x: x + 52, y: y + 39 }, w - 64, 12, { muted: true }),
  ].join("");
}

function nodeMarkup(index: GraphIndex, node: GraphNode, box: Rect): string {
  switch (nodeTier(node)) {
    case "frame":
      return frameNode(index, node, box);
    case "icon":
      return iconNode(node, box);
    case "card":
      return cardNode(node, box);
  }
}

function edgeMarkup(index: GraphIndex, placed: PlacedEdge): string {
  const { view } = placed;
  const geometry = edgeGeometry(placed.points);
  const source = index.byId.get(view.from);
  const stroke = color("edge", source?.layer, "muted");
  const style = LINE_STYLE[view.confidence];
  // The same dashes and widths as edges.css.
  const line = attrs({
    d: geometry.d,
    fill: "none",
    "stroke-width": style === "dotted" ? 2 : 1.5,
    "stroke-linecap": style === "dashed" ? "butt" : "round",
    "stroke-linejoin": "round",
    "stroke-dasharray": style === "dashed" ? "6 4" : style === "dotted" ? "0 5" : undefined,
  });
  const out = [
    `<path${line} style="stroke:${stroke}"/>`,
    style === "dotted"
      ? `<path d="${geometry.chevron}" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="stroke:${stroke}"/>`
      : `<path d="${geometry.arrow}" stroke-width="1" stroke-linejoin="round" style="fill:${stroke};stroke:${stroke}"/>`,
  ];
  if (style === "dot") {
    out.push(
      `<circle${attrs({ cx: geometry.dot.x, cy: geometry.dot.y, r: 2.5 })} style="fill:${stroke}"/>`,
    );
  }
  return out.join("");
}

function labelMarkup(placed: PlacedEdge): string {
  const { edge, count } = drawnEdge(placed.view);
  const text = fit(edgeLabelText(edgeLabel(edge, count)), LABEL_MAX, 11);
  const width = Math.ceil(textWidth(text, 11)) + 14;
  const { x, y } = placed.label;
  return (
    `<rect${attrs({ x: x - width / 2, y: y - 9.5, width, height: 19, rx: 9.5 })} style="fill:${v("s2")};stroke:${v("border")}"/>` +
    `<text${attrs({ x, y: y + 4, "font-size": 11, "text-anchor": "middle" })} style="fill:${v("muted")}">${esc(text)}</text>`
  );
}

/** Every logo the drawn nodes use, by slug, so the palette defines just those. */
function brandsOf(nodes: readonly GraphNode[]): Brand[] {
  const out = new Map<string, Brand>();
  for (const n of nodes) {
    const choice = iconFor(n);
    if (choice.type === "brand") out.set(choice.brand.slug, choice.brand);
  }
  return [...out.values()].sort((a, b) => compareStrings(a.slug, b.slug));
}

function footer(graph: ArchitectureGraph, width: number, top: number): string {
  const y = top + 26;
  const { owner, name, sha } = graph.repo;
  const repo = `${owner}/${name}`;
  const brand = 98;
  const max = width - 2 * PAD - brand - 16;
  const repoText = fit(repo, sha ? max - 72 : max, 12);
  return [
    `<line${attrs({ x1: 0, y1: top + 0.5, x2: width, y2: top + 0.5 })} style="stroke:${v("border")}"/>`,
    `<text${attrs({ x: PAD, y, "font-size": 12 })} style="fill:${v("muted")}" xml:space="preserve">${esc(repoText)}${
      sha ? ` <tspan font-family="${esc(MONO)}">${esc(sha.slice(0, 7))}</tspan>` : ""
    }</text>`,
    // The logo mark (chrome/uiIcons.tsx LogoMark) and the name, on the right.
    `<g transform="translate(${num(width - PAD - brand)} ${num(y - 12)}) scale(0.667)">`,
    `<rect x="3" y="3" width="18" height="18" rx="5.5" fill="none" stroke-width="2.25" style="stroke:${v("text")}"/>`,
    `<rect x="9" y="9" width="8" height="8" rx="2" style="fill:${v("accent")}"/>`,
    `</g>`,
    `<text${attrs({ x: width - PAD - brand + 22, y, "font-size": 12, "font-weight": 600 })} style="fill:${v("text")}">GitInside</text>`,
  ].join("");
}

/** The image's layout: a box per top-level node, routed lines, and the drawing's size. */
export interface TopLevelLayout {
  index: GraphIndex;
  top: readonly GraphNode[];
  boxes: ReadonlyMap<string, Rect>;
  /** In graph order. */
  edges: readonly PlacedEdge[];
  width: number;
  /** Without the footer. */
  height: number;
}

/** Lays out a graph's top level for {@link renderDiagram}. */
export function layoutTopLevel(graph: ArchitectureGraph): TopLevelLayout {
  const index = indexGraph(graph);
  const top = index.children.get(index.root.id) ?? [];
  const edges = liftEdges(index, new Set(top.map((n) => n.id)));
  const placement = place(index, top);
  const routed = routeAll(edges, placement);
  const laneRight = Math.max(...routed.flatMap((p) => p.points.map((q) => q.x)), 0);
  return {
    index,
    top,
    boxes: placement.boxes,
    edges: routed,
    width: Math.max(placement.width, laneRight + PAD, MIN_WIDTH),
    height: top.length > 0 ? placement.height : 2 * PAD + 40,
  };
}

/**
 * The graph's top level as a standalone SVG document (`image/svg+xml`).
 * Throws only on a graph without a root, which a schema-valid graph never is.
 */
export function renderDiagram(graph: ArchitectureGraph, options: DiagramImageOptions = {}): string {
  const theme = options.theme ?? "auto";
  const { index, top, boxes, edges: routed, width, height: bodyHeight } = layoutTopLevel(graph);
  const height = bodyHeight + FOOTER;
  const title = `${graph.repo.owner}/${graph.repo.name} architecture`;

  const body =
    top.length === 0
      ? `<text${attrs({ x: width / 2, y: bodyHeight / 2 + 5, "font-size": 14, "text-anchor": "middle" })} style="fill:${v("muted")}">No services found in this commit.</text>`
      : [
          ...routed.map((p) => edgeMarkup(index, p)),
          ...top.map((n) => {
            const box = boxes.get(n.id);
            return box ? nodeMarkup(index, n, box) : "";
          }),
          ...routed.map(labelMarkup),
        ].join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="gi"${attrs({
      width,
      height,
      viewBox: `0 0 ${num(width)} ${num(height)}`,
      role: "img",
      "aria-labelledby": "gi-title gi-desc",
    })}>`,
    `<title id="gi-title">${esc(title)}</title>`,
    `<desc id="gi-desc">${esc(summary(graph))}</desc>`,
    `<style>${paletteCss(theme, brandsOf(top))}</style>`,
    `<rect${attrs({ x: 0.5, y: 0.5, width: width - 1, height: height - 1, rx: 12 })} style="fill:${v("canvas")};stroke:${v("border")}"/>`,
    `<g font-family="${esc(SANS)}">`,
    body,
    footer(graph, width, bodyHeight),
    `</g>`,
    `</svg>`,
  ].join("");
}
