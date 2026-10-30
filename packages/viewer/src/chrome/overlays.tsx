import type { Confidence, Layer, NodeKind } from "@gitinside/schema";
import { useRef, type HTMLAttributes, type PointerEvent } from "react";
import { DiagramEdge } from "../edges/DiagramEdge.js";
import { CONFIDENCE_TEXT } from "../edges/describe.js";
import { DIFF_TEXT, type NodeDiff, type NodeShape } from "../nodes/describe.js";
import { IconButton } from "./controls.js";
import {
  boundsOf,
  LAYER_NAMES,
  minimapFit,
  toMinimap,
  zoomText,
  type MinimapFit,
  type Rect,
} from "./describe.js";
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
  /**
   * Asked to center the view on a canvas point: a click on the map, and each
   * move while dragging on it. Without it the map only draws.
   */
  onNavigate?: ((center: { x: number; y: number }) => void) | undefined;
}

/**
 * The minimap (UX.md: bottom-right): the diagram's boxes tinted by layer,
 * and a frame over the part in view. The map fits the diagram and the
 * viewport together, so the frame never falls off the edge. With
 * `onNavigate`, pressing on the map moves the view there and dragging keeps
 * it under the pointer; the map holds its scale for the whole drag, so it
 * doesn't shift under the pointer as the frame moves. Keyboard users have
 * the zoom keys and fit (UX.md), so the map stays a picture to screen readers.
 */
export function Minimap({
  nodes,
  viewport,
  width = 200,
  height = 128,
  onNavigate,
  className,
  ...rest
}: MinimapProps) {
  const bounds = boundsOf([...nodes.map((n) => n.rect), viewport]) ?? viewport;
  const fit = minimapFit(bounds, { width, height });
  const view = toMinimap(viewport, fit);
  const dragFit = useRef<MinimapFit | undefined>(undefined);

  /** The canvas point under a pointer on the map, read with the drag's fit. */
  const navigate = (event: PointerEvent<SVGSVGElement>, using: MinimapFit) => {
    const r = event.currentTarget.getBoundingClientRect();
    const mx = ((event.clientX - r.left) * width) / Math.max(r.width, 1);
    const my = ((event.clientY - r.top) * height) / Math.max(r.height, 1);
    onNavigate?.({ x: (mx - using.dx) / using.scale, y: (my - using.dy) / using.scale });
  };
  const drag = onNavigate && {
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragFit.current = fit;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      navigate(event, fit);
    },
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => {
      if (dragFit.current) navigate(event, dragFit.current);
    },
    onPointerUp: () => {
      dragFit.current = undefined;
    },
    onPointerCancel: () => {
      dragFit.current = undefined;
    },
  };
  return (
    <div
      {...rest}
      className={className ? `gi-overlay gi-minimap ${className}` : "gi-overlay gi-minimap"}
      data-navigable={onNavigate ? "" : undefined}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Minimap of ${nodes.length} ${nodes.length === 1 ? "box" : "boxes"}; the frame shows the part in view`}
        {...drag}
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
          <Shapes />
        </div>
        <div>
          <Highlights />
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

/**
 * What each node shape stands for, in the legend's order (frames, cards, icon
 * tiles). A record over every `NodeShape`, so a new shape can't miss its row.
 */
export const SHAPE_TEXT: Readonly<Record<NodeShape, string>> = {
  window: "Window: frontend app, page",
  box: "Box: backend service",
  folder: "Folder: module",
  capsule: "Capsule: route",
  table: "Table: model and its fields",
  card: "Card: file, function",
  cylinder: "Cylinder: datastore",
  pipe: "Pipe: queue",
  circle: "Circle: outside API",
  dotted: "Dotted: in the code, not linked",
};

const SHAPES = Object.keys(SHAPE_TEXT) as NodeShape[];

/**
 * A shape's outline at legend size (24 × 16), the same silhouettes as
 * nodes.css and `TILE_OUTLINES`, drawn in the muted hairline.
 */
function ShapeSwatch({ shape }: { shape: NodeShape | "stacked" }) {
  const outline = (() => {
    switch (shape) {
      case "window":
        return (
          <>
            <rect x={2.5} y={2.5} width={19} height={11} rx={3} />
            <path className="gi-legend__band" d="M2.5 6.5V5.5a3 3 0 0 1 3-3h13a3 3 0 0 1 3 3v1Z" />
          </>
        );
      case "box":
        return <rect x={2.5} y={2.5} width={19} height={11} rx={1.5} />;
      case "folder":
        return (
          <>
            <path d="M4.5 4.5V3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
            <rect x={2.5} y={4.5} width={19} height={9} rx={2} />
          </>
        );
      case "capsule":
        return <rect x={2.5} y={4.5} width={19} height={7} rx={3.5} />;
      case "table":
        return (
          <>
            <rect x={3.5} y={2.5} width={17} height={11} rx={1.5} />
            <path d="M3.5 7.5h17" />
          </>
        );
      case "card":
        return <rect x={3.5} y={3.5} width={17} height={9} rx={2.5} />;
      case "cylinder":
        return (
          <>
            <path d="M7.5 3.5a4.5 1.5 0 0 1 9 0v9a4.5 1.5 0 0 1-9 0Z" />
            <path d="M7.5 3.5a4.5 1.5 0 0 0 9 0" />
          </>
        );
      case "pipe":
        return (
          <>
            <path d="M5.5 3.5h12a1.5 4.5 0 0 1 0 9h-12a1.5 4.5 0 0 1 0-9Z" />
            <path d="M17.5 3.5a1.5 4.5 0 0 0 0 9" />
          </>
        );
      case "circle":
        return <circle cx={12} cy={8} r={5.5} />;
      case "dotted":
        return <rect x={3.5} y={3.5} width={17} height={9} rx={2.5} strokeDasharray="1 2" />;
      case "stacked":
        return (
          <>
            <path d="M4.5 12.5v1a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-1" />
            <rect x={2.5} y={1.5} width={19} height={11} rx={2} />
          </>
        );
    }
  })();
  return (
    <svg className="gi-legend__shape" width={24} height={16} viewBox="0 0 24 16" aria-hidden>
      {outline}
    </svg>
  );
}

/** The legend's second column: what each node shape means. */
function Shapes() {
  return (
    <div className="gi-legend__group">
      <h3>Shape</h3>
      <ul>
        {SHAPES.map((shape) => (
          <li key={shape}>
            <ShapeSwatch shape={shape} />
            {SHAPE_TEXT[shape]}
          </li>
        ))}
        <li>
          <ShapeSwatch shape="stacked" />
          Stacked edge: opens in place
        </li>
      </ul>
    </div>
  );
}

/** The legend's third column: what highlights mean. */
function Highlights() {
  return (
    <>
      <div className="gi-legend__group">
        <h3>Highlight</h3>
        <ul>
          <li>
            <span className="gi-legend__swatch" data-tone="trace" aria-hidden />
            On the request path
          </li>
          <li>
            <span className="gi-legend__swatch" data-tone="trace-current" aria-hidden />
            Current step of the trace
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
