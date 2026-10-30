/**
 * The GitInside mark's geometry (design gate, M4b.0d, ADR-0103), on a 24-unit
 * grid. One source for every place the mark is drawn: the top bar and the
 * site header ({@link LogoMark}), the README badge and image, and the favicon
 * (`apps/web/app/icon.svg`, a static copy checked against these values).
 *
 * The mark is a "G" drawn as an open frame, the rounded box services are
 * drawn in, whose bar runs inward to a node: an edge reaching inside the
 * repo. The frame takes the text color and the node the accent, so it
 * follows the theme. Stroked with round caps and joins, like the interface
 * icons.
 */

/** The frame and bar, one stroked path: from the top terminal, counterclockwise, then in. */
export const MARK_PATH =
  "M16.5 3H8.5A5.5 5.5 0 0 0 3 8.5v7A5.5 5.5 0 0 0 8.5 21h7a5.5 5.5 0 0 0 5.5-5.5V12h-7";

/** The node the bar ends on, filled; it covers the bar's end. */
export const MARK_NODE = { cx: 11.5, cy: 12, r: 3 } as const;

/**
 * Stroke width on the 24-unit grid for a mark drawn `size` px wide: 2 at 20px
 * and up, 2.5 below so the line still holds (1.25px in the 12px badge).
 */
export function markStroke(size: number): number {
  return size < 20 ? 2.5 : 2;
}

/** How {@link markMarkup} paints the mark: any CSS color, `var(--x)` included. */
export interface MarkPaint {
  frame: string;
  node: string;
  /** The drawn width in px, which picks the stroke ({@link markStroke}). */
  size: number;
}

/** The mark's shapes as SVG markup on its 24-unit grid, for the text renderers. */
export function markMarkup({ frame, node, size }: MarkPaint): string {
  return (
    `<path d="${MARK_PATH}" fill="none" stroke-width="${markStroke(size)}" stroke-linecap="round" stroke-linejoin="round" style="stroke:${frame}"/>` +
    `<circle cx="${MARK_NODE.cx}" cy="${MARK_NODE.cy}" r="${MARK_NODE.r}" style="fill:${node}"/>`
  );
}
