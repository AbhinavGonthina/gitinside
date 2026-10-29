import {
  canonicalize,
  parseGraph,
  type AnalysisWarning,
  type ArchitectureGraph,
  type GraphDiff,
  type GraphEdge,
  type GraphNode,
  type GraphRepo,
} from "@gitinside/schema";
import { describeRepo } from "./compare.js";

/** Thrown when a diff doesn't fit the graph it's applied to. */
export class DiffApplyError extends Error {
  override readonly name = "DiffApplyError";
}

/**
 * Remove base-only IDs, then insert or replace head records. Every step checks that the
 * diff agrees with the map: a removed or changed ID must be there, an added ID must not.
 */
function applyLists<T extends { id: string }>(
  what: "node" | "edge",
  base: readonly T[],
  lists: {
    added: readonly T[];
    removed: readonly string[];
    changed: readonly T[];
    renamed: readonly { from: string; record: T }[];
  },
): T[] {
  const items = new Map(base.map((item) => [item.id, item]));
  const remove = (id: string, as: string): void => {
    if (!items.delete(id)) throw new DiffApplyError(`${as} ${what} ${id} isn't in the base graph`);
  };
  const insert = (item: T, as: string): void => {
    if (items.has(item.id)) {
      throw new DiffApplyError(`${as} ${what} ${item.id} is already in the base graph`);
    }
    items.set(item.id, item);
  };

  for (const id of lists.removed) remove(id, "removed");
  for (const { from } of lists.renamed) remove(from, "renamed");
  for (const item of lists.changed) {
    if (!items.has(item.id)) {
      throw new DiffApplyError(`changed ${what} ${item.id} isn't in the base graph`);
    }
    items.set(item.id, item);
  }
  for (const item of lists.added) insert(item, "added");
  for (const { record } of lists.renamed) insert(record, "renamed");
  return [...items.values()];
}

/** Identity of a warning in the multiset: its code, file, and message. */
export const warningKey = (w: AnalysisWarning): string =>
  JSON.stringify([w.code, w.file ?? "", w.message]);

/** Base warnings minus `removed` (one occurrence each) plus `added`. */
function applyWarnings(base: readonly AnalysisWarning[], diff: GraphDiff): AnalysisWarning[] {
  const remaining = [...base];
  for (const warning of diff.warnings.removed) {
    const key = warningKey(warning);
    const index = remaining.findIndex((w) => warningKey(w) === key);
    if (index < 0) {
      throw new DiffApplyError(`removed warning ${warning.code} isn't in the base graph`);
    }
    remaining.splice(index, 1);
  }
  return [...remaining, ...diff.warnings.added];
}

const sameRepo = (a: GraphRepo, b: GraphRepo): boolean =>
  a.owner === b.owner && a.name === b.name && a.sha === b.sha;

/**
 * Rebuild the head graph from the base graph and their diff, validated and in canonical
 * order. `applyDiff(base, diffGraphs(base, head))` equals `head` (DESIGN.md §8, checked
 * by M6.5's property tests); this is what makes a stored diff complete on its own.
 *
 * Throws `DiffApplyError` when the diff was made from another base (repo, commit, or
 * analyzer version) or names items the base doesn't have, and a ZodError when the
 * result isn't a valid graph.
 */
export function applyDiff(base: ArchitectureGraph, diff: GraphDiff): ArchitectureGraph {
  if (!sameRepo(base.repo, diff.base.repo) || base.analyzerVersion !== diff.analyzerVersion) {
    throw new DiffApplyError(
      `the diff's base is ${describeRepo(diff.base.repo)} (analyzer ${diff.analyzerVersion}), ` +
        `not ${describeRepo(base.repo)} (analyzer ${base.analyzerVersion})`,
    );
  }

  const nodes = applyLists<GraphNode>("node", base.nodes, {
    added: diff.nodes.added,
    removed: diff.nodes.removed,
    changed: [...diff.nodes.modified, ...diff.nodes.updated].map((c) => c.node),
    renamed: diff.nodes.renamed.map((r) => ({ from: r.from, record: r.node })),
  });
  const edges = applyLists<GraphEdge>("edge", base.edges, {
    added: diff.edges.added,
    removed: diff.edges.removed,
    changed: [...diff.edges.modified, ...diff.edges.updated].map((c) => c.edge),
    renamed: diff.edges.renamed.map((r) => ({ from: r.from, record: r.edge })),
  });

  return parseGraph(
    canonicalize({
      schemaVersion: base.schemaVersion,
      repo: diff.head.repo,
      analyzerVersion: diff.analyzerVersion,
      nodes,
      edges,
      warnings: applyWarnings(base.warnings, diff),
    }),
  );
}
