import type {
  ArchitectureGraph,
  Confidence,
  EdgeKind,
  GraphEdge,
  GraphNode,
  Layer,
} from "@gitinside/schema";
import type { NodeCount } from "../nodes/describe.js";

/**
 * The prototype's view of a graph (M4a.7): which nodes are visible for an
 * expansion state, and the graph's edges lifted to them. This is the small,
 * static version of M4b.1's graph model, enough to drill one level, select,
 * and play a scripted trace. Everything comes from the graph; nothing is
 * added, and nothing found by the analyzer is dropped from the counts.
 */

/** Lookups over one graph. Children keep the graph's canonical order. */
export interface GraphIndex {
  graph: ArchitectureGraph;
  byId: ReadonlyMap<string, GraphNode>;
  children: ReadonlyMap<string, readonly GraphNode[]>;
  root: GraphNode;
}

/** Builds the lookups. Throws if the graph has no root, which a schema-valid graph always has. */
export function indexGraph(graph: ArchitectureGraph): GraphIndex {
  const byId = new Map<string, GraphNode>();
  const children = new Map<string, GraphNode[]>();
  let root: GraphNode | undefined;
  for (const node of graph.nodes) {
    byId.set(node.id, node);
    if (node.parentId === null) {
      root = node;
      continue;
    }
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node);
    else children.set(node.parentId, [node]);
  }
  if (!root) throw new Error("graph has no root node");
  return { graph, byId, children, root };
}

/** The node with this ID; throws for an unknown one (a bug in the caller, not the graph). */
export function nodeOf(index: GraphIndex, id: string): GraphNode {
  const node = index.byId.get(id);
  if (!node) throw new Error(`unknown node ${id}`);
  return node;
}

/** The node and its ancestors, nearest first, up to (and including) the root. */
export function ancestry(index: GraphIndex, id: string): GraphNode[] {
  const out: GraphNode[] = [];
  for (let n = index.byId.get(id); n; n = n.parentId ? index.byId.get(n.parentId) : undefined) {
    out.push(n);
  }
  return out;
}

/** The node's own layer, else the nearest ancestor's (modules and files take their service's). */
export function layerOf(index: GraphIndex, id: string): Layer | undefined {
  for (const n of ancestry(index, id)) if (n.layer) return n.layer;
  return undefined;
}

/** Whether a node has children, so it can be broken down. */
export function canOpen(index: GraphIndex, id: string): boolean {
  return (index.children.get(id)?.length ?? 0) > 0;
}

/**
 * The nodes in view: the root's children, plus the children of the one open
 * node (the prototype drills one level). An open node stays visible as the
 * frame around its children.
 */
export function visibleIds(index: GraphIndex, open: string | null): Set<string> {
  const ids = new Set<string>();
  for (const n of index.children.get(index.root.id) ?? []) ids.add(n.id);
  if (open && ids.has(open)) for (const n of index.children.get(open) ?? []) ids.add(n.id);
  return ids;
}

/**
 * The deepest visible node holding `id` (itself if visible). Every ancestor
 * of a visible child is visible too, so walking up finds the innermost one.
 */
export function visibleAncestor(
  index: GraphIndex,
  id: string,
  visible: ReadonlySet<string>,
): string | undefined {
  return ancestry(index, id).find((n) => visible.has(n.id))?.id;
}

/** Edge kinds the prototype leaves off the canvas: imports repeat the calls at these levels. */
export const HIDDEN_KINDS: ReadonlySet<EdgeKind> = new Set(["imports"]);

/** One drawn edge: every graph edge of one kind between two visible nodes. */
export interface ViewEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** The weakest confidence among them, so a line never claims more than its weakest link. */
  confidence: Confidence;
  /** The graph edges it stands for, in graph order. */
  edges: readonly GraphEdge[];
}

const STRENGTH: Readonly<Record<Confidence, number>> = {
  exact: 3,
  pattern: 2,
  heuristic: 1,
  unresolved: 0,
};

/** The weaker of two confidence levels. */
export function weaker(a: Confidence, b: Confidence): Confidence {
  return STRENGTH[a] <= STRENGTH[b] ? a : b;
}

/**
 * The graph's edges lifted to their visible ends (UX.md "Edge aggregation"),
 * one per (from, to, kind). Edges that land inside one visible node vanish
 * from the canvas (they happen inside it), as do hidden kinds. Ordered by
 * the first graph edge each one stands for, so the result is stable.
 */
export function liftEdges(index: GraphIndex, visible: ReadonlySet<string>): ViewEdge[] {
  const out = new Map<string, { view: ViewEdge; edges: GraphEdge[] }>();
  for (const edge of index.graph.edges) {
    if (HIDDEN_KINDS.has(edge.kind)) continue;
    const from = visibleAncestor(index, edge.from, visible);
    const to = visibleAncestor(index, edge.to, visible);
    if (!from || !to || from === to) continue;
    const id = `${edge.kind}:${from}->${to}`;
    const entry = out.get(id);
    if (entry) {
      entry.edges.push(edge);
      entry.view.confidence = weaker(entry.view.confidence, edge.confidence);
    } else {
      const edges = [edge];
      out.set(id, {
        view: { id, from, to, kind: edge.kind, confidence: edge.confidence, edges },
        edges,
      });
    }
  }
  return [...out.values()].map((e) => e.view);
}

/**
 * The edge as the label and line should draw it: a single edge keeps its own
 * label and reason; an aggregate becomes a count (`count` is set).
 */
export function drawnEdge(view: ViewEdge): {
  edge: Pick<GraphEdge, "kind" | "confidence"> &
    Partial<Pick<GraphEdge, "label" | "reason" | "fields">>;
  count?: number;
} {
  const [only] = view.edges;
  if (view.edges.length === 1 && only) return { edge: only };
  return { edge: { kind: view.kind, confidence: view.confidence }, count: view.edges.length };
}

/** Every node under `id`, not counting itself. */
export function descendants(index: GraphIndex, id: string): GraphNode[] {
  const out: GraphNode[] = [];
  const stack = [...(index.children.get(id) ?? [])];
  for (let n = stack.pop(); n; n = stack.pop()) {
    out.push(n);
    stack.push(...(index.children.get(n.id) ?? []));
  }
  return out;
}

const COUNTED: readonly { kind: GraphNode["kind"]; noun: string; unresolved?: boolean }[] = [
  { kind: "page", noun: "page" },
  { kind: "route", noun: "route" },
  { kind: "model", noun: "model" },
  { kind: "unresolved", noun: "unresolved call", unresolved: true },
];

/**
 * Count badges for a closed frame: what's inside it that a reader looks for
 * (pages, routes, models, and unresolved calls, which are never hidden).
 * Kinds with none are left out.
 */
export function frameCounts(index: GraphIndex, id: string): NodeCount[] {
  const inside = descendants(index, id);
  return COUNTED.flatMap(({ kind, noun, unresolved }) => {
    const value = inside.filter((n) => n.kind === kind).length;
    if (value === 0) return [];
    return [{ value, noun, ...(unresolved ? { unresolved } : {}) }];
  });
}

/** Whether `id` is `ancestor` or inside it. */
export function isWithin(index: GraphIndex, id: string, ancestor: string): boolean {
  return ancestry(index, id).some((n) => n.id === ancestor);
}

/** A connection of a selected node: the graph edge and the node at its other end. */
export interface NodeConnection {
  edge: GraphEdge;
  other: GraphNode;
}

/**
 * What a selection connects to outside itself (for the inspector's **Calls**
 * and **Called by**): every non-hidden graph edge with exactly one end in
 * the node or its descendants, split by direction, in graph order.
 */
export function connectionsOf(
  index: GraphIndex,
  id: string,
): { incoming: NodeConnection[]; outgoing: NodeConnection[] } {
  const incoming: NodeConnection[] = [];
  const outgoing: NodeConnection[] = [];
  for (const edge of index.graph.edges) {
    if (HIDDEN_KINDS.has(edge.kind)) continue;
    const fromIn = isWithin(index, edge.from, id);
    const toIn = isWithin(index, edge.to, id);
    if (fromIn && !toIn) outgoing.push({ edge, other: nodeOf(index, edge.to) });
    else if (toIn && !fromIn) incoming.push({ edge, other: nodeOf(index, edge.from) });
  }
  return { incoming, outgoing };
}
