import { compareStrings, type GraphEdge, type GraphNode, type NodeKind } from "@gitinside/schema";

type NodeOf<K extends NodeKind> = Extract<GraphNode, { kind: K }>;

/** Fields every node has that never count as a change a reviewer cares about. */
export const NODE_INCIDENTAL = ["label", "source"] as const;

/**
 * Per kind, the node fields whose change makes the node `modified` (ADR-0085). Every
 * field of every kind is either here, in `NODE_INCIDENTAL`, or `id`; a test checks the
 * table against the schema, so a new field can't slip through unclassified.
 *
 * - `kind`, `parentId`, and `layer` count for every kind: a node moving to another
 *   parent or layer changes where and how the diagram draws it.
 * - Labels are derived from the ID or the fingerprint fields (a route's "GET /x", a
 *   file's base name), so a label change alone is incidental, as are source positions.
 * - A symbol's only signature fact is `requiredParams` (ADR-0088); it carries no body
 *   hash, so a function whose body changed shows up through its file's `hash`.
 */
export const NODE_FINGERPRINTS: {
  readonly [K in NodeKind]: readonly Exclude<keyof NodeOf<K>, "id" | "label" | "source">[];
} = {
  system: ["kind", "parentId", "layer"],
  service: ["kind", "parentId", "layer", "root", "framework"],
  module: ["kind", "parentId", "layer", "path"],
  file: ["kind", "parentId", "layer", "path", "hash"],
  symbol: ["kind", "parentId", "layer", "symbolKind", "exported", "requiredParams"],
  route: ["kind", "parentId", "layer", "method", "path"],
  page: ["kind", "parentId", "layer", "path"],
  model: ["kind", "parentId", "layer", "fields"],
  datastore: ["kind", "parentId", "layer", "engine"],
  queue: ["kind", "parentId", "layer", "engine", "name"],
  external: ["kind", "parentId", "layer", "host"],
  unresolved: ["kind", "parentId", "layer", "reason", "expression", "detail"],
};

/** Edge fields that never count as a change: where the calls are, not what they do. */
export const EDGE_INCIDENTAL = ["sites"] as const;

/** Edge fields whose change makes the edge `modified`: everything but `id` and the sites. */
export const EDGE_FINGERPRINT = [
  "kind",
  "from",
  "to",
  "confidence",
  "label",
  "reason",
  "fields",
] as const satisfies readonly Exclude<keyof GraphEdge, "id" | "sites">[];

/** JSON with object keys sorted and `undefined` dropped, so equal values give equal strings. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort(compareStrings)) {
      sorted[key] = (v as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

/**
 * The value a fingerprint field is compared by. A model's fields are compared as a set
 * keyed by name: reordering columns in `schema.prisma` changes nothing a caller sees,
 * so it makes the model `updated`, not `modified`.
 */
function fingerprintValue(kind: string, field: string, value: unknown): string {
  if (kind === "model" && field === "fields" && Array.isArray(value)) {
    const byName = [...(value as { name: string }[])].sort((a, b) =>
      compareStrings(a.name, b.name),
    );
    return canonicalJson(byName);
  }
  return canonicalJson(value);
}

/**
 * Names of the top-level fields whose values differ between two records with the same
 * ID, sorted; `id` is never listed. Key order and `undefined` values don't count, so a
 * record read back from Postgres `jsonb` (keys reordered) equals the one written.
 */
export function changedFields(base: object, head: object): string[] {
  const a = base as Record<string, unknown>;
  const b = head as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("id");
  return [...keys]
    .filter((key) => canonicalJson(a[key]) !== canonicalJson(b[key]))
    .sort(compareStrings);
}

/**
 * Whether any of `changes` is a fingerprint field of the node whose value really differs.
 * A `parentId` that followed its parent's rename (`renames` maps base ⇒ head IDs) is no
 * change: a route in a moved file is `updated`, the move itself is the file's.
 */
export function isNodeModified(
  base: GraphNode,
  head: GraphNode,
  changes: string[],
  renames: ReadonlyMap<string, string> = new Map(),
): boolean {
  if (base.kind !== head.kind) return true;
  const fingerprint: readonly string[] = NODE_FINGERPRINTS[head.kind];
  const a = base as Record<string, unknown>;
  const b = head as Record<string, unknown>;
  return changes.some((field) => {
    if (!fingerprint.includes(field)) return false;
    if (field === "parentId" && base.parentId !== null) {
      if (renames.get(base.parentId) === head.parentId) return false;
    }
    return (
      fingerprintValue(head.kind, field, a[field]) !== fingerprintValue(head.kind, field, b[field])
    );
  });
}

/** Whether any of `changes` is an edge fingerprint field. */
export function isEdgeModified(changes: string[]): boolean {
  const fingerprint: readonly string[] = EDGE_FINGERPRINT;
  return changes.some((field) => fingerprint.includes(field));
}
