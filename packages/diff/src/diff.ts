import {
  canonicalize,
  canonicalizeDiff,
  edgeId,
  parseGraphDiff,
  summarizeDiff,
  type AnalysisWarning,
  type ArchitectureGraph,
  type GraphDiff,
  type GraphEdge,
} from "@gitinside/schema";
import { warningKey } from "./apply.js";
import { detectBroken } from "./broken.js";
import { checkComparable } from "./compare.js";
import { changedFields, isEdgeModified, isNodeModified } from "./fingerprint.js";
import { detectRenames, type FileContents } from "./rename.js";

/** Options for {@link diffGraphs}. */
export interface DiffOptions {
  /**
   * The two commits' file contents. Without them, a moved file is found only when its
   * content is unchanged, and a symbol only by following its file (ADR-0086).
   */
  contents?: FileContents;
}

/** The lists `classify` sorts one kind of record into. */
interface Classified<T> {
  added: T[];
  removed: T[];
  modified: { record: T; changes: string[] }[];
  updated: { record: T; changes: string[] }[];
  renamed: { from: string; record: T; changes: string[] }[];
}

/**
 * Match records by ID: base-only records are removed, head-only records added, unless
 * `renames` pairs them (base ID ⇒ head ID), and records in both are unchanged (no field
 * differs), `modified` (a fingerprint field differs), or `updated` (only incidental
 * fields differ).
 */
function classify<T extends { id: string }>(
  base: readonly T[],
  head: readonly T[],
  isModified: (base: T, head: T, changes: string[]) => boolean,
  renames: ReadonlyMap<string, string> = new Map(),
): Classified<T> {
  const heads = new Map(head.map((record) => [record.id, record]));
  const out: Classified<T> = { added: [], removed: [], modified: [], updated: [], renamed: [] };
  const baseOnly: T[] = [];
  for (const before of base) {
    const after = heads.get(before.id);
    if (after === undefined) {
      baseOnly.push(before);
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
  for (const before of baseOnly) {
    const to = renames.get(before.id);
    const after = to === undefined ? undefined : heads.get(to);
    if (after === undefined) {
      out.removed.push(before);
      continue;
    }
    heads.delete(after.id);
    out.renamed.push({ from: before.id, record: after, changes: changedFields(before, after) });
  }
  out.added = [...heads.values()];
  return out;
}

/** IDs in `base` but not `head`, and in `head` but not `base`. */
function onlyIn(base: readonly { id: string }[], head: readonly { id: string }[]) {
  const baseIds = new Set(base.map((r) => r.id));
  const headIds = new Set(head.map((r) => r.id));
  return {
    removed: new Set([...baseIds].filter((id) => !headIds.has(id))),
    added: new Set([...headIds].filter((id) => !baseIds.has(id))),
  };
}

/**
 * Base edge ⇒ head edge for edges whose endpoints were renamed: the base edge's ID with
 * both endpoints mapped, when head has that edge and base doesn't.
 */
function edgeRenames(
  base: readonly GraphEdge[],
  added: ReadonlySet<string>,
  nodes: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const edge of base) {
    const from = nodes.get(edge.from) ?? edge.from;
    const to = nodes.get(edge.to) ?? edge.to;
    if (from === edge.from && to === edge.to) continue;
    const id = edgeId(edge.kind, from, to);
    if (added.has(id)) out.set(edge.id, id);
  }
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
 * What changed from `base` to `head` (DESIGN.md §8): renames and moves found among
 * base-only and head-only nodes (`detectRenames`, thresholds in `RENAME_THRESHOLDS`),
 * edges renamed with their endpoints, everything else matched by ID and classified with
 * per-kind fingerprints (`NODE_FINGERPRINTS`, `EDGE_FINGERPRINT`), and warnings as a
 * multiset. The result is canonical (`canonicalizeDiff`), validated by `parseGraphDiff`,
 * and `applyDiff(base, result)` equals `head`.
 *
 * Handles: added, removed, modified, updated, and renamed nodes and edges, and broken
 * connections whose target is gone (`detectBroken`; see there for what it doesn't catch).
 *
 * Throws `IncompatibleGraphsError` for graphs from two analyzer versions.
 */
export function diffGraphs(
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  options: DiffOptions = {},
): GraphDiff {
  checkComparable(base, head);
  const before = canonicalize(base);
  const after = canonicalize(head);

  const nodeIds = onlyIn(before.nodes, after.nodes);
  const renames = detectRenames(before, after, nodeIds.removed, nodeIds.added, options.contents);
  const nodes = classify(
    before.nodes,
    after.nodes,
    (b, h, changes) => isNodeModified(b, h, changes, renames),
    renames,
  );
  const edges = classify(
    before.edges,
    after.edges,
    (_b, _h, changes) => isEdgeModified(changes),
    edgeRenames(before.edges, onlyIn(before.edges, after.edges).added, renames),
  );

  const lists = {
    nodes: {
      added: nodes.added,
      removed: nodes.removed.map((n) => n.id),
      modified: nodes.modified.map(({ record, changes }) => ({ node: record, changes })),
      updated: nodes.updated.map(({ record, changes }) => ({ node: record, changes })),
      renamed: nodes.renamed.map(({ from, record, changes }) => ({ from, node: record, changes })),
    },
    edges: {
      added: edges.added,
      removed: edges.removed.map((e) => e.id),
      modified: edges.modified.map(({ record, changes }) => ({ edge: record, changes })),
      updated: edges.updated.map(({ record, changes }) => ({ edge: record, changes })),
      renamed: edges.renamed.map(({ from, record, changes }) => ({ from, edge: record, changes })),
    },
    broken: detectBroken(before, after, renames),
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
