import type { GraphNode, Layer } from "@gitinside/schema";
import { edgeLabel, type EdgeText } from "../edges/describe.js";
import { textWidth } from "../image/markup.js";
import { countsInside, layerOf, type HierarchyIndex } from "../model/hierarchy.js";
import { drawnEdge, type ViewEdge, type ViewNode } from "../model/view.js";
import {
  countText,
  modelFieldsText,
  nodeLabel,
  nodeShape,
  nodeSubtitle,
  nodeTier,
  type NodeCount,
  type NodeText,
} from "../nodes/describe.js";

/**
 * Node and edge-label sizes for the layout (M4b.2), measured from what each
 * one draws: its name, subtitle, method chip, count badges, and a model's
 * fields, with the paddings, tile, and gaps of `styles/nodes.css`. Text is
 * estimated ({@link textWidth}, a little on the wide side) because the layout
 * runs before anything is drawn, in a worker and in tests, where nothing can
 * be measured. Widths grow with content between a floor that keeps the
 * diagram's rhythm and a ceiling past which names are cut with an ellipsis
 * (the full name is in the tooltip); count badges never wrap, so they can
 * widen a frame past the ceiling (design gate, DESIGN_SYSTEM.md §1.1).
 * Heights follow the shape's rows, which are fixed.
 */

/** A width and height in px. */
export interface Size {
  width: number;
  height: number;
}

/** A closed frame's narrowest width. */
export const MIN_FRAME_WIDTH = 248;
/** Widest a frame's name row grows before the name is cut; count badges can go past it. */
export const MAX_FRAME_WIDTH = 420;
/** Narrowest and widest a card grows (files, symbols, routes, pages, models, unresolved). */
export const MIN_CARD_WIDTH = 184;
export const MAX_CARD_WIDTH = 360;
/** Narrowest and widest an icon-first node grows (datastores, queues, outside APIs). */
export const MIN_ICON_WIDTH = 136;
export const MAX_ICON_WIDTH = 208;
/**
 * Horizontal space around a closed frame's count row (nodes.css): the 1px
 * borders, the 12px left and 16px right padding, and the 44px indent that
 * lines the row up with the name.
 */
export const FRAME_COUNTS_INSET = 2 + 12 + 16 + 44;
/** A count badge's padding and borders around its text (`.gi-badge`), and the gap between badges. */
export const BADGE_CHROME = 2 * 7 + 2;
export const BADGE_GAP = 4;
/**
 * Spare room on a row of text. The estimate is only a few px over Geist's
 * real widths on short words, and Linux draws text a few px wider than
 * Windows: `@shop/web`'s count row fit by 2px and wrapped in CI.
 */
export const COUNTS_SLACK = 16;
/** Height a window's title band adds (nodes.css `--gi-band`): frames, then page cards. */
export const WINDOW_BAND = { frame: 10, card: 6 } as const;
/** An open frame's header height (before a window's band) and its padding around the children. */
export const FRAME_HEADER = 60;
export const FRAME_PAD = 16;
/** An edge label pill's height, and the widest it gets (`.gi-edge-label`, then an ellipsis). */
export const EDGE_LABEL_HEIGHT = 22;
export const MAX_EDGE_LABEL_WIDTH = 280;

/** A small tile (`sm`, 32px) and the 12px gap after it, which every frame and card row starts with. */
const TILE_ROW = 32 + 12;
/** Gap between the parts of one line (method chip, text, code; `.gi-node__label`). */
const PART_GAP = 6;
/** The route method chip's padding and borders around its text (`.gi-method`). */
const METHOD_CHROME = 2 * 5 + 2;

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/**
 * Width of one line of a node's text: an optional method chip, plain text,
 * and code, `gap` apart. Code is the mono face at 95% of the line's size, as
 * `.gi-node code` draws it (subtitles keep full size).
 */
function lineWidth(line: NodeText & { method?: string }, size: number, codeSize: number): number {
  const parts = [
    line.method ? textWidth(line.method, 11, true) + METHOD_CHROME : 0,
    line.text ? textWidth(line.text, size) : 0,
    line.code ? textWidth(line.code, codeSize, true) : 0,
  ].filter((w) => w > 0);
  return parts.reduce((a, b) => a + b, 0) + PART_GAP * Math.max(parts.length - 1, 0);
}

/** The width of a node's name and subtitle, whichever is wider, at the tier's type sizes. */
function textBlockWidth(node: GraphNode, labelSize: number): number {
  return Math.max(
    lineWidth(nodeLabel(node), labelSize, labelSize * 0.95),
    lineWidth(nodeSubtitle(node), 12, 12),
  );
}

/** Width of a row of count badges, without the space around it. */
function badgesWidth(counts: readonly NodeCount[]): number {
  if (counts.length === 0) return 0;
  const badges = counts.reduce((w, c) => w + textWidth(countText(c), 12) + BADGE_CHROME, 0);
  return badges + BADGE_GAP * (counts.length - 1);
}

/**
 * The width a closed frame's count row needs to stay on one line. No badges
 * need only the inset.
 */
export function countsRowWidth(counts: readonly NodeCount[]): number {
  if (counts.length === 0) return FRAME_COUNTS_INSET;
  return Math.ceil(FRAME_COUNTS_INSET + badgesWidth(counts) + COUNTS_SLACK);
}

/** The kinds a closed frame counts, in badge order: what a reader looks for inside. */
const COUNTED: readonly {
  kind: GraphNode["kind"];
  noun: string;
  unresolved?: boolean;
}[] = [
  { kind: "page", noun: "page" },
  { kind: "route", noun: "route" },
  { kind: "model", noun: "model" },
  { kind: "unresolved", noun: "unresolved call", unresolved: true },
];

/**
 * Count badges for a closed frame: the pages, routes, models, and unresolved
 * calls anywhere inside it (unresolved calls are never hidden). Kinds with
 * none are left out.
 */
export function frameCounts(index: HierarchyIndex, id: string): NodeCount[] {
  const inside = countsInside(index, id);
  return COUNTED.flatMap(({ kind, noun, unresolved }) => {
    const value = inside[kind] ?? 0;
    return value === 0 ? [] : [{ value, noun, ...(unresolved ? { unresolved } : {}) }];
  });
}

/** What sizing a node needs besides the node: the layer it's tinted with and its badges. */
export interface SizeContext {
  /** Its service's layer when it has none of its own (picks window vs box). */
  layer?: Layer | undefined;
  /** Count badges it draws (closed frames). */
  counts?: readonly NodeCount[] | undefined;
}

/**
 * The box a node takes when closed, measured from its content. Frames have
 * a name row and, with badges, a count row under it; cards have one row of
 * tile, name, subtitle, and badges, plus a fields row for a model's table;
 * icon-first nodes have their tile with the name beneath. Windows add their
 * title band.
 */
export function closedSize(node: GraphNode, context: SizeContext = {}): Size {
  const shape = nodeShape(node, node.layer ?? context.layer);
  const counts = context.counts ?? [];
  switch (nodeTier(node)) {
    case "frame": {
      // Borders, 12px left and 16px right padding, then the tile row.
      const nameRow = 2 + 12 + 16 + TILE_ROW + textBlockWidth(node, 14) + COUNTS_SLACK;
      const band = shape === "window" ? WINDOW_BAND.frame : 0;
      return {
        width: Math.ceil(
          Math.max(clamp(nameRow, MIN_FRAME_WIDTH, MAX_FRAME_WIDTH), countsRowWidth(counts)),
        ),
        height: (counts.length > 0 ? 94 : 62) + band,
      };
    }
    case "icon": {
      // 8px padding each side and the borders around the centered name.
      const text = 2 + 2 * 8 + textBlockWidth(node, 13) + COUNTS_SLACK;
      return { width: Math.ceil(clamp(text, MIN_ICON_WIDTH, MAX_ICON_WIDTH)), height: 128 };
    }
    case "card": {
      // Capsules keep 4px more on each side for their round ends.
      const inset = shape === "capsule" ? 12 + 16 : 8 + 12;
      const badges = counts.length > 0 ? 12 + badgesWidth(counts) : 0;
      const row = 2 + inset + TILE_ROW + textBlockWidth(node, 13) + badges + COUNTS_SLACK;
      // The fields row spans the card with 12px on each side (`.gi-node__fields`).
      const fields = modelFieldsText(node);
      const fieldsRow = fields ? 2 + 2 * 12 + textWidth(fields, 12, true) + COUNTS_SLACK : 0;
      return {
        width: Math.ceil(clamp(Math.max(row, fieldsRow), MIN_CARD_WIDTH, MAX_CARD_WIDTH)),
        height: shape === "table" ? 80 : shape === "window" ? 52 + WINDOW_BAND.card : 52,
      };
    }
  }
}

/**
 * Height of an open node's header, above its children: a frame's
 * {@link FRAME_HEADER} plus a window's band; a card opened to show its
 * symbols (a file) keeps its own row as the header.
 */
export function openHeader(node: GraphNode, layer?: Layer): number {
  if (nodeTier(node) !== "frame") return closedSize(node, { layer }).height;
  return FRAME_HEADER + (nodeShape(node, node.layer ?? layer) === "window" ? WINDOW_BAND.frame : 0);
}

/** A visible node's closed size in a view: its service's layer, and badges when it's a frame. */
export function viewNodeSize(index: HierarchyIndex, view: ViewNode): Size {
  const counts = nodeTier(view.node) === "frame" ? frameCounts(index, view.id) : [];
  return closedSize(view.node, { layer: layerOf(index, view.id), counts });
}

/** Width of an edge label's text parts: method chip, text, code, then notes after a separator. */
function labelTextWidth(label: EdgeText): number {
  const notes = (label.notes ?? []).map((n) => textWidth(` · ${n}`, 12));
  return lineWidth(label, 12, 12) + notes.reduce((a, b) => a + b, 0);
}

/**
 * The pill an edge's label takes, measured from its words: `POST /api/orders
 * · HTTP`, `reads id, total`, "22 calls". Padded 8px and bordered
 * (`.gi-edge-label`), and never wider than the pill's maximum.
 */
export function edgeLabelSize(edge: ViewEdge): Size {
  const { edge: drawn, count } = drawnEdge(edge);
  const text = labelTextWidth(edgeLabel(drawn, count));
  return {
    width: Math.ceil(Math.min(2 + 2 * 8 + text + COUNTS_SLACK / 2, MAX_EDGE_LABEL_WIDTH)),
    height: EDGE_LABEL_HEIGHT,
  };
}
