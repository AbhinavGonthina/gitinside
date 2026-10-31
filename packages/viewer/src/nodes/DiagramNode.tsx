import type { GraphNode, Layer } from "@gitinside/schema";
import type { HTMLAttributes, ReactNode } from "react";
import { IconTile, isTileShape, NodeIcon, TILE_ICON_SIZE } from "../icons/Icon.js";
import {
  countText,
  DIFF_TEXT,
  modelFieldsText,
  nodeAccessibleName,
  nodeLabel,
  nodeShape,
  nodeSubtitle,
  nodeTier,
  type NodeCount,
  type NodeState,
  type NodeText,
} from "./describe.js";

/** Props for {@link DiagramNode}. */
export interface DiagramNodeProps
  extends NodeState,
    Omit<HTMLAttributes<HTMLElement>, "children" | "aria-label"> {
  node: GraphNode;
  /**
   * Layer to tint with when the node has none of its own (modules, files, and
   * symbols inherit their service's). The node's own layer wins.
   */
  layer?: Layer | undefined;
  /** Count badges, in the order given. */
  counts?: readonly NodeCount[] | undefined;
  /** Frames only: draw open, with `children` inside, instead of as a closed card. */
  expanded?: boolean;
  /** Frames only: the nodes drawn inside an expanded frame. */
  children?: ReactNode;
}

function Text({ value, className }: { value: NodeText; className: string }) {
  return (
    <span className={className}>
      {value.text && <span>{value.text}</span>}
      {value.code && <code>{value.code}</code>}
    </span>
  );
}

/** The diff state as a tag on the node's top edge, so it takes no room from the name. */
function DiffTag({ diff }: Pick<DiagramNodeProps, "diff">) {
  if (!diff) return null;
  return (
    <span className="gi-badge gi-node__diff" data-diff={diff}>
      <span className="gi-badge__dot" aria-hidden />
      {DIFF_TEXT[diff]}
    </span>
  );
}

function Badges({ counts }: Pick<DiagramNodeProps, "counts">) {
  if (!counts?.length) return null;
  return (
    <span className="gi-node__badges">
      {counts.map((c) => (
        <span
          key={c.noun}
          className="gi-badge"
          {...(c.unresolved ? { "data-unresolved": "" } : {})}
        >
          {countText(c)}
        </span>
      ))}
    </span>
  );
}

/**
 * One node of the diagram, in any state (DESIGN_SYSTEM.md §3). The kind picks
 * the container: services and modules are frames (a closed frame shows a
 * stacked edge, meaning it can be broken down; an open one holds `children`),
 * datastores, queues, and externals are icon-first, and everything else is a
 * compact card. Within a tier, `nodeShape` gives each layer and kind its own
 * outline (window, box, folder, capsule, table, and the icon tile's cylinder,
 * pipe, or circle), with a model's fields on a row of their own. States are
 * data attributes styled in `styles/nodes.css`, so
 * they combine freely and a theme switch re-renders nothing.
 *
 * Positioning, sizing, and events belong to the caller (the canvas in M4b);
 * extra HTML attributes are passed to the root element. The root is a
 * `group` named with its states in words; a caller giving it a role with
 * real states (the canvas's `treeitem` with `aria-selected`) gets a name
 * without "Selected".
 */
export function DiagramNode({
  node,
  layer,
  counts,
  expanded = false,
  children,
  hovered = false,
  selected = false,
  emphasis,
  diff,
  className,
  ...rest
}: DiagramNodeProps) {
  const tier = nodeTier(node);
  const open = tier === "frame" && expanded;
  const tint = node.layer ?? layer;
  const label = nodeLabel(node);
  const subtitle = nodeSubtitle(node);
  const tileSize = tier === "icon" ? "lg" : "sm";
  const shape = nodeShape(node, tint);
  const fields = modelFieldsText(node);
  // A role that carries selection (the canvas's tree items) says it; the name doesn't repeat it.
  const named = rest["aria-selected"] === undefined && selected;

  const attrs = {
    ...rest,
    className: className ? `gi-node ${className}` : "gi-node",
    "data-tier": tier,
    "data-kind": node.kind,
    "data-shape": shape,
    "aria-label": nodeAccessibleName(node, { selected: named, emphasis, diff }),
    ...(tier === "frame" ? { "data-expanded": String(open) } : {}),
    ...(tint ? { "data-layer": tint } : {}),
    ...(hovered ? { "data-hover": "" } : {}),
    ...(selected ? { "data-selected": "" } : {}),
    ...(emphasis ? { "data-emphasis": emphasis } : {}),
    ...(diff ? { "data-diff": diff } : {}),
  };

  const head = (
    <>
      <IconTile size={tileSize} layer={tint} shape={isTileShape(shape) ? shape : undefined}>
        <NodeIcon node={node} size={TILE_ICON_SIZE[tileSize]} />
      </IconTile>
      <span className="gi-node__text">
        <span className="gi-node__label" title={node.label}>
          {label.method && <span className="gi-method">{label.method}</span>}
          {label.text && <span>{label.text}</span>}
          {label.code && <code>{label.code}</code>}
        </span>
        {(subtitle.text ?? subtitle.code) && (
          <Text value={subtitle} className="gi-node__subtitle" />
        )}
      </span>
      <Badges counts={counts} />
      {fields && (
        <code className="gi-node__fields" title={fields}>
          {fields}
        </code>
      )}
      <DiffTag diff={diff} />
    </>
  );

  if (open) {
    return (
      <section role="group" {...attrs}>
        <header className="gi-node__header">{head}</header>
        <div className="gi-node__body">{children}</div>
      </section>
    );
  }
  return (
    <div role="group" {...attrs}>
      {head}
    </div>
  );
}
