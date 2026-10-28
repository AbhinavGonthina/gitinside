import type { GraphNode, Layer } from "@gitinside/schema";
import type { NodeCount, NodeState } from "./describe.js";

/**
 * One node of every kind (and every symbol kind) for stories and tests,
 * shaped like the analyzer's output for a small shop app.
 */
export interface NodeSample {
  node: GraphNode;
  /** The layer it inherits from its service, for kinds without their own. */
  layer?: Layer;
  counts?: NodeCount[];
}

const hash = "0".repeat(64);

export const nodeSamples: readonly NodeSample[] = [
  {
    node: {
      id: "service:web",
      kind: "service",
      label: "web",
      parentId: "system:root",
      root: "apps/web",
      framework: "next",
      layer: "frontend",
    },
    counts: [
      { value: 14, noun: "page" },
      { value: 2, noun: "unresolved call", unresolved: true },
    ],
  },
  {
    node: {
      id: "service:api",
      kind: "service",
      label: "api",
      parentId: "system:root",
      root: "apps/api",
      framework: "express",
      layer: "backend",
    },
    counts: [{ value: 23, noun: "route" }],
  },
  {
    node: {
      id: "module:api/src/routes",
      kind: "module",
      label: "routes",
      parentId: "service:api",
      path: "apps/api/src/routes",
    },
    layer: "backend",
    counts: [{ value: 6, noun: "file" }],
  },
  {
    node: {
      id: "file:api/src/routes/orders.ts",
      kind: "file",
      label: "orders.ts",
      parentId: "module:api/src/routes",
      path: "apps/api/src/routes/orders.ts",
      hash,
    },
    layer: "backend",
  },
  {
    node: {
      id: "symbol:api/src/routes/orders.ts#createOrder",
      kind: "symbol",
      label: "createOrder",
      parentId: "file:api/src/routes/orders.ts",
      symbolKind: "function",
      exported: true,
    },
    layer: "backend",
    counts: [{ value: 3, noun: "caller" }],
  },
  {
    node: {
      id: "symbol:api/src/services/orders.ts#OrderService",
      kind: "symbol",
      label: "OrderService",
      parentId: "file:api/src/services/orders.ts",
      symbolKind: "class",
      exported: true,
    },
    layer: "backend",
  },
  {
    node: {
      id: "symbol:api/src/services/orders.ts#OrderService.list",
      kind: "symbol",
      label: "OrderService.list",
      parentId: "symbol:api/src/services/orders.ts#OrderService",
      symbolKind: "method",
      exported: false,
    },
    layer: "backend",
  },
  {
    node: {
      id: "symbol:web/lib/api.ts#API_BASE",
      kind: "symbol",
      label: "API_BASE",
      parentId: "file:web/lib/api.ts",
      symbolKind: "variable",
      exported: true,
    },
    layer: "frontend",
  },
  {
    node: {
      id: "route:api/POST /api/orders",
      kind: "route",
      label: "POST /api/orders",
      parentId: "file:api/src/routes/orders.ts",
      method: "POST",
      path: "/api/orders",
      layer: "backend",
    },
    counts: [{ value: 2, noun: "caller" }],
  },
  {
    node: {
      id: "page:web//checkout",
      kind: "page",
      label: "/checkout",
      parentId: "file:web/app/checkout/page.tsx",
      path: "/checkout",
      layer: "frontend",
    },
  },
  {
    node: {
      id: "model:db/schema.prisma#Order",
      kind: "model",
      label: "Order",
      parentId: "file:db/schema.prisma",
      fields: [
        { name: "id", type: "String", optional: false },
        { name: "total", type: "Int", optional: false },
        { name: "status", type: "Status", optional: false },
        { name: "userId", type: "String", optional: false },
        { name: "note", type: "String", optional: true },
        { name: "createdAt", type: "DateTime", optional: false },
      ],
      layer: "data",
    },
  },
  {
    node: {
      id: "datastore:infra/postgres",
      kind: "datastore",
      label: "postgres",
      parentId: "system:root",
      engine: "postgres",
      layer: "data",
    },
  },
  {
    node: {
      id: "queue:infra/redis#emails",
      kind: "queue",
      label: "emails",
      parentId: "system:root",
      engine: "redis",
      name: "emails",
      layer: "infra",
    },
  },
  {
    node: {
      id: "external:ext/api.stripe.com",
      kind: "external",
      label: "api.stripe.com",
      parentId: "system:root",
      host: "api.stripe.com",
      layer: "external",
    },
  },
  {
    node: {
      id: "unresolved:web/lib/cms.ts:12:3",
      kind: "unresolved",
      label: "fetch(`${CMS_URL}/posts`)",
      parentId: "file:web/lib/cms.ts",
      reason: "DYNAMIC_URL",
      expression: "`${CMS_URL}/posts`",
      detail: "URL built from CMS_URL at runtime",
    },
    layer: "frontend",
  },
];

/** The states every node supports, in the order the stories show them (ROADMAP M4a.4). */
export const nodeStates: readonly { name: string; state: NodeState }[] = [
  { name: "Default", state: {} },
  { name: "Hover", state: { hovered: true } },
  { name: "Selected", state: { selected: true } },
  { name: "Dimmed", state: { emphasis: "dimmed" } },
  { name: "Traced", state: { emphasis: "traced" } },
  { name: "Added", state: { diff: "added" } },
  { name: "Changed", state: { diff: "changed" } },
  { name: "Removed", state: { diff: "removed" } },
];

/** The sample of a given kind (the first, for symbols), for building frames in stories. */
export function sampleOf(kind: GraphNode["kind"]): NodeSample {
  const found = nodeSamples.find((s) => s.node.kind === kind);
  if (!found) throw new Error(`no sample of kind ${kind}`);
  return found;
}
