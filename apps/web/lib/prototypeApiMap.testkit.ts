import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import shopDemo from "../../../fixtures/shop-demo/expected.json";

/**
 * shop-demo plus what an API map needs that it lacks (M10.3f3): a route no request reaches, an
 * exact caller beside the heuristic one, and a request whose URL couldn't be read. Its own
 * `GET {env:CMS_URL}/posts` is the broken call (`NO_MATCHING_ROUTE`).
 */
export function apiMapGraph(): ArchitectureGraph {
  const g = structuredClone(shopDemo) as ArchitectureGraph;
  g.nodes.push(
    {
      id: "route:api/DELETE /api/orders/:id",
      kind: "route",
      label: "DELETE /api/orders/:id",
      parentId: "file:api/src/routes/orders.ts",
      layer: "backend",
      method: "DELETE",
      path: "/api/orders/:id",
    },
    {
      id: "unresolved:web/lib/orders.ts:20:7",
      kind: "unresolved",
      label: "GET base",
      parentId: "service:web/",
      reason: "DYNAMIC_URL",
      expression: "fetch(base)",
      detail: "the URL starts with a value only known at runtime",
      source: { file: "apps/web/lib/orders.ts", line: 20, column: 7 },
    },
  );
  g.edges.push(
    {
      id: "http:symbol:web/lib/cms.ts#latestPosts->route:api/GET /api/orders",
      kind: "http",
      from: "symbol:web/lib/cms.ts#latestPosts",
      to: "route:api/GET /api/orders",
      confidence: "exact",
      sites: [
        { file: "apps/web/lib/cms.ts", line: 9, column: 3 },
        { file: "apps/web/lib/cms.ts", line: 7, column: 3 },
      ],
    },
    {
      id: "http:symbol:web/lib/orders.ts#listOrders->unresolved:web/lib/orders.ts:20:7",
      kind: "http",
      from: "symbol:web/lib/orders.ts#listOrders",
      to: "unresolved:web/lib/orders.ts:20:7",
      confidence: "unresolved",
      sites: [{ file: "apps/web/lib/orders.ts", line: 20, column: 7 }],
    },
  );
  return parseGraph(g);
}
