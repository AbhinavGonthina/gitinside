import type { GraphNode, Layer } from "@gitinside/schema";
import type { HTMLAttributes, ReactNode } from "react";
import {
  CONFIDENCE_TEXT,
  edgeLabel,
  edgeLabelText,
  LINE_STYLE,
  type EdgeLike,
} from "../edges/describe.js";
import { IconTile, NodeIcon, TILE_ICON_SIZE } from "../icons/Icon.js";
import { kindName, nodeLabel, nodeSubtitle } from "../nodes/describe.js";
import { LAYER_NAMES } from "./describe.js";
import { UiIcon } from "./uiIcons.js";

/**
 * The inspector (UX.md "Selection and inspector"): the panel on the right
 * that explains the selection. It is built from small parts so each
 * selection can show what applies to it: a header, the "From the code"
 * summary, facts, connections, a code preview, and actions.
 */

/** Props for {@link Inspector}. */
export interface InspectorProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

/** The inspector panel. Its width (340–380px, resizable) belongs to the layout around it. */
export function Inspector({ children, className, ...rest }: InspectorProps) {
  return (
    <aside
      aria-label="Inspector"
      {...rest}
      className={className ? `gi-inspector ${className}` : "gi-inspector"}
    >
      {children}
    </aside>
  );
}

/** Props for {@link InspectorHeader}. */
export interface InspectorHeaderProps {
  node: GraphNode;
  /** The layer it inherits from its service, for kinds without their own. */
  layer?: Layer | undefined;
  /** Where it lives, e.g. `apps/api/src/routes/orders.ts:14`. */
  location?: string | undefined;
}

/**
 * Kind and layer chips, then the icon and name, then where it lives. The
 * name is the inspector's heading, so the panel reads well to a screen reader.
 */
export function InspectorHeader({ node, layer, location }: InspectorHeaderProps) {
  const label = nodeLabel(node);
  const subtitle = nodeSubtitle(node);
  const tint = node.layer ?? layer;
  return (
    <header className="gi-inspector__header">
      <div className="gi-inspector__chips">
        <span className="gi-chip">{kindName(node)}</span>
        {tint && (
          <span className="gi-chip" data-layer={tint}>
            <span className="gi-chip__dot" aria-hidden />
            {LAYER_NAMES[tint]}
          </span>
        )}
      </div>
      <div className="gi-inspector__title">
        <IconTile layer={tint}>
          <NodeIcon node={node} size={TILE_ICON_SIZE.sm} />
        </IconTile>
        <h2 title={node.label}>
          {label.method && <span className="gi-method">{label.method}</span>}
          {label.text && <span>{label.text}</span>}
          {label.code && <code>{label.code}</code>}
        </h2>
      </div>
      {(subtitle.text ?? subtitle.code) && node.kind !== "unresolved" && (
        <p className="gi-inspector__subtitle">
          {subtitle.text}
          {subtitle.text && subtitle.code && " · "}
          {subtitle.code && <code>{subtitle.code}</code>}
        </p>
      )}
      {location && (
        <p className="gi-inspector__location">
          <code>{location}</code>
        </p>
      )}
    </header>
  );
}

/**
 * The plain-English sentence about the selection, labeled "From the code"
 * because it is templated from graph facts (there is no AI in v1). For an
 * unresolved item it is the reason it couldn't be linked.
 */
export function InspectorSummary({ children }: { children: ReactNode }) {
  return (
    <section className="gi-inspector__summary" aria-label="Summary">
      <span className="gi-inspector__source">From the code</span>
      <p>{children}</p>
    </section>
  );
}

/** A titled part of the inspector, with an optional count after the title. */
export function InspectorSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | undefined;
  children: ReactNode;
}) {
  return (
    <section className="gi-inspector__section">
      <h3>
        {title}
        {count !== undefined && <span className="gi-count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** One fact: a name and its value. Mark `code` for paths and identifiers. */
export interface Fact {
  label: string;
  value: string;
  code?: boolean;
}

/** Facts as a two-column list (counts, path, framework). Long values truncate; the tooltip has them whole. */
export function FactList({ facts }: { facts: readonly Fact[] }) {
  return (
    <dl className="gi-facts">
      {facts.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd title={f.value}>{f.code ? <code>{f.value}</code> : f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A node at the other end of one of the selection's edges. */
export interface Connection {
  node: GraphNode;
  layer?: Layer | undefined;
  /** The edge between the selection and this node, for its label and confidence. */
  edge: EdgeLike;
}

/** Props for {@link ConnectionList}. */
export interface ConnectionListProps {
  items: readonly Connection[];
  /** What to say when there are none, e.g. "Nothing in the repo calls this." */
  empty: string;
  /** Select that node (the explorer flies there, drilling if needed). */
  onSelect?: ((id: string) => void) | undefined;
}

/**
 * The **Calls** or **Called by** list: each row is the other node's icon and
 * name, the edge's label, and a short line in the edge's confidence style,
 * so the inspector and the canvas say the same thing the same way.
 */
export function ConnectionList({ items, empty, onSelect }: ConnectionListProps) {
  if (items.length === 0) return <p className="gi-inspector__empty">{empty}</p>;
  return (
    <ul className="gi-connections">
      {items.map(({ node, layer, edge }, i) => {
        const label = nodeLabel(node);
        const tint = node.layer ?? layer;
        // One row per edge, so a node can appear twice (reads and writes Order):
        // its ID alone isn't a unique key. The list order is deterministic.
        return (
          <li key={`${node.id} ${i}`}>
            <button
              type="button"
              className="gi-connection"
              onClick={() => onSelect?.(node.id)}
              title={`${node.label} · ${CONFIDENCE_TEXT[edge.confidence]}`}
            >
              <IconTile layer={tint}>
                <NodeIcon node={node} size={TILE_ICON_SIZE.sm} />
              </IconTile>
              <span className="gi-connection__text">
                <span className="gi-connection__name">
                  {label.method && <span className="gi-method">{label.method}</span>}
                  {label.text && <span>{label.text}</span>}
                  {label.code && <code>{label.code}</code>}
                </span>
                <span className="gi-connection__edge">
                  {edgeLabelText(edgeLabel(edge))} · {CONFIDENCE_TEXT[edge.confidence]}
                </span>
              </span>
              <svg
                className="gi-connection__line"
                data-line={LINE_STYLE[edge.confidence]}
                width={20}
                height={8}
                aria-hidden
              >
                <path d="M 1 4 L 19 4" />
                {LINE_STYLE[edge.confidence] === "dot" && <circle cx={4} cy={4} r={2} />}
              </svg>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Props for {@link CodePreview}. */
export interface CodePreviewProps {
  /** Repo-relative path of the file. */
  path: string;
  /** Line number of the first line in `lines`. */
  startLine: number;
  lines: readonly string[];
  /** The line the selection is on; it gets a marker and a tint. */
  highlight?: number | undefined;
  /** Permalink at the analyzed commit; without one there is no GitHub link. */
  href?: string | undefined;
}

/**
 * The code around the selection with line numbers (UX.md: 15 lines), and
 * "Open on GitHub" at that line. Plain text for now; M4b.5 adds Shiki
 * highlighting inside the same frame.
 */
export function CodePreview({ path, startLine, lines, highlight, href }: CodePreviewProps) {
  return (
    <figure className="gi-code">
      <figcaption className="gi-code__header">
        <code title={path}>{path}</code>
        {href && (
          <a className="gi-code__link" href={href} target="_blank" rel="noreferrer noopener">
            Open on GitHub
            <UiIcon name="open-external" size={14} />
          </a>
        )}
      </figcaption>
      <pre className="gi-code__body">
        {lines.map((line, i) => {
          const n = startLine + i;
          return (
            <span
              key={n}
              className="gi-code__line"
              {...(n === highlight ? { "data-highlight": "" } : {})}
            >
              <span className="gi-code__number" aria-hidden>
                {n}
              </span>
              <code>{line || " "}</code>
            </span>
          );
        })}
      </pre>
    </figure>
  );
}

/** A row of actions at the inspector's foot: Break down, Trace from here, and so on. */
export function InspectorActions({ children }: { children: ReactNode }) {
  return <div className="gi-inspector__actions">{children}</div>;
}
