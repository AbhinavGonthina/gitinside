import { compareStrings, SYSTEM_ID } from "@gitinside/schema";
import type {
  ArchitectureGraph,
  Confidence,
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
} from "@gitinside/schema";

/**
 * Impact analysis (M11.1, ADR-0298): given a node, everything in the repo that depends on it,
 * transitively and across services, each with the way it gets there and the weakest link on
 * that way. Pure and deterministic: the same graph and target give the same answer, whatever
 * order the graph lists its nodes and edges in. It runs where the graph already is (the
 * visitor's browser, ADR-0295), so it holds no state beyond an index built once per graph.
 *
 * **What "depends on" means.** A node depends on another when an edge between them is the
 * first using the second: `imports` (file on file), `calls`, `http` (the caller on the route),
 * `handles` (a route on its handler), `renders` (a page on its component), `reads` and
 * `writes` (code on a model), `stores` (a model on its datastore), `publishes` (a producer on
 * its queue), and `external_call` (code on an outside API). A `consumes` edge counts both
 * ways: the worker depends on its queue, and the queue (so, through it, every producer)
 * depends on the code that runs its jobs. The target counts as everything inside it, so a
 * file's or a service's dependents are what reaches any of its symbols, routes, or files from
 * outside it.
 *
 * **Which way, and how sure.** Each dependent gets one path to the target: the one whose
 * weakest edge is strongest (`exact` over `pattern` over `heuristic`), and among those the
 * shortest by hops. Its `confidence` is that weakest edge, `depth` its length.
 *
 * **May also reach.** Edges to `unresolved` nodes never reach anything. Instead, an
 * unresolved node may stand for a node the analyzer couldn't name: a request it couldn't
 * match may be to any route (an outside host it couldn't name, `EXTERNAL_HOST`, excepted), a
 * raw query or unknown model may touch any model, and a queue named at runtime may be any
 * queue. When the target or one of its dependents is such a node, those unresolved nodes and
 * everything that reaches them are listed apart, under `maybe`, never as dependents. This
 * repeats until no new kind turns up (a raw query behind a route makes unmatched requests
 * matter too). A target that is itself unresolved is reached only through unresolved edges,
 * so all its callers are `maybe`.
 *
 * **Not handled:** an unresolved import (the file it names isn't in the repo, so it can't be
 * the target); calls whose callee didn't resolve (the analyzer draws no edge for them); and
 * containment beyond the target itself: a file that imports a dependent file doesn't make its
 * own symbols dependents, nor does a dependent symbol make its file one.
 */

/** What an unresolved node may stand for, when the analyzer couldn't name its target. */
export type StandIn = "route" | "model" | "queue";

/** One node that depends on the target (or may), and its step toward it. */
export interface ImpactEntry {
  id: string;
  /** Hops from here to the target (to the stand-in, for an unresolved node it may be). */
  depth: number;
  /** The weakest edge on the way; always `unresolved` under `maybe`. */
  confidence: Confidence;
  /** The next node toward the target. Absent on a stand-in, where a `maybe` path starts. */
  next?: string;
  /** The edge from this node to `next`. */
  edge?: string;
  /** On an unresolved node listed because it may be something the target reaches: what. */
  standsFor?: StandIn;
}

/** What depends on a node. Entries are sorted by depth, then ID. */
export interface Impact {
  target: string;
  /** The target and every node inside it, sorted by ID. */
  inside: readonly string[];
  /** Nodes outside the target whose edges reach it. */
  dependents: readonly ImpactEntry[];
  /** Nodes that may reach it through an unresolved node, and those unresolved nodes. */
  maybe: readonly ImpactEntry[];
}

/** An edge into a node, read from the node that depends on it. */
interface Back {
  from: string;
  edge: GraphEdge;
}

/** A graph prepared for impact queries: build once, ask many times. */
export interface ImpactIndex {
  readonly graph: ArchitectureGraph;
  readonly byId: ReadonlyMap<string, GraphNode>;
  /** Each node's children, sorted by ID. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** Each node's dependents by one edge, sorted by their ID, then the edge's. */
  readonly into: ReadonlyMap<string, readonly Back[]>;
  /** Unresolved nodes that may stand for a node of each kind, sorted by ID. */
  readonly standIns: ReadonlyMap<StandIn, readonly string[]>;
}

/** Edge kinds whose `from` depends on their `to`. */
const FORWARD: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  "imports",
  "calls",
  "http",
  "handles",
  "renders",
  "reads",
  "writes",
  "stores",
  "publishes",
  "external_call",
]);

/** Confidence levels a path can reach through, strongest first. */
const LEVELS: readonly Confidence[] = ["exact", "pattern", "heuristic"];
const RANK: Readonly<Record<Confidence, number>> = {
  exact: 0,
  pattern: 1,
  heuristic: 2,
  unresolved: 3,
};

/** What an edge into an unresolved node says it stood for, if anything. */
function standInOf(edge: GraphEdge, node: GraphNode): StandIn | undefined {
  if (node.kind !== "unresolved") return undefined;
  switch (edge.kind) {
    case "http":
      return node.reason === "EXTERNAL_HOST" ? undefined : "route";
    case "reads":
    case "writes":
      return "model";
    case "publishes":
    case "consumes":
      return "queue";
    default:
      return undefined;
  }
}

const KIND_OF: Readonly<Record<StandIn, NodeKind>> = {
  route: "route",
  model: "model",
  queue: "queue",
};
const STAND_INS: readonly StandIn[] = ["route", "model", "queue"];

const byBack = (a: Back, b: Back) =>
  compareStrings(a.from, b.from) || compareStrings(a.edge.id, b.edge.id);

/** Index a graph for {@link impactOf}. Linear in the graph's size. */
export function impactIndex(graph: ArchitectureGraph): ImpactIndex {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.parentId === null) continue;
    const list = children.get(n.parentId);
    if (list) list.push(n.id);
    else children.set(n.parentId, [n.id]);
  }
  for (const list of children.values()) list.sort(compareStrings);

  const into = new Map<string, Back[]>();
  const add = (to: string, back: Back) => {
    const list = into.get(to);
    if (list) list.push(back);
    else into.set(to, [back]);
  };
  const standIns = new Map<StandIn, Set<string>>();
  for (const edge of graph.edges) {
    if (FORWARD.has(edge.kind)) add(edge.to, { from: edge.from, edge });
    else if (edge.kind === "consumes") {
      add(edge.to, { from: edge.from, edge });
      add(edge.from, { from: edge.to, edge });
    }
    const to = byId.get(edge.to);
    const stands = to && standInOf(edge, to);
    if (stands) {
      const set = standIns.get(stands);
      if (set) set.add(edge.to);
      else standIns.set(stands, new Set([edge.to]));
    }
  }
  for (const list of into.values()) list.sort(byBack);

  return {
    graph,
    byId,
    children,
    into,
    standIns: new Map([...standIns].map(([k, ids]) => [k, [...ids].sort(compareStrings)])),
  };
}

/** The target and everything inside it. */
function insideOf(index: ImpactIndex, target: string): string[] {
  const out: string[] = [];
  for (const stack = [target]; stack.length > 0; ) {
    const id = stack.pop() as string;
    out.push(id);
    for (const child of index.children.get(id) ?? []) stack.push(child);
  }
  return out.sort(compareStrings);
}

const byDepth = (a: ImpactEntry, b: ImpactEntry) => a.depth - b.depth || compareStrings(a.id, b.id);

/** What depends on `target` (any node but the system's). Throws for an unknown ID. */
export function impactOf(index: ImpactIndex, target: string): Impact {
  if (target === SYSTEM_ID) throw new Error("impact: the system node holds everything");
  if (!index.byId.has(target)) throw new Error(`impact: unknown node ${target}`);
  const inside = insideOf(index, target);
  const seeds = new Set(inside);
  const depthOf = (entries: ReadonlyMap<string, ImpactEntry>, id: string) =>
    entries.get(id)?.depth ?? 0;

  // Reaching: one breadth-first pass per level, through edges at least that sure. A node
  // first found at a level is reached no more surely, and its parent's path is as sure.
  const reached = new Map<string, ImpactEntry>();
  for (const level of LEVELS) {
    const seen = new Set(seeds);
    for (let frontier = inside; frontier.length > 0; ) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const back of index.into.get(id) ?? []) {
          if (RANK[back.edge.confidence] > RANK[level] || seen.has(back.from)) continue;
          seen.add(back.from);
          next.push(back.from);
          if (!reached.has(back.from)) {
            reached.set(back.from, {
              id: back.from,
              depth: depthOf(reached, id) + 1,
              confidence: level,
              next: id,
              edge: back.edge.id,
            });
          }
        }
      }
      frontier = next.sort(compareStrings);
    }
  }

  // May also reach: from unresolved edges into what's reached, and from the unresolved nodes
  // that may stand for a kind of node reached, through any edge.
  const maybe = new Map<string, ImpactEntry>();
  const known = (id: string) => seeds.has(id) || reached.has(id) || maybe.has(id);
  const kinds = new Set<NodeKind>();
  const note = (id: string) => {
    const kind = index.byId.get(id)?.kind;
    if (kind) kinds.add(kind);
  };
  let frontier: string[] = [];
  for (const id of [...inside, ...[...reached.keys()].sort(compareStrings)]) {
    for (const back of index.into.get(id) ?? []) {
      if (back.edge.confidence !== "unresolved" || known(back.from)) continue;
      const depth = (reached.get(id)?.depth ?? 0) + 1;
      maybe.set(back.from, {
        id: back.from,
        depth,
        confidence: "unresolved",
        next: id,
        edge: back.edge.id,
      });
      frontier.push(back.from);
      note(back.from);
    }
  }
  const opened = new Set<StandIn>();
  const open = () => {
    for (const stands of STAND_INS) {
      if (opened.has(stands) || !kinds.has(KIND_OF[stands])) continue;
      opened.add(stands);
      for (const id of index.standIns.get(stands) ?? []) {
        if (known(id)) continue;
        maybe.set(id, { id, depth: 0, confidence: "unresolved", standsFor: stands });
        frontier.push(id);
      }
    }
  };
  for (const id of seeds) note(id);
  for (const id of reached.keys()) note(id);
  open();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier.sort(compareStrings)) {
      for (const back of index.into.get(id) ?? []) {
        if (known(back.from)) continue;
        maybe.set(back.from, {
          id: back.from,
          depth: depthOf(maybe, id) + 1,
          confidence: "unresolved",
          next: id,
          edge: back.edge.id,
        });
        next.push(back.from);
        note(back.from);
      }
    }
    frontier = next;
    // A kind found only now (a route behind a raw query) brings in its own stand-ins.
    if (frontier.length === 0) open();
  }

  return {
    target,
    inside,
    dependents: [...reached.values()].sort(byDepth),
    maybe: [...maybe.values()].sort(byDepth),
  };
}

const cachedSteps = new WeakMap<Impact, Map<string, ImpactEntry>>();

/**
 * The way from `id` to the target: its node IDs, from `id` to the node inside the target (or,
 * under `maybe`, to the unresolved node it may stand for). `[id]` for a node inside the target,
 * `[]` for one not in the impact.
 */
export function impactPath(impact: Impact, id: string): string[] {
  let steps = cachedSteps.get(impact);
  if (!steps) {
    steps = new Map([...impact.dependents, ...impact.maybe].map((e) => [e.id, e]));
    cachedSteps.set(impact, steps);
  }
  if (impact.inside.includes(id)) return [id];
  if (!steps.has(id)) return [];
  const path = [id];
  for (let step = steps.get(id); step?.next !== undefined; step = steps.get(step.next)) {
    path.push(step.next);
  }
  return path;
}

/** How many entries each service holds (a node outside every service holds itself), most first, then by ID. */
export function impactByService(
  index: ImpactIndex,
  entries: readonly ImpactEntry[],
): { holder: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { id } of entries) {
    let holder = id;
    for (let n = index.byId.get(id); n && n.parentId !== null; n = index.byId.get(n.parentId)) {
      if (n.kind === "service") {
        holder = n.id;
        break;
      }
    }
    counts.set(holder, (counts.get(holder) ?? 0) + 1);
  }
  return [...counts]
    .map(([holder, count]) => ({ holder, count }))
    .sort((a, b) => b.count - a.count || compareStrings(a.holder, b.holder));
}
