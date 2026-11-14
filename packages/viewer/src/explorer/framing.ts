import { compareStrings } from "@gitinside/schema";
import type { Rect } from "../chrome/describe.js";
import { CODE_KINDS, type GraphView } from "../model/view.js";
import {
  fitCamera,
  keepInView,
  placeRect,
  READABLE_ZOOM,
  type Camera,
  type Size,
} from "./camera.js";
import { FIRST_VIEW, FIT_INSET, fitScale } from "./fit.js";
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
 * `pick`'s camera for the canvas below a band over its top, `top` canvas px
 * tall (M9.2g: the first-visit hint's card, which covered pawtograder's top
 * box): `pick` fits the canvas less the band's height past
 * {@link FIT_INSET}'s top, and the camera moves down by as much, so nothing
 * it fits starts under the band. `pick`'s camera for the whole canvas when
 * that already starts the diagram (its origin) below the band, when the band
 * is within the inset, or when what's left below it couldn't keep the insets
 * (a very short canvas, where the card then covers part of the diagram).
 */
export function belowBand(canvas: Size, top: number, pick: (canvas: Size) => Camera): Camera {
  const extra = Math.ceil(top - FIT_INSET.y);
  const whole = pick(canvas);
  if (
    extra <= 0 ||
    whole.y >= top ||
    canvas.width <= 0 ||
    canvas.height - extra <= 2 * FIT_INSET.y
  ) {
    return whole;
  }
  const camera = pick({ width: canvas.width, height: canvas.height - extra });
  return { ...camera, y: camera.y + extra };
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
 * focus to frame, or with `options.firstView` (the prototype) {@link firstView}.
 */
export function autoCamera(
  shown: Shown | undefined,
  canvas: Size,
  focus: string | undefined,
  options: { firstView?: boolean } = {},
): Camera {
  if (options.firstView && shown && focus === undefined) return firstView(shown, canvas);
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

/**
 * The system level's hub (M10.3b2, M10-design A2): the top-level service with the most lines
 * that aren't code dependency (requests, data, queues, outside calls), ties by ID
 * (`compareStrings`). Undefined when no service has one.
 */
export function hubOf(view: GraphView): string | undefined {
  const lines = new Map<string, number>();
  for (const e of view.edges) {
    if (CODE_KINDS.has(e.kind)) continue;
    for (const id of new Set([e.from, e.to])) {
      const n = view.byId.get(id);
      if (n?.parent === null && n.node.kind === "service") lines.set(id, (lines.get(id) ?? 0) + 1);
    }
  }
  let hub: [string, number] | undefined;
  for (const entry of lines) {
    if (!hub || entry[1] > hub[1] || (entry[1] === hub[1] && compareStrings(entry[0], hub[0]) < 0))
      hub = entry;
  }
  return hub?.[0];
}

/**
 * The prototype's first view of a level with nothing broken down (M10.3b2, M10-design A5): the
 * level's fit ({@link fitLevel}) when it takes {@link FIRST_VIEW}`.least` (70%) or more, else the
 * hub ({@link hubOf}) centered at {@link FIRST_VIEW}`.hub` (80%), moved back on an axis where
 * that would show past the diagram's edge (so the canvas stays full), and the level's fit with
 * no hub.
 */
export function firstView(shown: Shown, canvas: Size): Camera {
  const fit = fitLevel(shown.layout, canvas);
  if (canvas.width <= 0 || canvas.height <= 0 || fit.zoom >= FIRST_VIEW.least) return fit;
  const hub = hubOf(shown.view);
  const box = hub === undefined ? undefined : shown.layout.boxes.find((b) => b.id === hub);
  if (!box) return fit;
  const zoom = FIRST_VIEW.hub;
  const axis = (room: number, inset: number, length: number, at: number) => {
    const drawn = length * zoom;
    if (drawn <= room - 2 * inset) return Math.round((room - drawn) / 2);
    const centered = room / 2 - at * zoom;
    return Math.round(Math.min(inset, Math.max(room - inset - drawn, centered)));
  };
  return {
    zoom,
    x: axis(canvas.width, FIT_INSET.x, shown.layout.width, box.x + box.width / 2),
    y: axis(canvas.height, FIT_INSET.y, shown.layout.height, box.y + box.height / 2),
  };
}

/**
 * The prototype's first view kept clear of the canvas's overlays (M10.3c2, M10-design A9):
 * `overlays` are their boxes in canvas px (the hint line, the toolbar, a chip). On an axis where
 * the level fits the canvas, its boxes are inside {@link FIT_INSET}, clear of them, and the camera
 * stays; on one where it doesn't (a hub framed at 80%), boxes run under the edges, so the camera
 * moves along it to the nearest place (by the sum of the two moves, then the smaller vertical
 * one, then the smaller horizontal one) where no box meets an overlay, staying inside the diagram
 * and keeping `keep` (the hub) inside the insets, or with no `keep` within a quarter of the
 * canvas. The camera as given when there's no such place.
 */
export function clearOfOverlays(
  camera: Camera,
  layout: Size & { boxes: readonly Rect[] },
  canvas: Size,
  overlays: readonly Rect[],
  keep?: Rect,
): Camera {
  const live = overlays.filter((o) => o.width > 0 && o.height > 0);
  const { zoom } = camera;
  const meets = (x: number, y: number) =>
    layout.boxes.some((b) => {
      const left = b.x * zoom + x;
      const top = b.y * zoom + y;
      return live.some(
        (o) =>
          left < o.x + o.width &&
          left + b.width * zoom > o.x &&
          top < o.y + o.height &&
          top + b.height * zoom > o.y,
      );
    });
  if (live.length === 0 || !meets(camera.x, camera.y)) return camera;
  /**
   * Where one axis may go: the camera's own place, and, inside the diagram and with `keep` still
   * clear of the edges, those bounds and just past each span that puts a box under an overlay.
   */
  const places = (axis: "x" | "y") => {
    const [size, room, inset, start, length] =
      axis === "x"
        ? ([layout.width, canvas.width, FIT_INSET.x, "x", "width"] as const)
        : ([layout.height, canvas.height, FIT_INSET.y, "y", "height"] as const);
    const now = camera[axis];
    if (size * zoom <= room - 2 * inset) return [now];
    const reach = room / 4;
    const low = Math.max(
      room - inset - size * zoom,
      keep ? inset - keep[start] * zoom : now - reach,
    );
    const high = Math.min(
      inset,
      keep ? room - inset - (keep[start] + keep[length]) * zoom : now + reach,
    );
    const ends = live.flatMap((o) =>
      layout.boxes.flatMap((b) => [
        Math.floor(o[start] - (b[start] + b[length]) * zoom),
        Math.ceil(o[start] + o[length] - b[start] * zoom),
      ]),
    );
    const inside = [low, high, ...ends].filter((p) => p >= low && p <= high);
    return [...new Set([now, ...inside.map(Math.round)])];
  };
  const ys = places("y");
  const xs = places("x");
  // A level of hundreds of boxes (cal.diy's 113 services) would try too many: it stays.
  if (xs.length * ys.length > MAX_CLEAR_TRIES) return camera;
  const tries = ys.flatMap((y) => xs.map((x) => ({ x, y })));
  const away = (p: { x: number; y: number }) =>
    [
      Math.abs(p.x - camera.x) + Math.abs(p.y - camera.y),
      Math.abs(p.y - camera.y),
      p.y,
      p.x,
    ] as const;
  tries.sort((a, b) => {
    const [ka, kb] = [away(a), away(b)];
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || ka[3] - kb[3];
  });
  const best = tries.find((p) => !meets(p.x, p.y));
  return best ? { zoom, ...best } : camera;
}

/** Most camera places {@link clearOfOverlays} tries. */
const MAX_CLEAR_TRIES = 20_000;

/** The node broken down last that the drawn view still has open (`order`: the order they were opened in). */
export function lastOpened(order: readonly string[], shown: Shown | undefined): string | undefined {
  if (!shown) return undefined;
  const open = new Set(shown.view.open);
  return [...order].reverse().find((id) => open.has(id));
}
