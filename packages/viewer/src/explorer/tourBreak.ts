import { diffGraphs } from "@gitinside/diff";
import {
  compareStrings,
  edgeId,
  type ArchitectureGraph,
  type GraphDiff,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";

/**
 * The tour's broken connection (M10.3f2b, M10-design §3.1 step 4): a canned PR on the repo. Its
 * head is the graph with one route removed that another service still calls, drawn as the
 * analyzer draws a call that matches no route (each call site an unresolved `NO_MATCHING_ROUTE`
 * request under its file). `packages/diff` then diffs the two like any PR, so the break, its
 * words, and the overlay are the diff's own findings; only the PR is made up, and the tour's card
 * and diff chip say so.
 *
 * Which route: one reached over `http` from another service, from a source inside a file (the
 * unresolved call's parent). The first on `prefer` (the tour passes its suggested trace's path in
 * order, so the step breaks the first request the reader just traced, a page's or the frontend's
 * rather than one deep in the path), then the route with the fewest calling edges (one broken
 * line reads clearest), then by ID. None when the repo has no such call, or
 * when the diff doesn't call it broken; the tour then leaves the step out.
 */

/** A route node. */
export type RouteNode = Extract<GraphNode, { kind: "route" }>;

/** The canned PR: what it removes, and the diff of the repo against it. */
export interface TourBreak {
  route: RouteNode;
  /** The call's source, which head still has. */
  caller: GraphNode;
  /** The repo with the route removed: the canned PR's head. */
  head: ArchitectureGraph;
  /** `diffGraphs(repo, head)`. */
  diff: GraphDiff;
  /** The diff's words for the break ("GET /api/x was removed"). */
  detail: string;
}

/** The nearest ancestor (or the node itself) of a kind. */
function upTo(
  byId: ReadonlyMap<string, GraphNode>,
  id: string,
  kind: GraphNode["kind"],
): GraphNode | undefined {
  for (let node = byId.get(id); node !== undefined; ) {
    if (node.kind === kind) return node;
    node = node.parentId === null ? undefined : byId.get(node.parentId);
  }
  return undefined;
}

/**
 * The graph with `route` removed, its callers' requests left unmatched, as the analyzer has them.
 * `byId` is the repo's (callers are looked up in it), so `graph` may already lack other nodes.
 */
export function withoutRoute(
  graph: ArchitectureGraph,
  byId: ReadonlyMap<string, GraphNode>,
  route: RouteNode,
): ArchitectureGraph {
  const nodes = graph.nodes.filter((n) => n.id !== route.id);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => e.from !== route.id && e.to !== route.id);
  const calls = graph.edges.filter((e) => e.kind === "http" && e.to === route.id);
  for (const call of calls) {
    const file = upTo(byId, call.from, "file");
    if (file === undefined) continue;
    for (const { file: path, line, column, request: asked } of call.sites) {
      // `unresolved:<service>/<path>:<line>:<column>`, as the analyzer names a call's node.
      const id = `unresolved:${file.id.slice("file:".length)}:${line}:${column}`;
      if (ids.has(id)) continue;
      ids.add(id);
      // The request as the call site wrote it, which the diff knows the call by.
      const request = asked ?? `${route.method} ${route.path}`;
      nodes.push({
        id,
        kind: "unresolved",
        label: request,
        parentId: file.id,
        reason: "NO_MATCHING_ROUTE",
        expression: request,
        source: { file: path, line, column },
      });
      edges.push({
        id: edgeId("http", call.from, id),
        kind: "http",
        from: call.from,
        to: id,
        confidence: "unresolved",
        reason: "NO_MATCHING_ROUTE",
        sites: [{ file: path, line, column }],
      });
    }
  }
  return { ...graph, nodes, edges };
}

/** The route a canned PR removes to break a call; see the module comment for which. */
export function breakableRoute(
  graph: ArchitectureGraph,
  prefer: readonly string[] = [],
): RouteNode | undefined {
  const rank = new Map<string, number>();
  prefer.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const rankOf = (id: string) => rank.get(id) ?? prefer.length;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const callers = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const route = byId.get(e.to);
    if (e.kind !== "http" || route?.kind !== "route" || e.sites.length === 0) continue;
    if (upTo(byId, e.from, "file") === undefined) continue;
    const from = upTo(byId, e.from, "service");
    if (from === undefined || from.id === upTo(byId, route.id, "service")?.id) continue;
    callers.set(route.id, [...(callers.get(route.id) ?? []), e]);
  }
  const routes = [...callers.keys()].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      (callers.get(a)?.length ?? 0) - (callers.get(b)?.length ?? 0) ||
      compareStrings(a, b),
  );
  const [first] = routes;
  const route = first === undefined ? undefined : byId.get(first);
  return route?.kind === "route" ? route : undefined;
}

/** The tour's canned PR on `graph`; see the module comment for the route it removes. */
export function tourBreak(
  graph: ArchitectureGraph,
  prefer: readonly string[] = [],
): TourBreak | undefined {
  const route = breakableRoute(graph, prefer);
  if (!route) return undefined;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const head = withoutRoute(graph, byId, route);
  const diff = diffGraphs(graph, head);
  const broken = diff.broken.find((b) => b.to === route.id);
  const caller = broken && byId.get(broken.from);
  if (!broken || !caller) return undefined;
  return { route, caller, head, diff, detail: broken.detail };
}
