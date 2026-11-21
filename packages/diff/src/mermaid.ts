import {
  compareStrings,
  type ArchitectureGraph,
  type BrokenReason,
  type EdgeKind,
  type GraphDiff,
  type GraphNode,
  type NodeKind,
} from "@gitinside/schema";

/** Options for {@link renderMermaidSummary}. */
export interface MermaidSummaryOptions {
  /** Draw at most this many nodes; the rest are counted in a closing note. Default 40. */
  maxNodes?: number;
}

/** Node kinds a summary draws when they change: the level a PR reviewer reasons at. */
const SHOWN_KINDS: ReadonlySet<NodeKind> = new Set([
  "service",
  "route",
  "page",
  "model",
  "datastore",
  "queue",
  "external",
]);

/** Edge kinds a summary draws when they change: connections across those nodes. */
const SHOWN_EDGES: ReadonlySet<EdgeKind> = new Set([
  "http",
  "reads",
  "writes",
  "stores",
  "publishes",
  "consumes",
  "external_call",
]);

/** The word put before a label, so text says the kind as well as the shape does. */
const KIND_WORDS: Record<NodeKind, string> = {
  system: "system",
  service: "service",
  module: "folder",
  file: "file",
  symbol: "symbol",
  route: "",
  page: "page",
  model: "model",
  datastore: "datastore",
  queue: "queue",
  external: "external",
  unresolved: "unresolved",
};

/** What breaks, in the words of DESIGN_SYSTEM.md's broken-edge pill. Shared with the PR comment. */
export const BROKEN_WORDS: Record<BrokenReason, string> = {
  TARGET_REMOVED: "target removed",
  ROUTE_CHANGED: "route changed",
  TARGET_MOVED: "target moved",
  PARAMETERS_ADDED: "needs more arguments",
  FIELD_REMOVED: "field removed",
};

type NodeStatus = "added" | "removed" | "changed";
type EdgeStatus = NodeStatus | "broken";

const STATUS_WORDS: Record<EdgeStatus, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  broken: "Broken",
};

/** Stroke colors: the light theme's diff tokens (DESIGN_SYSTEM.md §3), legible on both GitHub themes. */
const COLORS: Record<EdgeStatus, string> = {
  added: "#1e8e4e",
  removed: "#d23b3b",
  changed: "#a87700",
  broken: "#d23b3b",
};

const NODE_STYLES: Record<NodeStatus, string> = {
  added: `stroke:${COLORS.added},stroke-width:2px`,
  removed: `stroke:${COLORS.removed},stroke-width:2px,stroke-dasharray:5 3`,
  changed: `stroke:${COLORS.changed},stroke-width:2px`,
};

const EDGE_STYLES: Record<EdgeStatus, string> = {
  added: `stroke:${COLORS.added},stroke-width:2px`,
  removed: `stroke:${COLORS.removed},stroke-width:2px,stroke-dasharray:5 3`,
  changed: `stroke:${COLORS.changed},stroke-width:2px`,
  broken: `stroke:${COLORS.broken},stroke-width:3px,stroke-dasharray:5 3`,
};

/** Longest label drawn, in code points, before it's cut with "...". */
const MAX_LABEL = 60;

/** Characters written as themselves; every other one becomes a `#<code>;` entity. */
const SAFE_CHAR = /^[A-Za-z0-9 ._,()/:@-]$/;

/**
 * Mermaid text for a label from the repo: whitespace collapsed, cut to `MAX_LABEL`, and
 * every character outside a small safe set written as a numeric entity, so a label
 * can't close its quotes, start a directive, or carry HTML (SECURITY.md T10).
 */
export function escapeMermaidLabel(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  const cut = chars.length > MAX_LABEL ? [...chars.slice(0, MAX_LABEL - 3), ".", ".", "."] : chars;
  return cut.map((c) => (SAFE_CHAR.test(c) ? c : `#${c.codePointAt(0) ?? 0};`)).join("");
}

/**
 * Mermaid's opening and closing brackets per kind: a shape per kind, as in the viewer.
 * Shared with the viewer's Mermaid export, so both draw a kind the same way.
 */
export function mermaidShape(kind: NodeKind): [string, string] {
  switch (kind) {
    case "route":
    case "page":
      return ["([", "])"];
    case "model":
    case "datastore":
      return ["[(", ")]"];
    case "queue":
      return ["[[", "]]"];
    case "external":
      return ["{{", "}}"];
    default:
      return ["[", "]"];
  }
}

/**
 * What a diff whose rename detection stopped at its budget says about it, or `undefined`.
 * Short enough for `MAX_LABEL`: "Moves not checked for 401 removed and 2 added files".
 * Shared with the PR comment and the viewer's changes list.
 */
export function renameLimitText(diff: GraphDiff): string | undefined {
  const limit = diff.renameLimit;
  if (limit === undefined) return undefined;
  const counts = [
    ...(limit.removed > 0 ? [[limit.removed, "removed"] as const] : []),
    ...(limit.added > 0 ? [[limit.added, "added"] as const] : []),
  ];
  const last = counts.at(-1)?.[0];
  return last === undefined
    ? "Moves checked only between files of the same name"
    : `Moves not checked for ${counts.map(([n, word]) => `${n} ${word}`).join(" and ")} ${last === 1 ? "file" : "files"}`;
}

/** The Mermaid note line for {@link renameLimitText}, or `undefined`. */
function renameLimitNote(diff: GraphDiff): string | undefined {
  const text = renameLimitText(diff);
  return text === undefined ? undefined : `  limit["${escapeMermaidLabel(text)}"]`;
}

/** A symbol's label after its enclosing symbols' (`DocumentInterpreter.parse`), else the label. */
function qualifiedLabel(node: GraphNode, lookup: (id: string) => GraphNode | undefined): string {
  const parts = [node.label];
  let parent = node.kind === "symbol" && node.parentId !== null ? lookup(node.parentId) : undefined;
  while (parent?.kind === "symbol") {
    parts.unshift(parent.label);
    parent = parent.parentId === null ? undefined : lookup(parent.parentId);
  }
  return parts.join(".");
}

/**
 * A node as the summary and the PR comment name it: its kind in words, then its label, a
 * method after its class (`method DocumentInterpreter.parse`), a route as just its label.
 * `lookup` finds the node's ancestors.
 */
export function describeNode(
  node: GraphNode,
  lookup: (id: string) => GraphNode | undefined,
): string {
  const word = node.kind === "symbol" ? node.symbolKind : KIND_WORDS[node.kind];
  const label = qualifiedLabel(node, lookup);
  return word === "" ? label : `${word} ${label}`;
}

/** How a drawn node changed. */
export type RegionNodeStatus = NodeStatus;
/** How a drawn connection changed. */
export type RegionEdgeStatus = EdgeStatus;

/** A node of a {@link ChangedRegion}. */
export interface RegionNode {
  /** Head's node, or base's when it was removed. */
  node: GraphNode;
  /** Unset for a node drawn only as an end of a connection. */
  status?: RegionNodeStatus;
  /** The change in words: "Added", "Removed", "Changed", "Moved", or "Renamed from …". */
  change?: string;
  /** {@link describeNode}'s words for it. */
  title: string;
  /** Its service (else the file declaring it), when another drawn node has the same title. */
  where?: string;
}

/** A connection of a {@link ChangedRegion}, between two of its nodes' IDs. */
export interface RegionConnection {
  from: string;
  to: string;
  status: RegionEdgeStatus;
  /** "Broken: target removed", "Added http, reads". */
  label: string;
}

/** What a diff changes at the architecture level, as {@link changedRegion} picks it. */
export interface ChangedRegion {
  /** At most `maxNodes`, in priority order: broken ends, changed nodes, then context. */
  nodes: RegionNode[];
  /** Connections whose ends are both drawn: broken first, then by ends and status. */
  connections: RegionConnection[];
  /** Nodes left out past `maxNodes`. */
  moreNodes: number;
  /** Connections left out because an end was. */
  moreConnections: number;
}

/** Options for {@link changedRegion}. */
export interface ChangedRegionOptions {
  /** Keep at most this many nodes; the rest are counted. Default 40. */
  maxNodes?: number;
}

/**
 * The part of the graph a diff changes, as the PR comment's summary draws it (Mermaid here,
 * an image in `@gitinside/viewer/image`). Deterministic: the same diff and graphs give the same
 * region.
 *
 * Picks:
 * - Broken connections, source to target (as head names it when renamed), whatever the
 *   endpoints' kinds, first.
 * - Added, removed, and changed services, routes, pages, models, datastores, queues, and
 *   external hosts, with the change in words ("Added", "Removed", "Changed", "Renamed
 *   from …").
 * - Added, removed, and changed `http`, `reads`, `writes`, `stores`, `publishes`,
 *   `consumes`, and `external_call` edges, each endpoint lifted to the nearest node of a
 *   drawn kind (a function calling a route is drawn from its service), merged when
 *   several edges lift to the same pair.
 *
 * Leaves out: files, folders, and symbols that changed without breaking a connection,
 * `imports`/`calls`/`handles`/`renders` edges, `updated` records (nothing a reader would
 * call a change), and warnings. Past `maxNodes`, the remaining nodes, and the connections
 * reaching them, are only counted.
 */
export function changedRegion(
  diff: GraphDiff,
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  options: ChangedRegionOptions = {},
): ChangedRegion {
  const maxNodes = options.maxNodes ?? 40;
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const headNodes = new Map(head.nodes.map((n) => [n.id, n]));
  const renamedTo = new Map(diff.nodes.renamed.map((r) => [r.from, r.node.id]));
  const lookup = (id: string): GraphNode | undefined => headNodes.get(id) ?? baseNodes.get(id);

  const status = new Map<string, { status: NodeStatus; from?: GraphNode | undefined }>();
  for (const n of diff.nodes.added) status.set(n.id, { status: "added" });
  for (const id of diff.nodes.removed) status.set(id, { status: "removed" });
  for (const c of diff.nodes.modified) status.set(c.node.id, { status: "changed" });
  for (const r of diff.nodes.renamed) {
    status.set(r.node.id, { status: "changed", from: baseNodes.get(r.from) });
  }

  /** The nearest node of a drawn kind at or above `id` in `nodes`, as a head ID if renamed. */
  const anchor = (id: string, nodes: ReadonlyMap<string, GraphNode>): string | undefined => {
    let node = nodes.get(id);
    while (node !== undefined && !SHOWN_KINDS.has(node.kind)) {
      node = node.parentId === null ? undefined : nodes.get(node.parentId);
    }
    return node === undefined ? undefined : (renamedTo.get(node.id) ?? node.id);
  };

  // A broken entry's `to` is its base ID; a target head also renamed is drawn as its head node.
  const connections: RegionConnection[] = diff.broken.map((b) => ({
    from: b.from,
    to: renamedTo.get(b.to) ?? b.to,
    status: "broken",
    label: `Broken: ${BROKEN_WORDS[b.reason]}`,
  }));
  const brokenEdges = new Set(diff.broken.map((b) => b.edge));
  const lifted = new Map<string, Omit<RegionConnection, "label"> & { kinds: Set<EdgeKind> }>();
  const lift = (
    edge: { id: string; kind: EdgeKind; from: string; to: string },
    edgeStatus: NodeStatus,
    nodes: ReadonlyMap<string, GraphNode>,
  ): void => {
    if (!SHOWN_EDGES.has(edge.kind) || brokenEdges.has(edge.id)) return;
    const from = anchor(edge.from, nodes);
    const to = anchor(edge.to, nodes);
    if (from === undefined || to === undefined || from === to) return;
    const key = [from, to, edgeStatus].join("\n");
    const known = lifted.get(key) ?? { from, to, status: edgeStatus, kinds: new Set() };
    known.kinds.add(edge.kind);
    lifted.set(key, known);
  };
  for (const e of diff.edges.added) lift(e, "added", headNodes);
  const baseEdges = new Map(base.edges.map((e) => [e.id, e]));
  for (const id of diff.edges.removed) {
    const edge = baseEdges.get(id);
    if (edge !== undefined) lift(edge, "removed", baseNodes);
  }
  for (const c of diff.edges.modified) lift(c.edge, "changed", headNodes);
  connections.push(
    ...[...lifted.values()]
      .map(({ kinds, ...c }) => ({
        ...c,
        label: `${STATUS_WORDS[c.status]} ${[...kinds].sort(compareStrings).join(", ")}`,
      }))
      .sort(
        (a, b) =>
          compareStrings(a.from, b.from) ||
          compareStrings(a.to, b.to) ||
          compareStrings(a.status, b.status),
      ),
  );

  // Priority order: broken endpoints, changed nodes, then context.
  const wanted: string[] = [];
  for (const c of connections.filter((c) => c.status === "broken")) wanted.push(c.from, c.to);
  wanted.push(
    ...[...status.keys()]
      .filter((id) => {
        const kind = lookup(id)?.kind;
        return kind !== undefined && SHOWN_KINDS.has(kind);
      })
      .sort(compareStrings),
  );
  for (const c of connections.filter((c) => c.status !== "broken")) wanted.push(c.from, c.to);
  const unique = [...new Set(wanted)].filter((id) => lookup(id) !== undefined);
  const drawn = unique.slice(0, maxNodes);
  const kept = new Set(drawn);

  const qualified = (node: GraphNode): string => qualifiedLabel(node, lookup);
  /** Label of the service `node` belongs to, if any. */
  const serviceOf = (node: GraphNode): string | undefined => {
    let current = node.parentId === null ? undefined : lookup(node.parentId);
    while (current !== undefined && current.kind !== "service") {
      current = current.parentId === null ? undefined : lookup(current.parentId);
    }
    return current?.label;
  };
  const titles = new Map<string, number>();
  for (const id of drawn) {
    const t = describeNode(lookup(id) as GraphNode, lookup);
    titles.set(t, (titles.get(t) ?? 0) + 1);
  }

  const nodes = drawn.map((id): RegionNode => {
    const node = lookup(id) as GraphNode;
    const title = describeNode(node, lookup);
    const out: RegionNode = { node, title };
    // Two drawn nodes reading the same ("datastore postgres" in two services) get their
    // service, else the file declaring them (a compose file's datastores sit under the system).
    const where = (titles.get(title) ?? 0) > 1 ? (serviceOf(node) ?? node.source?.file) : undefined;
    if (where !== undefined) out.where = where;
    const change = status.get(id);
    if (change === undefined) return out;
    out.status = change.status;
    if (change.from !== undefined) {
      // A method renamed within its class names only the old method; moved, the old class too.
      const from = qualified(change.from);
      const to = qualified(node);
      const sameOwner =
        from.slice(0, -change.from.label.length) === to.slice(0, -node.label.length);
      out.change = from === to ? "Moved" : `Renamed from ${sameOwner ? change.from.label : from}`;
    } else {
      out.change = STATUS_WORDS[change.status];
    }
    return out;
  });
  const shown = connections.filter((c) => kept.has(c.from) && kept.has(c.to));
  return {
    nodes,
    connections: shown,
    moreNodes: unique.length - drawn.length,
    moreConnections: connections.length - shown.length,
  };
}

/**
 * A Mermaid `flowchart` of what a diff changes at the architecture level, for the CLI
 * (`gitinside diff --format mermaid`) and the PR comment (M8.6). Deterministic: the same
 * diff and graphs give the same text.
 *
 * Draws {@link changedRegion}'s nodes and connections (see there for what it picks and
 * leaves out), each change in words ("Added", "Renamed from …") and in a colored, for
 * removed dashed, border or line. A method is named with its class (`method
 * DocumentInterpreter.parse`), so a reader can tell which `parse` broke.
 *
 * Past `maxNodes`, the remaining nodes and connections are counted in a closing note
 * rather than drawn. A diff with `renameLimit` gets a note that
 * moves weren't checked for that many files (they show as removed and added).
 */
export function renderMermaidSummary(
  diff: GraphDiff,
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  options: MermaidSummaryOptions = {},
): string {
  const region = changedRegion(diff, base, head, { maxNodes: options.maxNodes ?? 40 });
  const lines = ["flowchart LR"];
  const limitNote = renameLimitNote(diff);
  if (region.nodes.length === 0) {
    lines.push(`  none["${escapeMermaidLabel("No architecture-level changes")}"]`);
    if (limitNote !== undefined) lines.push(limitNote);
    return `${lines.join("\n")}\n`;
  }

  const names = new Map(region.nodes.map(({ node }, i) => [node.id, `n${i + 1}`]));
  const classes = new Map<NodeStatus, string[]>();
  for (const { node, status, change, title, where } of region.nodes) {
    let text = title;
    if (where !== undefined) text += ` in ${where}`;
    if (change !== undefined) text += ` - ${change}`;
    const [open, close] = mermaidShape(node.kind);
    const name = names.get(node.id) as string;
    lines.push(`  ${name}${open}"${escapeMermaidLabel(text)}"${close}`);
    if (status !== undefined) classes.set(status, [...(classes.get(status) ?? []), name]);
  }

  const styles = new Map<EdgeStatus, number[]>();
  region.connections.forEach((c, index) => {
    const arrow = c.status === "added" || c.status === "changed" ? "-->" : "-.->";
    lines.push(
      `  ${names.get(c.from) as string} ${arrow}|"${escapeMermaidLabel(c.label)}"| ${names.get(c.to) as string}`,
    );
    styles.set(c.status, [...(styles.get(c.status) ?? []), index]);
  });

  const { moreNodes: more, moreConnections: hidden } = region;
  if (more > 0 || hidden > 0) {
    const parts = [
      ...(more > 0 ? [`${more} more ${more === 1 ? "node" : "nodes"}`] : []),
      ...(hidden > 0 ? [`${hidden} more ${hidden === 1 ? "connection" : "connections"}`] : []),
    ];
    lines.push(`  more["${escapeMermaidLabel(`...and ${parts.join(" and ")} not drawn`)}"]`);
  }
  if (limitNote !== undefined) lines.push(limitNote);

  for (const s of ["added", "removed", "changed"] as const) {
    const members = classes.get(s);
    if (members === undefined) continue;
    lines.push(`  classDef ${s} ${NODE_STYLES[s]}`, `  class ${members.join(",")} ${s}`);
  }
  for (const s of ["broken", "added", "removed", "changed"] as const) {
    const members = styles.get(s);
    if (members !== undefined) lines.push(`  linkStyle ${members.join(",")} ${EDGE_STYLES[s]}`);
  }
  return `${lines.join("\n")}\n`;
}
