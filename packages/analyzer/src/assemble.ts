import { isDeepStrictEqual } from "node:util";
import {
  ArchitectureGraph,
  SCHEMA_VERSION,
  compareStrings,
  stringifyGraph,
  type AnalysisWarning,
  type Confidence,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { AnalysisError } from "./inventory.js";

/** The output of one pipeline pass (inventory, symbols, a framework detector, …). */
export interface GraphPart {
  /** Short name used in duplicate warnings, e.g. `express`. */
  source: string;
  nodes?: readonly GraphNode[];
  edges?: readonly GraphEdge[];
  warnings?: readonly AnalysisWarning[];
}

/** Everything {@link assembleGraph} needs besides the parts. */
export interface AssembleInput {
  repo: ArchitectureGraph["repo"];
  analyzerVersion: string;
  /** In precedence order: when two parts emit different nodes with one ID, the earlier part wins. */
  parts: readonly GraphPart[];
}

/** Most to least certain. `unresolved` never competes: it's fixed by the target node's kind. */
const STRENGTH: Record<Confidence, number> = { exact: 0, pattern: 1, heuristic: 2, unresolved: 3 };

/** How many validation issues an `INVALID_GRAPH` error lists before summarizing the rest. */
const MAX_ISSUES = 5;

/**
 * Merge the parts into one graph and validate it against the schema.
 * - Nodes: the first node per ID is kept. A later, different node with the same ID is
 *   dropped with a `DUPLICATE_NODE` warning (e.g. a custom Express server and a Next.js
 *   route file both declaring `GET /api/health`); identical duplicates merge silently.
 * - Edges: one edge per ID. Duplicates merge their `sites` and `fields` and keep the
 *   strongest confidence; label and reason come from the first.
 * - Warnings: exact duplicates are removed; order is file, code, message.
 * Collections keep pipeline order (deterministic); `stringifyGraph` applies the canonical
 * order on write. Throws `AnalysisError` `INVALID_GRAPH` if the result breaks the schema,
 * which means an analyzer bug, never a problem with the analyzed repo.
 */
export function assembleGraph(input: AssembleInput): ArchitectureGraph {
  const nodes = new Map<string, { node: GraphNode; source: string }>();
  const edges = new Map<string, GraphEdge>();
  const warnings: AnalysisWarning[] = [];

  for (const part of input.parts) {
    for (const node of part.nodes ?? []) {
      const kept = nodes.get(node.id);
      if (!kept) nodes.set(node.id, { node, source: part.source });
      else if (!isDeepStrictEqual(kept.node, node)) {
        warnings.push({
          code: "DUPLICATE_NODE",
          message: `${node.id} is produced by both ${kept.source} and ${part.source}; keeping ${kept.source}'s`,
          ...(node.source ? { file: node.source.file } : {}),
        });
      }
    }
    for (const edge of part.edges ?? []) {
      const kept = edges.get(edge.id);
      edges.set(edge.id, kept ? mergeEdges(kept, edge) : edge);
    }
    warnings.push(...(part.warnings ?? []));
  }

  const graph = {
    schemaVersion: SCHEMA_VERSION,
    repo: input.repo,
    analyzerVersion: input.analyzerVersion,
    nodes: [...nodes.values()].map((n) => n.node),
    edges: [...edges.values()],
    warnings: uniqueWarnings(warnings),
  };
  return validate(graph);
}

/** Combine two edges with the same ID (so the same kind, source, and target). */
function mergeEdges(a: GraphEdge, b: GraphEdge): GraphEdge {
  const sites = [...a.sites];
  for (const site of b.sites) {
    if (!sites.some((s) => isDeepStrictEqual(s, site))) sites.push(site);
  }
  const merged: GraphEdge = {
    ...a,
    confidence: STRENGTH[b.confidence] < STRENGTH[a.confidence] ? b.confidence : a.confidence,
    sites,
  };
  if (a.fields || b.fields) {
    merged.fields = [...new Set([...(a.fields ?? []), ...(b.fields ?? [])])].sort(compareStrings);
  }
  return merged;
}

function uniqueWarnings(warnings: AnalysisWarning[]): AnalysisWarning[] {
  const seen = new Set<string>();
  return warnings
    .filter((w) => {
      const key = JSON.stringify([w.code, w.file ?? null, w.message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        compareStrings(a.file ?? "", b.file ?? "") ||
        compareStrings(a.code, b.code) ||
        compareStrings(a.message, b.message),
    );
}

/** Schema-check a graph, turning Zod's error into an `AnalysisError` with readable issues. */
function validate(value: unknown): ArchitectureGraph {
  const result = ArchitectureGraph.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  );
  const extra = issues.length > MAX_ISSUES ? `; and ${issues.length - MAX_ISSUES} more` : "";
  throw new AnalysisError(
    "INVALID_GRAPH",
    `analyzer produced an invalid graph: ${issues.slice(0, MAX_ISSUES).join("; ")}${extra}`,
  );
}

/**
 * Serialize a graph for writing (CLI output, snapshots, uploads) with `stringifyGraph`,
 * then parse the text back and validate it. That catches values JSON can't carry
 * faithfully (`NaN` becomes `null`, `undefined` vanishes) before anything is written.
 * Throws `AnalysisError` `INVALID_GRAPH` on failure.
 */
export function serializeGraph(graph: ArchitectureGraph): string {
  const text = stringifyGraph(graph);
  validate(JSON.parse(text));
  return text;
}
