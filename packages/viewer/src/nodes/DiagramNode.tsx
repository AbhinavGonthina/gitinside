import type { GraphNode, Layer } from "@gitinside/schema";
import { Fragment, useId, type HTMLAttributes, type ReactNode } from "react";
import { IconTile, isTileShape, NodeIcon, TILE_ICON_SIZE } from "../icons/Icon.js";
import { Glyph } from "../icons/glyphs.js";
import { namePieces, type CardLook } from "./cards.js";
import {
  changesText,
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
  /**
   * A prefix of the name that other services share (`HierarchyIndex.scopes`),
   * drawn in a span of its own so the canvas can drop it when zoomed out. The
   * name still reads whole; a scope the name doesn't start with is ignored.
   */
  scope?: string | undefined;
  /**
   * The prototype's card (M10.3b3, `cardLook`): a name and subtitle drawn instead of the node's,
   * and, closed, a host group drawn as a circle tile with its members' logos. Counts still come
   * from `counts`.
   */
  card?: CardLook | undefined;
  /** The prototype's names (M10.3b3): wrap onto more lines instead of ending in "…". */
  wrap?: boolean | undefined;
  /** Frames only: draw open, with `children` inside, instead of as a closed card. */
  expanded?: boolean;
  /** Frames only: the nodes drawn inside an expanded frame. */
  children?: ReactNode;
}

// The text under a box's name (subtitle, count badges, a model's fields) is `aria-hidden`, and
// the same words, joined with commas, are the box's description: a `hidden` span the box's
// `aria-describedby` points to (a referenced node is read even when hidden; one plain string,
// so no browser runs "Next.js" into "apps/web"). The box's accessible name is its label and
// kind; before M9.6 a screen reader never heard the subtitle or counts, and the exposed text
// is now the label alone, which starts the name (WCAG 2.5.3, Label in Name; a11y.e2e.ts).

/** The box's description: subtitle, the counts that aren't changes (those are in the name), fields. */
export function nodeDescription(
  subtitle: NodeText,
  counts: readonly NodeCount[] | undefined,
  fields: string | undefined,
): string {
  return [
    subtitle.text,
    subtitle.code,
    ...(counts ?? []).filter((c) => !c.diff).map(countText),
    fields,
  ]
    .filter(Boolean)
    .join(", ");
}

function Text({ value, className }: { value: NodeText; className: string }) {
  return (
    <span className={className} aria-hidden>
      {value.text && <span>{value.text}</span>}
      {value.code && <code>{value.code}</code>}
    </span>
  );
}

/**
 * The diff state as a tag on the node's top edge, so it takes no room from the name. Hidden
 * from assistive tech: the name already says it ("Added in this change").
 */
function DiffTag({ diff }: Pick<DiagramNodeProps, "diff">) {
  if (!diff) return null;
  return (
    <span className="gi-badge gi-node__diff" data-diff={diff} aria-hidden>
      <span className="gi-badge__dot" aria-hidden />
      {DIFF_TEXT[diff]}
    </span>
  );
}

/** A name that may wrap: a break opportunity after each of its pieces (`namePieces`). */
function Breakable({ text, wrap }: { text: string; wrap: boolean }) {
  if (!wrap) return text;
  return namePieces(text).map((piece, i) => (
    <Fragment key={i}>
      {piece}
      <wbr />
    </Fragment>
  ));
}

/** A host group's tile (M10.3b3): up to four of its members' logos in a 2×2 grid. */
function LogoTile({ logos, layer }: { logos: readonly GraphNode[]; layer: Layer | undefined }) {
  const [only] = logos;
  return (
    <IconTile size="lg" layer={layer} shape="circle">
      {logos.length === 0 || !only ? (
        <Glyph name="external" size={TILE_ICON_SIZE.lg} />
      ) : logos.length === 1 ? (
        <NodeIcon node={only} size={TILE_ICON_SIZE.lg} />
      ) : (
        <span className="gi-icon-tile__logos" data-count={logos.length}>
          {logos.map((m) => (
            <NodeIcon key={m.id} node={m} size={18} />
          ))}
        </span>
      )}
    </IconTile>
  );
}

function Badges({ counts }: Pick<DiagramNodeProps, "counts">) {
  if (!counts?.length) return null;
  return (
    <span className="gi-node__badges" aria-hidden>
      {counts.map((c) => (
        <span
          key={c.diff ? `diff:${c.diff}` : c.noun}
          className="gi-badge"
          {...(c.unresolved ? { "data-unresolved": "" } : {})}
          {...(c.diff ? { "data-diff": c.diff } : {})}
        >
          {c.diff && <span className="gi-badge__dot" aria-hidden />}
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
  scope,
  card,
  wrap = false,
  expanded = false,
  children,
  hovered = false,
  selected = false,
  emphasis,
  diff,
  className,
  ...rest
}: DiagramNodeProps) {
  const open = nodeTier(node) === "frame" && expanded;
  // A closed host group is drawn as an outside API is: its logos on a circle tile.
  const logos = open ? undefined : card?.logos;
  const tier = logos ? "icon" : nodeTier(node);
  const tint = node.layer ?? layer;
  const label = card?.name === undefined ? nodeLabel(node) : { text: card.name };
  const subtitle = card?.subtitle ?? nodeSubtitle(node);
  const tileSize = tier === "icon" ? "lg" : "sm";
  const shape = logos ? "circle" : nodeShape(node, tint);
  // The accessible name starts with the name drawn (WCAG 2.5.3).
  const spoken = card?.name === undefined ? node : { ...node, label: card.name };
  const fields = modelFieldsText(node);
  // A role that carries selection (the canvas's tree items) says it; the name doesn't repeat it.
  const named = rest["aria-selected"] === undefined && selected;
  // A box holding changes says so in words too, as its badges do.
  const changes = changesText(counts ?? []);
  const descriptionId = useId();
  const hasSubtitle = Boolean(subtitle.text ?? subtitle.code);
  const description = [nodeDescription(subtitle, counts, fields), card?.caption]
    .filter(Boolean)
    .join(", ");
  const describedBy = [rest["aria-describedby"], description ? descriptionId : undefined].filter(
    Boolean,
  );

  const attrs = {
    ...rest,
    className: className ? `gi-node ${className}` : "gi-node",
    "data-tier": tier,
    "data-kind": node.kind,
    "data-shape": shape,
    "aria-label": [nodeAccessibleName(spoken, { selected: named, emphasis, diff }), changes]
      .filter(Boolean)
      .join(". "),
    ...(describedBy.length ? { "aria-describedby": describedBy.join(" ") } : {}),
    ...(tier === "frame" ? { "data-expanded": String(open) } : {}),
    ...(tint ? { "data-layer": tint } : {}),
    ...(wrap ? { "data-wrap": "" } : {}),
    ...(hovered ? { "data-hover": "" } : {}),
    ...(selected ? { "data-selected": "" } : {}),
    ...(emphasis ? { "data-emphasis": emphasis } : {}),
    ...(diff ? { "data-diff": diff } : {}),
  };

  const head = (
    <>
      {logos ? (
        <LogoTile logos={logos} layer={tint} />
      ) : (
        <IconTile size={tileSize} layer={tint} shape={isTileShape(shape) ? shape : undefined}>
          <NodeIcon node={node} size={TILE_ICON_SIZE[tileSize]} />
        </IconTile>
      )}
      <span className="gi-node__text">
        <span className="gi-node__label" title={node.label}>
          {label.method && <span className="gi-method">{label.method}</span>}
          {label.text &&
            (scope && card?.name === undefined && label.text.startsWith(scope) ? (
              <span>
                <span className="gi-node__scope">
                  <Breakable text={scope} wrap={wrap} />
                </span>
                <Breakable text={label.text.slice(scope.length)} wrap={wrap} />
              </span>
            ) : (
              <span>
                <Breakable text={label.text} wrap={wrap} />
              </span>
            ))}
          {label.code && (
            <code>
              <Breakable text={label.code} wrap={wrap} />
            </code>
          )}
        </span>
        {hasSubtitle && <Text value={subtitle} className="gi-node__subtitle" />}
        {card?.caption && (
          <span className="gi-node__caption" aria-hidden>
            {card.caption}
          </span>
        )}
      </span>
      <Badges counts={counts} />
      {fields && (
        <code className="gi-node__fields" title={fields} aria-hidden>
          {fields}
        </code>
      )}
      <DiffTag diff={diff} />
      {description && (
        <span id={descriptionId} hidden>
          {description}
        </span>
      )}
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
