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

/** Props for {@link IconTile}. */
export interface IconTileProps {
  size?: IconTileSize;
  /** Rings the tile in the layer's color (a restrained accent, never a fill). */
  layer?: Layer | undefined;
  children: ReactNode;
}

/**
 * The neutral rounded tile logos and glyphs sit on, so mixed brand colors stay
 * harmonious (DESIGN_SYSTEM.md §3). Always `surface-1`, the surface
 * {@link brandFill} checks contrast against.
 */
export function IconTile({ size = "sm", layer, children }: IconTileProps) {
  return (
    <span className="gi-icon-tile" data-size={size} {...(layer ? { "data-layer": layer } : {})}>
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
