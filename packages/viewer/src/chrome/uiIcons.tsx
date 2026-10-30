import type { ReactNode } from "react";
import { MARK_NODE, MARK_PATH, markStroke } from "../mark.js";

/**
 * Interface icons for the chrome (buttons, menus, overlays). They follow the
 * kind glyphs' family rules (24px grid, `currentColor` strokes, round caps
 * and joins, no fills) so the chrome and the canvas read as one set, but are
 * drawn for 16px use: fewer strokes, more open space, and a 2-unit stroke
 * (1.33px at 16px), since the glyphs' 1.5 drew hairlines next to 13px text.
 */

/** Stroke width on the 24-unit grid. */
export const UI_ICON_STROKE = 2;

/** Names of the interface icons. */
export type UiIconName =
  | "search"
  | "plus"
  | "minus"
  | "fit"
  | "chevron-right"
  | "close"
  | "share"
  | "filter"
  | "trace"
  | "legend"
  | "open-external"
  | "break-down"
  | "commit"
  | "compare";

/** Artwork for each interface icon. */
export const uiIcons: Readonly<Record<UiIconName, ReactNode>> = {
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 4.75 4.75" />
    </>
  ),
  plus: <path d="M12 5.25v13.5M5.25 12h13.5" />,
  minus: <path d="M5.25 12h13.5" />,
  // Four corners: fit the whole diagram in view.
  fit: (
    <path d="M4.5 9V6.5a2 2 0 0 1 2-2H9M15 4.5h2.5a2 2 0 0 1 2 2V9M19.5 15v2.5a2 2 0 0 1-2 2H15M9 19.5H6.5a2 2 0 0 1-2-2V15" />
  ),
  "chevron-right": <path d="m9.5 6 6 6-6 6" />,
  close: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  share: <path d="M12 4.5v10.5M8 8.5l4-4 4 4M5.5 13v4.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V13" />,
  filter: <path d="M4.5 7h15M7.5 12h9M10.5 17h3" />,
  // A request path: two ends joined by a stepped line, like a traced route.
  trace: (
    <>
      <circle cx="5.5" cy="17.5" r="2" />
      <circle cx="18.5" cy="6.5" r="2" />
      <path d="M7.5 17.5H10a2 2 0 0 0 2-2v-7a2 2 0 0 1 2-2h2.5" />
    </>
  ),
  legend: <path d="M4.5 7h.01M4.5 12h.01M4.5 17h.01M8.5 7h11M8.5 12h11M8.5 17h11" />,
  "open-external": (
    <path d="M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 14v3.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2H10" />
  ),
  // A frame with a frame inside: open a node in place.
  "break-down": (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="3" />
      <rect x="8.75" y="8.75" width="6.5" height="6.5" rx="1.5" />
    </>
  ),
  commit: (
    <>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M3.75 12h5M15.25 12h5" />
    </>
  ),
  compare: <path d="M4.5 8.5h13l-3-3M19.5 15.5h-13l3 3" />,
};

/** Every interface icon name. */
export const uiIconNames = Object.keys(uiIcons) as UiIconName[];

/** One interface icon, decorative: the control around it carries the name. */
export function UiIcon({ name, size = 16 }: { name: UiIconName; size?: number }) {
  return (
    <svg
      className="gi-ui-icon"
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={UI_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {uiIcons[name]}
    </svg>
  );
}

/**
 * The GitInside mark (`mark.ts`): a "G" drawn as an open frame whose bar runs
 * inward to a node, an edge reaching inside the repo. The frame is drawn in
 * the text color and the node in the accent, so the mark follows the theme.
 */
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="gi-logo-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d={MARK_PATH}
        stroke="currentColor"
        strokeWidth={markStroke(size)}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle className="gi-logo-mark__node" {...MARK_NODE} />
    </svg>
  );
}
