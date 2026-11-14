import { compareStrings } from "@gitinside/schema";
import type { Confidence, GraphEdge, GraphNode } from "@gitinside/schema";
import { CONFIDENCE_ORDER } from "../model/filters.js";
import { isWithin, nodeOf, type HierarchyIndex } from "../model/hierarchy.js";
import { hopsOf } from "./trace.js";

/**
 * Impact analysis for the prototype (M10.3f1, M10-design §3.2): "what depends on this?". A
 * node depends on the target when its request path reaches it: the trace's own hops
 * (`renders`, `calls`, `http`, `handles`, `reads`, `writes`, `stores`, `external_call`,
 * `publishes`, and `consumes` from the queue to its worker; `trace.ts`) walked backwards from
 * the target and everything inside it, with no depth limit. It stands in for M11.1's engine
 * until that's built: the same edges, read the other way, nothing guessed.
 *
 * "May also reach": when the target is or holds a route, a request GitInside couldn't match
 * (an `http` hop to an unresolved node, other than an outside host's) might be one of its
 * callers. Those requests, their unresolved ends, and whatever reaches them are listed apart,
 * never counted as dependents.
 *
 * Not followed: `imports` (a file importing another isn't a request going there, and the
 * trace leaves them out too), and unresolved function calls (an unknown symbol can't be tied
 * to one function).
 */

/** At most this many paths are listed, shortest first. */
export const IMPACT_PATHS = 5;

/** One way a page or route reaches the target: its nodes from the entry to the target, and its weakest link. */
export interface ImpactPath {
  nodes: readonly GraphNode[];
  confidence: Confidence;
}

/** The dependents inside one service (or one outside node at the system level). */
export interface ImpactGroup {
  /** The service, or the datastore, queue, or outside API itself. */
  holder: GraphNode;
  nodes: readonly GraphNode[];
}

/** What depends on a node. */
export interface Impact {
  target: GraphNode;
  /** Nodes outside the target whose request path reaches it. */
  dependents: ReadonlySet<string>;
  /** Nodes that may reach it through an unmatched request, and those requests' unresolved ends. */
  maybe: ReadonlySet<string>;
  /** The dependents by service, most first, then by name. */
  groups: readonly ImpactGroup[];
  /** Up to {@link IMPACT_PATHS} pages and routes reaching the target, by length, then name. */
  paths: readonly ImpactPath[];
}

/** The way back toward the target: the next node and the edge between. */
interface Toward {
  next: string;
  edge: GraphEdge;
}

/** Each node's hops into it, from the nodes whose request goes there. */
function hopsInto(index: HierarchyIndex): Map<string, Toward[]> {
  const into = new Map<string, Toward[]>();
  for (const [from, hops] of hopsOf(index)) {
    for (const hop of hops) {
      const list = into.get(hop.to);
      const back = { next: from, edge: hop.edge };
      if (list) list.push(back);
      else into.set(hop.to, [back]);
    }
  }
  return into;
}

const cachedInto = new WeakMap<HierarchyIndex, Map<string, Toward[]>>();

function intoOf(index: HierarchyIndex): Map<string, Toward[]> {
  let into = cachedInto.get(index);
  if (!into) {
    into = hopsInto(index);
    cachedInto.set(index, into);
  }
  return into;
}

/**
 * Breadth-first backwards from `seeds`: each node reached, with its step toward a seed (the
 * first found, so the shortest way). Nodes in `stop` aren't entered.
 */
function walkBack(
  into: ReadonlyMap<string, readonly Toward[]>,
  seeds: readonly string[],
  stop: ReadonlySet<string>,
): Map<string, Toward | null> {
  const reached = new Map<string, Toward | null>(seeds.map((id) => [id, null]));
  for (let queue = [...seeds]; queue.length > 0; ) {
    const next: string[] = [];
    for (const id of queue) {
      for (const back of into.get(id) ?? []) {
        // `back.next` is the node the request comes from; walking back, it's next to visit.
        const from = back.next;
        if (reached.has(from) || stop.has(from)) continue;
        reached.set(from, { next: id, edge: back.edge });
        next.push(from);
      }
    }
    queue = next.sort(compareStrings);
  }
  return reached;
}

/** The target and every node inside it, in graph order. */
function seedsOf(index: HierarchyIndex, target: string): string[] {
  return index.graph.nodes
    .filter((n) => n.id === target || isWithin(index, n.id, target))
    .map((n) => n.id);
}

/** Whether a request could land in the target: it is, or holds, a route. */
function takesRequests(index: HierarchyIndex, target: GraphNode): boolean {
  return target.kind === "route" || (index.inside.get(target.id)?.route ?? 0) > 0;
}

const weaker = (a: Confidence, b: Confidence) =>
  CONFIDENCE_ORDER.indexOf(a) >= CONFIDENCE_ORDER.indexOf(b) ? a : b;

/** What depends on `target` (any node but the root). Throws for an unknown ID. */
export function impactOf(index: HierarchyIndex, target: string): Impact {
  const node = nodeOf(index, target);
  const into = intoOf(index);
  const seeds = seedsOf(index, target);
  const seedSet = new Set(seeds);

  const back = walkBack(into, seeds, new Set());
  const dependents = new Set([...back.keys()].filter((id) => !seedSet.has(id)));

  // Requests that matched no route, when the target takes requests: they may be its callers.
  const maybe = new Set<string>();
  if (takesRequests(index, node)) {
    const unmatched = index.graph.edges.filter((e) => {
      if (e.kind !== "http") return false;
      const to = index.byId.get(e.to);
      return to?.kind === "unresolved" && to.reason !== "EXTERNAL_HOST";
    });
    const ends = [...new Set(unmatched.map((e) => e.to))].sort(compareStrings);
    for (const id of walkBack(into, ends, seedSet).keys()) {
      if (!dependents.has(id)) maybe.add(id);
    }
  }

  return {
    target: node,
    dependents,
    maybe,
    groups: groupsOf(index, dependents),
    paths: pathsOf(index, back, dependents),
  };
}

/** The dependents by the service holding them (or themselves, outside every service). */
function groupsOf(index: HierarchyIndex, dependents: ReadonlySet<string>): ImpactGroup[] {
  const byHolder = new Map<string, GraphNode[]>();
  for (const n of index.graph.nodes) {
    if (!dependents.has(n.id)) continue;
    const holder = index.service.get(n.id) ?? n.id;
    const list = byHolder.get(holder);
    if (list) list.push(n);
    else byHolder.set(holder, [n]);
  }
  return [...byHolder]
    .map(([holder, nodes]) => ({ holder: nodeOf(index, holder), nodes }))
    .sort(
      (a, b) =>
        b.nodes.length - a.nodes.length ||
        compareStrings(a.holder.label, b.holder.label) ||
        compareStrings(a.holder.id, b.holder.id),
    );
}

/** The shortest way from each page and route that depends on the target, the first few. */
function pathsOf(
  index: HierarchyIndex,
  back: ReadonlyMap<string, Toward | null>,
  dependents: ReadonlySet<string>,
): ImpactPath[] {
  const paths: ImpactPath[] = [];
  for (const n of index.graph.nodes) {
    if (!dependents.has(n.id) || (n.kind !== "page" && n.kind !== "route")) continue;
    const nodes: GraphNode[] = [n];
    let confidence: Confidence = "exact";
    for (let step = back.get(n.id); step; step = back.get(step.next)) {
      nodes.push(nodeOf(index, step.next));
      confidence = weaker(step.edge.confidence, confidence);
    }
    paths.push({ nodes, confidence });
  }
  return paths
    .sort(
      (a, b) =>
        a.nodes.length - b.nodes.length ||
        compareStrings(a.nodes[0]?.label ?? "", b.nodes[0]?.label ?? "") ||
        compareStrings(a.nodes[0]?.id ?? "", b.nodes[0]?.id ?? ""),
    )
    .slice(0, IMPACT_PATHS);
}

/** "23 things, in 3 services": how much depends on the target (a queue outside every service counts apart). */
export function impactCountText(impact: Impact): string {
  const count = (x: number, one: string, many: string) =>
    `${x.toLocaleString("en-US")} ${x === 1 ? one : many}`;
  const n = impact.dependents.size;
  if (n === 0) return "Nothing in the repo depends on this";
  const services = impact.groups.filter((g) => g.holder.kind === "service").length;
  const others = impact.groups.length - services;
  const where = [
    ...(services > 0 ? [count(services, "service", "services")] : []),
    ...(others > 0 ? [count(others, "other place", "other places")] : []),
  ];
  return `${count(n, "thing", "things")}, in ${where.join(" and ")}`;
}
