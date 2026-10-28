import "./fonts.js";
import "./styles/index.css";

export { ViewerRoot } from "./ViewerRoot.js";
export type { Theme, ViewerRootProps } from "./ViewerRoot.js";
export { cssVar, durations, scaleTokens, themeTokens } from "./tokens.js";
export type { ScaleTokenName, ThemeTokenName } from "./tokens.js";
export { contrastRatio, relativeLuminance } from "./contrast.js";
export {
  brandFill,
  brandForEngine,
  brandForFramework,
  brandForHost,
  brands,
  MONOCHROME,
  TILE_SURFACES,
} from "./icons/brands.js";
export type { Brand } from "./icons/brands.js";
export { Glyph, glyphNames, glyphs } from "./icons/glyphs.js";
export type { GlyphName, GlyphProps } from "./icons/glyphs.js";
export {
  BrandLogo,
  iconFor,
  iconLabel,
  IconTile,
  NodeIcon,
  NodeIconTile,
  TILE_ICON_SIZE,
} from "./icons/Icon.js";
export type {
  BrandLogoProps,
  IconTileProps,
  IconTileSize,
  NodeIconChoice,
  NodeIconProps,
} from "./icons/Icon.js";
export { DiagramNode } from "./nodes/DiagramNode.js";
export type { DiagramNodeProps } from "./nodes/DiagramNode.js";
export {
  countText,
  DIFF_TEXT,
  kindName,
  nodeAccessibleName,
  nodeLabel,
  nodeSubtitle,
  nodeTier,
  REASON_TEXT,
} from "./nodes/describe.js";
export { DiagramEdge, EdgeLabel, FLOW_PARTICLES } from "./edges/DiagramEdge.js";
export type { DiagramEdgeProps, EdgeLabelProps } from "./edges/DiagramEdge.js";
export {
  brokenText,
  CONFIDENCE_TEXT,
  EDGE_WORDS,
  edgeAccessibleName,
  edgeLabel,
  edgeLabelText,
  LINE_STYLE,
} from "./edges/describe.js";
export type { EdgeLike, EdgeLineStyle, EdgeState, EdgeText } from "./edges/describe.js";
export { ARROW, CORNER_RADIUS, DOT_OFFSET, edgeGeometry } from "./edges/geometry.js";
export type { EdgeGeometry, Point } from "./edges/geometry.js";
export type {
  NodeCount,
  NodeDiff,
  NodeEmphasis,
  NodeState,
  NodeText,
  NodeTier,
} from "./nodes/describe.js";
