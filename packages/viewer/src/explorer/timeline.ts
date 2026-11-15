import { diffGraphs } from "@gitinside/diff";
import {
  compareStrings,
  type ArchitectureGraph,
  type GraphDiff,
  type GraphNode,
} from "@gitinside/schema";
import { breakableRoute, withoutRoute } from "./tourBreak.js";

/**
 * The timeline's canned history (M10.3f4, M10-design §3.4), standing in for M11.4's series of
 * stored analyses until that engine is built: a few made-up commits that end at the repo's own
 * graph, each the one before it plus a small change, so the drawer's slider has something real to
 * diff. Every commit is the analyzed graph with parts taken out, never anything added, and the
 * drawer calls them an example.
 *
 * Going back from the analyzed commit, each earlier commit lacks a few more pages and routes: ones
 * nothing calls or points at (no edge into them) and with nothing inside them, so taking them out
 * leaves every other node and line as the analyzer drew it. They go a file at a time, at most
 * {@link HISTORY_CHUNK} per commit, files in ID order. Near the end, when a route another service
 * calls exists (`breakableRoute`, the tour's pick), one commit removes it, its callers left
 * unmatched as the analyzer draws them, and the next brings it back: the one broken connection in
 * the history. Each step's diff is `packages/diff`'s own, worked out when the slider first lands
 * there.
 *
 * Not shown: commits not analyzed yet and "Analyze N more" (M11.4 and I2.2's quota guard), real
 * dates and messages (the graph holds neither), and changes other than pages and routes coming and
 * going (services, models, and lines between them stay as they are).
 */

/** At most this many commits, the analyzed one last. */
export const HISTORY_COMMITS = 12;

/** At most this many pages and routes come in one commit. */
export const HISTORY_CHUNK = 3;

/** A commit's size, for the drawer's sparklines. */
export interface HistoryCounts {
  /** Pages and routes. */
  entries: number;
  /** Lines of every kind but imports. */
  connections: number;
  /** Requests that match no route (`NO_MATCHING_ROUTE`). */
  broken: number;
}

/** One commit of the canned history. */
export interface HistoryCommit {
  /** `example 3`, or the analyzed commit's short SHA (the last; "this commit" without one). */
  name: string;
  /** What the commit changed, as a commit message would say. */
  message: string;
  graph: ArchitectureGraph;
  counts: HistoryCounts;
}

/** The canned history, oldest commit first. */
export interface History {
  commits: readonly HistoryCommit[];
  /**
   * The diff of commit `at` against the one before it (the first against itself: no changes),
   * worked out once per commit.
   */
  diffAt(at: number): GraphDiff;
}

type Change =
  | { kind: "add"; nodes: readonly GraphNode[]; file: string }
  | { kind: "break"; route: GraphNode }
  | { kind: "fix"; route: GraphNode };

/** The nearest file holding a node, or none. */
function fileOf(byId: ReadonlyMap<string, GraphNode>, id: string): GraphNode | undefined {
  for (let node = byId.get(id); node !== undefined; ) {
    if (node.kind === "file") return node;
    node = node.parentId === null ? undefined : byId.get(node.parentId);
  }
  return undefined;
}

/** A graph's counts for the sparklines. */
export function historyCounts(graph: ArchitectureGraph): HistoryCounts {
  return {
    entries: graph.nodes.filter((n) => n.kind === "page" || n.kind === "route").length,
    connections: graph.edges.filter((e) => e.kind !== "imports").length,
    broken: graph.edges.filter((e) => e.kind === "http" && e.reason === "NO_MATCHING_ROUTE").length,
  };
}

/** The pages and routes an earlier commit can lack, by file (files and nodes in ID order). */
function removableByFile(
  graph: ArchitectureGraph,
  byId: ReadonlyMap<string, GraphNode>,
): GraphNode[][] {
  const pointedAt = new Set(graph.edges.map((e) => e.to));
  const parents = new Set(graph.nodes.flatMap((n) => (n.parentId === null ? [] : [n.parentId])));
  const files = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "page" && node.kind !== "route") continue;
    if (pointedAt.has(node.id) || parents.has(node.id)) continue;
    const file = fileOf(byId, node.id);
    if (!file) continue;
    files.set(file.id, [...(files.get(file.id) ?? []), node]);
  }
  return [...files.keys()]
    .sort(compareStrings)
    .map((id) => (files.get(id) ?? []).sort((a, b) => compareStrings(a.id, b.id)));
}

/** `graph` without `ids` and the lines touching them. */
function without(graph: ArchitectureGraph, ids: ReadonlySet<string>): ArchitectureGraph {
  if (ids.size === 0) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !ids.has(n.id)),
    edges: graph.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)),
  };
}

/** A file's name, for a commit message. */
function fileName(byId: ReadonlyMap<string, GraphNode>, id: string): string {
  const file = byId.get(id);
  const path = file?.kind === "file" ? file.path : id;
  return path.slice(path.lastIndexOf("/") + 1);
}

/** What a change says, as a commit message would. */
function messageOf(change: Change, byId: ReadonlyMap<string, GraphNode>): string {
  if (change.kind === "break") return `Remove ${change.route.label}`;
  if (change.kind === "fix") return `Bring back ${change.route.label}`;
  const [only] = change.nodes;
  if (change.nodes.length === 1 && only) {
    return only.kind === "page" ? `Add the ${only.label} page` : `Add ${only.label}`;
  }
  const kinds = new Set(change.nodes.map((n) => n.kind));
  const what = kinds.size > 1 ? "pages and routes" : kinds.has("page") ? "pages" : "routes";
  return `Add ${change.nodes.length} ${what} in ${fileName(byId, change.file)}`;
}

/**
 * The canned history of `graph` (see the module comment), or none when it has no page or route
 * to take out and no call to break: a history of one commit has nothing to show.
 */
export function cannedHistory(graph: ArchitectureGraph): History | undefined {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const broken = breakableRoute(graph);
  const room = HISTORY_COMMITS - 1 - (broken ? 2 : 0);
  const adds: Change[] = removableByFile(graph, byId)
    .flatMap((nodes) => {
      const chunks: GraphNode[][] = [];
      for (let i = 0; i < nodes.length; i += HISTORY_CHUNK) {
        chunks.push(nodes.slice(i, i + HISTORY_CHUNK));
      }
      return chunks;
    })
    .slice(0, room)
    .flatMap((nodes) => {
      const file = nodes[0] && fileOf(byId, nodes[0].id);
      return file ? [{ kind: "add" as const, nodes, file: file.id }] : [];
    });
  // The break and its fix come just before the last commit, so the latest stays the repo itself.
  const changes: Change[] = broken
    ? [
        ...adds.slice(0, Math.max(0, adds.length - 1)),
        { kind: "break", route: broken },
        { kind: "fix", route: broken },
        ...adds.slice(Math.max(0, adds.length - 1)),
      ]
    : adds;
  if (changes.length === 0) return undefined;

  // Commit k has the first `added` changes' pages and routes, and lacks the route while broken.
  const commits: HistoryCommit[] = [];
  const missing = new Set(adds.flatMap((c) => (c.kind === "add" ? c.nodes.map((n) => n.id) : [])));
  let isBroken = false;
  const push = (message: string, last: boolean) => {
    let shot = without(graph, missing);
    if (isBroken && broken) shot = withoutRoute(shot, byId, broken);
    const sha = graph.repo.sha;
    commits.push({
      name: last ? (sha ? sha.slice(0, 7) : "this commit") : `example ${commits.length + 1}`,
      message,
      graph: last ? graph : shot,
      counts: historyCounts(last ? graph : shot),
    });
  };
  push("The oldest example commit", false);
  changes.forEach((change, i) => {
    if (change.kind === "add") for (const n of change.nodes) missing.delete(n.id);
    else isBroken = change.kind === "break";
    push(messageOf(change, byId), i === changes.length - 1);
  });

  const diffs = new Map<number, GraphDiff>();
  return {
    commits,
    diffAt(at) {
      const k = Math.max(0, Math.min(at, commits.length - 1));
      const cached = diffs.get(k);
      if (cached) return cached;
      const head = commits[k];
      const base = commits[Math.max(0, k - 1)];
      if (!head || !base) throw new Error(`no commit ${k} in the history`);
      const made = diffGraphs(base.graph, head.graph);
      diffs.set(k, made);
      return made;
    },
  };
}
