import type { Rect } from "../chrome/describe.js";
import type { LayoutResult } from "../layout/elk.js";
import { ancestry, type HierarchyIndex } from "../model/hierarchy.js";
import { visibleAncestor, type GraphView, type ViewNode } from "../model/view.js";

/**
 * How the canvas moves from one drawn state to the next (M4b.3, UX.md
 * "Opening a node"): the node expands in place, its siblings glide aside,
 * and its children emerge from its center; closing reverses it. Pure, so the
 * motion is decided (and tested) apart from the animation that plays it.
 */

/** A view as drawn: the view and its layout. */
export interface Shown {
  view: GraphView;
  layout: LayoutResult;
}

/** A box in the next state, and where it starts from. */
export interface BoxMove {
  id: string;
  from: Rect;
  to: Rect;
  /** New on the canvas: it starts transparent, centered on the box it comes out of. */
  emerging: boolean;
}

/** A box leaving the canvas: it folds into the center of the box that now holds it, fading out. */
export interface BoxExit {
  node: ViewNode;
  from: Rect;
  to: Rect;
}

/** Every box that moves between two states. Boxes that stay put are left out. */
export interface TransitionPlan {
  moves: BoxMove[];
  exits: BoxExit[];
}

/** A rect of `size` with its center on `on`'s center. */
export function centeredOn(size: Pick<Rect, "width" | "height">, on: Rect): Rect {
  return {
    x: on.x + on.width / 2 - size.width / 2,
    y: on.y + on.height / 2 - size.height / 2,
    width: size.width,
    height: size.height,
  };
}

function rects(layout: LayoutResult): Map<string, Rect> {
  return new Map(layout.boxes.map(({ id, x, y, width, height }) => [id, { x, y, width, height }]));
}

const same = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Plans the move from `prev` to `next`. A box in both glides from its old
 * rect (or from `current`, where it's drawn now if a glide was cut short) to
 * its new one. A new box emerges from the center of its nearest ancestor that
 * was drawn before (the node just broken down). A box that's gone folds into
 * the center of the box holding it now (the node just closed). Moves are in
 * the next layout's order, exits in the previous one's.
 */
export function planTransition(
  index: HierarchyIndex,
  prev: Shown,
  next: Shown,
  current: ReadonlyMap<string, Rect> = new Map(),
): TransitionPlan {
  const before = rects(prev.layout);
  const after = rects(next.layout);
  const drawnNow = (id: string) => current.get(id) ?? before.get(id);

  const moves: BoxMove[] = [];
  for (const [id, to] of after) {
    const was = drawnNow(id);
    if (was) {
      if (!same(was, to)) moves.push({ id, from: was, to, emerging: false });
      continue;
    }
    const source = ancestry(index, id)
      .slice(1)
      .find((a) => prev.view.byId.has(a.id));
    const anchor = source ? drawnNow(source.id) : undefined;
    moves.push({ id, from: anchor ? centeredOn(to, anchor) : to, to, emerging: true });
  }

  const exits: BoxExit[] = [];
  for (const [id, was] of before) {
    const node = prev.view.byId.get(id);
    if (after.has(id) || !node) continue;
    const holder = visibleAncestor(index, next.view, id);
    const anchor = holder ? after.get(holder) : undefined;
    const from = current.get(id) ?? was;
    exits.push({ node, from, to: anchor ? centeredOn(from, anchor) : from });
  }
  return { moves, exits };
}
