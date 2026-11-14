import {
  compareStrings,
  type Confidence,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { EDGE_WORDS } from "../edges/describe.js";
import { brandForEngine } from "../icons/brands.js";
import { frameCounts } from "../layout/size.js";
import { connectionsOf, type NodeConnection } from "../model/connections.js";
import { groupLead, groupNote, isGroup, isImportsGroup } from "../model/groups.js";
import type { HierarchyIndex } from "../model/hierarchy.js";
import { REASON_TEXT } from "../nodes/describe.js";
import { serviceCounts, serviceRole } from "../nodes/cards.js";
import { STRENGTH } from "../model/view.js";

type CallSite = GraphEdge["sites"][number];

/**
 * The prototype's panel text (M10.3c3, M10-design A8, B9, B10), for the explorer's
 * `design="prototype"` only. Like the shipped summary (`summary.tsx`), every word is a fact of
 * the graph; nothing is guessed:
 *
 * - **The overview's sentence:** the services by role ("A Next.js app and an Express API"), then
 *   the datastores' engines and the outside APIs' count, with a fact row of counts under it.
 * - **A node's brief:** one lead sentence from its own fields, then one sentence of where its
 *   connections go ("It calls into @shop/api and 1 outside API."), at most {@link BRIEF_WORDS}
 *   words in all: a clause that would pass the limit is left out (the fact grid lists it all).
 * - **The fact grid:** a node's own facts, then its connections by where they go (Calls into,
 *   Outside APIs, Data, Unresolved, Used by), each a list of the nodes at the other end.
 * - **Connections grouped by target:** one row per node at the other end, with its call sites
 *   counted and the weakest confidence among its edges.
 *
 * Not handled: the ORM a model comes through (the graph doesn't record it), and roles beyond
 * `serviceRole`'s (an app, an API, a package, a server, a worker).
 */

/** The most words a brief (or the overview's sentence) may have (M10-design B9's check). */
export const BRIEF_WORDS = 30;

/** How many names a brief's clause lists before "and N more". */
const BRIEF_NAMES = 2;

/** Words in a text, as the check counts them: runs of non-space. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? noun : `${noun}s`}`;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A list in words: "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** Names in words, at most `shown`, then "and N more". */
function someNames(names: readonly string[], shown = BRIEF_NAMES): string {
  if (names.length <= shown) return listText(names);
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

/** Every service in graph order, those inside the prototype's groups too. */
export function allServices(index: HierarchyIndex): GraphNode[] {
  return index.graph.nodes.filter((n) => n.kind === "service");
}

/** A role inside a sentence: "app", "API", "Next.js app". */
function roleWord(role: string): string {
  return /^[A-Z][a-z]+$/.test(role) ? role.toLowerCase() : role;
}

/** "a Next.js app", "an Express API", "3 packages". */
function rolePhrase(role: string, n: number): string {
  const word = roleWord(role);
  if (n > 1) return `${n} ${word}s`;
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/** Engines in words, each once, in graph order ("PostgreSQL", "Redis"). */
function engineNames(nodes: readonly GraphNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind !== "datastore" && n.kind !== "queue") continue;
    const name = brandForEngine(n.engine)?.title ?? n.engine;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Most roles the overview's sentence names before "N other services". */
const ROLES_SHOWN = 3;

/**
 * The overview's "From the code" sentence (M10-design A8): the services by role, most first,
 * then the data's engines and the outside APIs, e.g. "A Next.js app and an Express API, with
 * PostgreSQL and 1 outside API." Past {@link BRIEF_WORDS}, the counts alone.
 */
export function systemSentence(index: HierarchyIndex): string {
  const services = allServices(index);
  const roles = new Map<string, number>();
  for (const s of services) {
    const role = serviceRole(index, s);
    roles.set(role, (roles.get(role) ?? 0) + 1);
  }
  // Most first; a tie keeps graph order (a Map keeps insertion order, and the sort is stable).
  const ranked = [...roles].sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, ROLES_SHOWN);
  const rest = ranked.slice(ROLES_SHOWN).reduce((sum, [, n]) => sum + n, 0);
  const parts = shown.map(([role, n]) => rolePhrase(role, n));
  if (rest > 0) parts.push(plural(rest, "other service"));
  const nodes = index.graph.nodes;
  const hosts = nodes.filter((n) => n.kind === "external").length;
  const engines = engineNames(nodes);
  const data = [
    ...(engines.length > ROLES_SHOWN
      ? [
          ...engines.slice(0, ROLES_SHOWN - 1),
          plural(engines.length - ROLES_SHOWN + 1, "other store"),
        ]
      : engines),
    ...(hosts > 0 ? [plural(hosts, "outside API")] : []),
  ];
  const sentence =
    parts.length > 0 && data.length > 0
      ? `${capitalize(listText(parts))}, with ${listText(data)}.`
      : parts.length > 0
        ? `${capitalize(listText(parts))}.`
        : data.length > 0
          ? `${capitalize(listText(data))}.`
          : "No services, data, or outside APIs were found.";
  if (wordCount(sentence) <= BRIEF_WORDS) return sentence;
  const stores = nodes.filter((n) => n.kind === "datastore").length;
  return `${capitalize(listText([plural(services.length, "service"), plural(stores, "datastore"), plural(hosts, "outside API")]))}.`;
}

/** One count in the overview's fact row. */
export interface CountFact {
  value: number;
  noun: string;
}

/** The overview's fact row: services, then pages, routes, models, and outside APIs (none left out). */
export function systemFacts(index: HierarchyIndex): CountFact[] {
  const count = (kind: GraphNode["kind"]) =>
    index.graph.nodes.filter((n) => n.kind === kind).length;
  return [
    { value: count("service"), noun: "service" },
    { value: count("page"), noun: "page" },
    { value: count("route"), noun: "route" },
    { value: count("model"), noun: "model" },
    { value: count("datastore"), noun: "datastore" },
    { value: count("external"), noun: "outside API" },
  ].filter((c) => c.value > 0);
}

/** A service's line in the overview's list: its role and its count row. */
export function serviceLine(index: HierarchyIndex, node: GraphNode): string {
  const counts = serviceCounts(index, node.id).map((c) => plural(c.value, c.noun));
  return [serviceRole(index, node), ...counts].join(" · ");
}

/** "with 3 routes and 2 files" for a frame, or "" when it holds nothing counted. */
function insideText(index: HierarchyIndex, id: string): string {
  const inside = frameCounts(index, id).map((c) => plural(c.value, c.noun));
  return inside.length > 0 ? ` with ${listText(inside)}` : "";
}

const SYMBOL_NOUN: Record<"function" | "class" | "method" | "variable", string> = {
  function: "function",
  class: "class",
  method: "method",
  variable: "value",
};

/** A node's lead sentence, from its own fields. */
function leadText(index: HierarchyIndex, node: GraphNode): string {
  switch (node.kind) {
    case "system":
      return systemSentence(index);
    case "service":
      return `${serviceRole(index, node)} ${node.root ? `in ${node.root}` : "at the repo root"}${insideText(index, node.id)}.`;
    case "module":
      return groupLead(index, node) ?? `Folder ${node.path}${insideText(index, node.id)}.`;
    case "file": {
      const defined = (index.children.get(node.id) ?? []).map((n) => n.label);
      return defined.length > 0
        ? `File defining ${someNames(defined)}.`
        : `File${insideText(index, node.id)}.`;
    }
    case "symbol": {
      const noun = SYMBOL_NOUN[node.symbolKind];
      return node.exported ? `Exported ${noun}.` : `${capitalize(noun)}.`;
    }
    case "route":
      return `Handles ${node.method} ${node.path} requests.`;
    case "page":
      return `Page at ${node.path}.`;
    case "model":
      return `Model with ${plural(node.fields.length, "field")}.`;
    case "datastore":
      return `Datastore running ${brandForEngine(node.engine)?.title ?? node.engine}.`;
    case "queue":
      return `Queue${node.name ? ` ${node.name}` : ""} on ${brandForEngine(node.engine)?.title ?? node.engine}.`;
    case "external":
      return `Outside API at ${node.host}.`;
    case "unresolved":
      return `${REASON_TEXT[node.reason]}, so it can't be linked. It's shown, not dropped.`;
  }
}

/** Kinds of line that run code in another place: what "calls into" counts. */
const CODE_KINDS: ReadonlySet<EdgeKind> = new Set(["calls", "http", "renders", "handles"]);

/** Where the other ends of connections go, each list in graph order with no repeats. */
interface Reach {
  /** Services other than the node's own that its code lines reach. */
  services: GraphNode[];
  /** Nodes in its own service that its code lines reach. */
  code: GraphNode[];
  hosts: GraphNode[];
  data: GraphNode[];
  unresolved: GraphNode[];
}

function reachOf(index: HierarchyIndex, node: GraphNode, list: readonly NodeConnection[]): Reach {
  const reach: Reach = { services: [], code: [], hosts: [], data: [], unresolved: [] };
  const add = (into: GraphNode[], n: GraphNode) => {
    if (!into.some((m) => m.id === n.id)) into.push(n);
  };
  const own = index.service.get(node.id);
  for (const { edge, other } of list) {
    if (other.kind === "external") add(reach.hosts, other);
    else if (other.kind === "unresolved") add(reach.unresolved, other);
    else if (other.kind === "datastore" || other.kind === "model" || other.kind === "queue")
      add(reach.data, other);
    else if (CODE_KINDS.has(edge.kind)) {
      const there = index.service.get(other.id);
      const service = there === undefined ? undefined : index.byId.get(there);
      if (service && there !== own) add(reach.services, service);
      else if (!service || there === own) add(reach.code, other);
    }
  }
  return reach;
}

/** The clauses of a brief's second sentence, in order. */
function clauses(reach: Reach): string[] {
  const out: string[] = [];
  const labels = (nodes: readonly GraphNode[]) => nodes.map((n) => n.label);
  if (reach.services.length > 0) out.push(`calls into ${someNames(labels(reach.services))}`);
  if (reach.code.length > 0) out.push(`calls ${someNames(labels(reach.code))}`);
  if (reach.hosts.length > 0) out.push(`calls ${plural(reach.hosts.length, "outside API")}`);
  if (reach.data.length > 0) out.push(`uses ${someNames(labels(reach.data))}`);
  if (reach.unresolved.length > 0)
    out.push(`makes ${plural(reach.unresolved.length, "unresolved call")}`);
  return out;
}

/** The first sentence that fits beside `lead` within {@link BRIEF_WORDS}, built from `parts`. */
function fitted(lead: string, parts: readonly string[], start: string): string | undefined {
  for (let n = parts.length; n > 0; n--) {
    const text = `${start}${listText(parts.slice(0, n))}.`;
    if (wordCount(lead) + wordCount(text) <= BRIEF_WORDS) return text;
  }
  return undefined;
}

/**
 * A node's brief (M10-design B9): its lead sentence (with why it's grouped, inside a group), then
 * one sentence of where its connections go, at most {@link BRIEF_WORDS} words in all. What
 * doesn't fit is left to the fact grid, never cut mid-name.
 */
export function briefOf(index: HierarchyIndex, node: GraphNode): string {
  const lead = leadText(index, node);
  if (node.id === index.root.id) return lead;
  const note = groupNote(index, node);
  const first = note && wordCount(`${lead} ${note}`) <= BRIEF_WORDS ? `${lead} ${note}` : lead;
  // Imports are left off as lines, so an imports group's connections would read as none.
  if (node.kind === "unresolved" || isImportsGroup(node)) return first;
  const { incoming, outgoing } = connectionsOf(index, node.id);
  const out = clauses(reachOf(index, node, outgoing));
  // A group's note already says who uses its members.
  const second =
    out.length > 0
      ? fitted(first, out, "It ")
      : first !== lead
        ? undefined
        : incoming.length > 0
          ? fitted(
              first,
              [someNames(usersOf(index, node, incoming).map((n) => n.label))],
              "Used by ",
            )
          : fitted(first, ["it"], "Nothing else in the repo connects to ");
  return second ? `${first} ${second}` : first;
}

/** The services (or, within its own service, the nodes) that `list`'s other ends belong to. */
function usersOf(index: HierarchyIndex, node: GraphNode, list: readonly NodeConnection[]) {
  const own = index.service.get(node.id);
  const out: GraphNode[] = [];
  for (const { other } of list) {
    const there = index.service.get(other.id);
    const service = there === undefined || there === own ? undefined : index.byId.get(there);
    const shown = service ?? other;
    if (!out.some((m) => m.id === shown.id)) out.push(shown);
  }
  return out;
}

/** One entry in a fact grid's value: a name, a node to fly to when it has one. */
export interface GridItem {
  text: string;
  code?: boolean;
  /** The node it names, which a click selects. */
  id?: string;
}

/** A fact grid row: its label and its value, one item or a list. */
export interface GridRow {
  label: string;
  items: GridItem[];
}

/** A node as a grid item: its host for an outside API, else its label. */
function nodeItem(n: GraphNode): GridItem {
  return n.kind === "external"
    ? { text: n.host, code: true, id: n.id }
    : { text: n.label, id: n.id };
}

/**
 * The node's fact grid (M10-design B9): its own facts, then where its connections go (Calls
 * into, Outside APIs, Data, Unresolved), then what uses it (Used by). Rows with nothing are left
 * out; every list is in graph order.
 */
export function factGrid(index: HierarchyIndex, node: GraphNode): GridRow[] {
  const rows: GridRow[] = [];
  const one = (label: string, text: string, code = false) =>
    rows.push({ label, items: [{ text, ...(code ? { code } : {}) }] });
  switch (node.kind) {
    case "service":
      one("Root", node.root || "(repo root)", Boolean(node.root));
      break;
    case "module":
    case "file":
      if (!isGroup(node)) one("Path", node.path, true);
      break;
    case "model":
      if (node.fields.length > 0)
        rows.push({
          label: "Fields",
          items: node.fields.map((f) => ({ text: f.name, code: true })),
        });
      break;
    case "datastore":
    case "queue":
      one("Engine", node.engine);
      break;
    case "unresolved":
      one("Reason", REASON_TEXT[node.reason]);
      if (node.detail) one("Detail", node.detail);
      if (node.expression) one("Expression", node.expression, true);
      break;
    default:
      break;
  }
  // An imports group's count would read "Unresolved calls"; its Imports list counts them instead.
  for (const c of isImportsGroup(node) ? [] : frameCounts(index, node.id)) {
    one(`${capitalize(c.noun)}s`, c.value.toLocaleString("en-US"));
  }
  const { incoming, outgoing } = connectionsOf(index, node.id);
  const reach = reachOf(index, node, outgoing);
  const list = (label: string, nodes: readonly GraphNode[]) => {
    if (nodes.length > 0) rows.push({ label, items: nodes.map(nodeItem) });
  };
  list("Calls into", [...reach.services, ...reach.code]);
  list("Outside APIs", reach.hosts);
  list("Data", reach.data);
  list("Unresolved", reach.unresolved);
  list("Used by", usersOf(index, node, incoming));
  if ("source" in node && node.source) {
    one("File", `${node.source.file}:${node.source.line}`, true);
  }
  return rows;
}

/** The connections with one node at the other end (M10-design B10). */
export interface ConnectionGroup {
  other: GraphNode;
  edges: GraphEdge[];
  /** The weakest confidence among `edges`. */
  weakest: Confidence;
}

/** Connections grouped by the node at the other end, in the order each first appears. */
export function groupConnections(list: readonly NodeConnection[]): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>();
  for (const { edge, other } of list) {
    const group = groups.get(other.id);
    if (!group) groups.set(other.id, { other, edges: [edge], weakest: edge.confidence });
    else {
      group.edges.push(edge);
      if (STRENGTH[edge.confidence] < STRENGTH[group.weakest]) group.weakest = edge.confidence;
    }
  }
  return [...groups.values()];
}

/**
 * A group's call sites, one per line (the list shows file and line, so two edges from one line,
 * as when a route runs two handlers in one folder, list it once: its first column), by file, then
 * line.
 */
export function groupSites(group: ConnectionGroup): CallSite[] {
  const seen = new Map<string, CallSite>();
  for (const e of group.edges) {
    for (const s of e.sites) {
      const key = `${s.file}:${s.line}`;
      const known = seen.get(key);
      if (!known || s.column < known.column) seen.set(key, s);
    }
  }
  return [...seen.values()].sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line);
}

/** Call sites an edge stands for: its sites, or one for an edge that lists none. */
function siteCount(edge: GraphEdge): number {
  return Math.max(edge.sites.length, 1);
}

/** A group's line in words: its call sites counted per kind ("2 calls", "1 read, 1 write"). */
export function groupCountText(group: ConnectionGroup): string {
  const byKind = new Map<EdgeKind, number>();
  for (const e of group.edges) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + siteCount(e));
  return [...byKind]
    .map(([kind, n]) => {
      const noun = EDGE_WORDS[kind].noun;
      return `${n.toLocaleString("en-US")} ${n === 1 ? noun : noun.endsWith("sh") ? `${noun}es` : `${noun}s`}`;
    })
    .join(", ");
}

/** A group's confidences, strongest first, for its tooltip: "1 exact, 1 heuristic". */
export function confidenceMix(group: ConnectionGroup): string {
  const counts = new Map<Confidence, number>();
  for (const e of group.edges) counts.set(e.confidence, (counts.get(e.confidence) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => STRENGTH[b[0]] - STRENGTH[a[0]])
    .map(([c, n]) => `${n} ${c}`)
    .join(", ");
}
