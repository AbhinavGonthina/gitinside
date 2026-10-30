import type { EdgeKind, GraphEdge, GraphNode } from "@gitinside/schema";
import { isWithin, nodeOf, type HierarchyIndex } from "./hierarchy.js";
import { DEFAULT_HIDDEN_KINDS } from "./view.js";

/** A connection of a selected node: the graph edge and the node at its other end. */
export interface NodeConnection {
  edge: GraphEdge;
  other: GraphNode;
}

/**
 * What a selection connects to outside itself (the inspector's **Calls** and
 * **Called by**, M4a.7): every graph edge with exactly one end in the node or
 * inside it, split by direction, in graph order. Edges of the hidden kinds
 * are left out, as on the canvas.
 */
export function connectionsOf(
  index: HierarchyIndex,
  id: string,
  hidden: ReadonlySet<EdgeKind> = DEFAULT_HIDDEN_KINDS,
): { incoming: NodeConnection[]; outgoing: NodeConnection[] } {
  const incoming: NodeConnection[] = [];
  const outgoing: NodeConnection[] = [];
  for (const edge of index.graph.edges) {
    if (hidden.has(edge.kind)) continue;
    const fromIn = isWithin(index, edge.from, id);
    const toIn = isWithin(index, edge.to, id);
    if (fromIn && !toIn) outgoing.push({ edge, other: nodeOf(index, edge.to) });
    else if (toIn && !fromIn) incoming.push({ edge, other: nodeOf(index, edge.from) });
  }
  return { incoming, outgoing };
}
