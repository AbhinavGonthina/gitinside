import {
  canonicalize,
  canonicalizeDiff,
  parseGraphDiff,
  summarizeDiff,
  type AnalysisWarning,
  type ArchitectureGraph,
  type GraphDiff,
} from "@gitinside/schema";
import { warningKey } from "./apply.js";
import { checkComparable } from "./compare.js";
import { changedFields, isEdgeModified, isNodeModified } from "./fingerprint.js";

/** The lists `classify` sorts one kind of record into; `renamed` is filled by M6.3. */
interface Classified<T> {
  added: T[];
  removed: string[];
  modified: { record: T; changes: string[] }[];
  updated: { record: T; changes: string[] }[];
}

/**
 * Match records by ID: base-only IDs are removed, head-only records added, and records
 * in both are unchanged (no field differs), `modified` (a fingerprint field differs), or
 * `updated` (only incidental fields differ).
 */
function classify<T extends { id: string }>(
  base: readonly T[],
  head: readonly T[],
  isModified: (base: T, head: T, changes: string[]) => boolean,
): Classified<T> {
  const heads = new Map(head.map((record) => [record.id, record]));
  const out: Classified<T> = { added: [], removed: [], modified: [], updated: [] };
  for (const before of base) {
    const after = heads.get(before.id);
    if (after === undefined) {
      out.removed.push(before.id);
      continue;
    }
    heads.delete(before.id);
    const changes = changedFields(before, after);
    if (changes.length === 0) continue;
    (isModified(before, after, changes) ? out.modified : out.updated).push({
      record: after,
      changes,
    });
  }
  out.added = [...heads.values()];
  return out;
}

/**
 * Warnings as multisets: each head occurrence cancels one equal base occurrence; base
 * leftovers are `removed`, head leftovers `added`.
 */
function diffWarnings(
  base: readonly AnalysisWarning[],
  head: readonly AnalysisWarning[],
): GraphDiff["warnings"] {
  const unmatched = new Map<string, number>();
  for (const warning of head) {
    const key = warningKey(warning);
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
  }
  const removed: AnalysisWarning[] = [];
  for (const warning of base) {
    const key = warningKey(warning);
    const left = unmatched.get(key) ?? 0;
    if (left > 0) unmatched.set(key, left - 1);
    else removed.push(warning);
  }
  const added: AnalysisWarning[] = [];
  for (const warning of head) {
    const key = warningKey(warning);
    const left = unmatched.get(key) ?? 0;
    if (left > 0) {
      added.push(warning);
      unmatched.set(key, left - 1);
    }
  }
  return { added, removed };
}

/**
 * What changed from `base` to `head` (DESIGN.md §8): nodes and edges matched by ID and
 * classified with per-kind fingerprints (`NODE_FINGERPRINTS`, `EDGE_FINGERPRINT`), and
 * warnings as a multiset. The result is canonical (`canonicalizeDiff`), validated by
 * `parseGraphDiff`, and `applyDiff(base, result)` equals `head`.
 *
 * Handles: added, removed, modified, and updated nodes and edges. Doesn't yet handle:
 * renames and moves (M6.3; a moved file is removed + added) and broken edges (M6.4),
 * so `renamed` and `broken` are empty.
 *
 * Throws `IncompatibleGraphsError` for graphs from two analyzer versions.
 */
export function diffGraphs(base: ArchitectureGraph, head: ArchitectureGraph): GraphDiff {
  checkComparable(base, head);
  const before = canonicalize(base);
  const after = canonicalize(head);

  const nodes = classify(before.nodes, after.nodes, isNodeModified);
  const edges = classify(before.edges, after.edges, (_b, _h, changes) => isEdgeModified(changes));

  const lists = {
    nodes: {
      added: nodes.added,
      removed: nodes.removed,
      modified: nodes.modified.map(({ record, changes }) => ({ node: record, changes })),
      updated: nodes.updated.map(({ record, changes }) => ({ node: record, changes })),
      renamed: [],
    },
    edges: {
      added: edges.added,
      removed: edges.removed,
      modified: edges.modified.map(({ record, changes }) => ({ edge: record, changes })),
      updated: edges.updated.map(({ record, changes }) => ({ edge: record, changes })),
      renamed: [],
    },
    broken: [],
  };
  return parseGraphDiff(
    canonicalizeDiff({
      schemaVersion: after.schemaVersion,
      analyzerVersion: after.analyzerVersion,
      base: { repo: before.repo },
      head: { repo: after.repo },
      ...lists,
      warnings: diffWarnings(before.warnings, after.warnings),
      summary: summarizeDiff(lists),
    }),
  );
}
