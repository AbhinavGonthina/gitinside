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

/** What breaks, in the words of DESIGN_SYSTEM.md's broken-edge pill. */
const BROKEN_WORDS: Record<BrokenReason, string> = {
  TARGET_REMOVED: "target removed",
  ROUTE_CHANGED: "route changed",
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

/** Mermaid's opening and closing brackets per kind: a shape per kind, as in the viewer. */
function shape(kind: NodeKind): [string, string] {
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

interface Connection {
  from: string;
  to: string;
  status: EdgeStatus;
  label: string;
}

/**
 * A Mermaid `flowchart` of what a diff changes at the architecture level, for the CLI
 * (`gitinside diff --format mermaid`) and the PR comment (M8.6). Deterministic: the same
 * diff and graphs give the same text.
 *
 * Draws:
 * - Broken connections, source to base target, whatever the endpoints' kinds, first.
 * - Added, removed, and changed services, routes, pages, models, datastores, queues, and
 *   external hosts, with the change in words ("Added", "Removed", "Changed", "Renamed
 *   from …") and in a colored, for removed dashed, border.
 * - Added, removed, and changed `http`, `reads`, `writes`, `stores`, `publishes`,
 *   `consumes`, and `external_call` edges, each endpoint lifted to the nearest node of a
 *   drawn kind (a function calling a route is drawn from its service), merged when
 *   several edges lift to the same pair.
 *
 * Doesn't draw: files, folders, and symbols that changed without breaking a connection,
 * `imports`/`calls`/`handles`/`renders` edges, `updated` records (nothing a reader would
 * call a change), and warnings. Past `maxNodes`, the remaining nodes and connections are
 * counted in a closing note rather than drawn.
 */
export function renderMermaidSummary(
  diff: GraphDiff,
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  options: MermaidSummaryOptions = {},
): string {
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

  const connections: Connection[] = diff.broken.map((b) => ({
    from: b.from,
    to: b.to,
    status: "broken",
    label: `Broken: ${BROKEN_WORDS[b.reason]}`,
  }));
  const brokenEdges = new Set(diff.broken.map((b) => b.edge));
  const lifted = new Map<string, Omit<Connection, "label"> & { kinds: Set<EdgeKind> }>();
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

  // Draw order is priority order: broken endpoints, changed nodes, then context.
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
  const names = new Map(drawn.map((id, i) => [id, `n${i + 1}`]));

  const lines = ["flowchart LR"];
  if (drawn.length === 0) {
    lines.push(`  none["${escapeMermaidLabel("No architecture-level changes")}"]`);
    return `${lines.join("\n")}\n`;
  }

  const title = (node: GraphNode): string => {
    const word = node.kind === "symbol" ? node.symbolKind : KIND_WORDS[node.kind];
    return word === "" ? node.label : `${word} ${node.label}`;
  };
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
    const t = title(lookup(id) as GraphNode);
    titles.set(t, (titles.get(t) ?? 0) + 1);
  }

  const classes = new Map<NodeStatus, string[]>();
  for (const id of drawn) {
    const node = lookup(id) as GraphNode;
    const change = status.get(id);
    let text = title(node);
    // Two drawn nodes reading the same ("datastore postgres" in two services) get their
    // service, else the file declaring them (a compose file's datastores sit under the system).
    const where = (titles.get(text) ?? 0) > 1 ? (serviceOf(node) ?? node.source?.file) : undefined;
    if (where !== undefined) text += ` in ${where}`;
    if (change?.from !== undefined) {
      text +=
        change.from.label === node.label ? " - Moved" : ` - Renamed from ${change.from.label}`;
    } else if (change !== undefined) {
      text += ` - ${STATUS_WORDS[change.status]}`;
    }
    const [open, close] = shape(node.kind);
    const name = names.get(id) as string;
    lines.push(`  ${name}${open}"${escapeMermaidLabel(text)}"${close}`);
    if (change !== undefined)
      classes.set(change.status, [...(classes.get(change.status) ?? []), name]);
  }

  const styles = new Map<EdgeStatus, number[]>();
  let index = 0;
  let hidden = 0;
  for (const c of connections) {
    const from = names.get(c.from);
    const to = names.get(c.to);
    if (from === undefined || to === undefined) {
      hidden++;
      continue;
    }
    const arrow = c.status === "added" || c.status === "changed" ? "-->" : "-.->";
    lines.push(`  ${from} ${arrow}|"${escapeMermaidLabel(c.label)}"| ${to}`);
    styles.set(c.status, [...(styles.get(c.status) ?? []), index++]);
  }

  const more = unique.length - drawn.length;
  if (more > 0 || hidden > 0) {
    const parts = [
      ...(more > 0 ? [`${more} more ${more === 1 ? "node" : "nodes"}`] : []),
      ...(hidden > 0 ? [`${hidden} more ${hidden === 1 ? "connection" : "connections"}`] : []),
    ];
    lines.push(`  more["${escapeMermaidLabel(`...and ${parts.join(" and ")} not drawn`)}"]`);
  }

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
