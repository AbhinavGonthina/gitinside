import type { Rect } from "../chrome/describe.js";
import {
  fitCamera,
  keepInView,
  placeRect,
  READABLE_ZOOM,
  type Camera,
  type Size,
} from "./camera.js";
import { FIT_INSET, fitScale } from "./fit.js";
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
 * The camera that fits a laid-out level: {@link fitCamera} while the level
 * fits the canvas, else at the fit's zoom (its 40% floor) on the window that
 * holds the most boxes wholly in view (M5.13b2). A sparse level of a big
 * monorepo (cal.diy's 113 services lay out 12k × 16k px) can leave the top-left
 * corner, where {@link fitCamera} starts, crossed only by lines. Each box's
 * center is a candidate window center, kept inside the level; ties go to the
 * leftmost window (where the level's flow starts), then the topmost. On an
 * axis that fits, the camera stays where the fit centers it.
 */
export function fitLevel(layout: Size & { boxes: readonly Rect[] }, canvas: Size): Camera {
  const fit = fitCamera(layout, canvas);
  if (canvas.width <= 0 || canvas.height <= 0) return fit;
  const zoom = fit.zoom;
  const room = {
    width: (canvas.width - 2 * FIT_INSET.x) / zoom,
    height: (canvas.height - 2 * FIT_INSET.y) / zoom,
  };
  const overX = layout.width > room.width;
  const overY = layout.height > room.height;
  if (!overX && !overY) return fit;
  const start = (center: number, length: number, space: number) =>
    Math.min(Math.max(center - space / 2, 0), length - space);
  let best: { x: number; y: number; count: number } | undefined;
  for (const b of layout.boxes) {
    const x = overX ? start(b.x + b.width / 2, layout.width, room.width) : 0;
    const y = overY ? start(b.y + b.height / 2, layout.height, room.height) : 0;
    let count = 0;
    for (const o of layout.boxes) {
      const inX = !overX || (o.x >= x && o.x + o.width <= x + room.width);
      const inY = !overY || (o.y >= y && o.y + o.height <= y + room.height);
      if (inX && inY) count++;
    }
    if (
      !best ||
      count > best.count ||
      (count === best.count && (x < best.x || (x === best.x && y < best.y)))
    ) {
      best = { x, y, count };
    }
  }
  if (!best) return fit;
  return {
    zoom,
    x: overX ? Math.round(FIT_INSET.x - best.x * zoom) : fit.x,
    y: overY ? Math.round(FIT_INSET.y - best.y * zoom) : fit.y,
  };
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
 * (M4b.15f): the level's fit ({@link fitLevel}) while the whole level fits at
 * {@link READABLE_ZOOM} or more, else a frame on `focus` (the node broken
 * down last), so a big level opens on what it leads with rather than on a
 * 40% overview whose names are a few pixels tall. The frame is the node's
 * whole box at its fit when that's readable; else at the zoom that fits its
 * name and entries (`entriesRect`), never below {@link READABLE_ZOOM}, with
 * its top-left corner at the inset (`placeRect`). The level's fit too with no
 * focus to frame.
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
  if (!frame || !entries) return shown ? fitLevel(shown.layout, canvas) : fitCamera(size, canvas);
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
