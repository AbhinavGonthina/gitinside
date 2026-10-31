import { useEffect, useState } from "react";
import type { Rect } from "../chrome/describe.js";
import { prefersReducedMotion } from "../motion.js";
import { durations } from "../tokens.js";
import { span } from "./cull.js";
import type { CameraMotion } from "./gestures.js";

/**
 * How long past a glide's duration its start stays drawn: the CSS transition
 * starts a frame or so after the render that sets it, so it lands that much later.
 */
export const GLIDE_SLACK_MS = 100;

/** How long a camera move with this motion glides (explorer.css), in ms. */
function glideMs(motion: CameraMotion): number {
  return motion === "layout" ? durations.layout : motion === "standard" ? durations.standard : 0;
}

/** Whether two rects are the same. */
function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height)
  );
}

/**
 * The part of the diagram the canvas may show while the camera glides
 * (M4b.15c), for culling: `visible` (the camera's destination) and, until
 * the glide lands, every rect it glided from. A glide moves the camera's
 * translate and scale along one eased curve, so each edge of the visible
 * rect moves one way from start to end: the span of the two holds every
 * frame in between. A glide interrupted by another keeps the first one's
 * start too, since the camera is somewhere between them when the second
 * begins.
 *
 * `glides` is whether camera moves glide yet (the explorer's first fit
 * doesn't); `motion` is the current move's (`none`: the pointer, at once).
 * Under reduced motion nothing glides, so it's always `visible`.
 */
export function useGlideSpan(
  visible: Rect | undefined,
  motion: CameraMotion,
  glides: boolean,
): Rect | undefined {
  const [last, setLast] = useState(visible);
  const [trail, setTrail] = useState<Rect | null>(null);
  // Adjust state while rendering (as `usePresence` does), so the render that
  // moves the camera already draws the glide's start.
  let from = trail;
  if (!sameRect(last, visible)) {
    setLast(visible);
    from =
      last !== undefined && glides && glideMs(motion) > 0 && !prefersReducedMotion()
        ? span(trail ?? last, last)
        : null;
    setTrail(from);
  }
  useEffect(() => {
    if (!trail) return;
    const timer = setTimeout(() => setTrail(null), glideMs(motion) + GLIDE_SLACK_MS);
    return () => clearTimeout(timer);
  }, [trail, motion]);
  return from && visible ? span(from, visible) : visible;
}
