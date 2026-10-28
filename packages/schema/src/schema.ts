import { z } from "zod";

/** Version of the `architecture.json` format. Bump the major on breaking changes. */
export const SCHEMA_VERSION = "1.0.0" as const;

/** What a node represents. Shape in the UI encodes this (see docs/DESIGN_SYSTEM.md). */
export const NodeKind = z.enum([
  "system",
  "service",
  "module",
  "file",
  "symbol",
  "route",
  "page",
  "model",
  "datastore",
  "queue",
  "external",
  "unresolved",
]);
export type NodeKind = z.infer<typeof NodeKind>;

/** Architectural layer. Color in the UI encodes this. */
export const Layer = z.enum(["frontend", "backend", "data", "infra", "external"]);
export type Layer = z.infer<typeof Layer>;

/** How sure the analyzer is about an edge. Line style in the UI encodes this. */
export const Confidence = z.enum(["exact", "pattern", "heuristic", "unresolved"]);
export type Confidence = z.infer<typeof Confidence>;

/** Relationship between two nodes. Hierarchy is expressed by `parentId`, not by edges. */
export const EdgeKind = z.enum([
  "imports",
  "calls",
  "http",
  "handles",
  "renders",
  "reads",
  "writes",
  "stores",
  "publishes",
  "consumes",
  "external_call",
]);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const HttpMethod = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
]);
export type HttpMethod = z.infer<typeof HttpMethod>;

/** Why something could not be resolved. Unresolved items are shown, never dropped. */
export const UnresolvedReason = z.enum([
  "DYNAMIC_URL",
  "NO_MATCHING_ROUTE",
  "AMBIGUOUS",
  "EXTERNAL_HOST",
  "WRAPPER_DEPTH",
  "DYNAMIC_ROUTE",
  "RAW_QUERY",
  "UNKNOWN_SYMBOL",
  "DYNAMIC_NAME",
]);
export type UnresolvedReason = z.infer<typeof UnresolvedReason>;

/** A position in the analyzed repo. `file` is repo-relative with forward slashes; line and column are 1-based. */
export const SourceLocation = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
  })
  .strict();
export type SourceLocation = z.infer<typeof SourceLocation>;

const nodeBase = {
  id: z.string().min(1),
  label: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  layer: Layer.optional(),
  source: SourceLocation.optional(),
};

const ModelField = z
  .object({ name: z.string().min(1), type: z.string().min(1), optional: z.boolean() })
  .strict();

/** A node in the hierarchy. Each kind carries its own fields. */
export const GraphNode = z.discriminatedUnion("kind", [
  z.object({ ...nodeBase, kind: z.literal("system") }).strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("service"),
      root: z.string(),
      framework: z.string().optional(),
    })
    .strict(),
  z.object({ ...nodeBase, kind: z.literal("module"), path: z.string() }).strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("file"),
      path: z.string().min(1),
      hash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("symbol"),
      symbolKind: z.enum(["function", "class", "method", "variable"]),
      exported: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("route"),
      method: HttpMethod,
      path: z.string().startsWith("/"),
    })
    .strict(),
  z.object({ ...nodeBase, kind: z.literal("page"), path: z.string().startsWith("/") }).strict(),
  z.object({ ...nodeBase, kind: z.literal("model"), fields: z.array(ModelField) }).strict(),
  z.object({ ...nodeBase, kind: z.literal("datastore"), engine: z.string().min(1) }).strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("queue"),
      engine: z.string().min(1),
      name: z.string().optional(),
    })
    .strict(),
  z.object({ ...nodeBase, kind: z.literal("external"), host: z.string().min(1) }).strict(),
  z
    .object({
      ...nodeBase,
      kind: z.literal("unresolved"),
      reason: UnresolvedReason,
      expression: z.string(),
      /** Why, in words shown to the user, when the reason code alone doesn't say. */
      detail: z.string().min(1).optional(),
    })
    .strict(),
]);
export type GraphNode = z.infer<typeof GraphNode>;

/**
 * A relationship between two leaf-level nodes. One edge per (kind, from, to);
 * every call site that produced it is listed in `sites`.
 */
export const GraphEdge = z
  .object({
    id: z.string().min(1),
    kind: EdgeKind,
    from: z.string().min(1),
    to: z.string().min(1),
    confidence: Confidence,
    label: z.string().optional(),
    reason: UnresolvedReason.optional(),
    /** For `reads`/`writes`: the model fields the call sites name, sorted. */
    fields: z.array(z.string().min(1)).optional(),
    sites: z.array(SourceLocation),
  })
  .strict();
export type GraphEdge = z.infer<typeof GraphEdge>;

/** A non-fatal problem found during analysis (syntax error, skipped file, missing tsconfig). */
export const AnalysisWarning = z
  .object({ code: z.string().min(1), message: z.string().min(1), file: z.string().optional() })
  .strict();
export type AnalysisWarning = z.infer<typeof AnalysisWarning>;

const graphShape = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repo: z
      .object({
        owner: z.string().min(1),
        name: z.string().min(1),
        sha: z
          .string()
          .regex(/^[0-9a-f]{7,40}$/)
          .optional(),
      })
      .strict(),
    analyzerVersion: z.string().min(1),
    nodes: z.array(GraphNode),
    edges: z.array(GraphEdge),
    warnings: z.array(AnalysisWarning),
  })
  .strict();

type GraphShape = z.infer<typeof graphShape>;

/** Cross-reference checks that a plain object schema can't express. */
function checkIntegrity(graph: GraphShape, ctx: z.RefinementCtx): void {
  const issue = (message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, message });

  const nodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) issue(`duplicate node id: ${node.id}`);
    nodes.set(node.id, node);
  }

  const roots = graph.nodes.filter((n) => n.kind === "system");
  if (roots.length !== 1) issue(`expected exactly one system node, found ${roots.length}`);

  for (const node of graph.nodes) {
    if (node.kind === "system") {
      if (node.parentId !== null) issue(`system node must have parentId null: ${node.id}`);
      continue;
    }
    if (node.parentId === null) {
      issue(`node has no parent: ${node.id}`);
      continue;
    }
    if (!nodes.has(node.parentId)) issue(`node ${node.id} has missing parent ${node.parentId}`);
  }

  // Walk each parent chain; a chain longer than the node count means a cycle.
  for (const node of graph.nodes) {
    let current: GraphNode | undefined = node;
    let steps = 0;
    while (current && current.parentId !== null && steps <= graph.nodes.length) {
      current = nodes.get(current.parentId);
      steps++;
    }
    if (steps > graph.nodes.length) {
      issue(`parent cycle involving ${node.id}`);
      break;
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) issue(`duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from) issue(`edge ${edge.id} has missing source ${edge.from}`);
    if (!to) issue(`edge ${edge.id} has missing target ${edge.to}`);
    if (to && (edge.confidence === "unresolved") !== (to.kind === "unresolved")) {
      issue(
        `edge ${edge.id}: confidence "unresolved" must be used exactly when the target is an unresolved node`,
      );
    }
  }
}

/** The full `architecture.json` document, including cross-reference checks. */
export const ArchitectureGraph = graphShape.superRefine(checkIntegrity);
export type ArchitectureGraph = z.infer<typeof ArchitectureGraph>;

/** Parse and validate an unknown value as an architecture graph. Throws a ZodError on failure. */
export function parseGraph(value: unknown): ArchitectureGraph {
  return ArchitectureGraph.parse(value);
}
