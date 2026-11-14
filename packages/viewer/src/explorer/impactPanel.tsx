import type { GraphNode } from "@gitinside/schema";
import { useId, useState } from "react";
import { Button } from "../chrome/controls.js";
import {
  Inspector,
  InspectorActions,
  InspectorSection,
  InspectorSummary,
} from "../chrome/Inspector.js";
import { CONFIDENCE_TEXT } from "../edges/describe.js";
import { UiIcon } from "../chrome/uiIcons.js";
import { IconTile, NodeIcon, TILE_ICON_SIZE } from "../icons/Icon.js";
import { layerOf, type HierarchyIndex } from "../model/hierarchy.js";
import { nodeLabel } from "../nodes/describe.js";
import { impactCountText, type Impact } from "./impact.js";
import { nodeWhere } from "./search.js";

/** A node's name in parts: a route's method, then its name or code. */
function NameParts({ node }: { node: GraphNode }) {
  const label = nodeLabel(node);
  return (
    <>
      {label.method && <span className="gi-method">{label.method}</span>}
      {label.text && <span>{label.text}</span>}
      {label.code && <code>{label.code}</code>}
    </>
  );
}

/** A node's name as the inspector lists it. */
function Name({ node }: { node: GraphNode }) {
  return (
    <span className="gi-connection__name">
      <NameParts node={node} />
    </span>
  );
}

/** A node's name in a sentence: "POST /api/orders", "createOrder". */
function plainName(node: GraphNode): string {
  const label = nodeLabel(node);
  const name = label.text ?? label.code ?? node.label;
  return label.method ? `${label.method} ${name}` : name;
}

/**
 * Where a dependent lives, by its end: its file and folder ("…/emails/send-signing-email.ts"),
 * since a path cut at the end hides the part that tells two `handler`s apart.
 */
export function shortWhere(path: string | undefined): string | undefined {
  const parts = path?.split("/") ?? [];
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

/** One row: the node's icon and name, and a line under it; selects the node. */
function NodeRow({
  index,
  node,
  detail,
  title,
  onSelect,
}: {
  index: HierarchyIndex;
  node: GraphNode;
  detail?: string | undefined;
  title?: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <button type="button" className="gi-connection" title={title} onClick={() => onSelect(node.id)}>
      <IconTile layer={node.layer ?? layerOf(index, node.id)}>
        <NodeIcon node={node} size={TILE_ICON_SIZE.sm} />
      </IconTile>
      <span className="gi-connection__text">
        <Name node={node} />
        {detail && <span className="gi-connection__edge">{detail}</span>}
      </span>
    </button>
  );
}

/** A list of nodes behind a toggle, opened one group at a time by the reader. */
function Toggle({
  label,
  open,
  controls,
  onToggle,
}: {
  label: string;
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="gi-connection__sites-toggle"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={label}
      onClick={onToggle}
    >
      <UiIcon name="chevron-right" size={14} />
    </button>
  );
}

/** Props for {@link ImpactPanel}. */
export interface ImpactPanelProps {
  index: HierarchyIndex;
  impact: Impact;
  /** Select a node (the explorer flies there, breaking down what holds it). */
  onSelect: (id: string) => void;
  /** Stop showing what depends on the target. */
  onClose: () => void;
}

/**
 * The inspector during impact analysis (M10.3f1, M10-design §3.2): what depends on the target,
 * by service (each opening to its nodes), the shortest paths from pages and routes with their
 * weakest link, and what may also reach it through requests GitInside couldn't match, listed
 * apart and never counted.
 */
export function ImpactPanel({ index, impact, onSelect, onClose }: ImpactPanelProps) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [maybeOpen, setMaybeOpen] = useState(false);
  const base = useId();
  const { target } = impact;
  const toggle = (id: string) => {
    const next = new Set(opened);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpened(next);
  };
  const maybe = index.graph.nodes.filter((n) => impact.maybe.has(n.id));
  return (
    <Inspector key={`impact:${target.id}`} data-design="prototype" className="gi-impact">
      <header className="gi-inspector__header">
        <div className="gi-inspector__chips">
          <span className="gi-chip" data-tone="impact">
            Impact
          </span>
        </div>
        <div className="gi-inspector__title">
          <IconTile layer={target.layer ?? layerOf(index, target.id)}>
            <NodeIcon node={target} size={TILE_ICON_SIZE.sm} />
          </IconTile>
          <h2 tabIndex={-1} title={`What depends on ${target.label}`}>
            <span className="gi-impact__lead">What depends on</span>
            <NameParts node={target} />
          </h2>
        </div>
      </header>
      <InspectorSummary>
        {impactCountText(impact)}. Everything whose request path reaches it, found in the code.
      </InspectorSummary>
      {impact.groups.length > 0 && (
        <InspectorSection title="Where" count={impact.groups.length}>
          <ul className="gi-connections">
            {impact.groups.map((g, i) => {
              const open = opened.has(g.holder.id);
              const listId = `${base}-${i}`;
              return (
                <li key={g.holder.id}>
                  <div className="gi-connection-group">
                    <NodeRow
                      index={index}
                      node={g.holder}
                      detail={`${g.nodes.length.toLocaleString("en-US")} ${g.nodes.length === 1 ? "depends" : "depend"} on it`}
                      onSelect={onSelect}
                    />
                    <Toggle
                      label={`${open ? "Hide" : "Show"} what depends on it in ${g.holder.label}`}
                      open={open}
                      controls={listId}
                      onToggle={() => toggle(g.holder.id)}
                    />
                  </div>
                  {open && (
                    <ul id={listId} className="gi-connections gi-impact__nodes">
                      {g.nodes.map((n) => (
                        <li key={n.id}>
                          <NodeRow
                            index={index}
                            node={n}
                            detail={shortWhere(nodeWhere(n))}
                            title={nodeWhere(n)}
                            onSelect={onSelect}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </InspectorSection>
      )}
      {impact.paths.length > 0 && (
        <InspectorSection title="Paths" count={impact.paths.length}>
          <ol className="gi-impact__paths">
            {impact.paths.map((p) => {
              const [entry] = p.nodes;
              if (!entry) return null;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="gi-impact__path"
                    onClick={() => onSelect(entry.id)}
                  >
                    <span className="gi-impact__hops">
                      {p.nodes.map((n, i) => (
                        <span key={n.id}>
                          {i > 0 && (
                            <>
                              <span aria-hidden="true"> → </span>
                              <span className="gi-visually-hidden"> to </span>
                            </>
                          )}
                          {plainName(n)}
                        </span>
                      ))}
                    </span>
                    <span className="gi-impact__confidence">{CONFIDENCE_TEXT[p.confidence]}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </InspectorSection>
      )}
      {maybe.length > 0 && (
        <section className="gi-inspector__section gi-notes">
          <h3>
            <button
              type="button"
              className="gi-notes__toggle"
              aria-expanded={maybeOpen}
              aria-controls={maybeOpen ? `${base}-maybe` : undefined}
              onClick={() => setMaybeOpen(!maybeOpen)}
            >
              <UiIcon name="chevron-right" size={14} />
              May also reach
              <span className="gi-count">{maybe.length.toLocaleString("en-US")}</span>
            </button>
          </h3>
          {maybeOpen && (
            <div id={`${base}-maybe`} className="gi-notes">
              <p className="gi-inspector__empty">
                Requests GitInside couldn&apos;t match to a route, and what makes them. They might
                land here; nothing is guessed, so they aren&apos;t counted.
              </p>
              <ul className="gi-connections">
                {maybe.map((n) => (
                  <li key={n.id}>
                    <NodeRow
                      index={index}
                      node={n}
                      detail={shortWhere(nodeWhere(n))}
                      title={nodeWhere(n)}
                      onSelect={onSelect}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      <InspectorActions>
        <Button variant="secondary" size="sm" icon="close" onClick={onClose}>
          Done
        </Button>
      </InspectorActions>
    </Inspector>
  );
}
