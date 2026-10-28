import type { ReactNode } from "react";

/**
 * The custom glyph set for generic kinds (DESIGN_SYSTEM.md §3, "Icons"),
 * drawn as one family: a 24px grid, 1.5px strokes in `currentColor`, round
 * caps and joins, no fills, and a live area of about 16.5px (3.75px margins)
 * so they sit at the same optical size as the brand logos on a tile.
 * Dots are zero-length strokes (`h.01`), so they scale with the stroke.
 */

/** Names of the glyphs, one per generic kind (plus fallbacks for unknown engines). */
export type GlyphName =
  | "service"
  | "module"
  | "file"
  | "function"
  | "method"
  | "class"
  | "variable"
  | "route"
  | "page"
  | "model"
  | "datastore"
  | "queue"
  | "external"
  | "unresolved";

interface GlyphDef {
  /** What the glyph stands for, used as its accessible label. */
  label: string;
  body: ReactNode;
}

/** Glyph artwork, in the order the gallery shows them (containers → symbols → data → edges). */
export const glyphs: Readonly<Record<GlyphName, GlyphDef>> = {
  // A two-unit server: the fallback when a service has no known framework.
  service: {
    label: "Service",
    body: (
      <>
        <rect x="3.75" y="4.25" width="16.5" height="6.5" rx="2" />
        <rect x="3.75" y="13.25" width="16.5" height="6.5" rx="2" />
        <path d="M7.25 7.5h.01M7.25 16.5h.01M11 7.5h5.75M11 16.5h5.75" />
      </>
    ),
  },
  module: {
    label: "Module",
    body: (
      <path d="M3.75 7a2 2 0 0 1 2-2h3.6l2 2.25h6.9a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2Z" />
    ),
  },
  file: {
    label: "File",
    body: (
      <>
        <path d="M13.25 3.75H7.5a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9Z" />
        <path d="M13.25 3.75V9h5.25M9 13.25h6M9 16.5h3.5" />
      </>
    ),
  },
  // A plain ƒ: crossbar plus a descending hook.
  function: {
    label: "Function",
    body: <path d="M16 4.25h-1.5a3 3 0 0 0-3 3v9.5a3 3 0 0 1-3 3H7M8 10.5h7" />,
  },
  // ƒ inside a frame: a function that belongs to something.
  method: {
    label: "Method",
    body: (
      <>
        <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="3" />
        <path d="M14.75 7.25h-.5a2 2 0 0 0-2 2v5.5a2 2 0 0 1-2 2h-1M9.25 11.25h4.5" />
      </>
    ),
  },
  // An open box: a class is a container for methods.
  class: {
    label: "Class",
    body: (
      <>
        <path d="M12 3.5 19.5 7.75v8.5L12 20.5l-7.5-4.25v-8.5Z" />
        <path d="M4.5 7.75 12 12l7.5-4.25M12 12v8.5" />
      </>
    ),
  },
  // Braces around a value: an exported constant or variable.
  variable: {
    label: "Variable",
    body: (
      <path d="M8.5 4.5h-.75a2 2 0 0 0-2 2v3.25L4 12l1.75 2.25v3.25a2 2 0 0 0 2 2h.75M15.5 4.5h.75a2 2 0 0 1 2 2v3.25L20 12l-1.75 2.25v3.25a2 2 0 0 1-2 2h-.75M12 12h.01" />
    ),
  },
  // A handler entry point: a request arriving at an endpoint.
  route: {
    label: "Route",
    body: (
      <>
        <circle cx="6" cy="12" r="2.25" />
        <path d="M8.25 12h11.5M15.75 8l4 4-4 4" />
      </>
    ),
  },
  // A browser window: a rendered page.
  page: {
    label: "Page",
    body: (
      <>
        <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" />
        <path d="M3.75 9h16.5M6.75 6.9h.01M9.25 6.9h.01" />
      </>
    ),
  },
  // A table with a header row: a data model.
  model: {
    label: "Model",
    body: (
      <>
        <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" />
        <path d="M3.75 9.5h16.5M3.75 14.25h16.5M9.5 9.5v9.75" />
      </>
    ),
  },
  // A cylinder: a datastore whose engine has no logo.
  datastore: {
    label: "Datastore",
    body: (
      <>
        <ellipse cx="12" cy="6.5" rx="7" ry="2.75" />
        <path d="M5 6.5v11c0 1.52 3.13 2.75 7 2.75s7-1.23 7-2.75v-11M5 12c0 1.52 3.13 2.75 7 2.75S19 13.52 19 12" />
      </>
    ),
  },
  // Messages lined up in a pipe.
  queue: {
    label: "Queue",
    body: (
      <>
        <rect x="2.75" y="7.25" width="18.5" height="9.5" rx="4.75" />
        <path d="M8 10.25v3.5M12 10.25v3.5M16 10.25v3.5" />
      </>
    ),
  },
  // A globe: an external host with no logo.
  external: {
    label: "External service",
    body: (
      <>
        <circle cx="12" cy="12" r="8.25" />
        <path d="M3.75 12h16.5M12 3.75c2.2 2.25 3.3 5 3.3 8.25s-1.1 6-3.3 8.25c-2.2-2.25-3.3-5-3.3-8.25s1.1-6 3.3-8.25Z" />
      </>
    ),
  },
  // A question in a dotted ring, echoing the dotted line of unresolved edges:
  // something the analyzer could not resolve, shown, not dropped. 16 round
  // dots (zero-length dashes) evenly around the 8.25 radius.
  unresolved: {
    label: "Unresolved",
    body: (
      <>
        <circle cx="12" cy="12" r="8.25" strokeDasharray="0 3.24" />
        <path d="M9.75 9.75a2.25 2.25 0 1 1 3.2 2.04c-.6.28-.95.86-.95 1.5v.21M12 16.25h.01" />
      </>
    ),
  },
};

/** Every glyph name, in gallery order. */
export const glyphNames = Object.keys(glyphs) as GlyphName[];

/** Props for {@link Glyph}. */
export interface GlyphProps {
  name: GlyphName;
  /** Rendered width and height in px. Defaults to 24, the grid size. */
  size?: number;
  /**
   * Accessible name. Without one the glyph is decorative (`aria-hidden`),
   * which is right when visible text next to it already names the thing.
   */
  title?: string;
}

/** One glyph from the custom set, stroked in `currentColor`. */
export function Glyph({ name, size = 24, title }: GlyphProps) {
  return (
    <svg
      className="gi-glyph"
      data-glyph={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(title === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": title })}
    >
      {title !== undefined && <title>{title}</title>}
      {glyphs[name].body}
    </svg>
  );
}
