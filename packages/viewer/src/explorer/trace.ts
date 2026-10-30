import type { GraphEdge, GraphNode, SourceLocation } from "@gitinside/schema";
import { EDGE_WORDS } from "../edges/describe.js";
import { nodeOf, type HierarchyIndex } from "../model/hierarchy.js";

/**
 * The explorer's trace until M4b.6 (from the M4a.7 prototype). It is
 * scripted, not computed: a start node and the IDs of the edges it follows,
 * in order. M4b.6 replaces the script with the BFS from UX.md. The script only names edges; every hop's words,
 * file, line, and confidence still come from the graph, and
 * {@link checkTrace} rejects a script that names a missing edge or a hop
 * that doesn't continue the path.
 */
export interface TraceScript {
  start: string;
  hops: readonly string[];
}

/** shop-demo's checkout request: the page to the database and Stripe. */
export const CHECKOUT_TRACE: TraceScript = {
  start: "page:web//checkout",
  hops: [
    "renders:page:web//checkout->symbol:web/app/checkout/page.tsx#Checkout",
    "calls:symbol:web/app/checkout/page.tsx#Checkout->symbol:web/lib/orders.ts#placeOrder",
    "http:symbol:web/lib/orders.ts#placeOrder->route:api/POST /api/orders",
    "handles:route:api/POST /api/orders->symbol:api/src/orders/handlers.ts#createOrder",
    "writes:symbol:api/src/orders/handlers.ts#createOrder->model:api/Order",
    "stores:model:api/Order->datastore:infra/db",
    "calls:symbol:api/src/orders/handlers.ts#createOrder->symbol:api/src/billing/stripe.ts#chargeOrder",
    "external_call:symbol:api/src/billing/stripe.ts#chargeOrder->external:ext/api.stripe.com",
  ],
};

/** One step of the player: the hop, its ends, and where in the code it happens. */
export interface TraceStep {
  edge: GraphEdge;
  from: GraphNode;
  to: GraphNode;
  /** "placeOrder requests POST /api/orders". */
  title: string;
  /** Where the hop happens: the edge's first site. */
  site: SourceLocation | undefined;
}

/** A name for a node in a sentence: "page /checkout" for pages, the label for everything else. */
function spoken(node: GraphNode): string {
  if (node.kind === "page") return `page ${node.path}`;
  return node.label;
}

/**
 * The steps of a script, checked against the graph. Throws if a hop names an
 * edge the graph doesn't have, or starts somewhere the path hasn't reached
 * (each hop must leave the start or a node an earlier hop arrived at).
 */
export function checkTrace(index: HierarchyIndex, script: TraceScript): TraceStep[] {
  const edges = new Map(index.graph.edges.map((e) => [e.id, e]));
  const reached = new Set([nodeOf(index, script.start).id]);
  return script.hops.map((id) => {
    const edge = edges.get(id);
    if (!edge) throw new Error(`trace names a missing edge: ${id}`);
    if (!reached.has(edge.from)) throw new Error(`trace hop doesn't continue the path: ${id}`);
    reached.add(edge.to);
    const from = nodeOf(index, edge.from);
    const to = nodeOf(index, edge.to);
    return {
      edge,
      from,
      to,
      title: `${spoken(from)} ${EDGE_WORDS[edge.kind].verb} ${spoken(to)}`,
      site: edge.sites[0],
    };
  });
}

/** Every node on the path: the start and both ends of every hop. */
export function traceNodes(steps: readonly TraceStep[], start: string): Set<string> {
  const out = new Set([start]);
  for (const s of steps) {
    out.add(s.from.id);
    out.add(s.to.id);
  }
  return out;
}
