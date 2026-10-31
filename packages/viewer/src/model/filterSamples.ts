import type { ArchitectureGraph, GraphEdge, GraphNode } from "@gitinside/schema";

/**
 * Sample data for the filters' tests and stories (M4b.8): the shop demo
 * plus what real repos carry next to the app, which the demo itself
 * doesn't: a test folder, a spec beside its code, and a config file at a
 * service's root.
 */

const HASH = "0".repeat(64);

/** The test folder the sample adds under `apps/api/src`. */
export const SAMPLE_TESTS = "module:api/src/__tests__";
/** A test file in it. */
export const SAMPLE_ORDERS_TEST = "file:api/src/__tests__/orders.test.ts";
/** A spec beside the code it tests. */
export const SAMPLE_SPEC = "file:api/src/orders/handlers.spec.ts";
/** A config file at the web service's root. */
export const SAMPLE_NEXT_CONFIG = "file:web/next.config.mjs";

const file = (id: string, parentId: string, path: string): GraphNode => ({
  id,
  kind: "file",
  label: path.split("/").pop() ?? path,
  parentId,
  path,
  hash: HASH,
});
const fn = (file: string, name: string): GraphNode => ({
  id: `symbol:${file.slice("file:".length)}#${name}`,
  kind: "symbol",
  label: name,
  parentId: file,
  symbolKind: "function",
  exported: true,
});
const calls = (from: string, to: string): GraphEdge => ({
  id: `calls:${from}->${to}`,
  kind: "calls",
  from,
  to,
  confidence: "exact",
  sites: [],
});

/** The shop demo graph with test and config files added (IDs above), and calls from the tests into the code. */
export function withTestFiles(shop: ArchitectureGraph): ArchitectureGraph {
  return {
    ...shop,
    nodes: [
      ...shop.nodes,
      {
        id: SAMPLE_TESTS,
        kind: "module",
        label: "__tests__",
        parentId: "module:api/src",
        path: "apps/api/src/__tests__",
      },
      file(SAMPLE_ORDERS_TEST, SAMPLE_TESTS, "apps/api/src/__tests__/orders.test.ts"),
      fn(SAMPLE_ORDERS_TEST, "createsAnOrder"),
      file(SAMPLE_SPEC, "module:api/src/orders", "apps/api/src/orders/handlers.spec.ts"),
      fn(SAMPLE_SPEC, "listsOrders"),
      file(SAMPLE_NEXT_CONFIG, "service:web/", "apps/web/next.config.mjs"),
    ],
    edges: [
      ...shop.edges,
      calls(
        "symbol:api/src/__tests__/orders.test.ts#createsAnOrder",
        "symbol:api/src/orders/handlers.ts#createOrder",
      ),
      calls(
        "symbol:api/src/orders/handlers.spec.ts#listsOrders",
        "symbol:api/src/orders/handlers.ts#listOrders",
      ),
    ],
  };
}
