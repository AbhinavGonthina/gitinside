import { compareStrings } from "@gitinside/schema";
import type {
  ArchitectureGraph,
  BrokenReason,
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphRepo,
} from "@gitinside/schema";
import type { NodeDiff } from "../nodes/describe.js";

/**
 * Diff mode's model (M6.9a, UX.md "Diff mode"): one graph holding both
 * versions, so base, head, and the overlay are three ways of drawing the same
 * boxes (which is what keeps their positions stable), plus each item's state
 * and the inspector's changes list. Everything comes from `packages/diff`'s
 * output and the two graphs; nothing is guessed.
 *
 * IDs are head IDs wherever an item exists in head: a renamed node or edge
 * appears once, under its head ID, with its base record in `renamedFrom`.
 * Items only in base (removed) keep their base IDs, with their parent and
 * endpoints moved to head IDs when those were renamed.
 */

/** Which version an item is drawn in. */
export type DiffVersion = "base" | "head";

/** A connection the diff found broken, for the canvas and the changes list. */
export interface BrokenConnection {
  /** The edge's ID in the overlay: the base edge for a removed target, else the head edge. */
  edge: string;
  /** Source node, a head ID. */
  from: string;
  /** Target node as it was in base (removed or changed). */
  to: string;
  reason: BrokenReason;
  /** What broke, in the diff's words ("POST /api/orders was removed"). */
  detail: string;
}

/** How many changes sit below a node, so a closed frame can say so. Zero counts are kept. */
export interface DiffCounts {
  added: number;
  changed: number;
  removed: number;
  broken: number;
}

/** What a changes-list row is about. */
export type ChangeStatus = NodeDiff | "broken";

/** One row of the changes list. Selecting it flies to `id`. */
export interface ChangeItem {
  status: ChangeStatus;
  /** The node to fly to: the changed node itself, or a broken connection's source. */
  id: string;
  /** The node's label in the version it's drawn in (head, else base). */
  label: string;
  kind: GraphNode["kind"];
  /**
   * For `changed`: the record's changed field names (`["hash"]`), or for a rename,
   * the base node (`from`). For `broken`: the connection.
   */
  fields?: readonly string[] | undefined;
  from?: GraphNode | undefined;
  broken?: BrokenConnection | undefined;
  /**
   * Added or removed nodes folded into this row because their nearest listed
   * ancestor has the same state (an added service lists once, with its files counted).
   */
  inside: number;
}

/** The inspector's changes list (UX.md "Diff mode"), each group in reading order. */
export interface ChangesList {
  added: readonly ChangeItem[];
  changed: readonly ChangeItem[];
  removed: readonly ChangeItem[];
  broken: readonly ChangeItem[];
}

/** Both versions of a repo in one graph, with each item's diff state. */
export interface DiffOverlay {
  /** Head's graph plus every base-only node and edge: valid under the graph schema. */
  graph: ArchitectureGraph;
  /**
   * Node IDs drawn in each version (renamed nodes under their head ID in both).
   * Each is a tree: a base node moved to an added parent (a move the diff didn't
   * pair as a rename) brings that parent's frame into base too.
   */
  nodesIn: Readonly<Record<DiffVersion, ReadonlySet<string>>>;
  /** Edge IDs drawn in each version, likewise. */
  edgesIn: Readonly<Record<DiffVersion, ReadonlySet<string>>>;
  /** Each changed node's state. Unchanged (and only `updated`) nodes are absent. */
  nodes: ReadonlyMap<string, NodeDiff>;
  /** Each changed edge's state, likewise. A broken edge also has its base state here. */
  edges: ReadonlyMap<string, NodeDiff>;
  /** Broken connections by overlay edge ID. */
  broken: ReadonlyMap<string, BrokenConnection>;
  /** Base records of renamed nodes, by head ID. */
  renamedFrom: ReadonlyMap<string, GraphNode>;
  /** Changes below each node (not counting itself), for every ancestor of a change. */
  inside: ReadonlyMap<string, Readonly<DiffCounts>>;
  changes: ChangesList;
}

/** Thrown when a diff wasn't computed from the two graphs it's paired with. */
export class DiffMismatchError extends Error {
  override readonly name = "DiffMismatchError";
}

const sameRepo = (a: GraphRepo, b: GraphRepo): boolean =>
  a.owner === b.owner && a.name === b.name && a.sha === b.sha;

const byId = (a: { id: string }, b: { id: string }): number => compareStrings(a.id, b.id);

/**
 * Builds the overlay. Throws {@link DiffMismatchError} when the diff names a
 * repo, analyzer version, or item that the graphs don't have (a diff stored
 * for another pair), so the explorer can fail visibly rather than draw a
 * wrong picture.
 */
export function buildDiffOverlay(
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  diff: GraphDiff,
): DiffOverlay {
  if (!sameRepo(diff.base.repo, base.repo) || !sameRepo(diff.head.repo, head.repo)) {
    throw new DiffMismatchError("the diff was computed for another pair of commits");
  }
  if (
    base.analyzerVersion !== diff.analyzerVersion ||
    head.analyzerVersion !== diff.analyzerVersion
  ) {
    throw new DiffMismatchError("the diff and the graphs come from different analyzer versions");
  }

  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const headNodes = new Map(head.nodes.map((n) => [n.id, n]));
  const baseEdges = new Map(base.edges.map((e) => [e.id, e]));
  const headEdges = new Map(head.edges.map((e) => [e.id, e]));
  const expect = (found: boolean, what: string): void => {
    if (!found) throw new DiffMismatchError(`the diff names ${what}, which the graphs don't have`);
  };

  // Base ID → head ID for renamed nodes and edges.
  const nodeTo = new Map<string, string>();
  const renamedFrom = new Map<string, GraphNode>();
  for (const r of diff.nodes.renamed) {
    const was = baseNodes.get(r.from);
    expect(was !== undefined && headNodes.has(r.node.id), `node ${r.from} → ${r.node.id}`);
    nodeTo.set(r.from, r.node.id);
    renamedFrom.set(r.node.id, was as GraphNode);
  }
  const edgeTo = new Map<string, string>();
  for (const r of diff.edges.renamed) {
    expect(baseEdges.has(r.from) && headEdges.has(r.edge.id), `edge ${r.from} → ${r.edge.id}`);
    edgeTo.set(r.from, r.edge.id);
  }
  const headId = (id: string): string => nodeTo.get(id) ?? id;

  const nodes = new Map<string, NodeDiff>();
  for (const n of diff.nodes.added) {
    expect(headNodes.has(n.id) && !baseNodes.has(n.id), `added node ${n.id}`);
    nodes.set(n.id, "added");
  }
  for (const c of diff.nodes.modified) {
    expect(headNodes.has(c.node.id) && baseNodes.has(c.node.id), `changed node ${c.node.id}`);
    nodes.set(c.node.id, "changed");
  }
  for (const id of renamedFrom.keys()) nodes.set(id, "changed");

  const removedNodes: GraphNode[] = [];
  for (const id of diff.nodes.removed) {
    const node = baseNodes.get(id);
    expect(node !== undefined && !headNodes.has(id), `removed node ${id}`);
    const { parentId } = node as GraphNode;
    removedNodes.push({
      ...(node as GraphNode),
      parentId: parentId === null ? null : headId(parentId),
    });
    nodes.set(id, "removed");
  }

  const edges = new Map<string, NodeDiff>();
  for (const e of diff.edges.added) {
    expect(headEdges.has(e.id) && !baseEdges.has(e.id), `added edge ${e.id}`);
    edges.set(e.id, "added");
  }
  for (const c of diff.edges.modified) {
    expect(headEdges.has(c.edge.id) && baseEdges.has(c.edge.id), `changed edge ${c.edge.id}`);
    edges.set(c.edge.id, "changed");
  }
  // An edge renamed only because an endpoint was is no change of its own.
  for (const r of diff.edges.renamed) if (r.changes.length > 0) edges.set(r.edge.id, "changed");

  const removedEdges: GraphEdge[] = [];
  for (const id of diff.edges.removed) {
    const edge = baseEdges.get(id);
    expect(edge !== undefined && !headEdges.has(id), `removed edge ${id}`);
    const { from, to } = edge as GraphEdge;
    removedEdges.push({ ...(edge as GraphEdge), from: headId(from), to: headId(to) });
    edges.set(id, "removed");
  }

  const broken = new Map<string, BrokenConnection>();
  for (const b of diff.broken) {
    const edge = edgeTo.get(b.edge) ?? b.edge;
    expect(
      baseEdges.has(b.edge) && (headEdges.has(edge) || edges.get(edge) === "removed"),
      `broken edge ${b.edge}`,
    );
    broken.set(edge, {
      edge,
      from: headId(b.from),
      to: headId(b.to),
      reason: b.reason,
      detail: b.detail,
    });
  }

  const graph: ArchitectureGraph = {
    ...head,
    nodes: [...head.nodes, ...removedNodes].sort(byId),
    edges: [...head.edges, ...removedEdges].sort(byId),
  };
  const all = new Map(graph.nodes.map((n) => [n.id, n]));

  // A node whose parent changed sits under its head parent; base still draws
  // that parent around it (as a plain frame), so each version stays a tree.
  const inBase = new Set<string>();
  for (const n of graph.nodes) {
    if (nodes.get(n.id) === "added" || inBase.has(n.id)) continue;
    inBase.add(n.id);
    for (const a of ancestorsOf(all, n.id)) inBase.add(a.id);
  }
  const nodesIn = { base: inBase, head: new Set(head.nodes.map((n) => n.id)) };
  const edgesIn = {
    base: new Set(graph.edges.filter((e) => edges.get(e.id) !== "added").map((e) => e.id)),
    head: new Set(head.edges.map((e) => e.id)),
  };

  return {
    graph,
    nodesIn,
    edgesIn,
    nodes,
    edges,
    broken,
    renamedFrom,
    inside: countInside(all, nodes, broken),
    changes: changesList(all, nodes, broken, diff, renamedFrom),
  };
}

/** A drawn line's diff state and, when it stands for broken connections, what broke. */
export interface LineMark {
  diff?: NodeDiff | undefined;
  broken?: string | undefined;
}

/**
 * What diff mode draws on the canvas (M6.9b): each node's own state, the
 * changes inside a box, and each drawn line's state. The layout sizes boxes
 * and pills from these (a closed box's change badges, a pill's leading word),
 * so the canvas draws exactly what was measured.
 */
export interface DiffMarks {
  /** The node's own state; unchanged nodes have none. */
  node(id: string): NodeDiff | undefined;
  /** The changes below a node, or none. */
  inside(id: string): Readonly<DiffCounts> | undefined;
  /** A drawn line's marks, from the graph edges it stands for. */
  line(edges: readonly Pick<GraphEdge, "id">[]): LineMark;
}

/**
 * The overlay's marks. A line standing for several edges takes their common
 * state, or `changed` when they differ (some added, some not); it's broken
 * when any of them is, with that connection's words, or how many broke.
 */
export function diffMarks(overlay: DiffOverlay): DiffMarks {
  return {
    node: (id) => overlay.nodes.get(id),
    inside: (id) => overlay.inside.get(id),
    line(edges) {
      const states = edges.map((e) => overlay.edges.get(e.id));
      const [first] = states;
      const diff = states.every((s) => s === first) ? first : "changed";
      const broken = edges.flatMap((e) => overlay.broken.get(e.id)?.detail ?? []);
      const [only] = broken;
      return {
        ...(diff ? { diff } : {}),
        ...(broken.length > 1
          ? { broken: `${broken.length} connections broken` }
          : only !== undefined
            ? { broken: only }
            : {}),
      };
    },
  };
}

/** The node's ancestors in the overlay, nearest first. */
function* ancestorsOf(all: ReadonlyMap<string, GraphNode>, id: string): Generator<GraphNode> {
  let parentId = all.get(id)?.parentId ?? null;
  while (parentId !== null) {
    const parent = all.get(parentId);
    if (!parent) return;
    yield parent;
    parentId = parent.parentId;
  }
}

function countInside(
  all: ReadonlyMap<string, GraphNode>,
  nodes: ReadonlyMap<string, NodeDiff>,
  broken: ReadonlyMap<string, BrokenConnection>,
): Map<string, DiffCounts> {
  const inside = new Map<string, DiffCounts>();
  const add = (id: string, status: ChangeStatus): void => {
    for (const a of ancestorsOf(all, id)) {
      const counts = inside.get(a.id) ?? { added: 0, changed: 0, removed: 0, broken: 0 };
      counts[status]++;
      inside.set(a.id, counts);
    }
  };
  for (const [id, status] of nodes) add(id, status);
  for (const b of broken.values()) add(b.from, "broken");
  return inside;
}

function changesList(
  all: ReadonlyMap<string, GraphNode>,
  nodes: ReadonlyMap<string, NodeDiff>,
  broken: ReadonlyMap<string, BrokenConnection>,
  diff: GraphDiff,
  renamedFrom: ReadonlyMap<string, GraphNode>,
): ChangesList {
  const depth = (id: string): number => [...ancestorsOf(all, id)].length;
  const item = (id: string, status: ChangeStatus): ChangeItem => {
    const node = all.get(id) as GraphNode;
    return { status, id, label: node.label, kind: node.kind, inside: 0 };
  };
  // Shallow first, so a service reads before its files; then by label and ID.
  const order = (a: ChangeItem, b: ChangeItem): number =>
    depth(a.id) - depth(b.id) || compareStrings(a.label, b.label) || compareStrings(a.id, b.id);

  /** Added or removed rows, each folded into its nearest ancestor of the same state. */
  const folded = (status: "added" | "removed"): ChangeItem[] => {
    const rows = new Map<string, ChangeItem>();
    const ids = [...nodes].filter(([, s]) => s === status).map(([id]) => id);
    for (const id of ids) {
      if (nodes.get(all.get(id)?.parentId ?? "") !== status) rows.set(id, item(id, status));
    }
    for (const id of ids) {
      if (rows.has(id)) continue;
      for (const a of ancestorsOf(all, id)) {
        const row = rows.get(a.id);
        if (row) {
          row.inside++;
          break;
        }
      }
    }
    return [...rows.values()].sort(order);
  };

  const fields = new Map(diff.nodes.modified.map((c) => [c.node.id, c.changes]));
  const changed = [...nodes]
    .filter(([, s]) => s === "changed")
    .map(([id]): ChangeItem => {
      const from = renamedFrom.get(id);
      return { ...item(id, "changed"), fields: fields.get(id) ?? [], ...(from ? { from } : {}) };
    })
    .sort(order);

  const brokenRows = [...broken.values()]
    .map((b): ChangeItem => ({ ...item(b.from, "broken"), broken: b }))
    .sort((a, b) => order(a, b) || compareStrings(a.broken?.edge ?? "", b.broken?.edge ?? ""));

  return { added: folded("added"), changed, removed: folded("removed"), broken: brokenRows };
}
