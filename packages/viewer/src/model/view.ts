import { compareStrings } from "@gitinside/schema";
import type { Confidence, EdgeKind, GraphEdge, GraphNode, NodeKind } from "@gitinside/schema";
import { canOpen, type HierarchyIndex } from "./hierarchy.js";

/**
 * What the canvas shows for one expansion state (M4b.1): the visible nodes,
 * each inside the frame it's drawn in, and the graph's edges lifted to their
 * visible ends (UX.md "Edge aggregation"). A pure function of the index and
 * the expansion set, so the same state always gives the same view, and the
 * layout (M4b.2) can cache by `open`.
 *
 * Routes first (design gate, ADR-0105): an open service shows its routes and
 * pages from anywhere inside it as an `entries` section ahead of its folders.
 * An entry moves into its file when that file is opened, so it's drawn once.
 */

/** Which part of its parent frame a node is drawn in. */
export type Section = "entries" | "contents";

/** One node on the canvas. */
export interface ViewNode {
  id: string;
  node: GraphNode;
  /** The visible frame it's drawn inside; null at the top level (the root's children). */
  parent: string | null;
  /** `entries` for a route or page shown at its service's first level, else `contents`. */
  section: Section;
  /** Frames around it (0 at the top level). */
  level: number;
  /** Broken down: drawn as a frame around its children. */
  open: boolean;
  /** Has children, so it can be broken down. */
  canOpen: boolean;
}

/** One drawn edge: every graph edge of one kind between two visible nodes. */
export interface ViewEdge {
  /** `<kind>:<from>-><to>` over the visible ends, like the graph's edge IDs. */
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** The weakest confidence among them, so a line never claims more than its weakest link. */
  confidence: Confidence;
  /** The graph edges it stands for, in graph order. */
  edges: readonly GraphEdge[];
}

/** The canvas for one expansion state. */
export interface GraphView {
  /** Visible nodes, depth first in drawing order (a frame, then its children). */
  nodes: readonly ViewNode[];
  byId: ReadonlyMap<string, ViewNode>;
  /** Visible children of each open node (and of the root, under its ID), in drawing order. */
  childrenOf: ReadonlyMap<string, readonly string[]>;
  /** The nodes actually open, sorted: the requested ones that are visible and can open. */
  open: readonly string[];
  edges: readonly ViewEdge[];
}

/** Options for `buildView`. */
export interface ViewOptions {
  /** Edge kinds left off the canvas. Defaults to `DEFAULT_HIDDEN_KINDS`. */
  hiddenKinds?: ReadonlySet<EdgeKind>;
}

/** Hidden unless asked for: imports repeat the calls at every level above a file. */
export const DEFAULT_HIDDEN_KINDS: ReadonlySet<EdgeKind> = new Set(["imports"]);

// Inside a frame, folders come before loose files, and both before the rest
// (unresolved calls in a service, symbols and routes in a file), each group
// in graph order.
const RANK: Partial<Record<NodeKind, number>> = { module: 0, file: 1 };
const rank = (n: GraphNode) => RANK[n.kind] ?? 2;

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
 * The nodes that are really open for a requested set: each must be able to
 * open and sit under the root through open nodes only. A node asked open
 * inside a closed one is ignored now and opens again with it, so closing a
 * service and reopening it restores its inside.
 */
export function effectiveOpen(index: HierarchyIndex, expanded: Iterable<string>): Set<string> {
  const asked = new Set(expanded);
  const open = new Set<string>();
  const stack = [...(index.children.get(index.root.id) ?? [])];
  for (let n = stack.pop(); n; n = stack.pop()) {
    if (!asked.has(n.id) || !canOpen(index, n.id)) continue;
    open.add(n.id);
    stack.push(...(index.children.get(n.id) ?? []));
  }
  return open;
}

/** Builds the view for an expansion state (node IDs asked to be open). */
export function buildView(
  index: HierarchyIndex,
  expanded: Iterable<string>,
  options: ViewOptions = {},
): GraphView {
  const open = effectiveOpen(index, expanded);
  const nodes: ViewNode[] = [];
  const byId = new Map<string, ViewNode>();
  const childrenOf = new Map<string, string[]>();

  // An entry is drawn in its file when the file is open, else in its
  // service's entries section when the service is open.
  const inFile = (n: GraphNode) => n.parentId !== null && open.has(n.parentId);
  const place = (n: GraphNode, parent: string | null, section: Section, level: number) => {
    const view: ViewNode = {
      id: n.id,
      node: n,
      parent,
      section,
      level,
      open: open.has(n.id),
      canOpen: canOpen(index, n.id),
    };
    nodes.push(view);
    byId.set(n.id, view);
    const siblings = childrenOf.get(parent ?? index.root.id);
    if (siblings) siblings.push(n.id);
    else childrenOf.set(parent ?? index.root.id, [n.id]);
    if (!view.open) return;
    if (n.kind === "service") {
      for (const entry of index.entries.get(n.id) ?? []) {
        if (!inFile(entry)) place(entry, n.id, "entries", level + 1);
      }
    }
    const kids = [...(index.children.get(n.id) ?? [])];
    kids.sort((a, b) => rank(a) - rank(b));
    // A route or page reached here is in its open file, so it's drawn there.
    for (const child of kids) place(child, n.id, "contents", level + 1);
  };
  for (const top of index.children.get(index.root.id) ?? []) place(top, null, "contents", 0);

  return {
    nodes,
    byId,
    childrenOf,
    open: [...open].sort(compareStrings),
    edges: liftEdges(index, byId, options.hiddenKinds ?? DEFAULT_HIDDEN_KINDS),
  };
}

/**
 * The graph's edges lifted to their visible ends, one per (kind, from, to).
 * Edges that land inside one visible node vanish (they happen inside it), as
 * do hidden kinds. Ordered by the first graph edge each one stands for, so
 * the result is stable.
 */
function liftEdges(
  index: HierarchyIndex,
  visible: ReadonlyMap<string, ViewNode>,
  hidden: ReadonlySet<EdgeKind>,
): ViewEdge[] {
  const memo = new Map<string, string | undefined>();
  const out = new Map<string, { view: ViewEdge; edges: GraphEdge[] }>();
  for (const edge of index.graph.edges) {
    if (hidden.has(edge.kind)) continue;
    const from = visibleHolder(index, edge.from, visible, memo);
    const to = visibleHolder(index, edge.to, visible, memo);
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
 * The innermost visible node holding `id`: itself if visible, else the
 * nearest visible ancestor. An entry shown at its service's level is visible
 * itself, so edges reach it directly. `memo` caches answers for one view.
 */
function visibleHolder(
  index: HierarchyIndex,
  id: string,
  visible: ReadonlyMap<string, ViewNode>,
  memo: Map<string, string | undefined>,
): string | undefined {
  if (memo.has(id)) return memo.get(id);
  const node = index.byId.get(id);
  let found: string | undefined;
  if (visible.has(id)) found = id;
  else if (node?.parentId) found = visibleHolder(index, node.parentId, visible, memo);
  memo.set(id, found);
  return found;
}

/** The innermost visible node holding `id` in a view, or undefined for the root. */
export function visibleAncestor(
  index: HierarchyIndex,
  view: GraphView,
  id: string,
): string | undefined {
  return visibleHolder(index, id, view.byId, new Map());
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

/**
 * The frames a visible node is drawn inside, outermost first, ending with
 * the node itself (for breadcrumbs). An entry's trail is its service, then it.
 */
export function viewTrail(view: GraphView, id: string): ViewNode[] {
  const out: ViewNode[] = [];
  for (let n = view.byId.get(id); n; n = n.parent ? view.byId.get(n.parent) : undefined) {
    out.push(n);
  }
  return out.reverse();
}
