import type { ArchitectureGraph, GraphEdge, GraphNode } from "@gitinside/schema";
import { shopDemo } from "../shopDemo.testkit.js";

/** The edge IDs {@link codeShop} adds: code dependency only. */
export const CODE_EDGES = {
  /** web calls `@shop/ui`'s button: a "uses code" line at the system level. */
  webUi: "calls:symbol:web/app/page.tsx#Home->symbol:ui/src/button.tsx#Button",
  /** web also calls one of api's handlers, beside its requests: a second "uses code" line. */
  webApi: "calls:symbol:web/app/page.tsx#Home->symbol:api/src/orders/handlers.ts#listOrders",
  /** api calls the button too, so laid out by ELK ui would take a column after api's. */
  apiUi: "calls:symbol:api/src/orders/handlers.ts#listOrders->symbol:ui/src/button.tsx#Button",
  /** web's page imports the button's file (hidden by default, like every import). */
  webUiImport: "imports:file:web/app/page.tsx->file:ui/src/button.tsx",
} as const;

const site = (file: string) => [{ file, line: 1, column: 1 }];

/**
 * shop-demo plus code dependency between its services (M10.3b2): a `@shop/ui` package with one
 * component, which web and api call and web imports, and a call from web straight into an api
 * handler, beside web's requests to api. One package alone isn't grouped as shared (that takes two).
 */
export function codeShop(): ArchitectureGraph {
  const g = shopDemo();
  const nodes: GraphNode[] = [
    {
      id: "service:ui/",
      kind: "service",
      label: "@shop/ui",
      parentId: "system:root",
      root: "packages/ui",
    },
    {
      id: "file:ui/src/button.tsx",
      kind: "file",
      label: "button.tsx",
      parentId: "service:ui/",
      path: "packages/ui/src/button.tsx",
      hash: "0".repeat(64),
    },
    {
      id: "symbol:ui/src/button.tsx#Button",
      kind: "symbol",
      label: "Button",
      parentId: "file:ui/src/button.tsx",
      source: { file: "packages/ui/src/button.tsx", line: 1, column: 1 },
      symbolKind: "function",
      exported: true,
    },
  ];
  const edges: GraphEdge[] = [
    {
      id: CODE_EDGES.webUi,
      kind: "calls",
      from: "symbol:web/app/page.tsx#Home",
      to: "symbol:ui/src/button.tsx#Button",
      confidence: "exact",
      sites: site("apps/web/app/page.tsx"),
    },
    {
      id: CODE_EDGES.webApi,
      kind: "calls",
      from: "symbol:web/app/page.tsx#Home",
      to: "symbol:api/src/orders/handlers.ts#listOrders",
      confidence: "exact",
      sites: site("apps/web/app/page.tsx"),
    },
    {
      id: CODE_EDGES.apiUi,
      kind: "calls",
      from: "symbol:api/src/orders/handlers.ts#listOrders",
      to: "symbol:ui/src/button.tsx#Button",
      confidence: "exact",
      sites: site("apps/api/src/orders/handlers.ts"),
    },
    {
      id: CODE_EDGES.webUiImport,
      kind: "imports",
      from: "file:web/app/page.tsx",
      to: "file:ui/src/button.tsx",
      confidence: "exact",
      sites: site("apps/web/app/page.tsx"),
    },
  ];
  return { ...g, nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] };
}
