import type { GraphNode, NodeKind, UnresolvedReason } from "@gitinside/schema";
import { brandForEngine, brandForFramework, brandForHost } from "../icons/brands.js";

/**
 * Words and tiers for drawing a node (DESIGN_SYSTEM.md §3). Everything here is
 * derived from the node's own fields, with no AI and no guessing, so the same
 * graph always reads the same way.
 */

/**
 * Container style by kind tier:
 * - `frame`: services and modules, translucent frames that hold children.
 * - `card`: files, symbols, routes, pages, models, and unresolved items.
 * - `icon`: datastores, queues, and externals, a large icon tile with the label beneath.
 */
export type NodeTier = "frame" | "card" | "icon";

/** The container style a node is drawn with. */
export function nodeTier(node: GraphNode): NodeTier {
  switch (node.kind) {
    case "system":
    case "service":
    case "module":
      return "frame";
    case "datastore":
    case "queue":
    case "external":
      return "icon";
    default:
      return "card";
  }
}

const KIND_NAMES: Readonly<Record<NodeKind, string>> = {
  system: "System",
  service: "Service",
  module: "Module",
  file: "File",
  symbol: "Symbol",
  route: "Route",
  page: "Page",
  model: "Model",
  datastore: "Datastore",
  queue: "Queue",
  external: "External API",
  unresolved: "Unresolved",
};

const SYMBOL_KIND_NAMES = {
  function: "Function",
  class: "Class",
  method: "Method",
  variable: "Variable",
} as const;

/** The kind in words, as users recognize it: "Route", "Method", "External API". */
export function kindName(node: GraphNode): string {
  return node.kind === "symbol" ? SYMBOL_KIND_NAMES[node.symbolKind] : KIND_NAMES[node.kind];
}

/**
 * Why an unresolved item couldn't be linked, in words (UX.md "Unresolved
 * nodes explain why"). A node's own `detail` is more specific and wins.
 */
export const REASON_TEXT: Readonly<Record<UnresolvedReason, string>> = {
  DYNAMIC_URL: "URL built at runtime",
  NO_MATCHING_ROUTE: "No route in the repo matches",
  AMBIGUOUS: "Matches more than one target",
  EXTERNAL_HOST: "Host outside the repo",
  WRAPPER_DEPTH: "URL passed through more than one wrapper",
  DYNAMIC_ROUTE: "Route path built at runtime",
  RAW_QUERY: "Raw SQL query",
  UNKNOWN_SYMBOL: "Target not found in the repo",
  DYNAMIC_NAME: "Name chosen at runtime",
};

/** A line of text split into a plain part and a code part (paths, hosts), either optional. */
export interface NodeText {
  text?: string;
  code?: string;
}

function parts(text: string | undefined, code: string | undefined): NodeText {
  return { ...(text ? { text } : {}), ...(code ? { code } : {}) };
}

/**
 * The node's name as drawn. Code-like names (symbols, page paths, unresolved
 * expressions) are `code` so they get the mono face; routes split their method
 * off so it can sit in a chip. Everything else is plain text.
 */
export function nodeLabel(node: GraphNode): NodeText & { method?: string } {
  switch (node.kind) {
    case "route":
      return { method: node.method, code: node.path };
    case "symbol":
    case "unresolved":
      return { code: node.label };
    case "page":
      return { code: node.path };
    default:
      return { text: node.label };
  }
}

/** Folder part of a repo-relative path, or undefined at the repo root. */
function dirname(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : undefined;
}

/**
 * The muted line under a node's name: the framework or engine by name, the
 * folder it lives in, or why it's unresolved.
 */
export function nodeSubtitle(node: GraphNode): NodeText {
  switch (node.kind) {
    case "system":
      return { text: "System" };
    case "service": {
      const framework = node.framework
        ? (brandForFramework(node.framework)?.title ?? node.framework)
        : undefined;
      return parts(framework ?? (node.root ? undefined : "Service"), node.root || undefined);
    }
    case "module":
      return parts(undefined, node.path || undefined);
    case "file":
      return parts(undefined, dirname(node.path));
    case "symbol": {
      const name = SYMBOL_KIND_NAMES[node.symbolKind];
      return { text: node.exported ? `Exported ${name.toLowerCase()}` : name };
    }
    case "route":
      return {};
    case "page":
      return { text: "Page" };
    case "model": {
      const n = node.fields.length;
      return { text: n === 0 ? "No fields" : `${n} ${n === 1 ? "field" : "fields"}` };
    }
    case "datastore":
      return { text: brandForEngine(node.engine)?.title ?? node.engine };
    case "queue":
      return { text: `${brandForEngine(node.engine)?.title ?? node.engine} queue` };
    case "external": {
      const brand = brandForHost(node.host)?.title;
      return parts(brand ?? "External API", node.host === node.label ? undefined : node.host);
    }
    case "unresolved":
      return { text: node.detail ?? REASON_TEXT[node.reason] };
  }
}

/** How a node is currently emphasized: off the trace path, or on it. */
export type NodeEmphasis = "dimmed" | "traced";

/** A node's state in diff mode. */
export type NodeDiff = "added" | "changed" | "removed";

/** Every visual state a node can be in; the fields combine (e.g. selected and traced). */
export interface NodeState {
  /** Draw the hover look without a pointer (stories, keyboard proxies). `:hover` also applies it. */
  hovered?: boolean;
  selected?: boolean;
  emphasis?: NodeEmphasis | undefined;
  diff?: NodeDiff | undefined;
}

/** Diff states in words, shown on the node's badge so color is never the only signal. */
export const DIFF_TEXT: Readonly<Record<NodeDiff, string>> = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
};

/**
 * The node's accessible name: name and kind first, as the screen-reader
 * announcement in UX.md reads ("routes/orders, module"), then each active
 * state in words.
 */
export function nodeAccessibleName(node: GraphNode, state: NodeState = {}): string {
  const out = [`${node.label}, ${kindName(node).toLowerCase()}`];
  if (state.selected) out.push("Selected");
  if (state.emphasis === "traced") out.push("On the request path");
  if (state.diff) out.push(`${DIFF_TEXT[state.diff]} in this change`);
  return out.join(". ");
}

/** A count shown on a node's badge row, e.g. 12 routes or 3 unresolved calls. */
export interface NodeCount {
  value: number;
  /** Singular noun: "route". */
  noun: string;
  /** Plural noun when it isn't `noun + "s"`. */
  plural?: string;
  /** Draw the badge in the unresolved style (dotted), for counts of unresolved items. */
  unresolved?: boolean;
}

/** "1 route", "12 routes", "1,204 files". */
export function countText({ value, noun, plural }: NodeCount): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? noun : (plural ?? `${noun}s`)}`;
}
