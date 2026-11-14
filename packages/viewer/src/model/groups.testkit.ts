import type { ArchitectureGraph, GraphEdge, GraphNode } from "@gitinside/schema";
import { shopDemo } from "../shopDemo.testkit.js";

/** The AI hosts {@link groupedShop} adds, which the API calls once each. */
export const AI_HOSTS = ["api.openai.com", "api.anthropic.com", "api.groq.com"] as const;

/**
 * shop-demo plus what the prototype's system level groups (M10.3b1): three AI hosts the API
 * calls, and two packages (`@shop/ui`, `@shop/tsconfig`) with no work of their own.
 */
export function groupedShop(): ArchitectureGraph {
  const g = shopDemo();
  const api = "file:api/src/billing/stripe.ts";
  const nodes: GraphNode[] = [
    ...AI_HOSTS.map(
      (host): GraphNode => ({
        id: `external:ext/${host}`,
        kind: "external",
        label: host,
        host,
        layer: "external",
        parentId: "system:root",
      }),
    ),
    ...["ui", "tsconfig"].map(
      (name): GraphNode => ({
        id: `service:${name}/`,
        kind: "service",
        label: `@shop/${name}`,
        parentId: "system:root",
        root: `packages/${name}`,
      }),
    ),
  ];
  const edges: GraphEdge[] = AI_HOSTS.map((host) => ({
    id: `external_call:${api}->external:ext/${host}`,
    kind: "external_call",
    from: api,
    to: `external:ext/${host}`,
    confidence: "exact",
    sites: [{ file: "apps/api/src/billing/stripe.ts", line: 1, column: 1 }],
  }));
  return { ...g, nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] };
}
