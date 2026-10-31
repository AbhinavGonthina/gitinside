import type { Rect } from "../chrome/describe.js";
import {
  fitCamera,
  keepInView,
  placeRect,
  READABLE_ZOOM,
  type Camera,
  type Size,
} from "./camera.js";
import { fitScale } from "./fit.js";
import type { Shown } from "./transition.js";

/**
 * The bounding box of the boxes with these IDs in a layout (diagram
 * coordinates), or undefined when none of them is laid out.
 */
export function boxesRect(
  boxes: readonly (Rect & { id: string })[],
  ids: Iterable<string>,
): Rect | undefined {
  const wanted = new Set(ids);
  let found: { left: number; top: number; right: number; bottom: number } | undefined;
  for (const b of boxes) {
    if (!wanted.has(b.id)) continue;
    found = found
      ? {
          left: Math.min(found.left, b.x),
          top: Math.min(found.top, b.y),
          right: Math.max(found.right, b.x + b.width),
          bottom: Math.max(found.bottom, b.y + b.height),
        }
      : { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
  }
  return (
    found && {
      x: found.left,
      y: found.top,
      width: found.right - found.left,
      height: found.bottom - found.top,
    }
  );
}

/**
 * What must read in a broken-down node: from its frame's top-left corner
 * (its name) to the far corner of its entries (the routes and pages leading
 * a service's first level, UX.md), or its whole frame when it has none.
 * Undefined when it isn't drawn open.
 */
export function entriesRect(shown: Shown, id: string): Rect | undefined {
  if (!shown.view.byId.get(id)?.open) return undefined;
  const frame = shown.layout.boxes.find((b) => b.id === id);
  if (!frame) return undefined;
  const entries = (shown.view.childrenOf.get(id) ?? []).filter(
    (c) => shown.view.byId.get(c)?.section === "entries",
  );
  const rect = boxesRect(shown.layout.boxes, entries);
  if (!rect) return frame;
  return {
    x: frame.x,
    y: frame.y,
    width: rect.x + rect.width - frame.x,
    height: rect.y + rect.height - frame.y,
  };
}

/**
 * The camera the explorer picks itself until the reader pans or zooms
 * (M4b.15f): the fit (`fitCamera`) while the whole level fits at
 * {@link READABLE_ZOOM} or more, else a frame on `focus` (the node broken
 * down last), so a big level opens on what it leads with rather than on a
 * 40% overview whose names are a few pixels tall. The frame is the node's
 * whole box at its fit when that's readable; else at the zoom that fits its
 * name and entries (`entriesRect`), never below {@link READABLE_ZOOM}, with
 * its top-left corner at the inset (`placeRect`). The fit too with no focus
 * to frame.
 */
export function autoCamera(
  shown: Shown | undefined,
  canvas: Size,
  focus: string | undefined,
): Camera {
  const size: Size = shown ? shown.layout : { width: 0, height: 0 };
  const frame =
    shown && focus !== undefined && fitScale(size, canvas) < READABLE_ZOOM
      ? shown.layout.boxes.find((b) => b.id === focus)
      : undefined;
  const entries = frame && shown && entriesRect(shown, frame.id);
  if (!frame || !entries) return fitCamera(size, canvas);
  const whole = fitScale(frame, canvas);
  const zoom = whole >= READABLE_ZOOM ? whole : Math.max(READABLE_ZOOM, fitScale(entries, canvas));
  return keepInView(placeRect(frame, canvas, zoom), size, canvas);
}

/** The node broken down last that the drawn view still has open (`order`: the order they were opened in). */
export function lastOpened(order: readonly string[], shown: Shown | undefined): string | undefined {
  if (!shown) return undefined;
  const open = new Set(shown.view.open);
  return [...order].reverse().find((id) => open.has(id));
}
