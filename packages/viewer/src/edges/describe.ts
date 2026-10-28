import type { Confidence, EdgeKind, GraphEdge } from "@gitinside/schema";
import { DIFF_TEXT, REASON_TEXT, type NodeDiff, type NodeEmphasis } from "../nodes/describe.js";

/**
 * Words and line styles for drawing an edge (DESIGN_SYSTEM.md §3). Like the
 * node helpers, everything comes from the edge's own fields: a label never
 * claims more than the analyzer found (no guessed protocol or host).
 */

/** The fields of an edge that drawing uses; a whole `GraphEdge` fits. */
export type EdgeLike = Pick<GraphEdge, "kind" | "confidence"> &
  Partial<Pick<GraphEdge, "label" | "reason" | "fields">>;

/**
 * Line style by confidence: solid = exact, solid with a dot near the source
 * = pattern, dashed = heuristic, dotted = unresolved.
 */
export type EdgeLineStyle = "solid" | "dot" | "dashed" | "dotted";

/** The line style each confidence level is drawn with. */
export const LINE_STYLE: Readonly<Record<Confidence, EdgeLineStyle>> = {
  exact: "solid",
  pattern: "dot",
  heuristic: "dashed",
  unresolved: "dotted",
};

/** Confidence in words, for the legend, accessible names, and the inspector. */
export const CONFIDENCE_TEXT: Readonly<Record<Confidence, string>> = {
  exact: "Exact match",
  pattern: "Pattern match",
  heuristic: "Heuristic match",
  unresolved: "Unresolved",
};

/** What each relationship is called: the label's verb, and the noun for counts. */
export const EDGE_WORDS: Readonly<Record<EdgeKind, { verb: string; noun: string }>> = {
  imports: { verb: "imports", noun: "import" },
  calls: { verb: "calls", noun: "call" },
  http: { verb: "requests", noun: "request" },
  handles: { verb: "handled by", noun: "handler" },
  renders: { verb: "renders", noun: "render" },
  reads: { verb: "reads", noun: "read" },
  writes: { verb: "writes", noun: "write" },
  stores: { verb: "stored in", noun: "model" },
  publishes: { verb: "publishes to", noun: "publish" },
  consumes: { verb: "consumes", noun: "consumer" },
  external_call: { verb: "calls API", noun: "API call" },
};

/**
 * An edge label as drawn: an optional method chip, plain text, a code part
 * (paths, fields), and muted notes after a middle dot (protocol, "ambiguous").
 */
export interface EdgeText {
  method?: string;
  text?: string;
  code?: string;
  notes?: string[];
}

/** An HTTP edge's label is the route's own label, `"POST /api/orders"`. */
function splitRoute(label: string): { method: string; path: string } | undefined {
  const match = /^([A-Z]+) (\/.*)$/.exec(label);
  return match ? { method: match[1] as string, path: match[2] as string } : undefined;
}

/**
 * The label drawn on an edge. With `count`, the edge stands for that many
 * edges between hidden descendants (UX.md "Edge aggregation"): "22 calls".
 * An unresolved edge says why, in words, from its reason code.
 */
export function edgeLabel(edge: EdgeLike, count?: number): EdgeText {
  const words = EDGE_WORDS[edge.kind];
  if (count !== undefined) {
    const n = count.toLocaleString("en-US");
    return { text: `${n} ${count === 1 ? words.noun : pluralNoun(words.noun)}` };
  }
  if (edge.confidence === "unresolved" && edge.reason) {
    return { text: REASON_TEXT[edge.reason] };
  }
  const notes = edge.reason === "AMBIGUOUS" ? ["ambiguous"] : [];
  if (edge.kind === "http") {
    const route = edge.label ? splitRoute(edge.label) : undefined;
    if (route) return { method: route.method, code: route.path, notes: ["HTTP", ...notes] };
    return { text: "HTTP request", ...(notes.length ? { notes } : {}) };
  }
  const fields = edge.fields?.length ? { code: edge.fields.join(", ") } : {};
  return { text: words.verb, ...fields, ...(notes.length ? { notes } : {}) };
}

function pluralNoun(noun: string): string {
  return noun.endsWith("sh") ? `${noun}es` : `${noun}s`;
}

/** An edge label as one line of plain text, for tooltips and accessible names. */
export function edgeLabelText(label: EdgeText): string {
  const main = [label.method, label.text, label.code].filter(Boolean).join(" ");
  return [main, ...(label.notes ?? [])].join(" · ");
}

/** A broken edge's words (UX.md "Diff mode"), from the kind of node it lost. */
export function brokenText(targetKind: string): string {
  const kind = targetKind.toLowerCase();
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} removed in this PR`;
}

/** Every visual state an edge can be in; the fields combine. */
export interface EdgeState {
  /** Draw the hover look without a pointer (stories, keyboard proxies). */
  hovered?: boolean | undefined;
  selected?: boolean | undefined;
  emphasis?: NodeEmphasis | undefined;
  diff?: NodeDiff | undefined;
  /**
   * Diff mode: the edge still exists in head but its target was removed or
   * changed incompatibly (DESIGN.md §8.4). The label says what broke.
   */
  broken?: string | undefined;
}

/**
 * The edge's accessible name: the relationship from one end to the other,
 * the label, the confidence in words, then each active state.
 * `"createOrder requests POST /api/orders. POST /api/orders · HTTP. Exact match. Selected"`.
 */
export function edgeAccessibleName(
  edge: EdgeLike,
  ends: { from: string; to: string },
  options: EdgeState & { count?: number | undefined } = {},
): string {
  const out = [
    `${ends.from} ${EDGE_WORDS[edge.kind].verb} ${ends.to}`,
    edgeLabelText(edgeLabel(edge, options.count)),
    CONFIDENCE_TEXT[edge.confidence],
  ];
  if (options.selected) out.push("Selected");
  if (options.emphasis === "traced") out.push("On the request path");
  if (options.diff) out.push(`${DIFF_TEXT[options.diff]} in this change`);
  if (options.broken) out.push(`Broken: ${options.broken}`);
  return out.join(". ");
}
