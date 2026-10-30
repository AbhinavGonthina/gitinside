import { useEffect, useState } from "react";
import { durations } from "./tokens.js";

/**
 * Motion helpers for JS-timed animation (DESIGN_SYSTEM.md §4 "Motion"). CSS
 * transitions read the duration tokens, which reduced motion zeroes; anything
 * timed in JS must ask the same media query, so it goes through here.
 */

/** The media query that turns motion off (tokens.css uses the same one). */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Whether the user asked for reduced motion. False where `matchMedia` is missing (SSR, jsdom). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

/** Where an overlay is in its life: shown, playing its exit, or gone. */
export type Presence = "open" | "closing" | null;

/**
 * Keeps an overlay (the legend, the command palette) mounted while it plays
 * its exit, so it leaves the way it came instead of vanishing. Returns
 * `"open"` while `open`, `"closing"` for `exitMs` after it turns false, then
 * `null` (unmount). The caller sets `data-state` from it; CSS plays the exit
 * and makes a closing overlay inert. Reopening mid-exit returns to `"open"`.
 * Under reduced motion, or with `exitMs` 0, it unmounts at once.
 */
export function usePresence(open: boolean, exitMs: number = durations.fast): Presence {
  const [closing, setClosing] = useState(false);
  const [last, setLast] = useState(open);
  // Adjust state while rendering (React's pattern for "state from a prop
  // change"), so the closing render happens in the same pass as the change.
  if (open !== last) {
    setLast(open);
    setClosing(!open && exitMs > 0 && !prefersReducedMotion());
  }
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setClosing(false), exitMs);
    return () => clearTimeout(timer);
  }, [closing, exitMs]);
  return open ? "open" : closing ? "closing" : null;
}
