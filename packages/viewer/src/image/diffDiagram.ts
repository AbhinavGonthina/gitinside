import {
  changedRegion,
  type ChangedRegion,
  type RegionConnection,
  type RegionNode,
} from "@gitinside/diff";
import type { ArchitectureGraph, GraphDiff, GraphNode, Layer } from "@gitinside/schema";
import type { Rect } from "../chrome/describe.js";
import { edgeGeometry } from "../edges/geometry.js";
import { TILE_ICON_SIZE } from "../icons/Icon.js";
import { nodeLabel, nodeSubtitle, type NodeText } from "../nodes/describe.js";
import { scaleTokens } from "../tokens.js";
import {
  brandsOf,
  color,
  footer,
  FOOTER,
  PAD,
  place,
  routeAll,
  textLine,
  tile,
  type Placement,
} from "./diagram.js";
import { LABEL_HEIGHT, spreadLabels, type PlacedEdge } from "./layout.js";
import { attrs, esc, fit, num, textWidth } from "./markup.js";
import { paletteCss, v, type ImageTheme } from "./palette.js";

/**
 * The PR comment's image (M15.2a, ADR-0320): what a pull request changes in the
 * architecture, drawn in the README image's style, from the same region the
 * comment's Mermaid summary draws (`changedRegion` in `@gitinside/diff`).
 *
 * - **What's drawn:** broken connections and their ends first, then changed
 *   services, routes, pages, models, datastores, queues, and outside APIs, then
 *   changed connections lifted to them; at most {@link MAX_DIFF_BOXES} boxes,
 *   so a render costs about the same on any repo (ADR-0295). What's left out is
 *   counted in the footer.
 * - **Boxes** are all cards (icon tile, name, and a muted line naming the kind
 *   or framework and the service it's in), placed in layer columns as the
 *   README image places its top level, a box's layer being its service's. A
 *   changed box takes the canvas's diff state: a border in its color, a faint
 *   tint, a tag on its top edge saying the change ("Added", "Renamed from …");
 *   a removed one is dashed and ghosted.
 * - **Lines** are colored by change (broken ones red, thicker, dashed; removed
 *   ones faded and dashed), routed and labeled as in the README image. Their
 *   label pills say the change and kind ("Added http", "Broken: target removed").
 * - **Same input ⇒ same bytes**, as `renderDiagram`: no clock or measuring.
 * - **Untrusted text:** every label, path, and SHA goes through `esc`.
 * - **Not handled:** nested context (a route is drawn alone, not inside its
 *   service's frame), and nodes whose change is only a field: the comment's
 *   text lists those.
 */

/** Most boxes one image draws (ADR-0295): the same cap as the comment's Mermaid summary. */
export const MAX_DIFF_BOXES = 40;

/** Every box is a card this size: the README image's card. */
const CARD = { width: 232, height: 52 } as const;
/** Narrowest image, so the footer's repo, SHAs, and counts fit. */
const MIN_DIFF_WIDTH = 640;
/** Longest line label, as the README image's (the room between layer columns, less a margin). */
const LABEL_MAX = 136;
/** Widest change tag, and how far it rises above its box's top edge. */
const TAG_MAX = 168;
const TAG_RISE = 10;
const SANS = scaleTokens["font-sans"];

type Status = "added" | "changed" | "removed";

/** Options for {@link renderDiffDiagram}. */
export interface DiffDiagramOptions {
  /** Default `auto`: dark, or light when the reader's system prefers it. */
  theme?: ImageTheme;
}

/** A line of the image: a region connection. */
type Line = RegionConnection;

/** The image's layout, for tests and {@link renderDiffDiagram}. */
export interface DiffLayout {
  /** The drawn boxes, by node ID. */
  boxes: ReadonlyMap<string, Rect>;
  /** In the region's order. */
  edges: readonly PlacedEdge<Line>[];
  width: number;
  /** Without the footer. */
  height: number;
}

/** A node's layer: its own, else its nearest ancestor's (a route takes its service's). */
function layerFor(
  node: GraphNode,
  lookup: (id: string) => GraphNode | undefined,
): Layer | undefined {
  let current: GraphNode | undefined = node;
  while (current !== undefined) {
    if (current.layer !== undefined) return current.layer;
    current = current.parentId === null ? undefined : lookup(current.parentId);
  }
  return undefined;
}

/** The label of the service `node` is in, if it's below one. */
function serviceOf(
  node: GraphNode,
  lookup: (id: string) => GraphNode | undefined,
): string | undefined {
  let current = node.parentId === null ? undefined : lookup(node.parentId);
  while (current !== undefined && current.kind !== "service") {
    current = current.parentId === null ? undefined : lookup(current.parentId);
  }
  return current?.label;
}

/** Lays out a region's boxes and lines. */
function layoutRegion(
  nodes: readonly RegionNode[],
  connections: readonly Line[],
  layers: ReadonlyMap<string, Layer | undefined>,
): DiffLayout & { placement: Placement } {
  const placement = place(
    nodes.map(({ node }) => ({ id: node.id, kind: node.kind, layer: layers.get(node.id) })),
    () => CARD,
  );
  const lines = routeAll(connections, placement);
  const widths = lines.map((p) => labelPill(p.view).width);
  // Each box with the band above it where its tag sits, so no label covers a tag.
  const taken = [...placement.boxes.values()].map((b) => ({
    ...b,
    y: b.y - TAG_RISE,
    height: b.height + TAG_RISE,
  }));
  const edges = spreadLabels(lines, widths, taken);
  // A lane's line or a label beside the last column widens the drawing.
  const right = Math.max(
    ...edges.flatMap((p) => p.points.map((q) => q.x)),
    ...edges.flatMap((p, i) => (p.hideLabel ? [] : [p.label.x + (widths[i] ?? 0) / 2])),
    0,
  );
  return {
    placement,
    boxes: placement.boxes,
    edges,
    width: Math.max(placement.width, Math.ceil(right) + PAD, MIN_DIFF_WIDTH),
    height: nodes.length > 0 ? placement.height : 2 * PAD + 40,
  };
}

/** Lays out what {@link renderDiffDiagram} draws for a diff. */
export function layoutDiffDiagram(
  diff: GraphDiff,
  base: ArchitectureGraph,
  head: ArchitectureGraph,
): DiffLayout {
  const { layout } = prepare(diff, base, head);
  return layout;
}

function prepare(diff: GraphDiff, base: ArchitectureGraph, head: ArchitectureGraph) {
  const region = changedRegion(diff, base, head, { maxNodes: MAX_DIFF_BOXES });
  const headNodes = new Map(head.nodes.map((n) => [n.id, n]));
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  // A removed node's ancestors are base's; a drawn node is head's when it still exists.
  const lookup = (id: string): GraphNode | undefined => headNodes.get(id) ?? baseNodes.get(id);
  const layers = new Map(region.nodes.map(({ node }) => [node.id, layerFor(node, lookup)]));
  const layout = layoutRegion(region.nodes, region.connections, layers);
  return { region, lookup, layers, layout };
}

/** The line's stroke color and dashes for its change. */
function lineStyle(status: Line["status"]): { stroke: string; width: number; dash?: string } {
  switch (status) {
    case "broken":
      return { stroke: v("diff-removed"), width: 2, dash: "5 4" };
    case "removed":
      return { stroke: v("diff-removed"), width: 1.5, dash: "6 4" };
    case "added":
      return { stroke: v("diff-added"), width: 1.5 };
    case "changed":
      return { stroke: v("diff-changed"), width: 1.5 };
  }
}

/** The status color a line's label dot and border use. */
const labelStatus = (status: Line["status"]): Status => (status === "broken" ? "removed" : status);

/** A line's label text, cut to fit, and its pill's width (a dot, a gap, then the text). */
export function labelPill(line: Line): { text: string; width: number } {
  const text = fit(line.label, LABEL_MAX - 11, 11);
  return { text, width: Math.ceil(textWidth(text, 11)) + 14 + 11 };
}

function lineMarkup(placed: PlacedEdge<Line>): string {
  const { stroke, width, dash } = lineStyle(placed.view.status);
  const geometry = edgeGeometry(placed.points);
  const faded = placed.view.status === "removed" ? ' opacity="0.5"' : "";
  return (
    `<g${faded}>` +
    `<path${attrs({
      d: geometry.d,
      fill: "none",
      "stroke-width": width,
      "stroke-linecap": dash ? "butt" : "round",
      "stroke-linejoin": "round",
      "stroke-dasharray": dash,
    })} style="stroke:${stroke}"/>` +
    `<path d="${geometry.arrow}" stroke-width="1" stroke-linejoin="round" style="fill:${stroke};stroke:${stroke}"/>` +
    `</g>`
  );
}

function labelMarkup(placed: PlacedEdge<Line>): string {
  if (placed.hideLabel) return "";
  const { text, width } = labelPill(placed.view);
  const { x, y } = placed.label;
  const status = labelStatus(placed.view.status);
  const broken = placed.view.status === "broken";
  const left = x - width / 2;
  return (
    `<rect${attrs({ x: left, y: y - LABEL_HEIGHT / 2, width, height: LABEL_HEIGHT, rx: LABEL_HEIGHT / 2 })} style="fill:${v(broken ? "s1" : "s2")};stroke:${v(broken ? "diff-removed" : `diff-${status}-border`)}"/>` +
    `<circle${attrs({ cx: left + 10, cy: y, r: 3 })} style="fill:${v(`diff-${status}`)}"/>` +
    `<text${attrs({ x: left + 18, y: y + 4, "font-size": 11 })} style="fill:${v("text")}">${esc(text)}</text>`
  );
}

/** The muted second line of a card: its kind or framework, then the service it's in. */
function secondLine(r: RegionNode, lookup: (id: string) => GraphNode | undefined): NodeText {
  const own = nodeSubtitle(r.node);
  const where = r.node.kind === "service" ? undefined : (serviceOf(r.node, lookup) ?? r.where);
  if (where === undefined) return own;
  const text = own.text ? `${own.text} · ${where}` : where;
  // A folder path (a file's) reads after the service: "api · src/lib".
  return own.code ? { text: `${where} ·`, code: own.code } : { text };
}

/** A card for a region node, in its change's colors with its tag. */
function cardMarkup(
  r: RegionNode,
  box: Rect,
  layer: Layer | undefined,
  lookup: (id: string) => GraphNode | undefined,
): string {
  const { x, y, width: w, height: h } = box;
  const status = r.status;
  const removed = status === "removed";
  const unresolved = r.node.kind === "unresolved";
  const fill = status ? v(`diff-${status}-fill`) : v(unresolved ? "canvas" : "s1");
  const stroke = status
    ? v(`diff-${status}`)
    : unresolved
      ? v("muted")
      : color("frame-border", layer, "border");
  const dash = removed
    ? ' stroke-dasharray="5 3"'
    : unresolved
      ? ' stroke-dasharray="1.5 2.5"'
      : "";
  const out = [
    `<rect${attrs({ x: x + 0.5, y: y + 0.5, width: w - 1, height: h - 1, rx: 10 })}${dash} style="fill:${fill};stroke:${stroke}"/>`,
    // A removed box is ghosted, its name struck through, as on the canvas.
    removed ? `<g opacity="0.5">` : "",
    tile(r.node, x + 10, y + 10, 32, TILE_ICON_SIZE.sm, 6, layer),
    textLine(nodeLabel(r.node), { x: x + 52, y: y + 23 }, w - 64, 13, {
      weight: 500,
      strike: removed,
    }),
    textLine(secondLine(r, lookup), { x: x + 52, y: y + 39 }, w - 64, 12, { muted: true }),
    removed ? `</g>` : "",
  ];
  if (status !== undefined && r.change !== undefined) out.push(tagMarkup(r.change, status, box));
  return out.join("");
}

/** The change's tag on a box's top edge, right-aligned (nodes.css `.gi-node__diff`). */
function tagMarkup(change: string, status: Status, box: Rect): string {
  const text = fit(change, TAG_MAX - 25, 11);
  const width = Math.ceil(textWidth(text, 11)) + 14 + 11;
  const left = box.x + box.width - 12 - width;
  const top = box.y - TAG_RISE;
  return (
    `<rect${attrs({ x: left + 0.5, y: top + 0.5, width: width - 1, height: 19, rx: 9.5 })} style="fill:${v("s1")};stroke:${v(`diff-${status}-border`)}"/>` +
    `<circle${attrs({ cx: left + 10, cy: top + 10, r: 3 })} style="fill:${v(`diff-${status}`)}"/>` +
    `<text${attrs({ x: left + 18, y: top + 14, "font-size": 11 })} style="fill:${v("text")}">${esc(text)}</text>`
  );
}

/** "2 broken connections, 3 changed boxes and 4 changed connections." for the image's description. */
function describeRegion(region: ChangedRegion): string {
  const broken = region.connections.filter((c) => c.status === "broken").length;
  const changed = region.nodes.filter((n) => n.status !== undefined).length;
  const lines = region.connections.length - broken;
  const counts: [number, string, string][] = [
    [broken, "broken connection", "broken connections"],
    [changed, "changed box", "changed boxes"],
    [lines, "changed connection", "changed connections"],
  ];
  const parts = counts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (parts.length === 0) return "No architecture-level changes.";
  const last = parts.pop() as string;
  return `${parts.length > 0 ? `${parts.join(", ")} and ${last}` : last}.`;
}

/** The footer's note: the base commit, and what wasn't drawn. */
function footerNote(
  base: ArchitectureGraph,
  region: ChangedRegion,
  edges: readonly PlacedEdge<Line>[],
): string {
  const parts = base.repo.sha ? [`vs ${base.repo.sha.slice(0, 7)}`] : [];
  const { moreNodes, moreConnections } = region;
  const left = [
    ...(moreNodes > 0 ? [`${moreNodes} ${moreNodes === 1 ? "box" : "boxes"}`] : []),
    ...(moreConnections > 0
      ? [`${moreConnections} ${moreConnections === 1 ? "line" : "lines"}`]
      : []),
  ];
  if (left.length > 0) parts.push(`${left.join(" and ")} not drawn`);
  const hidden = edges.filter((p) => p.hideLabel).length;
  if (hidden > 0) parts.push(`${hidden} ${hidden === 1 ? "label" : "labels"} left off`);
  return parts.join(" · ");
}

/**
 * What `diff` changes between `base` and `head`, as a standalone SVG document
 * (`image/svg+xml`) for the PR comment. See the module comment for what it draws.
 */
export function renderDiffDiagram(
  diff: GraphDiff,
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  options: DiffDiagramOptions = {},
): string {
  const theme = options.theme ?? "auto";
  const { region, lookup, layers, layout } = prepare(diff, base, head);
  const { boxes, edges, width, height: bodyHeight } = layout;
  const height = bodyHeight + FOOTER;
  const title = `${head.repo.owner}/${head.repo.name}: architecture changes`;
  const nodes = region.nodes.map((r) => r.node);

  const body =
    region.nodes.length === 0
      ? `<text${attrs({ x: width / 2, y: bodyHeight / 2 + 5, "font-size": 14, "text-anchor": "middle" })} style="fill:${v("muted")}">No architecture-level changes.</text>`
      : [
          ...edges.map(lineMarkup),
          ...region.nodes.map((r) => {
            const box = boxes.get(r.node.id);
            return box ? cardMarkup(r, box, layers.get(r.node.id), lookup) : "";
          }),
          ...edges.map(labelMarkup),
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
    `<desc id="gi-desc">${esc(describeRegion(region))}</desc>`,
    `<style>${paletteCss(theme, brandsOf(nodes), { diff: true })}</style>`,
    `<rect${attrs({ x: 0.5, y: 0.5, width: width - 1, height: height - 1, rx: 12 })} style="fill:${v("canvas")};stroke:${v("border")}"/>`,
    `<g font-family="${esc(SANS)}">`,
    body,
    footer(head, width, bodyHeight, footerNote(base, region, edges)),
    `</g>`,
    `</svg>`,
  ].join("");
}
