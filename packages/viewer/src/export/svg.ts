import type { GraphNode, Layer } from "@gitinside/schema";
import type { Rect } from "../chrome/describe.js";
import { TILE_ICON_SIZE } from "../icons/Icon.js";
import {
  brandsOf,
  color,
  edgeMarkup,
  FOOTER,
  folderTab,
  footer,
  frameNode,
  iconNode,
  labelMarkup,
  MIN_WIDTH,
  textLine,
  tile,
  windowBand,
} from "../image/diagram.js";
import type { PlacedEdge } from "../image/layout.js";
import { attrs, esc, fit, num } from "../image/markup.js";
import { LAYERS, paletteCss, v } from "../image/palette.js";
import type { LayoutResult } from "../layout/elk.js";
import { edgeLabelSize, WINDOW_BAND } from "../layout/size.js";
import { layerOf, type HierarchyIndex } from "../model/hierarchy.js";
import type { GraphView, ViewNode } from "../model/view.js";
import {
  countText,
  modelFieldsText,
  nodeLabel,
  nodeShape,
  nodeSubtitle,
  nodeTier,
} from "../nodes/describe.js";
import { scaleTokens, themeTokens } from "../tokens.js";
import type { Theme } from "../ViewerRoot.js";

/**
 * The view on screen as a standalone SVG file (UX.md "Export", M4b.10): the
 * boxes, frames, lines, and pills the canvas draws, at the positions its ELK
 * layout gave them, in one theme, with the README image's footer (repo,
 * commit, GitInside).
 *
 * - **Drawn like the canvas:** open nodes as translucent frames around their
 *   children (nested ones deepen the tint) with their name row on top;
 *   closed frames, cards, and icon tiles from the README image's own markup
 *   (`image/diagram.ts`), in their service's layer colors; lines in their
 *   source's layer color, dashed or dotted by confidence, with their pills.
 *   Stacked as on the canvas: open frames (outer first), lines, closed
 *   boxes, pills.
 * - **Same view and layout ⇒ same bytes.** No clock or measuring: text is
 *   sized from estimates and cut with "…" before it could overflow.
 * - **Untrusted text:** every label, path, and host is escaped (`esc`), and
 *   nothing from the graph reaches an attribute name, a style, or a URL.
 * - **Not drawn:** the selection, a trace, and zoom-dependent detail (an
 *   export is always at full detail); fonts aren't embedded, so text uses
 *   Geist where it's installed, else the system's sans and mono.
 */

/** Options for {@link renderViewSvg}. */
export interface ViewSvgOptions {
  theme: Theme;
}

const SANS = scaleTokens["font-sans"];

/** How strongly an open frame tints what's under it (nodes.css `[data-expanded="true"]`). */
const OPEN_TINT = 0.06;

/** A card's row: 52px tall, its 32px tile centered in it (nodes.css `[data-tier="card"]`). */
const CARD_ROW = 52;

/** The raw layer colors, which open frames tint with (the README image's palette has only mixes). */
function layerCss(theme: Theme): string {
  const t = themeTokens[theme];
  return `.gi{${LAYERS.map((l) => `--layer-${l}:${t[`layer-${l}`]}`).join(";")}}`;
}

/** An open frame's fill: its layer's color, faint, so nested frames deepen the tint. */
function tint(layer: Layer | undefined): string {
  return `${color("layer", layer, "muted")};fill-opacity:${OPEN_TINT}`;
}

/** Corner radius by frame shape, as nodes.css: a window 16, a box 6, a folder 12. */
function frameRadius(shape: string): number {
  return shape === "window" ? 16 : shape === "box" ? 6 : 12;
}

/** A broken-down frame (service or folder): translucent, with its name row as the header. */
function openFrame(node: GraphNode, box: Rect, layer: Layer | undefined): string {
  const shape = nodeShape(node, layer);
  const rx = frameRadius(shape);
  const band = shape === "window" ? WINDOW_BAND.frame : 0;
  const border = color("frame-border", layer, "border");
  const { x, width: w } = box;
  const y = box.y + band;
  return [
    `<rect${attrs({ x: x + 0.5, y: box.y + 0.5, width: w - 1, height: box.height - 1, rx })} style="fill:${tint(layer)};stroke:${border}"/>`,
    band > 0 ? windowBand(layer, box, rx, band) : "",
    shape === "folder" ? folderTab(x, box.y, tint(layer), border) : "",
    // The header row (FRAME_HEADER, 60px): the tile centered in it, then the name and subtitle.
    tile(node, x + 12, y + 14, 32, TILE_ICON_SIZE.sm, 6, layer),
    textLine(nodeLabel(node), { x: x + 56, y: y + 27 }, w - 56 - 16, 14, { weight: 600 }),
    textLine(nodeSubtitle(node), { x: x + 56, y: y + 44 }, w - 56 - 16, 12, { muted: true }),
  ].join("");
}

/**
 * A card (file, symbol, route, page, model, unresolved call), in its shape:
 * a capsule for a route, a window's band for a page, a table with its fields
 * row for a model, dotted on the canvas color when unresolved. An open card
 * (a file broken down) keeps its row at the top, above its children.
 */
function card(node: GraphNode, box: Rect, layer: Layer | undefined): string {
  const shape = nodeShape(node, layer);
  const unresolved = node.kind === "unresolved";
  const { x, width: w, height: h } = box;
  const band = shape === "window" ? WINDOW_BAND.card : 0;
  const rx = shape === "capsule" ? Math.min(h, CARD_ROW) / 2 : shape === "table" ? 6 : 10;
  const fill = unresolved ? v("canvas") : shape === "table" ? color("frame", layer, "s1") : v("s1");
  const stroke = unresolved ? v("muted") : v("border");
  const out = [
    `<rect${attrs({ x: x + 0.5, y: box.y + 0.5, width: w - 1, height: h - 1, rx })}${unresolved ? ' stroke-dasharray="1.5 2.5"' : ""} style="fill:${fill};stroke:${stroke}"/>`,
    band > 0 ? windowBand(layer, box, rx, band) : "",
  ];
  const y = box.y + band;
  // Capsules keep 4px more beside the tile for their round ends.
  const tileX = x + (shape === "capsule" ? 13 : 9);
  const textX = tileX + 32 + 12;
  const max = x + w - textX - (shape === "capsule" ? 16 : 12);
  out.push(
    tile(node, tileX, y + (CARD_ROW - 32) / 2, 32, TILE_ICON_SIZE.sm, 6, layer),
    textLine(nodeLabel(node), { x: textX, y: y + 23 }, max, 13, { weight: 500 }),
    textLine(nodeSubtitle(node), { x: textX, y: y + 39 }, max, 12, { muted: true }),
  );
  const fields = modelFieldsText(node);
  if (shape === "table" && fields) {
    // The fields row, ruled off under the header, on the surface color.
    const top = box.y + CARD_ROW + 0.5;
    const r = rx;
    const left = x + 0.5;
    const right = x + w - 0.5;
    const bottom = box.y + h - 0.5;
    out.push(
      `<path d="M${num(left)} ${num(top)}H${num(right)}V${num(bottom - r)}A${r} ${r} 0 0 1 ${num(right - r)} ${num(bottom)}H${num(left + r)}A${r} ${r} 0 0 1 ${num(left)} ${num(bottom - r)}Z" style="fill:${v("s1")};stroke:${stroke}"/>`,
      `<text${attrs({ x: x + 12, y: top + 17.5, "font-size": 12 })} style="fill:${v("muted")}" xml:space="preserve">${esc(fit(fields, w - 24, 12))}</text>`,
    );
  }
  return out.join("");
}

/** One box: an open frame, or the closed node in its tier's markup. */
function boxMarkup(index: HierarchyIndex, n: ViewNode, box: Rect): string {
  const layer = layerOf(index, n.id);
  const tier = nodeTier(n.node);
  if (n.open && tier === "frame") return openFrame(n.node, box, layer);
  if (tier === "frame") return frameNode(index, n.node, box, layer);
  if (tier === "icon") return iconNode(n.node, box, layer);
  return card(n.node, box, layer);
}

/** "12 parts and 9 connections, with api and api/src broken down." */
function describe(view: GraphView): string {
  const counts = `${countText({ value: view.nodes.length, noun: "part" })} and ${countText({
    value: view.edges.length,
    noun: "connection",
  })}`;
  const open = view.nodes.filter((n) => n.open).map((n) => n.node.label);
  if (open.length === 0) return `${counts}.`;
  const last = open.pop() as string;
  const names = open.length > 0 ? `${open.join(", ")} and ${last}` : last;
  return `${counts}, with ${names} broken down.`;
}

/**
 * The view as a standalone SVG document (`image/svg+xml`) from its layout
 * (`LayoutResult` for this view, e.g. from the explorer's layout cache).
 * Boxes and lines the layout has but the view doesn't are skipped.
 */
export function renderViewSvg(
  index: HierarchyIndex,
  view: GraphView,
  layout: LayoutResult,
  options: ViewSvgOptions,
): string {
  const { graph } = index;
  const width = Math.max(layout.width, MIN_WIDTH);
  const bodyHeight = layout.height;
  const height = bodyHeight + FOOTER;

  const boxes = layout.boxes.flatMap((b) => {
    const n = view.byId.get(b.id);
    return n ? [{ n, box: b }] : [];
  });
  const edges = new Map(view.edges.map((e) => [e.id, e]));
  const lines = layout.edges.flatMap((p): PlacedEdge[] => {
    const e = edges.get(p.id);
    return e ? [{ view: e, points: p.points, label: p.label }] : [];
  });

  const body = [
    ...boxes.filter(({ n }) => n.open).map(({ n, box }) => boxMarkup(index, n, box)),
    ...lines.map((p) => edgeMarkup(index, p)),
    ...boxes.filter(({ n }) => !n.open).map(({ n, box }) => boxMarkup(index, n, box)),
    // The layout kept room for each pill at the canvas's size, less its 14px of padding.
    ...lines.map((p) => labelMarkup(p, edgeLabelSize(p.view).width - 14)),
  ].join("");

  const title = `${graph.repo.owner}/${graph.repo.name} architecture`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="gi"${attrs({
      width,
      height,
      viewBox: `0 0 ${num(width)} ${num(height)}`,
      role: "img",
      "aria-labelledby": "gi-title gi-desc",
    })}>`,
    `<title id="gi-title">${esc(title)}</title>`,
    `<desc id="gi-desc">${esc(describe(view))}</desc>`,
    `<style>${paletteCss(options.theme, brandsOf(view.nodes.map((n) => n.node)))}${layerCss(options.theme)}</style>`,
    `<rect${attrs({ x: 0.5, y: 0.5, width: width - 1, height: height - 1, rx: 12 })} style="fill:${v("canvas")};stroke:${v("border")}"/>`,
    `<g font-family="${esc(SANS)}">`,
    body,
    footer(graph, width, bodyHeight),
    `</g>`,
    `</svg>`,
  ].join("");
}
