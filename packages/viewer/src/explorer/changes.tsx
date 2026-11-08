import { renameLimitText } from "@gitinside/diff";
import type { GraphDiff, GraphNode } from "@gitinside/schema";
import { useId } from "react";
import { IconTile, NodeIcon, TILE_ICON_SIZE } from "../icons/Icon.js";
import type { ChangeItem, ChangesList, ChangeStatus } from "../model/diff.js";
import { isWithin, layerOf, type HierarchyIndex } from "../model/hierarchy.js";
import { DIFF_TEXT, kindName, nodeLabel } from "../nodes/describe.js";

/**
 * Diff mode's changes list in the inspector (M6.9d, UX.md "Diff mode"):
 * Added / Changed / Removed / Broken, each row in words from the diff
 * ("Moved from src/routes/orders.ts", "Method and path changed", the broken
 * connection's own words). Selecting a row flies to its node.
 */

/** The groups in reading order, with their headings. */
const GROUPS: readonly { status: ChangeStatus; title: string }[] = [
  { status: "added", title: "Added" },
  { status: "changed", title: "Changed" },
  { status: "removed", title: "Removed" },
  { status: "broken", title: "Broken" },
];

/** A row's state in words, leading its accessible name. */
const STATUS_TEXT: Readonly<Record<ChangeStatus, string>> = { ...DIFF_TEXT, broken: "Broken" };

/** A changed record field in words; fields not listed read as their own name. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  hash: "code",
  fields: "fields",
  path: "path",
  method: "method",
  root: "root folder",
  framework: "framework",
  engine: "engine",
  name: "name",
  host: "host",
  requiredParams: "required parameters",
  exported: "export",
  symbolKind: "kind",
  kind: "kind",
  layer: "layer",
  parentId: "parent",
  reason: "reason",
  expression: "expression",
  detail: "detail",
};

/** Fields that never read as a change: a label and a source position follow from the rest. */
const INCIDENTAL = new Set(["label", "source"]);

/** Fields a rename's words already say (where it moved from). */
const MOVE_FIELDS = new Set(["path", "parentId"]);

/** "a", "a and b", "a, b, and c". */
function listWords(words: readonly string[]): string {
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1) ?? ""}`;
}

/** "Method and path changed", or nothing when no field a reader cares about changed. */
function fieldsChanged(fields: readonly string[], skip: ReadonlySet<string>): string | undefined {
  const words = [
    ...new Set(
      fields.filter((f) => !INCIDENTAL.has(f) && !skip.has(f)).map((f) => FIELD_WORDS[f] ?? f),
    ),
  ];
  if (words.length === 0) return undefined;
  const text = `${listWords(words)} changed`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A path's folder ("" at the repo root). */
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Where a node lives: a file's or folder's path, else its source file. */
function whereOf(node: GraphNode): string | undefined {
  if (node.kind === "file" || node.kind === "module") return node.path;
  return "source" in node ? node.source?.file : undefined;
}

/**
 * A renamed or moved node in words. A file or folder that moved says where
 * from (its old path holds its old name too); one renamed in its folder, or a
 * symbol renamed in its file, says its old name; a symbol that moved says
 * which file it was in, and its old name if that changed too.
 */
export function renameWords(node: GraphNode, from: GraphNode): string {
  const renamed = from.label !== node.label;
  const was = whereOf(from);
  if (node.kind === "file" || node.kind === "module") {
    const now = whereOf(node);
    if (was !== undefined && now !== undefined && folderOf(was) !== folderOf(now)) {
      return `Moved from ${was}`;
    }
    return renamed ? `Renamed from ${from.label}` : "Moved";
  }
  const moved = was !== undefined && was !== whereOf(node);
  if (renamed && moved) return `Renamed from ${from.label}, moved from ${was}`;
  if (moved) return `Moved from ${was}`;
  return renamed ? `Renamed from ${from.label}` : "Moved";
}

/** What a node is and where it lives: "Route · src/server.ts". */
function kindAndPlace(node: GraphNode): string {
  const where = whereOf(node);
  return where === undefined || where === "" ? kindName(node) : `${kindName(node)} · ${where}`;
}

/**
 * A row's second line, from the diff alone: a rename or move and what else
 * changed, the fields that changed, a broken connection's words, or for an
 * added or removed node what it is, where, and how much more came with it.
 */
export function changeDetail(item: ChangeItem, node: GraphNode): string {
  switch (item.status) {
    case "broken":
      return item.broken?.detail ?? "Broken";
    case "changed": {
      const fields = item.fields ?? [];
      if (item.from) {
        const also = fieldsChanged(fields, MOVE_FIELDS);
        const moved = renameWords(node, item.from);
        return also ? `${moved} · ${also.toLowerCase()}` : moved;
      }
      return fieldsChanged(fields, new Set()) ?? "Changed";
    }
    default: {
      const more = item.inside > 0 ? ` · ${item.inside.toLocaleString("en-US")} more inside` : "";
      return `${kindAndPlace(node)}${more}`;
    }
  }
}

/**
 * What the overview says when the diff's rename detection stopped at its budget
 * (`renameLimit`, ADR-0086's M6.11n2 amendment), or `undefined`: the comparison
 * fails visibly rather than passing a move off as a removal and an addition.
 * Only a diff made with file contents (the PR bot's, M8.6f2) can carry it.
 */
export function movesNote(diff: GraphDiff): string | undefined {
  const text = renameLimitText(diff);
  return text === undefined
    ? undefined
    : `${text}, so a moved file may show as one removed and one added.`;
}

/** How many changes a group stands for: its rows and what's folded into them, as the frames count them. */
function groupCount(rows: readonly ChangeItem[]): number {
  return rows.reduce((n, r) => n + 1 + r.inside, 0);
}

/** Props for {@link ChangesSection}. */
export interface ChangesSectionProps {
  /** The overlay's hierarchy: every row's node is in it, in either version. */
  index: HierarchyIndex;
  changes: ChangesList;
  /** Only the rows for this node and what's inside it (the selection); the root lists all. */
  within: string;
  /** Each folded node's row (`DiffOverlay.foldedInto`): a selection folded into one lists that row. */
  foldedInto: ReadonlyMap<string, string>;
  /** Fly to a row's node, drilling down to it. */
  onSelect: (id: string) => void;
  /** {@link movesNote} of the diff, shown in the overview only (it counts the whole diff's files). */
  limit?: string | undefined;
}

/**
 * The changes list: a group per state with what it stands for counted, each
 * row the node's icon and name, then its change in words. Groups with no
 * rows are left out; the repo overview says when nothing changed, and a
 * selection with no changes in it shows no section. A selection folded into
 * an added or removed row (a file of an added service) lists that row too,
 * since its frame counts those changes (M6.11g). The overview leads with
 * `limit` when the diff left some moves unchecked (M8.6f2).
 */
export function ChangesSection({
  index,
  changes,
  within,
  foldedInto,
  onSelect,
  limit,
}: ChangesSectionProps) {
  const headingId = useId();
  const all = within === index.root.id;
  const host = foldedInto.get(within);
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: changes[g.status].filter(
      (r) =>
        all ||
        isWithin(index, r.id, within) ||
        (r.id === host && (g.status === "added" || g.status === "removed")),
    ),
  })).filter((g) => g.rows.length > 0);
  if (groups.length === 0 && !all) return null;
  return (
    <section className="gi-inspector__section gi-changes" aria-labelledby={headingId}>
      <h3 id={headingId}>{all ? "Changes" : "Changes here"}</h3>
      {all && limit !== undefined && <p className="gi-changes__limit">{limit}</p>}
      {groups.length === 0 ? (
        <p className="gi-inspector__empty">
          Nothing the diagram draws changed between these commits.
        </p>
      ) : (
        groups.map((g) => (
          <ChangeGroup
            key={g.status}
            index={index}
            title={g.title}
            rows={g.rows}
            onSelect={onSelect}
          />
        ))
      )}
    </section>
  );
}

function ChangeGroup({
  index,
  title,
  rows,
  onSelect,
}: {
  index: HierarchyIndex;
  title: string;
  rows: readonly ChangeItem[];
  onSelect: (id: string) => void;
}) {
  const id = useId();
  return (
    <>
      <h4 id={id} className="gi-changes__group">
        {title}
        <span className="gi-count">{groupCount(rows).toLocaleString("en-US")}</span>
      </h4>
      <ul className="gi-connections" aria-labelledby={id}>
        {rows.map((row) => (
          <ChangeRow
            key={`${row.id} ${row.broken?.edge ?? ""}`}
            index={index}
            row={row}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </>
  );
}

function ChangeRow({
  index,
  row,
  onSelect,
}: {
  index: HierarchyIndex;
  row: ChangeItem;
  onSelect: (id: string) => void;
}) {
  const node = index.byId.get(row.id);
  if (!node) return null;
  const label = nodeLabel(node);
  const detail = changeDetail(row, node);
  const tint = node.layer ?? layerOf(index, node.id);
  return (
    <li>
      <button
        type="button"
        className="gi-connection gi-change"
        data-diff={row.status}
        aria-label={`${STATUS_TEXT[row.status]}: ${node.label}, ${kindName(node).toLowerCase()}. ${detail}`}
        title={`${node.label} · ${detail}`}
        onClick={() => onSelect(row.id)}
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
          <span className="gi-connection__edge">{detail}</span>
        </span>
        <span className="gi-change__mark" aria-hidden />
      </button>
    </li>
  );
}
