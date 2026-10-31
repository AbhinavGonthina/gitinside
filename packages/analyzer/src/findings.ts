import { compareStrings, type GraphNode } from "@gitinside/schema";

/**
 * What an analysis has found so far, for a progress screen (#8): the services, routes,
 * pages, data stores, and external services in the nodes the stages have produced. A key
 * is present once a stage that finds it has run, so `routes: 0` means "looked, found none"
 * and a missing key means "not looked yet". Like timings, findings never enter the graph.
 */
export interface AnalysisFindings {
  /** Service labels, sorted (after `workspace`). */
  services?: string[];
  /** Route nodes (after `express`; `next` adds its own). */
  routes?: number;
  /** Page nodes (after `next`). */
  pages?: number;
  /** Datastore and queue labels, sorted (after `infra`; `queues` adds its own). */
  stores?: string[];
  /** External service labels, sorted (after `http`; `sdk` adds its own). */
  externals?: string[];
}

/** One key of {@link AnalysisFindings}. */
export type FindingKey = keyof AnalysisFindings;

const ALL_KEYS: readonly FindingKey[] = ["services", "routes", "pages", "stores", "externals"];

/** The finding a node counts towards, if any. Unresolved nodes are never findings. */
function keyOf(node: GraphNode): FindingKey | undefined {
  switch (node.kind) {
    case "service":
      return "services";
    case "route":
      return "routes";
    case "page":
      return "pages";
    case "datastore":
    case "queue":
      return "stores";
    case "external":
      return "externals";
    default:
      return undefined;
  }
}

/** The findings in `nodes` (one per node ID) for `keys`. */
function summarize(nodes: Iterable<GraphNode>, keys: ReadonlySet<FindingKey>): AnalysisFindings {
  const labels = new Map<FindingKey, string[]>(ALL_KEYS.map((key) => [key, []]));
  for (const node of nodes) {
    const key = keyOf(node);
    if (key !== undefined) labels.get(key)?.push(node.label);
  }
  const list = (key: FindingKey) => (labels.get(key) ?? []).sort(compareStrings);
  return {
    ...(keys.has("services") ? { services: list("services") } : {}),
    ...(keys.has("routes") ? { routes: list("routes").length } : {}),
    ...(keys.has("pages") ? { pages: list("pages").length } : {}),
    ...(keys.has("stores") ? { stores: list("stores") } : {}),
    ...(keys.has("externals") ? { externals: list("externals") } : {}),
  };
}

/**
 * Every finding in a finished graph's nodes. The last report of {@link createFindings}
 * equals this for the graph `analyze` returns (fixtures.test.ts checks it on every fixture).
 */
export function findingsOf(nodes: readonly GraphNode[]): AnalysisFindings {
  return summarize(nodes, new Set(ALL_KEYS));
}

/** Collects what the stages find and reports the running total (see {@link createFindings}). */
export interface FindingsTracker {
  /**
   * After a stage: mark `keys` as looked for, add the stage's `nodes` (the first node with
   * an ID wins, as in assembly), and report everything found so far.
   */
  add(keys: readonly FindingKey[], nodes: readonly GraphNode[]): void;
}

/** A tracker reporting to `report`; without one, `add` does nothing. */
export function createFindings(report?: (found: AnalysisFindings) => void): FindingsTracker {
  const nodes = new Map<string, GraphNode>();
  const keys = new Set<FindingKey>();
  return {
    add(stageKeys, stageNodes) {
      if (report === undefined) return;
      for (const key of stageKeys) keys.add(key);
      for (const node of stageNodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
      report(summarize(nodes.values(), keys));
    },
  };
}
