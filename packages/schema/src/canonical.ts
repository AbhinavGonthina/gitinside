import type { GraphDiff } from "./diff.js";
import type { AnalysisWarning, ArchitectureGraph, GraphEdge, SourceLocation } from "./schema.js";

/** Locale-independent string ordering. `localeCompare` is avoided because its result varies by machine. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareLocations(a: SourceLocation, b: SourceLocation): number {
  return compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;
}

function compareWarnings(a: AnalysisWarning, b: AnalysisWarning): number {
  return (
    compareStrings(a.code, b.code) ||
    compareStrings(a.file ?? "", b.file ?? "") ||
    compareStrings(a.message, b.message)
  );
}

const byId = (a: { id: string }, b: { id: string }): number => compareStrings(a.id, b.id);

function canonicalEdge(edge: GraphEdge): GraphEdge {
  return { ...edge, sites: [...edge.sites].sort(compareLocations) };
}

/**
 * Return a copy of the graph with every collection in a fixed order:
 * nodes and edges by ID, edge sites by location, warnings by code, file, then message.
 * Model fields keep declaration order, which is already deterministic and meaningful.
 */
export function canonicalize(graph: ArchitectureGraph): ArchitectureGraph {
  return {
    ...graph,
    nodes: [...graph.nodes].sort(byId),
    edges: graph.edges.map(canonicalEdge).sort(byId),
    warnings: [...graph.warnings].sort(compareWarnings),
  };
}

/**
 * Return a copy of the diff with every collection in a fixed order: entries by their
 * head ID (removed IDs as strings), `changes` by name, broken edges by edge ID then
 * reason, and edge records and broken edges with their sites sorted as in graphs.
 */
export function canonicalizeDiff(diff: GraphDiff): GraphDiff {
  const ids = (list: string[]) => [...list].sort(compareStrings);
  const changes = <T extends { changes: string[] }>(entry: T): T => ({
    ...entry,
    changes: ids(entry.changes),
  });
  const byNode = (a: { node: { id: string } }, b: { node: { id: string } }) => byId(a.node, b.node);
  const byEdge = (a: { edge: { id: string } }, b: { edge: { id: string } }) => byId(a.edge, b.edge);
  const edgeEntry = <T extends { edge: GraphEdge; changes: string[] }>(entry: T): T =>
    changes({ ...entry, edge: canonicalEdge(entry.edge) });
  return {
    ...diff,
    nodes: {
      added: [...diff.nodes.added].sort(byId),
      removed: ids(diff.nodes.removed),
      modified: diff.nodes.modified.map(changes).sort(byNode),
      updated: diff.nodes.updated.map(changes).sort(byNode),
      renamed: diff.nodes.renamed.map(changes).sort(byNode),
    },
    edges: {
      added: diff.edges.added.map(canonicalEdge).sort(byId),
      removed: ids(diff.edges.removed),
      modified: diff.edges.modified.map(edgeEntry).sort(byEdge),
      updated: diff.edges.updated.map(edgeEntry).sort(byEdge),
      renamed: diff.edges.renamed.map(edgeEntry).sort(byEdge),
    },
    broken: diff.broken
      .map((b) => ({ ...b, sites: [...b.sites].sort(compareLocations) }))
      .sort((a, b) => compareStrings(a.edge, b.edge) || compareStrings(a.reason, b.reason)),
    warnings: {
      added: [...diff.warnings.added].sort(compareWarnings),
      removed: [...diff.warnings.removed].sort(compareWarnings),
    },
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a graph byte-for-byte deterministically: canonical collection order,
 * sorted object keys, 2-space indent, trailing newline. Used for snapshots and golden files.
 */
export function stringifyGraph(graph: ArchitectureGraph): string {
  return `${JSON.stringify(sortKeys(canonicalize(graph)), null, 2)}\n`;
}

/** Serialize a diff the way `stringifyGraph` serializes a graph. The only way diffs are written. */
export function stringifyDiff(diff: GraphDiff): string {
  return `${JSON.stringify(sortKeys(canonicalizeDiff(diff)), null, 2)}\n`;
}
