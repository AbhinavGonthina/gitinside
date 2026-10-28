import type { Confidence, EdgeKind, GraphEdge, Layer } from "@gitinside/schema";
import type { EdgeState } from "./describe.js";

/**
 * One edge of every kind for stories and tests, shaped like the analyzer's
 * output for the same small shop app as the node samples. Together they use
 * every confidence level.
 */
export interface EdgeSample {
  edge: GraphEdge;
  /** Labels of the two ends, for the accessible name. */
  ends: { from: string; to: string };
  /** The source's layer. */
  layer?: Layer;
}

const site = { file: "apps/web/lib/api.ts", line: 12, column: 3 };

function sample(
  kind: EdgeKind,
  confidence: Confidence,
  from: string,
  to: string,
  layer: Layer | undefined,
  extra: Partial<GraphEdge> = {},
): EdgeSample {
  return {
    edge: {
      id: `${kind}:${from}->${to}`,
      kind,
      from,
      to,
      confidence,
      sites: [site],
      ...extra,
    },
    ends: { from, to },
    ...(layer ? { layer } : {}),
  };
}

export const edgeSamples: readonly EdgeSample[] = [
  sample("http", "exact", "submitOrder", "POST /api/orders", "frontend", {
    label: "POST /api/orders",
  }),
  sample("http", "pattern", "loadOrder", "GET /api/orders/:id", "frontend", {
    label: "GET /api/orders/:id",
  }),
  sample("http", "heuristic", "listOrders", "GET /api/orders", "frontend", {
    label: "GET /api/orders",
    reason: "AMBIGUOUS",
  }),
  sample("http", "unresolved", "loadPosts", "fetch(`${CMS_URL}/posts`)", "frontend", {
    reason: "DYNAMIC_URL",
  }),
  sample("imports", "exact", "checkout/page.tsx", "lib/api.ts", "frontend"),
  sample("calls", "exact", "createOrder", "OrderService.create", "backend"),
  sample("handles", "exact", "POST /api/orders", "createOrder", "backend"),
  sample("renders", "exact", "/checkout", "CheckoutPage", "frontend"),
  sample("reads", "exact", "OrderService.list", "Order", "backend", {
    fields: ["id", "status", "total"],
  }),
  sample("writes", "heuristic", "createOrder", "Order", "backend", {
    fields: ["total", "userId"],
  }),
  sample("stores", "exact", "Order", "postgres", "data"),
  sample("publishes", "exact", "createOrder", "emails", "backend"),
  sample("consumes", "exact", "sendReceipt", "emails", "backend"),
  sample("external_call", "heuristic", "chargeCard", "api.stripe.com", "backend"),
];

/** The sample of a given confidence level (the first), for state matrices. */
export function edgeSampleOf(confidence: Confidence): EdgeSample {
  const found = edgeSamples.find((s) => s.edge.confidence === confidence);
  if (!found) throw new Error(`no sample with confidence ${confidence}`);
  return found;
}

/** The states every edge supports, in the order the stories show them (ROADMAP M4a.5). */
export const edgeStates: readonly { name: string; state: EdgeState; flow?: boolean }[] = [
  { name: "Default", state: {} },
  { name: "Flow", state: {}, flow: true },
  { name: "Hover", state: { hovered: true } },
  { name: "Selected", state: { selected: true } },
  { name: "Traced", state: { emphasis: "traced" }, flow: true },
  { name: "Dimmed", state: { emphasis: "dimmed" } },
  { name: "Added", state: { diff: "added" } },
  { name: "Changed", state: { diff: "changed" } },
  { name: "Removed", state: { diff: "removed" } },
  { name: "Broken", state: { broken: "Route removed in this PR" } },
];
