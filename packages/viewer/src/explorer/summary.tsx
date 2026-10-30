import type { EdgeKind, GraphNode } from "@gitinside/schema";
import type { ReactNode } from "react";
import { brandForEngine, brandForFramework } from "../icons/brands.js";
import { frameCounts } from "../layout/size.js";
import { connectionsOf, type NodeConnection } from "../model/connections.js";
import type { HierarchyIndex } from "../model/hierarchy.js";
import { REASON_TEXT } from "../nodes/describe.js";

/**
 * The inspector's "From the code" summary (UX.md, M4b.5a): a lead sentence
 * per kind from the node's own fields, then one sentence per kind of
 * connection, naming what's at the other end. Every word comes from the
 * graph; there is no AI in v1, and nothing is guessed: a node with no
 * connections says so.
 */

/** How many names a connection sentence lists before "and N more". */
export const NAMES_SHOWN = 3;

/** The order the sentences come in: entry points first, then the request's path down to data and outside APIs. */
const KIND_ORDER: readonly EdgeKind[] = [
  "handles",
  "renders",
  "calls",
  "http",
  "reads",
  "writes",
  "stores",
  "publishes",
  "consumes",
  "external_call",
  "imports",
];

/** What the selection does along an outgoing edge of each kind. */
const OUTGOING: Record<EdgeKind, string> = {
  handles: "Runs",
  renders: "Renders",
  calls: "Calls",
  http: "Requests",
  reads: "Reads",
  writes: "Writes",
  stores: "Stored in",
  publishes: "Publishes to",
  consumes: "Consumes",
  external_call: "Calls the outside API",
  imports: "Imports",
};

/** What is done to the selection along an incoming edge of each kind. */
const INCOMING: Record<EdgeKind, string> = {
  handles: "Handles",
  renders: "Rendered by",
  calls: "Called by",
  http: "Requested by",
  reads: "Read by",
  writes: "Written by",
  stores: "Holds",
  publishes: "Published to by",
  consumes: "Consumed by",
  external_call: "Called by",
  imports: "Imported by",
};

const SYMBOL_NOUN: Record<"function" | "class" | "method" | "variable", string> = {
  function: "function",
  class: "class",
  method: "method",
  variable: "value",
};

function plural(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** An engine as the node's subtitle names it ("PostgreSQL" for `postgres`). */
function engineName(engine: string): string {
  return brandForEngine(engine)?.title ?? engine;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A list in words: "a", "a and b", "a, b and c". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** Names in words, at most {@link NAMES_SHOWN}, then "and N more". */
export function namesText(names: readonly string[]): string {
  if (names.length <= NAMES_SHOWN) return listText(names);
  const rest = names.length - NAMES_SHOWN;
  return `${names.slice(0, NAMES_SHOWN).join(", ")} and ${rest} more`;
}

/**
 * The service `other` is named with as seen from `node`, or "" when it needs
 * none: its own service, a service itself, or infrastructure. Two services
 * often use the same names (a client's `listOrders` requests the API's), so
 * a name from another service says which.
 */
function otherService(index: HierarchyIndex, node: GraphNode, other: GraphNode): string {
  const here = index.service.get(node.id);
  const there = index.service.get(other.id);
  if (there === undefined || there === here || there === other.id) return "";
  return index.byId.get(there)?.label ?? there;
}

/**
 * One sentence per edge kind, e.g. "Calls createOrder and validate." or
 * "Requested by listOrders and placeOrder in @shop/web.": each node at the
 * other end named once, grouped by its service, in graph order.
 */
export function connectionSentences(
  index: HierarchyIndex,
  node: GraphNode,
  connections: readonly NodeConnection[],
  verbs: Record<EdgeKind, string>,
): string[] {
  const byKind = new Map<EdgeKind, Map<string, string[]>>();
  for (const { edge, other } of connections) {
    const groups = byKind.get(edge.kind) ?? new Map<string, string[]>();
    const service = otherService(index, node, other);
    const names = groups.get(service) ?? [];
    if (!names.includes(other.label)) names.push(other.label);
    groups.set(service, names);
    byKind.set(edge.kind, groups);
  }
  return KIND_ORDER.flatMap((kind) => {
    const groups = byKind.get(kind);
    if (!groups) return [];
    const parts = [...groups].map(
      ([service, names]) => `${namesText(names)}${service ? ` in ${service}` : ""}`,
    );
    // Each group already has its own "and", so groups join with "plus".
    return [`${verbs[kind]} ${parts.join(", plus ")}.`];
  });
}

/** "with 3 routes and 2 files" for a frame, or "" when it holds nothing counted. */
function insideText(index: HierarchyIndex, id: string): string {
  const inside = frameCounts(index, id).map((c) => plural(c.value, c.noun));
  return inside.length > 0 ? ` with ${listText(inside)}` : "";
}

/** The kind's lead sentence, from the node's own fields. */
function lead(index: HierarchyIndex, node: GraphNode): ReactNode {
  switch (node.kind) {
    case "system": {
      const top = index.children.get(node.id) ?? [];
      const count = (kind: GraphNode["kind"], noun: string) =>
        plural(top.filter((n) => n.kind === kind).length, noun);
      const inside = frameCounts(index, node.id).map((c) => plural(c.value, c.noun));
      return `${count("service", "service")}, ${count("datastore", "datastore")} and ${count("external", "outside API")}, with ${listText(inside)} inside.`;
    }
    case "service": {
      const framework = node.framework
        ? (brandForFramework(node.framework)?.title ?? node.framework)
        : undefined;
      return (
        <>
          {framework ? `${framework} service` : "Service"}
          {node.root ? (
            <>
              {" in "}
              <code>{node.root}</code>
            </>
          ) : (
            " at the repo root"
          )}
          {insideText(index, node.id)}.
        </>
      );
    }
    case "module":
      return (
        <>
          Folder <code>{node.path}</code>
          {insideText(index, node.id)}.
        </>
      );
    case "file":
      return `File${insideText(index, node.id)}.`;
    case "symbol": {
      const noun = SYMBOL_NOUN[node.symbolKind];
      const what = node.exported ? `Exported ${noun}` : capitalize(noun);
      // Zero required arguments says nothing worth a clause.
      const takes =
        node.requiredParams && node.symbolKind !== "variable"
          ? `, called with at least ${plural(node.requiredParams, "argument")}`
          : "";
      return `${what}${takes}.`;
    }
    case "route":
      return (
        <>
          Handles <code>{`${node.method} ${node.path}`}</code> requests.
        </>
      );
    case "page":
      return (
        <>
          Page at <code>{node.path}</code>.
        </>
      );
    case "model":
      return `Model with ${plural(node.fields.length, "field")}.`;
    case "datastore":
      return `Datastore running ${engineName(node.engine)}.`;
    case "queue":
      return (
        <>
          Queue
          {node.name ? (
            <>
              {" "}
              <code>{node.name}</code>
            </>
          ) : null}{" "}
          on {engineName(node.engine)}.
        </>
      );
    case "external":
      return (
        <>
          Outside API at <code>{node.host}</code>.
        </>
      );
    case "unresolved":
      return `${capitalize(node.detail ?? REASON_TEXT[node.reason])}, so it can't be linked. It's shown, not dropped.`;
  }
}

/**
 * The whole summary: the lead, then what it does (outgoing), then what uses
 * it (incoming). The repo overview (the root) has only its lead; any other
 * node with no connections says "Nothing else in the repo connects to it."
 */
export function summaryOf(index: HierarchyIndex, node: GraphNode): ReactNode {
  const first = lead(index, node);
  if (node.id === index.root.id) return first;
  const { incoming, outgoing } = connectionsOf(index, node.id);
  // A model is stored in its datastore; a frame holding models keeps data there.
  const out = node.kind === "model" ? OUTGOING : { ...OUTGOING, stores: "Keeps data in" };
  const rest = [
    ...connectionSentences(index, node, outgoing, out),
    ...connectionSentences(index, node, incoming, INCOMING),
  ];
  if (rest.length === 0 && node.kind !== "unresolved") {
    rest.push("Nothing else in the repo connects to it.");
  }
  return (
    <>
      {first}
      {rest.map((sentence) => ` ${sentence}`).join("")}
    </>
  );
}
