import { compareStrings } from "@gitinside/schema";
import type { EdgeKind, GraphEdge, GraphNode, SourceLocation } from "@gitinside/schema";
import { EDGE_WORDS } from "../edges/describe.js";
import { nodeOf, type HierarchyIndex } from "../model/hierarchy.js";

/**
 * Trace mode's request path (M4b.6, UX.md "Trace mode", ADR-0117): every
 * hop a request can take from a page or route, computed from the graph's
 * edges, never scripted or guessed.
 *
 * Followed: `renders`, `calls`, `http`, `handles`, `reads`, `writes`,
 * `stores`, `external_call`, `publishes`, and `consumes` backwards (the
 * analyzer draws it from the worker to the queue, so the path goes from a
 * queue to the code that runs its jobs). Not followed: `imports` (a file
 * importing another isn't a request going there). Edges to `unresolved`
 * nodes are hops like any other, so a path that can't be followed ends
 * visibly where the analyzer lost it.
 *
 * Which hops: everything reachable within {@link TRACE_DEPTH} hops of the
 * start, by breadth-first distance. In what order: depth-first in call
 * order, so the steps read like the request runs (a function's calls by
 * their first call site's file, line, and column, each followed to its end
 * before the next). Each node is followed once and each edge is one step, so
 * a cycle (recursion, two services calling each other) ends where it closes.
 */

/** How many hops from the start the path follows (UX.md). */
export const TRACE_DEPTH = 12;

/** Edge kinds the path follows from their `from` end. */
const FORWARD: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  "renders",
  "calls",
  "http",
  "handles",
  "reads",
  "writes",
  "stores",
  "external_call",
  "publishes",
]);

/** One step of the player: the hop, its ends in the request's direction, and where in the code it happens. */
export interface TraceStep {
  edge: GraphEdge;
  /** Where the request is before this hop (the edge's `to` for a `consumes` edge). */
  from: GraphNode;
  /** Where it goes. */
  to: GraphNode;
  /** "placeOrder requests POST /api/orders". */
  title: string;
  /** Where the hop happens: the edge's first site. */
  site: SourceLocation | undefined;
}

/** A computed request path. */
export interface Trace {
  start: GraphNode;
  steps: TraceStep[];
  /**
   * Nodes {@link TRACE_DEPTH} hops out that the path reaches but doesn't
   * follow further, though they have hops of their own (in path order).
   * Empty when the whole path fits.
   */
  cutOff: GraphNode[];
}

/** A name for a node in a sentence: "page /checkout" for pages, the label for everything else. */
function spoken(node: GraphNode): string {
  if (node.kind === "page") return `page ${node.path}`;
  return node.label;
}

/** A hop in the request's direction. */
interface Hop {
  edge: GraphEdge;
  to: string;
}

/** Call order: first call site's file, line, column; edges without sites last; then by ID. */
function compareHops(a: Hop, b: Hop): number {
  const sa = a.edge.sites[0];
  const sb = b.edge.sites[0];
  if (sa && sb) {
    const bySite = compareStrings(sa.file, sb.file) || sa.line - sb.line || sa.column - sb.column;
    if (bySite !== 0) return bySite;
  } else if (sa || sb) {
    return sa ? -1 : 1;
  }
  return compareStrings(a.edge.id, b.edge.id);
}

/** Each node's hops in the request's direction, in call order. */
function hopsByNode(edges: readonly GraphEdge[]): Map<string, Hop[]> {
  const out = new Map<string, Hop[]>();
  const add = (from: string, hop: Hop) => {
    const list = out.get(from);
    if (list) list.push(hop);
    else out.set(from, [hop]);
  };
  for (const edge of edges) {
    if (FORWARD.has(edge.kind)) add(edge.from, { edge, to: edge.to });
    else if (edge.kind === "consumes") add(edge.to, { edge, to: edge.from });
  }
  for (const list of out.values()) list.sort(compareHops);
  return out;
}

const cachedHops = new WeakMap<HierarchyIndex, Map<string, Hop[]>>();

function hopsOf(index: HierarchyIndex): Map<string, Hop[]> {
  let hops = cachedHops.get(index);
  if (!hops) {
    hops = hopsByNode(index.graph.edges);
    cachedHops.set(index, hops);
  }
  return hops;
}

/**
 * The request path from `start` (any node; the explorer offers pages and
 * routes). Throws for an unknown start. A start with no hops gives no steps.
 */
export function traceFrom(index: HierarchyIndex, start: string): Trace {
  const first = nodeOf(index, start);
  const hops = hopsOf(index);

  // Breadth-first distances, so a node's depth is its shortest way in.
  const depth = new Map<string, number>([[first.id, 0]]);
  for (let queue = [first.id], d = 0; queue.length > 0 && d < TRACE_DEPTH; d++) {
    const next: string[] = [];
    for (const id of queue) {
      for (const hop of hops.get(id) ?? []) {
        if (depth.has(hop.to)) continue;
        depth.set(hop.to, d + 1);
        next.push(hop.to);
      }
    }
    queue = next;
  }

  // Depth-first in call order, iteratively (a long chain of calls mustn't
  // overflow the stack). A node is followed once, and only within the depth.
  const steps: TraceStep[] = [];
  const cutOff: GraphNode[] = [];
  const followed = new Set<string>();
  const stack: { hops: readonly Hop[]; next: number; from: GraphNode }[] = [];
  const follow = (node: GraphNode) => {
    followed.add(node.id);
    const out = hops.get(node.id) ?? [];
    if ((depth.get(node.id) ?? TRACE_DEPTH) >= TRACE_DEPTH) {
      if (out.length > 0) cutOff.push(node);
      return;
    }
    stack.push({ hops: out, next: 0, from: node });
  };
  follow(first);
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as (typeof stack)[number];
    const hop = top.hops[top.next++];
    if (!hop) {
      stack.pop();
      continue;
    }
    const to = nodeOf(index, hop.to);
    const reversed = hop.edge.kind === "consumes";
    steps.push({
      edge: hop.edge,
      from: top.from,
      to,
      title: reversed
        ? `${spoken(top.from)} consumed by ${spoken(to)}`
        : `${spoken(top.from)} ${EDGE_WORDS[hop.edge.kind].verb} ${spoken(to)}`,
      site: hop.edge.sites[0],
    });
    if (!followed.has(to.id)) follow(to);
  }
  return { start: first, steps, cutOff };
}

/** Every node on the path: the start and both ends of every hop. */
export function traceNodes(trace: Trace): Set<string> {
  const out = new Set([trace.start.id]);
  for (const s of trace.steps) {
    out.add(s.from.id);
    out.add(s.to.id);
  }
  return out;
}

/** Whether the explorer offers to trace from a node: a page or route with somewhere to go. */
export function canTraceFrom(index: HierarchyIndex, node: GraphNode): boolean {
  return (
    (node.kind === "page" || node.kind === "route") && (hopsOf(index).get(node.id)?.length ?? 0) > 0
  );
}
