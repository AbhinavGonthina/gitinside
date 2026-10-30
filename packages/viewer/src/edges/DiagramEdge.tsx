import type { Layer } from "@gitinside/schema";
import type { CSSProperties, HTMLAttributes, SVGAttributes } from "react";
import { DIFF_TEXT } from "../nodes/describe.js";
import {
  edgeAccessibleName,
  edgeLabel,
  edgeLabelText,
  LINE_STYLE,
  type EdgeLike,
  type EdgeState,
  type EdgeText,
} from "./describe.js";
import { edgeGeometry, type Point } from "./geometry.js";

/** Flow particles per edge; each starts a fraction of a lap after the last. */
export const FLOW_PARTICLES = 2;

/** State as data attributes, shared by the line and its label so they style together. */
function stateAttrs(edge: EdgeLike, layer: Layer | undefined, state: EdgeState) {
  return {
    "data-kind": edge.kind,
    "data-confidence": edge.confidence,
    "data-line": LINE_STYLE[edge.confidence],
    ...(layer ? { "data-layer": layer } : {}),
    ...(state.hovered ? { "data-hover": "" } : {}),
    ...(state.selected ? { "data-selected": "" } : {}),
    ...(state.emphasis ? { "data-emphasis": state.emphasis } : {}),
    ...(state.diff ? { "data-diff": state.diff } : {}),
    ...(state.broken ? { "data-broken": "" } : {}),
  };
}

/** Props for {@link DiagramEdge}. */
export interface DiagramEdgeProps
  extends EdgeState,
    Omit<SVGAttributes<SVGGElement>, "children" | "aria-label" | "points"> {
  edge: EdgeLike;
  /** The route, source first: ELK's start, bend, and end points. */
  points: readonly Point[];
  /** Labels of the two ends, for the accessible name. */
  ends: { from: string; to: string };
  /** The source's layer, which colors the line and its flow. */
  layer?: Layer | undefined;
  /** Draw particles travelling source to target (turned off by reduced motion). */
  flow?: boolean;
  /**
   * The trace player's current hop: a pulse travels the line every trace hop
   * (900ms), `"backward"` when the request goes target to source (a queue to
   * the worker consuming it). Turned off by reduced motion.
   */
  pulse?: "forward" | "backward" | undefined;
  /** For an aggregated edge: how many edges it stands for. */
  count?: number | undefined;
}

/**
 * One edge of the diagram as SVG, in any state (DESIGN_SYSTEM.md §3, "Edge
 * components"). Line style encodes confidence, the arrowhead points at the
 * target (an open chevron when unresolved), and the source's layer colors
 * the line. States are data attributes styled in `styles/edges.css`.
 *
 * The label is a separate HTML element ({@link EdgeLabel}) placed by the
 * caller at {@link edgeGeometry}'s `mid`, the way React Flow draws labels
 * above the SVG layer in M4b.
 */
export function DiagramEdge({
  edge,
  points,
  ends,
  layer,
  flow = false,
  pulse,
  count,
  hovered,
  selected,
  emphasis,
  diff,
  broken,
  className,
  ...rest
}: DiagramEdgeProps) {
  const state = { hovered, selected, emphasis, diff, broken };
  const g = edgeGeometry(points);
  const unresolved = edge.confidence === "unresolved";
  return (
    <g
      role="img"
      {...rest}
      className={className ? `gi-edge ${className}` : "gi-edge"}
      aria-label={edgeAccessibleName(edge, ends, { ...state, count })}
      {...stateAttrs(edge, layer, state)}
    >
      <path className="gi-edge__hit" d={g.flowPath} />
      <path className="gi-edge__line" d={g.d} />
      {LINE_STYLE[edge.confidence] === "dot" && (
        <circle className="gi-edge__dot" cx={g.dot.x} cy={g.dot.y} r={2.5} />
      )}
      <path
        className={unresolved ? "gi-edge__arrow gi-edge__arrow--open" : "gi-edge__arrow"}
        d={unresolved ? g.chevron : g.arrow}
      />
      {flow &&
        !unresolved &&
        Array.from({ length: FLOW_PARTICLES }, (_, i) => (
          <circle
            key={i}
            className="gi-edge__particle"
            r={3}
            style={
              {
                offsetPath: `path("${g.flowPath}")`,
                "--gi-flow-lag": String(i / FLOW_PARTICLES),
              } as CSSProperties
            }
          />
        ))}
      {pulse && (
        // pathLength 100: the dash and its travel are percentages of the line, whatever its length.
        <path className="gi-edge__pulse" d={g.flowPath} pathLength={100} data-pulse={pulse} />
      )}
    </g>
  );
}

/** Props for {@link EdgeLabel}. */
export interface EdgeLabelProps
  extends EdgeState,
    Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  edge: EdgeLike;
  layer?: Layer | undefined;
  count?: number | undefined;
}

function LabelText({ value }: { value: EdgeText }) {
  return (
    <>
      {value.method && <span className="gi-method">{value.method}</span>}
      {value.text && <span>{value.text}</span>}
      {value.code && <code>{value.code}</code>}
      {value.notes?.map((note) => (
        <span key={note} className="gi-edge-label__note">
          {note}
        </span>
      ))}
    </>
  );
}

/**
 * An edge's label pill: relationship and protocol (`POST /api/orders · HTTP`),
 * a count for aggregated edges, or the reason for an unresolved one. In diff
 * mode it leads with the diff state in words; a broken edge's label says what
 * broke instead. Position it with `style` (centered on
 * the point you give it); it is hidden from assistive tech because the edge's
 * accessible name already says the same.
 */
export function EdgeLabel({
  edge,
  layer,
  count,
  hovered,
  selected,
  emphasis,
  diff,
  broken,
  className,
  ...rest
}: EdgeLabelProps) {
  const state = { hovered, selected, emphasis, diff, broken };
  const label = edgeLabel(edge, count);
  return (
    <span
      aria-hidden
      title={broken ?? edgeLabelText(label)}
      {...rest}
      className={className ? `gi-edge-label ${className}` : "gi-edge-label"}
      {...stateAttrs(edge, layer, state)}
    >
      {broken ? (
        <>
          <span className="gi-badge__dot" aria-hidden />
          <span>{broken}</span>
        </>
      ) : (
        <>
          {diff && (
            <span className="gi-edge-label__diff">
              <span className="gi-badge__dot" aria-hidden />
              {DIFF_TEXT[diff]}
            </span>
          )}
          <LabelText value={label} />
        </>
      )}
    </span>
  );
}
