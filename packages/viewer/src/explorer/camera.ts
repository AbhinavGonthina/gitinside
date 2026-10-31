import type { Rect } from "../chrome/describe.js";
import { FIT_INSET, fitScale } from "./fit.js";

/**
 * Where the explorer's canvas looks (M4b.4): a diagram point `p` is drawn at
 * `p * zoom + (x, y)` canvas pixels. Pure values; the explorer turns one into
 * a CSS transform.
 */
export interface Camera {
  zoom: number;
  x: number;
  y: number;
}

/** A width and height in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** A point in canvas pixels or diagram coordinates. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Zoom limits and the step of the − / + buttons and keys. Below 25% a
 * service's name is under 4px; above 200% a card fills a laptop canvas.
 */
export const ZOOM = { min: 0.25, max: 2, step: 1.25 } as const;

/** How much of the diagram stays on the canvas however far it's panned, in canvas px. */
export const KEEP_IN_VIEW = 48;

const round = (n: number) => Math.round(n * 100) / 100;

/** `zoom` within {@link ZOOM}'s limits, rounded to a hundredth. */
export function clampZoom(zoom: number): number {
  return round(Math.min(ZOOM.max, Math.max(ZOOM.min, zoom)));
}

/**
 * The lowest zoom the explorer frames something at when it picks the camera
 * itself (after a drill-down, on a trace step; M4b.15f). Box names (13–14px)
 * are drawn at about 11px and secondary text (12px) at about 10px, a step
 * above `DETAIL_ZOOM.full` (65%), the least that still reads. The fit's 40%
 * floor draws names at about 5px.
 */
export const READABLE_ZOOM = 0.8;

/**
 * The camera that fits the diagram (`fitScale`: 40–100%): centered on an axis
 * where it fits, else starting at {@link FIT_INSET} so its first column (a
 * service's routes) is in view and the rest is a pan away. An unmeasured
 * canvas (0 × 0, as in tests) gets 100% at the origin.
 */
export function fitCamera(diagram: Size, canvas: Size): Camera {
  return placeRect({ x: 0, y: 0, ...diagram }, canvas, fitScale(diagram, canvas));
}

/**
 * The camera at `zoom` that places `rect` (diagram coordinates) the way
 * {@link fitCamera} places a whole diagram: centered on an axis where it
 * fits, else with its top or left edge at {@link FIT_INSET}, so what starts
 * there (a frame's name, its first column) is in view. An unmeasured canvas
 * gets 100% at the origin.
 */
export function placeRect(rect: Rect, canvas: Size, zoom: number): Camera {
  if (canvas.width <= 0 || canvas.height <= 0) return { zoom: 1, x: 0, y: 0 };
  const place = (room: number, start: number, length: number, inset: number) => {
    const free = room - length * zoom;
    return Math.round((free >= 2 * inset ? free / 2 : inset) - start * zoom);
  };
  return {
    zoom,
    x: place(canvas.width, rect.x, rect.width, FIT_INSET.x),
    y: place(canvas.height, rect.y, rect.height, FIT_INSET.y),
  };
}

/**
 * Room a trace hop's ends keep from the canvas's edges, in canvas px: clear
 * of the overlays in its corners, the trace and filter chips on top and the
 * minimap (about 140px tall) and legend below (M4b.15f).
 */
export const HOP_MARGIN = { x: 48, y: 160 } as const;

/**
 * How a trace step moves the camera (M4b.15f): the zoom stays as it is,
 * raised to {@link READABLE_ZOOM} from below it, and lowered as far as it
 * takes to show both ends of the hop (`rect`, their bounding box) with
 * `margin` to spare. Unchanged (the same object) when that's the zoom
 * already and both ends are wholly on the canvas; else centered on them.
 * The margin on each side is at most a quarter of the canvas, so a short
 * canvas keeps half its room for the hop instead of none (M4b.15h).
 */
export function frameHop(
  camera: Camera,
  rect: Rect,
  canvas: Size,
  wanted: { x: number; y: number } = HOP_MARGIN,
): Camera {
  if (canvas.width <= 0 || canvas.height <= 0) return camera;
  const margin = {
    x: Math.min(wanted.x, canvas.width / 4),
    y: Math.min(wanted.y, canvas.height / 4),
  };
  const fits = clampZoom(
    Math.min(
      (canvas.width - 2 * margin.x) / Math.max(rect.width, 1),
      (canvas.height - 2 * margin.y) / Math.max(rect.height, 1),
    ),
  );
  const zoom = Math.min(fits, Math.max(camera.zoom, READABLE_ZOOM));
  const left = rect.x * camera.zoom + camera.x;
  const top = rect.y * camera.zoom + camera.y;
  const inside =
    left >= margin.x &&
    top >= margin.y &&
    left + rect.width * camera.zoom <= canvas.width - margin.x &&
    top + rect.height * camera.zoom <= canvas.height - margin.y;
  if (zoom === camera.zoom && inside) return camera;
  return centerOn(
    { zoom, x: 0, y: 0 },
    { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    canvas,
  );
}

/** The camera at `zoom` (clamped) with the diagram point under canvas point `at` kept there. */
export function zoomAt(camera: Camera, zoom: number, at: Point): Camera {
  const next = clampZoom(zoom);
  const k = next / camera.zoom;
  return {
    zoom: next,
    x: round(at.x - (at.x - camera.x) * k),
    y: round(at.y - (at.y - camera.y) * k),
  };
}

/**
 * One step in or out (`direction` 1 or −1) around the canvas's center: the
 * level times or divided by {@link ZOOM}`.step`, clamped.
 */
export function stepZoom(camera: Camera, direction: 1 | -1, canvas: Size): Camera {
  const zoom = direction > 0 ? camera.zoom * ZOOM.step : camera.zoom / ZOOM.step;
  return zoomAt(camera, zoom, { x: canvas.width / 2, y: canvas.height / 2 });
}

/** The zoom factor for one wheel or pinch event's `deltaY` in pixels (negative zooms in). */
export function wheelZoomFactor(deltaY: number): number {
  return 2 ** (-deltaY / 250);
}

/** The camera moved by `dx`, `dy` canvas pixels. */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { zoom: camera.zoom, x: round(camera.x + dx), y: round(camera.y + dy) };
}

/**
 * The camera panned back just enough that at least {@link KEEP_IN_VIEW}
 * pixels of the diagram (or all of it, if it's smaller) stay on each axis of
 * the canvas, so it can't be lost off the edge. An unmeasured canvas keeps
 * the camera.
 */
export function keepInView(camera: Camera, diagram: Size, canvas: Size): Camera {
  if (canvas.width <= 0 || canvas.height <= 0) return camera;
  const axis = (pos: number, length: number, room: number) => {
    const drawn = length * camera.zoom;
    const keep = Math.min(KEEP_IN_VIEW, drawn, room);
    return Math.min(room - keep, Math.max(keep - drawn, pos));
  };
  return {
    zoom: camera.zoom,
    x: round(axis(camera.x, diagram.width, canvas.width)),
    y: round(axis(camera.y, diagram.height, canvas.height)),
  };
}

/** The part of the diagram the canvas shows, in diagram coordinates. */
export function visibleRect(camera: Camera, canvas: Size): Rect {
  return {
    x: round(-camera.x / camera.zoom),
    y: round(-camera.y / camera.zoom),
    width: round(canvas.width / camera.zoom),
    height: round(canvas.height / camera.zoom),
  };
}

/** The camera at the same zoom with diagram point `p` at the canvas's center. */
export function centerOn(camera: Camera, p: Point, canvas: Size): Camera {
  return {
    zoom: camera.zoom,
    x: round(canvas.width / 2 - p.x * camera.zoom),
    y: round(canvas.height / 2 - p.y * camera.zoom),
  };
}

/**
 * The camera unchanged if `box` (diagram coordinates) is wholly on the canvas
 * with `margin` canvas px to spare, else centered on the box: how the
 * explorer flies to a connection picked in the inspector, and follows
 * keyboard focus. A box too big for the canvas at this zoom (a broken-down
 * frame) counts as its top-left part that fits, where its name is, so it's
 * that part that's brought into view.
 */
export function ensureVisible(camera: Camera, whole: Rect, canvas: Size, margin = 24): Camera {
  if (canvas.width <= 0 || canvas.height <= 0) return camera;
  const room = (length: number, space: number) =>
    Math.min(length, Math.max(0, (space - 2 * margin) / camera.zoom));
  const box = {
    x: whole.x,
    y: whole.y,
    width: room(whole.width, canvas.width),
    height: room(whole.height, canvas.height),
  };
  const left = box.x * camera.zoom + camera.x;
  const top = box.y * camera.zoom + camera.y;
  const inside =
    left >= margin &&
    top >= margin &&
    left + box.width * camera.zoom <= canvas.width - margin &&
    top + box.height * camera.zoom <= canvas.height - margin;
  if (inside) return camera;
  return centerOn(camera, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, canvas);
}

/**
 * How the explorer flies to a command palette pick: centered on `box` at
 * 100%, or less if that's what it takes to fit the box with `margin` to
 * spare. A camera already zoomed in at least that far only pans if it must
 * ({@link ensureVisible}); it never zooms out.
 */
export function zoomToBox(camera: Camera, box: Rect, canvas: Size, margin = 24): Camera {
  if (canvas.width <= 0 || canvas.height <= 0) return camera;
  const fits = Math.min(
    (canvas.width - 2 * margin) / Math.max(box.width, 1),
    (canvas.height - 2 * margin) / Math.max(box.height, 1),
  );
  const zoom = clampZoom(Math.min(1, fits));
  if (camera.zoom >= zoom) return ensureVisible(camera, box, canvas, margin);
  return centerOn(
    { zoom, x: 0, y: 0 },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    canvas,
  );
}

/**
 * The camera moved so a box that went from `before` to `after` (diagram
 * coordinates, e.g. the node just broken down) keeps its top-left corner where
 * it was on the canvas: drilling with a hand-set camera doesn't throw the
 * diagram around.
 */
export function holdInPlace(camera: Camera, before: Point, after: Point): Camera {
  return panBy(camera, (before.x - after.x) * camera.zoom, (before.y - after.y) * camera.zoom);
}

/** Two cameras draw the same. */
export function sameCamera(a: Camera, b: Camera): boolean {
  return a.zoom === b.zoom && a.x === b.x && a.y === b.y;
}
