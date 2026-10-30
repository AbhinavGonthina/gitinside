import { compareStrings } from "@gitinside/schema";
import type { ArchitectureGraph, GraphNode, Layer, NodeKind } from "@gitinside/schema";

/**
 * The explorer's lookups over one graph (M4b.1): the `parentId` tree, each
 * node's depth and service, what's inside each node, and each service's
 * entry points. Built once per graph in one pass, so every later question
 * (visibility, lifting, counts) is a map lookup or a walk up a few levels.
 * Everything comes from the graph; nothing is added or guessed.
 */

/** Counts of each kind among a node's descendants (not itself). Kinds with none are absent. */
export type KindCounts = Readonly<Partial<Record<NodeKind, number>>>;

/** A node that opens a service's first level (UX.md "Drill-down", ADR-0105). */
export type EntryNode = Extract<GraphNode, { kind: "route" | "page" }>;

/** Lookups over one graph. */
export interface HierarchyIndex {
  graph: ArchitectureGraph;
  root: GraphNode;
  byId: ReadonlyMap<string, GraphNode>;
  /** Tree children by `parentId`, in the graph's canonical order. */
  children: ReadonlyMap<string, readonly GraphNode[]>;
  /** Levels below the root (the root is 0, services 1). */
  depth: ReadonlyMap<string, number>;
  /** The nearest service at or above each node; absent for the root and infra-level nodes. */
  service: ReadonlyMap<string, string>;
  /** Each service's routes and pages, from anywhere inside it, in entry order. */
  entries: ReadonlyMap<string, readonly EntryNode[]>;
  /** What's inside each node, by kind. */
  inside: ReadonlyMap<string, KindCounts>;
}

/** Whether a node is one of a service's entry points (a route or a page). */
export function isEntry(node: GraphNode): node is EntryNode {
  return node.kind === "route" || node.kind === "page";
}

/**
 * Entry order: by URL path, so a service reads like its route table; then
 * pages before routes on the same path, then by method, then by ID.
 */
export function compareEntries(a: EntryNode, b: EntryNode): number {
  return (
    compareStrings(a.path, b.path) ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.kind === "route" ? a.method : "", b.kind === "route" ? b.method : "") ||
    compareStrings(a.id, b.id)
  );
}

/**
 * Builds the lookups. Throws when the graph has no root or a node isn't
 * under it (a parent cycle or a missing parent), which `parseGraph` already
 * rejects, so it only fires on a graph that skipped validation.
 */
export function buildHierarchy(graph: ArchitectureGraph): HierarchyIndex {
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

  // Breadth-first from the root: parents come before their children, so
  // depth and service are known when a child is reached.
  const depth = new Map<string, number>([[root.id, 0]]);
  const service = new Map<string, string>();
  const order: GraphNode[] = [root];
  for (let i = 0; i < order.length; i++) {
    const node = order[i] as GraphNode;
    const level = (depth.get(node.id) ?? 0) + 1;
    const owner = service.get(node.id);
    for (const child of children.get(node.id) ?? []) {
      depth.set(child.id, level);
      if (child.kind === "service") service.set(child.id, child.id);
      else if (owner) service.set(child.id, owner);
      order.push(child);
    }
  }
  if (order.length !== graph.nodes.length) {
    const stray = graph.nodes.find((n) => !depth.has(n.id));
    throw new Error(`node ${stray?.id ?? "?"} is not under the root`);
  }

  // Deepest first, so each node's counts are complete before they're added to its parent's.
  const inside = new Map<string, Partial<Record<NodeKind, number>>>();
  for (let i = order.length - 1; i > 0; i--) {
    const node = order[i] as GraphNode;
    const parentId = node.parentId as string;
    const into = inside.get(parentId) ?? {};
    into[node.kind] = (into[node.kind] ?? 0) + 1;
    for (const [kind, n] of Object.entries(inside.get(node.id) ?? {}) as [NodeKind, number][]) {
      into[kind] = (into[kind] ?? 0) + n;
    }
    inside.set(parentId, into);
  }

  const entries = new Map<string, EntryNode[]>();
  for (const node of graph.nodes) {
    const owner = service.get(node.id);
    if (!owner || !isEntry(node)) continue;
    const list = entries.get(owner);
    if (list) list.push(node);
    else entries.set(owner, [node]);
  }
  for (const list of entries.values()) list.sort(compareEntries);

  return { graph, root, byId, children, depth, service, entries, inside };
}

/** The node with this ID; throws for an unknown one (a bug in the caller, not the graph). */
export function nodeOf(index: HierarchyIndex, id: string): GraphNode {
  const node = index.byId.get(id);
  if (!node) throw new Error(`unknown node ${id}`);
  return node;
}

/** The node and its ancestors, nearest first, up to (and including) the root. */
export function ancestry(index: HierarchyIndex, id: string): GraphNode[] {
  const out: GraphNode[] = [];
  for (let n = index.byId.get(id); n; n = n.parentId ? index.byId.get(n.parentId) : undefined) {
    out.push(n);
  }
  return out;
}

/** Whether `id` is `ancestor` or inside it. Walks up only as far as the ancestor's depth. */
export function isWithin(index: HierarchyIndex, id: string, ancestor: string): boolean {
  const stop = index.depth.get(ancestor);
  if (stop === undefined) return false;
  let n = index.byId.get(id);
  while (n && (index.depth.get(n.id) ?? 0) > stop) {
    n = n.parentId ? index.byId.get(n.parentId) : undefined;
  }
  return n?.id === ancestor;
}

/** The node's own layer, else the nearest ancestor's (modules and files take their service's). */
export function layerOf(index: HierarchyIndex, id: string): Layer | undefined {
  for (const n of ancestry(index, id)) if (n.layer) return n.layer;
  return undefined;
}

/** Whether a node has children, so it can be broken down. */
export function canOpen(index: HierarchyIndex, id: string): boolean {
  return (index.children.get(id)?.length ?? 0) > 0;
}

/** What's inside a node, by kind (empty for a leaf). */
export function countsInside(index: HierarchyIndex, id: string): KindCounts {
  return index.inside.get(id) ?? {};
}
