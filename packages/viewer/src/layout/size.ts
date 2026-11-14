import type { GraphNode, Layer } from "@gitinside/schema";
import { edgeLabel, type EdgeText } from "../edges/describe.js";
import { textWidth } from "../image/markup.js";
import { cardLook, nameLines, type CardLook } from "../nodes/cards.js";
import type { DiffCounts, DiffMarks, LineMark } from "../model/diff.js";
import { countsInside, layerOf, type HierarchyIndex } from "../model/hierarchy.js";
import { drawnEdge, edgeWithin, type ViewEdge, type ViewNode } from "../model/view.js";
import {
  countText,
  DIFF_TEXT,
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
/**
 * Room a path-only frame keeps below its children for "+ N more" (M10.3d2): the button
 * (`.gi-drill__more`, {@link MORE_BUTTON} tall) and a gap of 8px above it.
 */
export const MORE_BUTTON = 24;
export const MORE_FOOT = MORE_BUTTON + 8;
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

/** A change badge's dot and the gap after it (`.gi-badge__dot`, `.gi-badge`'s gap). */
const BADGE_DOT = 6 + 5;

/** Width of a row of count badges, without the space around it. */
function badgesWidth(counts: readonly NodeCount[]): number {
  if (counts.length === 0) return 0;
  const badges = counts.reduce(
    (w, c) => w + textWidth(countText(c), 12) + BADGE_CHROME + (c.diff ? BADGE_DOT : 0),
    0,
  );
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

const CHANGES: readonly (keyof DiffCounts)[] = ["added", "changed", "removed", "broken"];

/**
 * Diff mode's badges for a closed box holding changes (M6.9b): how many
 * nodes inside were added, changed, or removed, and how many connections
 * from inside broke. Zero counts are left out.
 */
export function changeCounts(inside: Readonly<DiffCounts> | undefined): NodeCount[] {
  if (!inside) return [];
  return CHANGES.flatMap((status) =>
    inside[status] === 0
      ? []
      : [{ value: inside[status], noun: status, plural: status, diff: status }],
  );
}

/** The prototype's look for a visible box (`cardLook`); an open box keeps the shipped header. */
export function viewCardLook(index: HierarchyIndex, view: ViewNode): CardLook | undefined {
  return view.open ? undefined : cardLook(index, view.node);
}

/**
 * The badges a visible node draws: a frame's counts (an open frame's too, as
 * the floor of its width), then, closed and in diff mode, its change badges.
 * With the prototype's `cards`, a closed service or host group draws its card's
 * counts instead (`cardLook`).
 */
export function viewNodeCounts(
  index: HierarchyIndex,
  view: ViewNode,
  marks?: DiffMarks | undefined,
  cards = false,
): NodeCount[] {
  const card = cards ? viewCardLook(index, view) : undefined;
  const counts = card?.counts
    ? [...card.counts]
    : nodeTier(view.node) === "frame"
      ? frameCounts(index, view.id)
      : [];
  if (!marks || view.open) return counts;
  return [...counts, ...changeCounts(marks.inside(view.id))];
}

/** What sizing a node needs besides the node: the layer it's tinted with and its badges. */
export interface SizeContext {
  /** Its service's layer when it has none of its own (picks window vs box). */
  layer?: Layer | undefined;
  /** Count badges it draws (closed frames). */
  counts?: readonly NodeCount[] | undefined;
  /**
   * The prototype's cards (M10.3b3): names wrap to more lines instead of ending in "…", and
   * services and host groups are sized from their {@link CardLook}.
   */
  wrap?: boolean | undefined;
  /** The prototype's look for this box (`cardLook`), with `wrap`. */
  card?: CardLook | undefined;
}

/** Narrowest and widest a prototype service card grows before its name wraps (M10-design B7). */
export const MIN_WRAP_WIDTH = 200;
export const MAX_WRAP_WIDTH = 280;
/** Height each wrapped line of a name adds: 14px and 13px names at the tight line height. */
export const NAME_LINE = { frame: 18, icon: 17 } as const;
/**
 * Height an icon-first card's caption adds (M10.3c2, `.gi-node__caption`): a 4px gap, the 1px
 * dotted rule, 3px, and one 16px line.
 */
export const CAPTION_ROW = 24;

/**
 * A prototype box's size (M10.3b3), names wrapping rather than cut: a service's card grows to
 * fit its name and subtitle up to {@link MAX_WRAP_WIDTH} (its count row can widen it further),
 * then its name takes a second line; a name that two lines still can't hold widens the card, up
 * to {@link MAX_FRAME_WIDTH}, before taking a third. Icon-first boxes (and a closed host group,
 * drawn with its logo tile) keep their widths and add lines. Other frames are sized as shipped.
 */
function wrappedSize(node: GraphNode, context: SizeContext): Size | undefined {
  const card = context.card;
  const name = card?.name ?? node.label;
  const subtitle = lineWidth(card?.subtitle ?? nodeSubtitle(node), 12, 12);
  if (card?.logos || nodeTier(node) === "icon") {
    const chrome = 2 + 2 * 8 + COUNTS_SLACK;
    const caption = card?.caption ? textWidth(card.caption, 12) : 0;
    const width = Math.ceil(
      clamp(
        chrome + Math.max(textWidth(name, 13), subtitle, caption),
        MIN_ICON_WIDTH,
        MAX_ICON_WIDTH,
      ),
    );
    const lines = nameLines(name, 13, width - chrome);
    return {
      width,
      height: 128 + (lines - 1) * NAME_LINE.icon + (card?.caption ? CAPTION_ROW : 0),
    };
  }
  if (node.kind !== "service" || !card) return undefined;
  const counts = context.counts ?? [];
  const chrome = 2 + 12 + 16 + TILE_ROW + COUNTS_SLACK;
  let width = Math.ceil(
    Math.max(
      clamp(chrome + Math.max(textWidth(name, 14), subtitle), MIN_WRAP_WIDTH, MAX_WRAP_WIDTH),
      countsRowWidth(counts),
    ),
  );
  while (nameLines(name, 14, width - chrome) > 2 && width < MAX_FRAME_WIDTH) width += 8;
  const lines = nameLines(name, 14, width - chrome);
  const band = nodeShape(node, node.layer ?? context.layer) === "window" ? WINDOW_BAND.frame : 0;
  return { width, height: (counts.length > 0 ? 94 : 62) + band + (lines - 1) * NAME_LINE.frame };
}

/**
 * The box a node takes when closed, measured from its content. Frames have
 * a name row and, with badges, a count row under it; cards have one row of
 * tile, name, subtitle, and badges, plus a fields row for a model's table;
 * icon-first nodes have their tile with the name beneath. Windows add their
 * title band.
 */
export function closedSize(node: GraphNode, context: SizeContext = {}): Size {
  const wrapped = context.wrap ? wrappedSize(node, context) : undefined;
  if (wrapped) return wrapped;
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

/**
 * A visible node's closed size in a view: its service's layer, and its badges
 * (`viewNodeCounts`). In diff mode a renamed node fits its base name too,
 * which Base draws (M6.9c2); a version's counts never outgrow the overlay's,
 * which hold both versions' items.
 */
export function viewNodeSize(
  index: HierarchyIndex,
  view: ViewNode,
  marks?: DiffMarks | undefined,
  cards = false,
): Size {
  const card = cards ? viewCardLook(index, view) : undefined;
  const context = {
    layer: layerOf(index, view.id),
    counts: viewNodeCounts(index, view, marks, cards),
    wrap: cards,
    card,
  };
  const size = closedSize(view.node, context);
  const was = marks?.baseNode(view.node);
  if (!was) return size;
  const before = closedSize(was, context);
  return {
    width: Math.max(size.width, before.width),
    height: Math.max(size.height, before.height),
  };
}

/**
 * A drawn line's pill in a view. In diff mode it fits what each of Overlay,
 * Base, and Head draws on it (M6.9c2): the state's word or what broke, and in
 * a version keeping fewer of its connections, theirs (one keeps its own
 * label, wider than "3 calls"), so switching never re-lays out.
 */
export function viewEdgeLabelSize(edge: ViewEdge, marks?: DiffMarks | undefined): Size {
  const size = edgeLabelSize(edge, marks?.line(edge.edges));
  if (!marks) return size;
  const widths = [marks.edgesIn.base, marks.edgesIn.head].map((keep) => {
    const kept = edgeWithin(edge, keep);
    return kept ? edgeLabelSize(kept).width : 0;
  });
  return { ...size, width: Math.max(size.width, ...widths) };
}

/** Width of an edge label's text parts: method chip, text, code, then notes after a separator. */
function labelTextWidth(label: EdgeText): number {
  const notes = (label.notes ?? []).map((n) => textWidth(` · ${n}`, 12));
  return lineWidth(label, 12, 12) + notes.reduce((a, b) => a + b, 0);
}

/** A pill's 6px dot, then the 5px gap inside the diff word (`.gi-edge-label__diff`). */
const LABEL_DOT = 6;
const DIFF_WORD_GAP = 5;
/** Gap between a pill's parts (`.gi-edge-label`). */
const LABEL_GAP = 6;

/**
 * The pill an edge's label takes, measured from its words: `POST /api/orders
 * · HTTP`, `reads id, total`, "22 calls". In diff mode (`mark`) it leads
 * with the state in words, and a broken line's pill says what broke instead.
 * Padded 8px and bordered (`.gi-edge-label`), and never wider than the
 * pill's maximum.
 */
export function edgeLabelSize(edge: ViewEdge, mark?: LineMark | undefined): Size {
  const { edge: drawn, count } = drawnEdge(edge);
  const text = mark?.broken
    ? LABEL_DOT + LABEL_GAP + textWidth(mark.broken, 12)
    : labelTextWidth(edgeLabel(drawn, count)) +
      (mark?.diff
        ? LABEL_DOT + DIFF_WORD_GAP + textWidth(DIFF_TEXT[mark.diff], 12) + LABEL_GAP
        : 0);
  return {
    width: Math.ceil(Math.min(2 + 2 * 8 + text + COUNTS_SLACK / 2, MAX_EDGE_LABEL_WIDTH)),
    height: EDGE_LABEL_HEIGHT,
  };
}
