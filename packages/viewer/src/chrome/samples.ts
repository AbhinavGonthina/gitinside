import type { GraphNode } from "@gitinside/schema";
import { sampleOf } from "../nodes/samples.js";
import type { PaletteResult } from "./CommandPalette.js";
import type { Connection, Fact } from "./Inspector.js";
import type { Crumb, MinimapNode } from "./overlays.js";
import type { RepoRef } from "./describe.js";

/**
 * Chrome content for stories and tests, for the same small shop app as the
 * node and edge samples: what the explorer would show with the
 * `POST /api/orders` route selected.
 */

export const sampleRepo: RepoRef = {
  owner: "acme",
  name: "shop",
  sha: "a1b2c3f4d5e6f708192a3b4c5d6e7f8091a2b3c4",
};

/** The drill-down path down to the orders routes file. */
export const sampleCrumbs: readonly Crumb[] = [
  { id: "system:root", label: "shop", kind: "system" },
  { id: "service:api", label: "api", kind: "service" },
  { id: "module:api/src/routes", label: "routes", kind: "module" },
  { id: "file:api/src/routes/orders.ts", label: "orders.ts", kind: "file" },
];

/** Inspector facts for the selected route. */
export const routeFacts: readonly Fact[] = [
  { label: "Method", value: "POST" },
  { label: "Path", value: "/api/orders", code: true },
  { label: "Service", value: "api · Express" },
  { label: "Handler", value: "createOrder", code: true },
  { label: "File", value: "apps/api/src/routes/orders.ts", code: true },
];

const checkout: GraphNode = {
  id: "symbol:web/app/checkout/actions.ts#submitOrder",
  kind: "symbol",
  label: "submitOrder",
  parentId: "file:web/app/checkout/actions.ts",
  symbolKind: "function",
  exported: true,
};

const mobile: GraphNode = {
  id: "symbol:web/lib/api.ts#retryOrder",
  kind: "symbol",
  label: "retryOrder",
  parentId: "file:web/lib/api.ts",
  symbolKind: "function",
  exported: true,
};

/** Who calls the route: two requests from the web app. */
export const routeCalledBy: readonly Connection[] = [
  {
    node: checkout,
    layer: "frontend",
    edge: { kind: "http", confidence: "exact", label: "POST /api/orders" },
  },
  {
    node: mobile,
    layer: "frontend",
    edge: { kind: "http", confidence: "heuristic", label: "POST /api/orders" },
  },
];

/** What the route reaches: its handler, then the model it writes. */
export const routeCalls: readonly Connection[] = [
  {
    node: sampleOf("symbol").node,
    layer: "backend",
    edge: { kind: "handles", confidence: "exact" },
  },
  {
    node: sampleOf("model").node,
    edge: { kind: "writes", confidence: "pattern", fields: ["total", "status", "userId"] },
  },
];

/** The 15 lines around the route's registration. */
export const routeCode = {
  path: "apps/api/src/routes/orders.ts",
  startLine: 7,
  highlight: 14,
  lines: [
    'import { Router } from "express";',
    'import { prisma } from "../db";',
    'import { createOrder } from "../services/orders";',
    "",
    "export const orders = Router();",
    "",
    "// Orders are created from the checkout page.",
    'orders.post("/", async (req, res) => {',
    "  const order = await createOrder(prisma, req.body);",
    "  res.status(201).json(order);",
    "});",
    "",
    'orders.get("/:id", async (req, res) => {',
    "  res.json(await prisma.order.findUnique({ where: { id: req.params.id } }));",
    "});",
  ],
} as const;

/** Palette results for the query "ord", with the matched characters. */
export const paletteResults: readonly PaletteResult[] = [
  {
    node: sampleOf("route").node,
    path: "apps/api/src/routes/orders.ts",
    matches: [[10, 13]],
  },
  {
    node: sampleOf("file").node,
    layer: "backend",
    path: "apps/api/src/routes",
    matches: [[0, 3]],
  },
  {
    node: sampleOf("symbol").node,
    layer: "backend",
    path: "apps/api/src/routes/orders.ts",
    matches: [[6, 9]],
  },
  {
    node: sampleOf("model").node,
    path: "packages/db/schema.prisma",
    matches: [[0, 3]],
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
    path: "apps/api/src/services/orders.ts",
    matches: [[0, 3]],
  },
];

/** The top-level boxes of the shop diagram, as the minimap sees them. */
export const minimapNodes: readonly MinimapNode[] = [
  { id: "service:web", rect: { x: 0, y: 80, width: 280, height: 220 }, layer: "frontend" },
  { id: "service:api", rect: { x: 400, y: 0, width: 360, height: 420 }, layer: "backend" },
  { id: "service:worker", rect: { x: 400, y: 480, width: 300, height: 140 }, layer: "backend" },
  {
    id: "datastore:infra/postgres",
    rect: { x: 880, y: 140, width: 136, height: 120 },
    layer: "data",
  },
  {
    id: "queue:infra/redis#emails",
    rect: { x: 880, y: 470, width: 136, height: 120 },
    layer: "infra",
  },
  {
    id: "external:ext/api.stripe.com",
    rect: { x: 1120, y: 300, width: 136, height: 120 },
    layer: "external",
  },
];
