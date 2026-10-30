import type { HierarchyIndex } from "../model/hierarchy.js";
import type { ViewEdge } from "../model/view.js";

/**
 * How much of the diagram's text the canvas draws at a zoom (UX.md
 * "Zoom-dependent detail", M4b.4b):
 *
 * - `full`: everything, names, subtitles, counts, model fields, and edge labels.
 * - `names`: box names only; subtitles, counts, fields, and edge labels fade
 *   out, except the pills of the selection's lines and the current trace hop.
 * - `outline`: service names and the lines between services only. Other boxes
 *   keep their shape and icon (the primary marker) without text, unless
 *   selected or on a trace; lines inside one service fade out unless selected
 *   or on a trace; no pills.
 *
 * Nothing is dropped from the model: zooming in brings it all back.
 */
export type Detail = "full" | "names" | "outline";

/**
 * The lowest zoom of each level. Secondary text is 12px, so at 65% it's drawn
 * at about 8px, the smallest that still reads; below that only names (13–14px)
 * stay. 40% is the fit's floor (`fitScale`), so a fitted level never drops to
 * `outline`: only zooming out by hand does.
 */
export const DETAIL_ZOOM = { full: 0.65, names: 0.4 } as const;

/** The detail level drawn at `zoom`. */
export function detailAt(zoom: number): Detail {
  if (zoom >= DETAIL_ZOOM.full) return "full";
  if (zoom >= DETAIL_ZOOM.names) return "names";
  return "outline";
}

/** A service's name is 14px in the diagram (nodes.css, frame labels). */
const SERVICE_LABEL_PX = 14;

/**
 * Below full detail a service's name is scaled up so it's drawn at least
 * this many screen px (up to 3×), like a map's region names: it's the one
 * label left to read a zoomed-out diagram by.
 */
export const SERVICE_NAME_PX = 12;

/**
 * How much a service's name is scaled at `zoom`: 1 at full detail, else
 * enough to draw it at {@link SERVICE_NAME_PX} on screen, at most 3,
 * rounded to a hundredth. A CSS transform does the scaling, so no box is
 * resized; a name wider than its box ends in an ellipsis (the full name is
 * its tooltip and the inspector's heading).
 */
export function serviceNameScale(zoom: number): number {
  if (detailAt(zoom) === "full") return 1;
  const scale = SERVICE_NAME_PX / (SERVICE_LABEL_PX * zoom);
  return Math.round(Math.min(3, Math.max(1, scale)) * 100) / 100;
}

/**
 * The line joins two boxes in the same service (or inside one), so it isn't
 * part of the system-level picture `outline` keeps. A line touching a node
 * outside every service (a datastore, a queue, an outside API) or another
 * service is kept.
 */
export function insideOneService(index: HierarchyIndex, e: ViewEdge): boolean {
  const from = index.service.get(e.from);
  return from !== undefined && from === index.service.get(e.to);
}
