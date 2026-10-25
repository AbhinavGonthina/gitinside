import type { ArchitectureGraph, SourceLocation } from "./schema.js";

/** Locale-independent string ordering. `localeCompare` is avoided because its result varies by machine. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareLocations(a: SourceLocation, b: SourceLocation): number {
  return compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;
}

/**
 * Return a copy of the graph with every collection in a fixed order:
 * nodes and edges by ID, edge sites by location, warnings by code, file, then message.
 * Model fields keep declaration order, which is already deterministic and meaningful.
 */
export function canonicalize(graph: ArchitectureGraph): ArchitectureGraph {
  return {
    ...graph,
    nodes: [...graph.nodes].sort((a, b) => compareStrings(a.id, b.id)),
    edges: [...graph.edges]
      .map((edge) => ({ ...edge, sites: [...edge.sites].sort(compareLocations) }))
      .sort((a, b) => compareStrings(a.id, b.id)),
    warnings: [...graph.warnings].sort(
      (a, b) =>
        compareStrings(a.code, b.code) ||
        compareStrings(a.file ?? "", b.file ?? "") ||
        compareStrings(a.message, b.message),
    ),
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
