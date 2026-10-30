import type { GraphNode, Layer } from "@gitinside/schema";
import type { CSSProperties, ReactNode } from "react";
import {
  brandFill,
  brandForEngine,
  brandForFramework,
  brandForHost,
  type Brand,
} from "./brands.js";
import { Glyph, glyphs, type GlyphName } from "./glyphs.js";

/** What a node is drawn with: a technology logo when known, otherwise its kind's glyph. */
export type NodeIconChoice = { type: "brand"; brand: Brand } | { type: "glyph"; glyph: GlyphName };

const SYMBOL_GLYPHS = {
  function: "function",
  class: "class",
  method: "method",
  variable: "variable",
} as const satisfies Record<string, GlyphName>;

/**
 * The icon for a node (DESIGN_SYSTEM.md §3): technology when the node's own
 * field names one we have a logo for, otherwise the glyph for its kind.
 * Pure and total, so the same graph always draws the same icons.
 */
export function iconFor(node: GraphNode): NodeIconChoice {
  const glyph = (g: GlyphName): NodeIconChoice => ({ type: "glyph", glyph: g });
  const logoOr = (b: Brand | undefined, g: GlyphName): NodeIconChoice =>
    b ? { type: "brand", brand: b } : glyph(g);
  switch (node.kind) {
    // The system root is never drawn as a node; it shares the service fallback.
    case "system":
      return glyph("service");
    case "service":
      return logoOr(brandForFramework(node.framework), "service");
    case "module":
      return glyph("module");
    case "file":
      return glyph("file");
    case "symbol":
      return glyph(SYMBOL_GLYPHS[node.symbolKind]);
    case "route":
      return glyph("route");
    case "page":
      return glyph("page");
    case "model":
      return glyph("model");
    case "datastore":
      return logoOr(brandForEngine(node.engine), "datastore");
    case "queue":
      return logoOr(brandForEngine(node.engine), "queue");
    case "external":
      return logoOr(brandForHost(node.host), "external");
    case "unresolved":
      return glyph("unresolved");
  }
}

/** Props for {@link BrandLogo}. */
export interface BrandLogoProps {
  brand: Brand;
  /** Rendered width and height in px. Defaults to 24. */
  size?: number;
  /** Accessible name; defaults to the brand's title. Pass `null` when adjacent text names it. */
  title?: string | null;
}

/**
 * A technology logo, filled with its brand color or the monochrome fallback
 * for the current theme ({@link brandFill}). Both fills are set as custom
 * properties and `icons.css` picks one by `data-theme`, so a theme switch
 * re-renders nothing. The mark is inset on its 24px grid so filled logos
 * match the optical size of the stroked glyphs.
 */
export function BrandLogo({ brand, size = 24, title }: BrandLogoProps) {
  const label = title === undefined ? brand.title : title;
  const style = {
    "--gi-brand-dark": brandFill(brand, "dark"),
    "--gi-brand-light": brandFill(brand, "light"),
  } as CSSProperties;
  return (
    <svg
      className="gi-brand"
      data-brand={brand.slug}
      width={size}
      height={size}
      viewBox="-3 -3 30 30"
      fill="currentColor"
      style={style}
      {...(label === null ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      {label !== null && <title>{label}</title>}
      <path d={brand.path} />
    </svg>
  );
}

/** Props for {@link NodeIcon}. */
export interface NodeIconProps {
  node: GraphNode;
  /** Rendered width and height in px. Defaults to 24. */
  size?: number;
  /** Accessible name. Omit when the node's label is shown next to the icon. */
  title?: string;
}

/** The icon {@link iconFor} picks for a node, rendered. Decorative unless `title` is given. */
export function NodeIcon({ node, size = 24, title }: NodeIconProps) {
  const choice = iconFor(node);
  if (choice.type === "brand") {
    return <BrandLogo brand={choice.brand} size={size} title={title ?? null} />;
  }
  return <Glyph name={choice.glyph} size={size} {...(title === undefined ? {} : { title })} />;
}

/** Tile sizes: `sm` for card rows, `lg` for icon-first nodes (datastores, queues, externals). */
export type IconTileSize = "sm" | "lg";

/** Icon size inside each tile size, in px. */
export const TILE_ICON_SIZE: Readonly<Record<IconTileSize, number>> = { sm: 20, lg: 32 };

/** The outlines a large tile can take instead of the rounded square: datastores, queues, outside APIs. */
export type TileShape = "cylinder" | "pipe" | "circle";

/** A tile outline: its box, the path drawn (filled), an optional rim line, and where the icon centers. */
export interface TileOutline {
  width: number;
  height: number;
  /** Outline path, on a 1px hairline drawn at half-pixel offsets. */
  d: string;
  /** Stroked only: the front edge that makes a cylinder read as one. */
  rim?: string;
  iconX: number;
  iconY: number;
}

/**
 * Tile outlines by shape, the one source for the canvas ({@link IconTile})
 * and the README image. All are 64px tall, so icon-first nodes line up:
 * - `cylinder`: a datastore, upright, with its top rim; the icon sits in the body.
 * - `pipe`: a queue, a cylinder lying down with its open end on the right.
 * - `circle`: an outside API, the world beyond the repo.
 */
export const TILE_OUTLINES: Readonly<Record<TileShape, TileOutline>> = {
  cylinder: {
    width: 56,
    height: 64,
    d: "M0.5 7A27.5 6.5 0 0 1 55.5 7V57A27.5 6.5 0 0 1 0.5 57Z",
    rim: "M0.5 7A27.5 6.5 0 0 0 55.5 7",
    iconX: 28,
    iconY: 37,
  },
  pipe: {
    width: 84,
    height: 64,
    d: "M7.5 6.5H76.5A7 25.5 0 0 1 76.5 57.5H7.5A7 25.5 0 0 1 7.5 6.5Z",
    rim: "M76.5 6.5A7 25.5 0 0 0 76.5 57.5",
    iconX: 37,
    iconY: 32,
  },
  circle: {
    width: 64,
    height: 64,
    d: "M32 2.5A29.5 29.5 0 1 1 32 61.5A29.5 29.5 0 1 1 32 2.5Z",
    iconX: 32,
    iconY: 32,
  },
};

/** Whether a node shape (`nodeShape`) is drawn by its icon tile's outline. */
export function isTileShape(shape: string): shape is TileShape {
  return Object.hasOwn(TILE_OUTLINES, shape);
}

/** Props for {@link IconTile}. */
export interface IconTileProps {
  size?: IconTileSize;
  /** Rings the tile in the layer's color (a restrained accent, never a fill). */
  layer?: Layer | undefined;
  /** Large tiles only: draw this outline instead of the rounded square. */
  shape?: TileShape | undefined;
  children: ReactNode;
}

/** Padding that moves a centered icon to (`iconX`, `iconY`) in its box. */
function iconOffset({ width, height, iconX, iconY }: TileOutline): CSSProperties {
  const dx = 2 * iconX - width;
  const dy = 2 * iconY - height;
  return {
    width,
    height,
    ...(dx > 0 ? { paddingLeft: dx } : dx < 0 ? { paddingRight: -dx } : {}),
    ...(dy > 0 ? { paddingTop: dy } : dy < 0 ? { paddingBottom: -dy } : {}),
  };
}

/**
 * The neutral tile logos and glyphs sit on, so mixed brand colors stay
 * harmonious (DESIGN_SYSTEM.md §3). Always `surface-1`, the surface
 * {@link brandFill} checks contrast against. A rounded square, or for large
 * tiles one of {@link TILE_OUTLINES}, so the kind shows in the outline too.
 */
export function IconTile({ size = "sm", layer, shape, children }: IconTileProps) {
  const outline = size === "lg" && shape ? TILE_OUTLINES[shape] : undefined;
  return (
    <span
      className="gi-icon-tile"
      data-size={size}
      {...(layer ? { "data-layer": layer } : {})}
      {...(outline && shape ? { "data-shape": shape, style: iconOffset(outline) } : {})}
    >
      {outline && (
        <svg
          className="gi-icon-tile__outline"
          width={outline.width}
          height={outline.height}
          viewBox={`0 0 ${outline.width} ${outline.height}`}
          aria-hidden
        >
          <path d={outline.d} />
          {outline.rim && <path className="gi-icon-tile__rim" d={outline.rim} />}
        </svg>
      )}
      {children}
    </span>
  );
}

/** A node's icon on its tile, ringed by its layer: the usual way to draw one. */
export function NodeIconTile({ node, size = "sm" }: { node: GraphNode; size?: IconTileSize }) {
  return (
    <IconTile size={size} layer={node.layer}>
      <NodeIcon node={node} size={TILE_ICON_SIZE[size]} />
    </IconTile>
  );
}

/** The accessible label of a node's icon: the brand's title, or the glyph's kind. */
export function iconLabel(choice: NodeIconChoice): string {
  return choice.type === "brand" ? choice.brand.title : glyphs[choice.glyph].label;
}
