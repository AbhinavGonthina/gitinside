import type { Confidence, Layer, NodeKind } from "@gitinside/schema";
import type { HTMLAttributes } from "react";
import { DiagramEdge } from "../edges/DiagramEdge.js";
import { CONFIDENCE_TEXT } from "../edges/describe.js";
import { Glyph } from "../icons/glyphs.js";
import { DIFF_TEXT, type NodeDiff } from "../nodes/describe.js";
import { IconButton } from "./controls.js";
import { boundsOf, LAYER_NAMES, minimapFit, toMinimap, zoomText, type Rect } from "./describe.js";
import { UiIcon } from "./uiIcons.js";

/** One level of the drill-down path. */
export interface Crumb {
  id: string;
  label: string;
  kind?: NodeKind | undefined;
}

/** Props for {@link Breadcrumbs}. */
export interface BreadcrumbsProps extends Omit<HTMLAttributes<HTMLElement>, "onSelect"> {
  /** From the system down to the level in view; the last one is current. */
  items: readonly Crumb[];
  /** Go up to that level (UX.md "Going up"). */
  onSelect?: ((id: string) => void) | undefined;
}

/**
 * Where you are in the drill-down (UX.md "Layout": bottom-left of the
 * canvas). Every level above the current one is a button that collapses back
 * to it; the current level is marked `aria-current`.
 */
export function Breadcrumbs({ items, onSelect, className, ...rest }: BreadcrumbsProps) {
  return (
    <nav
      aria-label="Drill-down path"
      {...rest}
      className={className ? `gi-overlay gi-breadcrumbs ${className}` : "gi-overlay gi-breadcrumbs"}
    >
      <ol>
        {items.map((c, i) => {
          const current = i === items.length - 1;
          const code = c.kind === "file" || c.kind === "symbol";
          const text = code ? <code>{c.label}</code> : c.label;
          return (
            <li key={c.id}>
              {i > 0 && <UiIcon name="chevron-right" size={14} />}
              {current ? (
                <span className="gi-breadcrumbs__current" aria-current="location">
                  {text}
                </span>
              ) : (
                <button
                  type="button"
                  className="gi-breadcrumbs__link"
                  onClick={() => onSelect?.(c.id)}
                >
                  {text}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Props for {@link ZoomControls}. */
export interface ZoomControlsProps extends HTMLAttributes<HTMLDivElement> {
  /** Current zoom, 1 = 100%. */
  zoom: number;
  onZoomIn?: (() => void) | undefined;
  onZoomOut?: (() => void) | undefined;
  onFit?: (() => void) | undefined;
}

/** Zoom out / level / zoom in / fit (UX.md: top-right; keys − + 0). */
export function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  className,
  ...rest
}: ZoomControlsProps) {
  return (
    <div
      role="group"
      aria-label="Zoom"
      {...rest}
      className={className ? `gi-overlay gi-zoom ${className}` : "gi-overlay gi-zoom"}
    >
      <IconButton
        icon="minus"
        label="Zoom out"
        size="sm"
        aria-keyshortcuts="-"
        onClick={onZoomOut}
      />
      <output className="gi-zoom__level" aria-label={`Zoom ${zoomText(zoom)}`}>
        {zoomText(zoom)}
      </output>
      <IconButton icon="plus" label="Zoom in" size="sm" aria-keyshortcuts="+" onClick={onZoomIn} />
      <span className="gi-overlay__divider" aria-hidden />
      <IconButton
        icon="fit"
        label="Fit to screen"
        size="sm"
        aria-keyshortcuts="0"
        onClick={onFit}
      />
    </div>
  );
}

/** A node as the minimap draws it: its box on the canvas and its layer. */
export interface MinimapNode {
  id: string;
  rect: Rect;
  layer?: Layer | undefined;
}

/** Props for {@link Minimap}. */
export interface MinimapProps extends HTMLAttributes<HTMLDivElement> {
  /** The top-level boxes in view (services, datastores, externals), in canvas coordinates. */
  nodes: readonly MinimapNode[];
  /** The visible part of the canvas, in canvas coordinates. */
  viewport: Rect;
  width?: number;
  height?: number;
}

/**
 * The minimap shell (UX.md: bottom-right): the diagram's boxes tinted by
 * layer, and a frame over the part in view. M4b adds dragging the frame;
 * here it only draws. The map fits the diagram and the viewport together,
 * so the frame never falls off the edge.
 */
export function Minimap({
  nodes,
  viewport,
  width = 200,
  height = 128,
  className,
  ...rest
}: MinimapProps) {
  const bounds = boundsOf([...nodes.map((n) => n.rect), viewport]) ?? viewport;
  const fit = minimapFit(bounds, { width, height });
  const view = toMinimap(viewport, fit);
  return (
    <div
      {...rest}
      className={className ? `gi-overlay gi-minimap ${className}` : "gi-overlay gi-minimap"}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Minimap of ${nodes.length} ${nodes.length === 1 ? "box" : "boxes"}; the frame shows the part in view`}
      >
        {nodes.map((n) => {
          const r = toMinimap(n.rect, fit);
          return (
            <rect
              key={n.id}
              className="gi-minimap__node"
              {...(n.layer ? { "data-layer": n.layer } : {})}
              x={r.x}
              y={r.y}
              width={r.width}
              height={r.height}
              rx={2}
            />
          );
        })}
        <rect
          className="gi-minimap__viewport"
          x={view.x}
          y={view.y}
          width={view.width}
          height={view.height}
          rx={3}
        />
      </svg>
    </div>
  );
}

// The legend's rows, taken from the tables the canvas draws with. The schema
// is imported for types only (it stays out of the bundle), so a test checks
// these lists against its enums instead.
const LAYERS = Object.keys(LAYER_NAMES) as Layer[];
const CONFIDENCES = Object.keys(CONFIDENCE_TEXT) as Confidence[];
const DIFF_STATES = Object.keys(DIFF_TEXT) as NodeDiff[];

/** Props for {@link Legend}. */
export interface LegendProps extends HTMLAttributes<HTMLElement> {
  onClose?: (() => void) | undefined;
}

/**
 * What every visual device means (DESIGN_SYSTEM.md §3: "always one click
 * away and generated from these same tokens"). Rows come from the same
 * tables the canvas draws with: layers from the schema, line styles from
 * `DiagramEdge` itself, diff words from `DIFF_TEXT`, so the legend can't
 * drift from the diagram.
 */
export function Legend({ onClose, className, ...rest }: LegendProps) {
  return (
    <section
      aria-label="Legend"
      {...rest}
      className={className ? `gi-popover gi-legend ${className}` : "gi-popover gi-legend"}
    >
      <header className="gi-popover__header">
        <h2>Legend</h2>
        {onClose && <IconButton icon="close" label="Close legend" size="sm" onClick={onClose} />}
      </header>
      <div className="gi-legend__columns">
        <div>
          <LayerAndConnection />
        </div>
        <div>
          <ShapeAndHighlight />
        </div>
      </div>
    </section>
  );
}

/** The legend's first column: what color and line style mean. */
function LayerAndConnection() {
  return (
    <>
      <div className="gi-legend__group">
        <h3>Layer</h3>
        <ul>
          {LAYERS.map((layer) => (
            <li key={layer}>
              <span className="gi-legend__swatch" data-layer={layer} aria-hidden />
              {LAYER_NAMES[layer]}
            </li>
          ))}
        </ul>
      </div>
      <div className="gi-legend__group">
        <h3>Connection</h3>
        <ul>
          {CONFIDENCES.map((confidence) => (
            <li key={confidence}>
              <svg className="gi-legend__line" width={40} height={12} aria-hidden>
                <DiagramEdge
                  edge={{ kind: "calls", confidence }}
                  ends={{ from: "", to: "" }}
                  points={[
                    { x: 1, y: 6 },
                    { x: 39, y: 6 },
                  ]}
                />
              </svg>
              {CONFIDENCE_TEXT[confidence]}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** The legend's second column: what container shape and highlights mean. */
function ShapeAndHighlight() {
  return (
    <>
      <div className="gi-legend__group">
        <h3>Shape</h3>
        <ul>
          <li>
            <Glyph name="module" size={16} />
            Frame: service or folder, opens in place
          </li>
          <li>
            <Glyph name="file" size={16} />
            Card: file, function, route, model
          </li>
          <li>
            <Glyph name="datastore" size={16} />
            Icon: datastore, queue, outside API
          </li>
          <li>
            <Glyph name="unresolved" size={16} />
            Dotted: in the code, not linked
          </li>
        </ul>
      </div>
      <div className="gi-legend__group">
        <h3>Highlight</h3>
        <ul>
          <li>
            <span className="gi-legend__swatch" data-tone="trace" aria-hidden />
            On the request path
          </li>
          {DIFF_STATES.map((diff) => (
            <li key={diff}>
              <span className="gi-legend__swatch" data-tone={diff} aria-hidden />
              {DIFF_TEXT[diff]} in this change
            </li>
          ))}
          <li>
            <span className="gi-legend__swatch" data-tone="broken" aria-hidden />
            Broken connection
          </li>
        </ul>
      </div>
    </>
  );
}
