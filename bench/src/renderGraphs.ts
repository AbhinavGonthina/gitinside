import { createHash } from "node:crypto";
import {
  canonicalize,
  edgeId,
  nodeId,
  SCHEMA_VERSION,
  SYSTEM_ID,
  type ArchitectureGraph,
  type Confidence,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { buildHierarchy, buildView, DEFAULT_FILTERS, type Filters } from "@gitinside/viewer";

// Graphs for the render benchmark (EVALUATION.md §2, M4b.13b): what the
// explorer draws at a target number of visible nodes, and the expansion
// state that gets it there.

/** How many services the synthetic graph has (half frontends, half backends). */
export const SYNTHETIC_SERVICES = 10;

/** A graph and the nodes to open (`Explorer`'s `initialOpen`), with what that level draws. */
export interface RenderCase {
  graph: ArchitectureGraph;
  open: string[];
  /** Boxes on the canvas at that expansion, under the explorer's default filters. */
  nodes: number;
  /** Lines on the canvas at that expansion. */
  lines: number;
}

const pad = (i: number): string => String(i).padStart(4, "0");
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const CONFIDENCES: readonly Confidence[] = ["exact", "pattern", "heuristic"];

/**
 * A synthetic graph whose `open` level draws exactly `visible` boxes: 10
 * services, each broken down into its routes (backends) or pages
 * (frontends), plus one closed `src` folder holding the handlers and
 * components. Lines: each route handles, and each page renders, into its
 * folder; each frontend's folder calls one route of the next backend per
 * page over HTTP (confidence cycling exact, pattern, heuristic). So
 * `visible` = 10 + 10 × (entries + 1), and there are 1.5 lines per entry.
 * `visible` must be a multiple of 10, at least 30.
 */
export function syntheticGraph(visible: number): RenderCase {
  const perService = visible / SYNTHETIC_SERVICES - 1;
  const entries = perService - 1;
  if (!Number.isInteger(perService) || entries < 1) {
    throw new Error(`visible must be a multiple of ${SYNTHETIC_SERVICES}, at least 30`);
  }
  const nodes: GraphNode[] = [
    { id: SYSTEM_ID, kind: "system", label: "synthetic", parentId: null },
  ];
  const edges: GraphEdge[] = [];
  const edge = (kind: EdgeKind, from: string, to: string, file: string, line: number, i = 0) =>
    edges.push({
      id: edgeId(kind, from, to),
      kind,
      from,
      to,
      confidence: CONFIDENCES[i % CONFIDENCES.length] as Confidence,
      sites: [{ file, line, column: 1 }],
    });
  const open: string[] = [];
  const name = (k: number) => (k % 2 === 0 ? `web-${k}` : `api-${k}`);
  /** Each backend's route IDs, for the frontends' HTTP calls. */
  const routes = new Map<number, string[]>();

  for (let k = 0; k < SYNTHETIC_SERVICES; k++) {
    const svc = name(k);
    const frontend = k % 2 === 0;
    const service = nodeId("service", svc, "");
    const folder = nodeId("module", svc, "src");
    const path = `apps/${svc}/src/app.ts`;
    const file = nodeId("file", svc, "src/app.ts");
    open.push(service);
    nodes.push(
      frontend
        ? {
            id: service,
            kind: "service",
            label: svc,
            parentId: SYSTEM_ID,
            layer: "frontend",
            root: `apps/${svc}`,
            framework: "next",
          }
        : {
            id: service,
            kind: "service",
            label: svc,
            parentId: SYSTEM_ID,
            layer: "backend",
            root: `apps/${svc}`,
            framework: "express",
          },
      { id: folder, kind: "module", label: "src", parentId: service, path: `apps/${svc}/src` },
      { id: file, kind: "file", label: "app.ts", parentId: folder, path, hash: hash(path) },
    );
    const ids: string[] = [];
    for (let i = 0; i < entries; i++) {
      const line = i * 10 + 1;
      const source = { file: path, line, column: 1 };
      const symbol = nodeId("symbol", svc, `src/app.ts#${frontend ? "Page" : "handler"}${pad(i)}`);
      nodes.push({
        id: symbol,
        kind: "symbol",
        label: `${frontend ? "Page" : "handler"}${pad(i)}`,
        parentId: file,
        source,
        symbolKind: "function",
        exported: true,
      });
      if (frontend) {
        const page = nodeId("page", svc, `/area-${pad(i)}`);
        nodes.push({
          id: page,
          kind: "page",
          label: `/area-${pad(i)}`,
          parentId: file,
          path: `/area-${pad(i)}`,
          layer: "frontend",
          source,
        });
        edge("renders", page, symbol, path, line);
      } else {
        const route = nodeId("route", svc, `GET /v1/items-${pad(i)}`);
        nodes.push({
          id: route,
          kind: "route",
          label: `GET /v1/items-${pad(i)}`,
          parentId: file,
          method: "GET",
          path: `/v1/items-${pad(i)}`,
          layer: "backend",
          source,
        });
        edge("handles", route, symbol, path, line);
        ids.push(route);
      }
    }
    routes.set(k, ids);
  }
  // Frontend k calls backend k + 1, one route per page.
  for (let k = 0; k < SYNTHETIC_SERVICES; k += 2) {
    const svc = name(k);
    const path = `apps/${svc}/src/app.ts`;
    (routes.get(k + 1) ?? []).forEach((route, i) => {
      const page = nodeId("symbol", svc, `src/app.ts#Page${pad(i)}`);
      edge("http", page, route, path, i * 10 + 2, i);
    });
  }

  const graph = canonicalize({
    schemaVersion: SCHEMA_VERSION,
    repo: { owner: "bench", name: "synthetic" },
    analyzerVersion: "synthetic",
    nodes,
    edges,
    warnings: [],
  });
  const view = buildView(buildHierarchy(graph), open, { filters: DEFAULT_FILTERS });
  return { graph, open, nodes: view.nodes.length, lines: view.edges.length };
}

/**
 * The expansion state of a real graph that comes closest to `target` visible
 * boxes without passing it, as a reader would get there: shallowest first,
 * in drawing order, each node opened if the level still fits, until nothing
 * more fits. Counted under `filters` (the explorer's defaults), so the
 * explorer opened with `open` draws `nodes` boxes.
 */
export function openToReach(
  graph: ArchitectureGraph,
  target: number,
  filters: Filters = DEFAULT_FILTERS,
): RenderCase {
  const index = buildHierarchy(graph);
  const open: string[] = [];
  let view = buildView(index, open, { filters });
  const tried = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    const candidates = view.nodes
      .filter((n) => !n.open && n.canOpen && !tried.has(n.id))
      .sort((a, b) => a.level - b.level);
    for (const candidate of candidates) {
      const next = buildView(index, [...open, candidate.id], { filters });
      if (next.nodes.length > target) {
        // Nothing opened later shrinks the level, so it never fits again.
        tried.add(candidate.id);
        continue;
      }
      open.push(candidate.id);
      view = next;
      grew = true;
    }
  }
  return { graph, open, nodes: view.nodes.length, lines: view.edges.length };
}
