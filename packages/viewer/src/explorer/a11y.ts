import type { EdgeKind } from "@gitinside/schema";
import type { Rect } from "../chrome/describe.js";
import { connectionsOf } from "../model/connections.js";
import { nodeOf, type HierarchyIndex } from "../model/hierarchy.js";
import { nodeAccessibleName } from "../nodes/describe.js";

/** Where an arrow key moves focus on the canvas. */
export type Direction = "up" | "down" | "left" | "right";

/** The arrow keys' directions, by `KeyboardEvent.key`. */
export const ARROW_KEYS: Readonly<Record<string, Direction>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** Boxes may touch or overlap by this much and still count as beyond (ELK's rounding). */
const TOLERANCE = 1;

/** How much a box off to the side counts against it, per pixel, next to one straight ahead. */
const SIDEWAYS_WEIGHT = 2;

/**
 * The box an arrow key moves to from `from` (UX.md: "the nearest node in that
 * direction"): among the boxes wholly past its edge on that side, the one
 * with the least gap, where each pixel off to the side counts double; ties go
 * to the one whose center is nearest the line through `from`'s center, then
 * to the earlier box. "Wholly past" leaves out the frame a box is drawn in
 * and the boxes drawn inside it, so the arrows move between neighbors and
 * Tab goes in and out of frames. `undefined` when nothing is that way.
 * Pure and deterministic.
 */
export function nearestBox(
  boxes: readonly (Rect & { id: string })[],
  from: string,
  direction: Direction,
): string | undefined {
  const start = boxes.find((b) => b.id === from);
  if (!start) return undefined;
  const vertical = direction === "up" || direction === "down";
  const forward = direction === "down" || direction === "right";
  /** A box's extent along the arrow's axis and across it. */
  const along = (r: Rect): [number, number] =>
    vertical ? [r.y, r.y + r.height] : [r.x, r.x + r.width];
  const across = (r: Rect): [number, number] =>
    vertical ? [r.x, r.x + r.width] : [r.y, r.y + r.height];
  const [startLow, startHigh] = along(start);
  const [sideLow, sideHigh] = across(start);
  const middle = (sideLow + sideHigh) / 2;

  let best: { id: string; score: number; offset: number } | undefined;
  for (const b of boxes) {
    if (b.id === from) continue;
    const [low, high] = along(b);
    const gap = forward ? low - startHigh : startLow - high;
    if (gap < -TOLERANCE) continue;
    const [bLow, bHigh] = across(b);
    const sideways = Math.max(0, bLow - sideHigh, sideLow - bHigh);
    const score = Math.max(0, gap) + SIDEWAYS_WEIGHT * sideways;
    const offset = Math.abs((bLow + bHigh) / 2 - middle);
    if (!best || score < best.score || (score === best.score && offset < best.offset)) {
      best = { id: b.id, score, offset };
    }
  }
  return best?.id;
}

/** How many other ends a selection announcement names before "and N more". */
export const ANNOUNCED_ENDS = 5;

/** "a, b and 3 more": names in order, without repeats, the rest counted. */
function nameList(names: readonly string[]): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, ANNOUNCED_ENDS);
  const more = unique.length - shown.length;
  return more > 0
    ? `${shown.join(", ")} and ${more.toLocaleString("en-US")} more`
    : shown.join(", ");
}

/**
 * What the live region says when a node is selected (UX.md "Keyboard and
 * accessibility"): its name and kind, then what it connects to outside
 * itself, as the inspector lists it (`connectionsOf`, the kinds hidden on the
 * canvas left out): "routes/orders, module. Calls payments, db. Called by
 * web." Each list names its first {@link ANNOUNCED_ENDS} ends and counts the
 * rest.
 */
export function selectionAnnouncement(
  index: HierarchyIndex,
  id: string,
  hiddenKinds?: ReadonlySet<EdgeKind>,
): string {
  const { incoming, outgoing } = connectionsOf(index, id, hiddenKinds);
  const out = [nodeAccessibleName(nodeOf(index, id))];
  if (outgoing.length > 0) out.push(`Calls ${nameList(outgoing.map((c) => c.other.label))}`);
  if (incoming.length > 0) out.push(`Called by ${nameList(incoming.map((c) => c.other.label))}`);
  return `${out.join(". ")}.`;
}
