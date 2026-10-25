import type { EdgeKind, NodeKind } from "./schema.js";

/** ID of the single system root node. */
export const SYSTEM_ID = "system:root";

/**
 * Stable node ID built from qualified names, so the same thing keeps the same ID
 * across commits (ADR-0019). Examples:
 * `symbol:api/src/routes/orders.ts#createOrder`, `route:api/POST /api/orders`, `model:api/Order`.
 */
export function nodeId(kind: Exclude<NodeKind, "system">, service: string, qualified: string): string {
  return `${kind}:${service}/${qualified}`;
}

/** Stable edge ID. There is at most one edge per (kind, from, to). */
export function edgeId(kind: EdgeKind, from: string, to: string): string {
  return `${kind}:${from}->${to}`;
}
