import { compareStrings, EdgeKind, SYSTEM_ID } from "@gitinside/schema";
import type { ArchitectureGraph, Confidence, GraphEdge, GraphNode } from "@gitinside/schema";

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
 * **Which way, and how sure.** Each dependent gets one path to the target, a strongest one:
 * its weakest edge is as sure as any path from that node allows (`exact` over `pattern` over
 * `heuristic`), and that edge is the entry's `confidence`. Within each level the search goes
 * nearest first, so the path is short, though not always the shortest of the equally sure:
 * it carries on along the path of the node it was found from, which may have been found
 * earlier, more surely, and further out. `depth` is the path's length.
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
 *
 * **How it's fast** (the interactive budget, `bench:impact`): nodes are numbered in ID order,
 * and each node's incoming edges sit in flat arrays sorted by confidence, then by the
 * depending node's number. A query fills a few typed arrays and reads each edge at most once,
 * and that order (never the graph's) decides every tie, which is what makes it deterministic.
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

/** A graph prepared for impact queries: build once with {@link impactIndex}, ask many times. */
export interface ImpactIndex {
  readonly graph: ArchitectureGraph;
  /** Node IDs in ID order; a node's number is its place here. */
  readonly ids: readonly string[];
  /** @internal The nodes by number. */
  readonly nodes: readonly GraphNode[];
  /** @internal Each node's number. */
  readonly number: ReadonlyMap<string, number>;
  /** @internal Each node's parent's number, -1 for the system node. */
  readonly parent: Int32Array;
  /** @internal Children of node `i`: `children[childStart[i] .. childStart[i + 1])`, in number order. */
  readonly childStart: Int32Array;
  readonly children: Int32Array;
  /**
   * @internal Edges into node `i`: `[inStart[i] .. inStart[i + 1])` of `inFrom` (the node that
   * depends on `i`), `inEdge` (the edge), and `inRank` (its confidence, 0 = exact … 3 =
   * unresolved), sorted by rank, then `inFrom`, then the edge's kind.
   */
  readonly inStart: Int32Array;
  readonly inFrom: Int32Array;
  readonly inEdge: Int32Array;
  readonly inRank: Uint8Array;
  /** @internal Unresolved nodes that may stand for a node of each kind, in number order. */
  readonly standIns: ReadonlyMap<StandIn, Int32Array>;
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

const CONFIDENCE: readonly Confidence[] = ["exact", "pattern", "heuristic", "unresolved"];
const RANK: Readonly<Record<Confidence, number>> = {
  exact: 0,
  pattern: 1,
  heuristic: 2,
  unresolved: 3,
};
const UNRESOLVED = 3;
/** Edge kinds by number, for ties between two edges joining the same pair of nodes. */
const KIND_NUMBER = new Map(EdgeKind.options.map((k, i) => [k, i]));
const STAND_INS: readonly StandIn[] = ["route", "model", "queue"];

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

/**
 * A counting sort of `m` items by `key` (each in `0 .. n - 1`): where each key's items start
 * (`n + 1` offsets), and the items in key order, each key's in item order.
 */
function bucketed(n: number, m: number, key: Int32Array): { start: Int32Array; items: Int32Array } {
  const start = new Int32Array(n + 1);
  for (let j = 0; j < m; j++) {
    const k = (key[j] as number) + 1;
    start[k] = (start[k] as number) + 1;
  }
  for (let i = 0; i < n; i++) start[i + 1] = (start[i + 1] as number) + (start[i] as number);
  const fill = start.slice(0, n);
  const items = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    const k = key[j] as number;
    const at = fill[k] as number;
    items[at] = j;
    fill[k] = at + 1;
  }
  return { start, items };
}

/** Index a graph for {@link impactOf}: O(nodes · log nodes + edges · log edges). */
export function impactIndex(graph: ArchitectureGraph): ImpactIndex {
  const nodes = [...graph.nodes].sort((a, b) => compareStrings(a.id, b.id));
  const n = nodes.length;
  const ids = nodes.map((node) => node.id);
  const number = new Map(ids.map((id, i) => [id, i]));
  const at = (id: string) => number.get(id) as number;

  const parent = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = nodes[i]?.parentId;
    if (p !== null && p !== undefined) parent[i] = at(p);
  }
  // The system node, with no parent, goes in a last bucket past every node's.
  const byParent = bucketed(
    n + 1,
    n,
    parent.map((p) => (p < 0 ? n : p)),
  );
  const childStart = byParent.start;
  const children = byParent.items;

  // Edges into each node, from the node that depends on it (a `consumes` edge twice).
  const edges = graph.edges;
  let m = 0;
  for (const edge of edges) m += FORWARD.has(edge.kind) ? 1 : edge.kind === "consumes" ? 2 : 0;
  const eTo = new Int32Array(m);
  const eFrom = new Int32Array(m);
  const eEdge = new Int32Array(m);
  const eRank = new Uint8Array(m);
  const eKind = new Uint8Array(m);
  const standSets = new Map<StandIn, Set<number>>();
  let j = 0;
  const push = (to: number, from: number, e: number, rank: number, kind: number) => {
    eTo[j] = to;
    eFrom[j] = from;
    eEdge[j] = e;
    eRank[j] = rank;
    eKind[j] = kind;
    j++;
  };
  edges.forEach((edge, e) => {
    const from = at(edge.from);
    const to = at(edge.to);
    const rank = RANK[edge.confidence];
    const kind = (KIND_NUMBER.get(edge.kind) as number) * 2;
    if (FORWARD.has(edge.kind)) push(to, from, e, rank, kind);
    else if (edge.kind === "consumes") {
      push(to, from, e, rank, kind);
      push(from, to, e, rank, kind + 1);
    }
    const stands = standInOf(edge, nodes[to] as GraphNode);
    if (stands) {
      const set = standSets.get(stands);
      if (set) set.add(to);
      else standSets.set(stands, new Set([to]));
    }
  });
  const { start: inStart, items } = bucketed(n, m, eTo);
  const order = (a: number, b: number) =>
    (eRank[a] as number) - (eRank[b] as number) ||
    (eFrom[a] as number) - (eFrom[b] as number) ||
    (eKind[a] as number) - (eKind[b] as number);
  for (let i = 0; i < n; i++) items.subarray(inStart[i], inStart[i + 1]).sort(order);
  const inFrom = items.map((x) => eFrom[x] as number);
  const inEdge = items.map((x) => eEdge[x] as number);
  const inRank = Uint8Array.from(items, (x) => eRank[x] as number);

  const standIns = new Map(
    [...standSets].map(([k, set]) => [k, Int32Array.from(set).sort()] as const),
  );
  return {
    graph,
    ids,
    nodes,
    number,
    parent,
    childStart,
    children,
    inStart,
    inFrom,
    inEdge,
    inRank,
    standIns,
  };
}

/** Where a node stands in a query. */
const UNSEEN = -1;
const SEED = 4;
const MAYBE = 3;

/** What depends on `target` (any node but the system's). Throws for an unknown ID. */
export function impactOf(index: ImpactIndex, target: string): Impact {
  if (target === SYSTEM_ID) throw new Error("impact: the system node holds everything");
  const t = index.number.get(target);
  if (t === undefined) throw new Error(`impact: unknown node ${target}`);
  const { inStart, inFrom, inEdge, inRank } = index;
  const n = index.ids.length;
  /** -1 unseen, 0–2 reached at that confidence, 3 maybe, 4 inside the target. */
  const state = new Int8Array(n).fill(UNSEEN);
  const depth = new Int32Array(n);
  const next = new Int32Array(n).fill(-1);
  const via = new Int32Array(n).fill(-1);

  // The target and everything inside it, in number order.
  const inside: number[] = [];
  for (const stack = [t]; stack.length > 0; ) {
    const i = stack.pop() as number;
    inside.push(i);
    state[i] = SEED;
    for (let c = index.childStart[i] as number; c < (index.childStart[i + 1] as number); c++) {
      stack.push(index.children[c] as number);
    }
  }
  inside.sort((a, b) => a - b);

  // Reaching: one pass per level, nearest first. A node scans, at its own level, its edges
  // that sure or surer; at each later level, only the edges of that level.
  const reached: number[] = [];
  for (let level = 0; level < UNRESOLVED; level++) {
    const buckets: number[][] = [];
    const put = (i: number) => (buckets[depth[i] as number] ??= []).push(i);
    for (const i of inside) put(i);
    for (const i of reached) put(i);
    for (let d = 0; d < buckets.length; d++) {
      const bucket = buckets[d] ?? [];
      for (let b = 0; b < bucket.length; b++) {
        const u = bucket[b] as number;
        const own = state[u] === level;
        for (let k = inStart[u] as number; k < (inStart[u + 1] as number); k++) {
          const rank = inRank[k] as number;
          if (rank > level) break;
          if (rank < level && !own) continue;
          const w = inFrom[k] as number;
          if (state[w] !== UNSEEN) continue;
          state[w] = level;
          depth[w] = d + 1;
          next[w] = u;
          via[w] = inEdge[k] as number;
          reached.push(w);
          put(w);
        }
      }
    }
  }

  // May also reach: from unresolved edges into what's reached, and from the unresolved nodes
  // that may stand for a kind of node reached, through any edge.
  const maybe: number[] = [];
  const stands = new Map<number, StandIn>();
  const kinds = new Set<string>();
  const note = (i: number) => kinds.add((index.nodes[i] as GraphNode).kind);
  const mark = (w: number, d: number, toward: number, edge: number) => {
    state[w] = MAYBE;
    depth[w] = d;
    next[w] = toward;
    via[w] = edge;
    maybe.push(w);
    note(w);
  };
  for (const u of [...inside, ...reached]) {
    note(u);
    // Sorted by rank, so the unresolved edges come last.
    for (let k = (inStart[u + 1] as number) - 1; k >= (inStart[u] as number); k--) {
      if ((inRank[k] as number) !== UNRESOLVED) break;
      const w = inFrom[k] as number;
      if (state[w] === UNSEEN) {
        mark(w, (depth[u] as number) + 1, u, inEdge[k] as number);
      }
    }
  }
  const opened = new Set<StandIn>();
  const open = () => {
    for (const s of STAND_INS) {
      if (opened.has(s) || !kinds.has(s)) continue;
      opened.add(s);
      for (const i of index.standIns.get(s) ?? []) {
        if (state[i] !== UNSEEN) continue;
        mark(i, 0, -1, -1);
        stands.set(i, s);
      }
    }
  };
  open();
  for (let q = 0; q < maybe.length; q++) {
    const u = maybe[q] as number;
    for (let k = inStart[u] as number; k < (inStart[u + 1] as number); k++) {
      const w = inFrom[k] as number;
      if (state[w] === UNSEEN) mark(w, (depth[u] as number) + 1, u, inEdge[k] as number);
    }
    // A kind found only now (a route behind a raw query) brings in its own stand-ins.
    if (q === maybe.length - 1) open();
  }

  const entry = (i: number): ImpactEntry => {
    const e: ImpactEntry = {
      id: index.ids[i] as string,
      depth: depth[i] as number,
      confidence: CONFIDENCE[state[i] as number] as Confidence,
    };
    const toward = next[i] as number;
    if (toward >= 0) {
      e.next = index.ids[toward] as string;
      e.edge = (index.graph.edges[via[i] as number] as GraphEdge).id;
    }
    const s = stands.get(i);
    if (s) e.standsFor = s;
    return e;
  };
  const byDepth = (a: number, b: number) => (depth[a] as number) - (depth[b] as number) || a - b;
  return {
    target,
    inside: inside.map((i) => index.ids[i] as string),
    dependents: reached.sort(byDepth).map(entry),
    maybe: maybe.sort(byDepth).map(entry),
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
    for (let i = index.number.get(id) ?? -1; i >= 0; i = index.parent[i] as number) {
      const node = index.nodes[i] as GraphNode;
      if (node.kind === "service") {
        holder = node.id;
        break;
      }
    }
    counts.set(holder, (counts.get(holder) ?? 0) + 1);
  }
  return [...counts]
    .map(([holder, count]) => ({ holder, count }))
    .sort((a, b) => b.count - a.count || compareStrings(a.holder, b.holder));
}
