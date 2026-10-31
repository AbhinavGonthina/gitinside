// Fonts are a separate entry (`@gitinside/viewer/fonts`, src/fonts.ts): the
// built index.js must import in plain Node, which can't load CSS (ADR-0056).
// This stylesheet import is extracted to dist/style.css by the library build.
import "./styles/index.css";

export { ViewerRoot } from "./ViewerRoot.js";
export type { Theme, ViewerRootProps } from "./ViewerRoot.js";
export { cssVar, durations, scaleTokens, themeTokens } from "./tokens.js";
export type { ScaleTokenName, ThemeTokenName } from "./tokens.js";
export { prefersReducedMotion, REDUCED_MOTION_QUERY, usePresence } from "./motion.js";
export type { Presence } from "./motion.js";
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
export {
  Button,
  IconButton,
  Kbd,
  LinkButton,
  SegmentedControl,
  StatusChip,
  Toggle,
} from "./chrome/controls.js";
export type {
  ButtonProps,
  ButtonVariant,
  IconButtonProps,
  LinkButtonProps,
  Segment,
  SegmentedControlProps,
  StatusChipProps,
  StatusTone,
  ToggleProps,
} from "./chrome/controls.js";
export { DIFF_VIEWS, TopBar } from "./chrome/TopBar.js";
export type { DiffView, TopBarProps } from "./chrome/TopBar.js";
export { Breadcrumbs, Legend, Minimap, ZoomControls } from "./chrome/overlays.js";
export type {
  BreadcrumbsProps,
  Crumb,
  LegendProps,
  MinimapNode,
  MinimapProps,
  ZoomControlsProps,
} from "./chrome/overlays.js";
export {
  CodePreview,
  ConnectionList,
  FactList,
  Inspector,
  InspectorActions,
  InspectorHeader,
  InspectorSection,
  InspectorSummary,
} from "./chrome/Inspector.js";
export type {
  CodePreviewProps,
  Connection,
  ConnectionListProps,
  Fact,
  InspectorHeaderProps,
  InspectorProps,
} from "./chrome/Inspector.js";
export { CONNECTION_NAMES, FiltersPopover, KIND_PLURALS } from "./chrome/FiltersPopover.js";
export type { FiltersPopoverProps } from "./chrome/FiltersPopover.js";
export {
  LINK_COPIED_MESSAGE,
  LINK_COPIED_MS,
  LINK_COPY_FAILED_MESSAGE,
  ShareMenu,
} from "./chrome/ShareMenu.js";
export type { ShareMenuProps } from "./chrome/ShareMenu.js";
export { CommandPalette } from "./chrome/CommandPalette.js";
export type { CommandPaletteProps, PaletteResult } from "./chrome/CommandPalette.js";
export {
  boundsOf,
  githubLineUrl,
  highlightSegments,
  LAYER_NAMES,
  minimapFit,
  shortSha,
  toMinimap,
  zoomText,
} from "./chrome/describe.js";
export type { MinimapFit, Rect, RepoRef, TextSegment } from "./chrome/describe.js";
export { LogoMark, UiIcon, uiIconNames, uiIcons } from "./chrome/uiIcons.js";
export { MARK_NODE, MARK_PATH, markStroke } from "./mark.js";
export {
  ancestry,
  buildHierarchy,
  canOpen,
  compareEntries,
  countsInside,
  isEntry,
  isWithin,
  layerOf,
  nodeOf,
} from "./model/hierarchy.js";
export type { EntryNode, HierarchyIndex, KindCounts } from "./model/hierarchy.js";
export {
  buildView,
  DEFAULT_HIDDEN_KINDS,
  drawnEdge,
  effectiveOpen,
  viewTrail,
  visibleAncestor,
  weaker,
} from "./model/view.js";
export type { GraphView, Section, ViewEdge, ViewNode, ViewOptions } from "./model/view.js";
export {
  activeFilterCount,
  DEFAULT_FILTERS,
  FILTER_KINDS,
  filterOptions,
  filtersKey,
  filtersShowing,
  hiddenNodes,
  isTestOrConfig,
  isUnder,
  NO_FILTERS,
  normalizeFilters,
  normalizeFolder,
} from "./model/filters.js";
export type { FilterOption, FilterOptions, Filters } from "./model/filters.js";
export { closedSize, edgeLabelSize, frameCounts, openHeader, viewNodeSize } from "./layout/size.js";
export type { Size, SizeContext } from "./layout/size.js";
export {
  ELK_OPTIONS,
  elkGraph,
  LAYOUT_PAD,
  layoutInput,
  readLayout,
  runLayout,
} from "./layout/elk.js";
export type {
  LayoutEdge,
  LayoutInput,
  LayoutNode,
  LayoutResult,
  PlacedEdge,
} from "./layout/elk.js";
export {
  createLayoutCache,
  createLayoutEngine,
  LAYOUT_CACHE_SIZE,
  layoutKey,
} from "./layout/engine.js";
export type {
  LayoutCache,
  LayoutEngine,
  LayoutEngineOptions,
  LayoutWorkerFactory,
} from "./layout/engine.js";
export { connectionsOf } from "./model/connections.js";
export type { NodeConnection } from "./model/connections.js";
export {
  closeIn,
  collapseTo,
  isShown,
  openIn,
  revealIn,
  upFrom,
  useDrill,
} from "./explorer/drill.js";
export type { Drill, Expansion } from "./explorer/drill.js";
export { centeredOn, planTransition } from "./explorer/transition.js";
export type { BoxExit, BoxMove, Shown, TransitionPlan } from "./explorer/transition.js";
export { DrillCanvas } from "./explorer/DrillCanvas.js";
export type { BoxLook, DrillCanvasProps, LineLook } from "./explorer/DrillCanvas.js";
export { FIT_INSET, fitScale } from "./explorer/fit.js";
export {
  centerOn,
  clampZoom,
  ensureVisible,
  fitCamera,
  holdInPlace,
  keepInView,
  KEEP_IN_VIEW,
  panBy,
  stepZoom,
  visibleRect,
  wheelZoomFactor,
  ZOOM,
  zoomAt,
} from "./explorer/camera.js";
export type { Camera } from "./explorer/camera.js";
export { DRAG_THRESHOLD } from "./explorer/gestures.js";
export type { CameraMotion } from "./explorer/gestures.js";
export { canTraceFrom, TRACE_DEPTH, traceFrom, traceNodes } from "./explorer/trace.js";
export type { Trace, TraceStep } from "./explorer/trace.js";
export { createGitHubSourceLoader, MAX_SOURCE_BYTES } from "./explorer/sources.js";
export type { GitHubSourceLoaderOptions, SourceLoader } from "./explorer/sources.js";
export {
  decodeState,
  DEFAULT_STATE,
  encodeState,
  STATE_PARAMS,
  withState,
} from "./explorer/deepLink.js";
export type { DecodedState, ExplorerState, IgnoredParam } from "./explorer/deepLink.js";
export { Explorer } from "./explorer/Explorer.js";
export type { ExplorerProps } from "./explorer/Explorer.js";
export type { UiIconName } from "./chrome/uiIcons.js";
export type {
  NodeCount,
  NodeDiff,
  NodeEmphasis,
  NodeState,
  NodeText,
  NodeTier,
} from "./nodes/describe.js";
