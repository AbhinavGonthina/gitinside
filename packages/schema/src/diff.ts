import { z } from "zod";
import {
  AnalysisWarning,
  GraphEdge,
  GraphNode,
  GraphRepo,
  SCHEMA_VERSION,
  SourceLocation,
} from "./schema.js";

/**
 * Field names that differ between the base and head records of one item, e.g.
 * `["hash"]` for an edited file or `["fields"]` for a model that gained a column.
 * `id` is never listed: renamed items carry their base ID in `from` instead.
 */
const Changes = z.array(
  z
    .string()
    .min(1)
    .refine((name) => name !== "id", "`id` is never a change"),
);

/**
 * A node with the same ID in base and head whose record differs. The head record is
 * carried whole, so applying the diff to base rebuilds head exactly (ADR-0084).
 */
export const NodeChange = z.object({ node: GraphNode, changes: Changes.min(1) }).strict();
export type NodeChange = z.infer<typeof NodeChange>;

/** A base node that reappears in head under another ID (a moved file, a renamed symbol). */
export const NodeRename = z
  .object({ from: z.string().min(1), node: GraphNode, changes: Changes })
  .strict();
export type NodeRename = z.infer<typeof NodeRename>;

/** An edge with the same ID in base and head whose record differs. */
export const EdgeChange = z.object({ edge: GraphEdge, changes: Changes.min(1) }).strict();
export type EdgeChange = z.infer<typeof EdgeChange>;

/** A base edge whose endpoints were renamed, so its head ID differs. */
export const EdgeRename = z
  .object({ from: z.string().min(1), edge: GraphEdge, changes: Changes })
  .strict();
export type EdgeRename = z.infer<typeof EdgeRename>;

/** Why a connection that worked in base no longer does (DESIGN.md §8.4). */
export const BrokenReason = z.enum([
  /** The target is gone from head, but the source still makes the call. */
  "TARGET_REMOVED",
  /** The target route's method or path changed. */
  "ROUTE_CHANGED",
  /** The target function needs more arguments than the call passes. */
  "PARAMETERS_ADDED",
  /** A model field the source reads or writes was removed. */
  "FIELD_REMOVED",
]);
export type BrokenReason = z.infer<typeof BrokenReason>;

/**
 * A broken connection: a base edge whose source still exists in head and still
 * makes the call, but whose target no longer answers it.
 */
export const BrokenEdge = z
  .object({
    /** ID of the base edge that broke. */
    edge: z.string().min(1),
    /** Source node; it exists in head. */
    from: z.string().min(1),
    /** Target node as it was in base. */
    to: z.string().min(1),
    reason: BrokenReason,
    /** Why, in words shown to the user ("POST /api/orders was removed"). */
    detail: z.string().min(1),
    /** Head call sites that still make the call. */
    sites: z.array(SourceLocation),
  })
  .strict();
export type BrokenEdge = z.infer<typeof BrokenEdge>;

const nodeLists = z
  .object({
    /** Head records of nodes that exist only in head. */
    added: z.array(GraphNode),
    /** IDs of base nodes that exist only in base. */
    removed: z.array(z.string().min(1)),
    /** Same ID, and a fingerprint field changed (a route's handler, a model's fields, a file's hash). */
    modified: z.array(NodeChange),
    /** Same ID and fingerprint; only other facts changed (a source position, a label). Not shown as a change. */
    updated: z.array(NodeChange),
    renamed: z.array(NodeRename),
  })
  .strict();

const edgeLists = z
  .object({
    added: z.array(GraphEdge),
    removed: z.array(z.string().min(1)),
    /** Same ID, and the confidence, label, reason, or fields changed. */
    modified: z.array(EdgeChange),
    /** Same ID; only the call sites moved. Not shown as a change. */
    updated: z.array(EdgeChange),
    renamed: z.array(EdgeRename),
  })
  .strict();

const listCounts = z
  .object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    renamed: z.number().int().nonnegative(),
  })
  .strict();

/** Counts of every list, for the PR comment, the Check Run, and `pull_requests.broken_count`. */
export const DiffSummary = z
  .object({ nodes: listCounts, edges: listCounts, broken: z.number().int().nonnegative() })
  .strict();
export type DiffSummary = z.infer<typeof DiffSummary>;

const diffShape = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    /** Both graphs come from this analyzer version; a diff across versions is refused. */
    analyzerVersion: z.string().min(1),
    base: z.object({ repo: GraphRepo }).strict(),
    head: z.object({ repo: GraphRepo }).strict(),
    nodes: nodeLists,
    edges: edgeLists,
    broken: z.array(BrokenEdge),
    /** Warnings as a multiset: head's are base's minus `removed` plus `added`. */
    warnings: z
      .object({ added: z.array(AnalysisWarning), removed: z.array(AnalysisWarning) })
      .strict(),
    summary: DiffSummary,
  })
  .strict();

type DiffShape = z.infer<typeof diffShape>;

/** Count each list of a diff. Builders call this rather than counting by hand. */
export function summarizeDiff(diff: Pick<DiffShape, "nodes" | "edges" | "broken">): DiffSummary {
  const count = (lists: Record<keyof DiffSummary["nodes"], unknown[]>) => ({
    added: lists.added.length,
    removed: lists.removed.length,
    modified: lists.modified.length,
    updated: lists.updated.length,
    renamed: lists.renamed.length,
  });
  return { nodes: count(diff.nodes), edges: count(diff.edges), broken: diff.broken.length };
}

/** Each ID may appear in one list only; a list naming it twice is a builder bug. */
function checkUnique(what: "node" | "edge", ids: string[], issue: (message: string) => void): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) issue(`${what} ${id} appears more than once in the diff`);
    seen.add(id);
  }
}

function checkIntegrity(diff: DiffShape, ctx: z.RefinementCtx): void {
  const issue = (message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const { nodes, edges } = diff;

  checkUnique(
    "node",
    [
      ...nodes.added.map((n) => n.id),
      ...nodes.removed,
      ...[...nodes.modified, ...nodes.updated].map((c) => c.node.id),
      ...nodes.renamed.flatMap((r) => [r.from, r.node.id]),
    ],
    issue,
  );
  checkUnique(
    "edge",
    [
      ...edges.added.map((e) => e.id),
      ...edges.removed,
      ...[...edges.modified, ...edges.updated].map((c) => c.edge.id),
      ...edges.renamed.flatMap((r) => [r.from, r.edge.id]),
    ],
    issue,
  );
  checkUnique(
    "edge",
    diff.broken.map((b) => b.edge),
    (message) => issue(`broken ${message}`),
  );

  // A broken edge's source is in head. Its target is gone (`TARGET_REMOVED`,
  // `ROUTE_CHANGED`), or still there but changed (`PARAMETERS_ADDED`, `FIELD_REMOVED`:
  // the edge itself survives, ADR-0088).
  const removedNodes = new Set(nodes.removed);
  const removedEdges = new Set(edges.removed);
  const changedNodes = new Set([
    ...nodes.modified.map((c) => c.node.id),
    ...nodes.renamed.map((r) => r.from),
  ]);
  for (const b of diff.broken) {
    if (b.reason === "TARGET_REMOVED" || b.reason === "ROUTE_CHANGED") {
      if (!removedEdges.has(b.edge)) issue(`broken edge ${b.edge} isn't a removed edge`);
      if (!removedNodes.has(b.to))
        issue(`broken edge ${b.edge} targets ${b.to}, which isn't removed`);
    } else {
      if (removedEdges.has(b.edge)) issue(`broken edge ${b.edge} (${b.reason}) was removed`);
      if (!changedNodes.has(b.to)) {
        issue(`broken edge ${b.edge} (${b.reason}) targets ${b.to}, which isn't modified`);
      }
    }
    if (removedNodes.has(b.from) || nodes.renamed.some((r) => r.from === b.from)) {
      issue(`broken edge ${b.edge} comes from ${b.from}, which isn't in head`);
    }
  }

  const expected = summarizeDiff(diff);
  const lists = ["added", "removed", "modified", "updated", "renamed"] as const;
  const matches =
    diff.summary.broken === expected.broken &&
    lists.every(
      (list) =>
        diff.summary.nodes[list] === expected.nodes[list] &&
        diff.summary.edges[list] === expected.edges[list],
    );
  if (!matches) issue(`summary does not match the lists: expected ${JSON.stringify(expected)}`);
}

/**
 * What changed between two graphs of the same repo (DESIGN.md §8): `packages/diff`'s
 * output, stored for PR diffs and read by the viewer's diff mode and the PR bot.
 */
export const GraphDiff = diffShape.superRefine(checkIntegrity);
export type GraphDiff = z.infer<typeof GraphDiff>;

/** Parse and validate an unknown value as a graph diff. Throws a ZodError on failure. */
export function parseGraphDiff(value: unknown): GraphDiff {
  return GraphDiff.parse(value);
}
