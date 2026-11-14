import { compareStrings } from "@gitinside/schema";
import type { GraphNode, Layer } from "@gitinside/schema";
import { layerOf, type HierarchyIndex } from "../model/hierarchy.js";
import { kindName } from "../nodes/describe.js";
import { canTraceFrom, traceFrom, traceNodes, type Trace } from "./trace.js";

/**
 * Suggested traces (M10.3d1, M10-design B11), for the prototype's trace picker and its "Try
 * this": the request paths that make the best first demo, ranked from the graph's own trace
 * (`traceFrom`), so a suggestion is exact for this graph, never guessed.
 *
 * Where one can start: every page and route the picker offers, and the code that makes a request
 * a route in the repo answers (ADR-0280). A UI with no pages (wanderlust's Vite app) starts its
 * requests in components, so B11's "page → API" exists there only from such a start.
 *
 * The rank, in order: the path makes a request that a route in the repo answers (an `http` hop to
 * a route; B11 said "crosses a service boundary", but maxun's UI and API are one package, so the
 * request counts wherever the route is); it reaches a datastore or an outside API; it passes
 * through more services; it takes fewer steps (a shorter path that does all that reads better);
 * then the start's node ID (`compareStrings`).
 */

/** How many suggestions the picker shows. */
export const SUGGESTED = 3;

/** A suggested trace: where it starts and how its path reads. */
export interface Suggestion {
  node: GraphNode;
  /** The start's layer (its own or its service's), for the picker's icon tint. */
  layer?: Layer | undefined;
  /** The start's file, if it has one. */
  path?: string | undefined;
  /** The path's shape: "page → API → postgres, 7 steps". */
  shape: string;
  /** Whether a hop is a request that a route in the repo answers. */
  answered: boolean;
  /** Whether the path reaches a datastore or an outside API. */
  reachesOut: boolean;
  /** Services the path passes through. */
  services: number;
  steps: number;
}

/** Kinds a path can end at outside the code. */
function isOut(node: GraphNode): boolean {
  return node.kind === "datastore" || node.kind === "external";
}

/** Whether a hop is an `http` request that a route in the repo answers. */
function isAnswered(step: Trace["steps"][number]): boolean {
  return step.edge.kind === "http" && step.to.kind === "route";
}

/**
 * The path's shape in a few words: what it starts at ("page", "route", "function"), "API" for
 * each request a route answers, then the first datastore or outside API it reaches, and its step
 * count.
 */
function shapeOf(trace: Trace): string {
  const parts = [kindName(trace.start).toLowerCase()];
  let out: GraphNode | undefined;
  for (const step of trace.steps) {
    if (isAnswered(step) && parts[parts.length - 1] !== "API") parts.push("API");
    if (!out && isOut(step.to)) out = step.to;
  }
  if (out) parts.push(out.label);
  const n = trace.steps.length;
  return `${parts.join(" → ")}, ${n.toLocaleString("en-US")} ${n === 1 ? "step" : "steps"}`;
}

/**
 * Where a suggestion can start, in graph order: the picker's pages and routes, then each node
 * that makes an `http` request a route answers, unless a page's or route's path already reaches
 * it (the outer start shows the same request, from where it begins).
 */
export function suggestionStarts(index: HierarchyIndex): GraphNode[] {
  const starts = index.graph.nodes.filter((n) => canTraceFrom(index, n));
  const reached = new Set<string>();
  for (const start of starts)
    for (const id of traceNodes(traceFrom(index, start.id))) reached.add(id);
  const requests = new Map<string, GraphNode>();
  for (const edge of index.graph.edges) {
    if (edge.kind !== "http" || index.byId.get(edge.to)?.kind !== "route") continue;
    const from = index.byId.get(edge.from);
    if (from && !reached.has(from.id)) requests.set(from.id, from);
  }
  return [...starts, ...requests.values()];
}

/** One start's suggestion, from its trace. */
export function suggestionOf(index: HierarchyIndex, node: GraphNode): Suggestion {
  const trace = traceFrom(index, node.id);
  const services = new Set<string>();
  for (const id of traceNodes(trace)) {
    const service = index.service.get(id);
    if (service !== undefined) services.add(service);
  }
  return {
    node,
    layer: node.layer ?? layerOf(index, node.id),
    path: "source" in node ? node.source?.file : undefined,
    shape: shapeOf(trace),
    answered: trace.steps.some(isAnswered),
    reachesOut: trace.steps.some((s) => isOut(s.to)),
    services: services.size,
    steps: trace.steps.length,
  };
}

/** B11's order: the better demo first. */
export function compareSuggestions(a: Suggestion, b: Suggestion): number {
  return (
    Number(b.answered) - Number(a.answered) ||
    Number(b.reachesOut) - Number(a.reachesOut) ||
    b.services - a.services ||
    a.steps - b.steps ||
    compareStrings(a.node.id, b.node.id)
  );
}

/** The best `limit` traces to suggest, best first; none when nothing can be traced. */
export function suggestTraces(index: HierarchyIndex, limit = SUGGESTED): Suggestion[] {
  return suggestionStarts(index)
    .map((n) => suggestionOf(index, n))
    .sort(compareSuggestions)
    .slice(0, limit);
}
