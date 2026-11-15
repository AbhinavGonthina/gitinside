import { apiMap } from "@gitinside/api-map";
import type { ArchitectureGraph } from "@gitinside/schema";

/** A graph's counts, as `analyses.stats` and the timeline's `analysis_counts` row hold them. */
export interface GraphCounts {
  /** Source files analyzed: the graph's `file` nodes. */
  files: number;
  nodes: number;
  edges: number;
  /** Nodes of kind `unresolved` (requests, imports, and calls shown with a reason). */
  unresolved: number;
  /** `service` nodes. */
  services: number;
  /**
   * Requests `@gitinside/api-map` calls broken: aimed at the repo, and no route matches
   * (ADR-0299). Not every `NO_MATCHING_ROUTE` request, most of which say no route is missing.
   */
  broken: number;
}

/** The counts of `graph` (M11.4a): the child reports them, and a diff job's stored side. */
export function graphCounts(graph: ArchitectureGraph): GraphCounts {
  let files = 0;
  let unresolved = 0;
  let services = 0;
  for (const node of graph.nodes) {
    if (node.kind === "file") files++;
    else if (node.kind === "unresolved") unresolved++;
    else if (node.kind === "service") services++;
  }
  return {
    files,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    unresolved,
    services,
    broken: apiMap(graph).totals.broken,
  };
}
