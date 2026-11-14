import { compareStrings, UnresolvedReason } from "@gitinside/schema";
import type { ArchitectureGraph, EdgeKind, GraphNode, Layer } from "@gitinside/schema";
import { HOST_GROUPS, hostGroupFor, OTHER_HOSTS, type HostGroup } from "../icons/hostGroups.js";
import { REASON_TEXT } from "../nodes/describe.js";
import { commonGeneratedPath } from "./generatedPaths.js";
import {
  buildHierarchy,
  compareEntries,
  countsInside,
  type EntryNode,
  type HierarchyIndex,
} from "./hierarchy.js";

/**
 * A system level that summarizes (M10.3b1, M10-design A3 and A6), for the prototype design only:
 * the graph with two kinds of group added at the top level, so a monorepo's config packages and
 * anything-llm's 50 outside APIs don't each take a box beside the services that do the work.
 *
 * - **Shared packages:** a top-level service with no routes or pages and no request, data, queue,
 *   or outside call from anywhere inside it (no `http`, `reads`, `writes`, `stores`, `publishes`,
 *   `consumes`, or `external_call` edge) only holds code other services use. Two or more such
 *   services go in one "Shared packages · N" box; in a repo with several services, a repo-root
 *   service that qualifies goes in even alone, as "Repo root" (wanderlust's `app`).
 * - **Outside hosts by purpose:** top-level outside APIs grouped by `hostGroupFor`; a group of
 *   {@link MIN_HOST_GROUP} or more is one box ("AI models · 27"), smaller ones stay themselves.
 *
 * Groups are `module` nodes (a folder that breaks down like any other) with IDs under
 * {@link GROUP_PREFIX}, which no analyzed node has; members move under them and nothing else
 * changes: every edge, ID, and field is the graph's, so lifting, traces, search, and selection work
 * as before and a group's lines are its members' lines lifted. Deterministic: graph order, ties by
 * `compareStrings`.
 *
 * - **Route and page groups inside a service** (M10.3d3, M10-design B3): a service with more
 *   than {@link MAX_ENTRY_BOXES} routes and pages has them grouped by path (`entryLevel`), so its
 *   first level leads with `/api/auth · 7 routes` rather than a column of 315 routes. A grouped
 *   entry moves out of its file into its group, so it's drawn there even when its file is open.
 *   Likewise a service drawing more than {@link MAX_ENTRY_BOXES} unresolved calls has them
 *   grouped by reason (`unresolvedGroups`).
 * - **Imports not in the repo** (M10.3d4, M10-design B4): a service's unresolved imports (nodes
 *   only `imports` edges reach) go in one box per reason at any count of 2 or more, "Not in the
 *   repo · 84 imports" (`importsGroups`), named for the generated folder most of them point to.
 *
 * Not handled: a shared service nested below the top level (none are); an entry with no literal
 * segment left (`/:id`, `/*`) stays itself at its level (or in "Other"), and two parameters of
 * different names (`/:id/x`, `/:slug/x`) make two groups.
 * A closed host group's logo tile is `cardLook`'s (M10.3b3), as is a route group's capsule.
 */

/** The ID prefix of a group node; analyzed node IDs start with their kind, never this. */
export const GROUP_PREFIX = "group:";
/** The shared packages' group. */
export const SHARED_GROUP = `${GROUP_PREFIX}shared`;
/** The prefix of the outside hosts' groups: `group:hosts/<slug>`. */
export const HOSTS_GROUP_PREFIX = `${GROUP_PREFIX}hosts/`;
/** Fewest services a "Shared packages" box is made for (a lone repo root aside). */
export const MIN_SHARED_GROUP = 2;
/** Fewest hosts a purpose gets its own box for; fewer stay themselves. */
export const MIN_HOST_GROUP = 3;

/** Edges that are a service's own work rather than code others call. */
const OWN_WORK: ReadonlySet<EdgeKind> = new Set([
  "http",
  "reads",
  "writes",
  "stores",
  "publishes",
  "consumes",
  "external_call",
]);

/** Whether a node is one of the summary's groups rather than something the analyzer found. */
export function isGroup(node: Pick<GraphNode, "id">): boolean {
  return node.id.startsWith(GROUP_PREFIX);
}

/** The purpose a hosts group stands for, by its ID. */
function hostGroupOf(id: string): HostGroup | undefined {
  if (!id.startsWith(HOSTS_GROUP_PREFIX)) return undefined;
  const slug = id.slice(HOSTS_GROUP_PREFIX.length);
  if (slug === OTHER_HOSTS.slug) return OTHER_HOSTS;
  const found = HOST_GROUPS.find((g) => g.slug === slug);
  return found && { slug: found.slug, title: found.title };
}

/**
 * The top-level services that only hold shared code, in graph order: no entries and no edge of
 * {@link OWN_WORK} from anywhere inside.
 */
export function sharedServices(index: HierarchyIndex): GraphNode[] {
  const busy = new Set<string>();
  for (const e of index.graph.edges) {
    const owner = index.service.get(e.from);
    if (owner && OWN_WORK.has(e.kind)) busy.add(owner);
  }
  return (index.children.get(index.root.id) ?? []).filter(
    (n) => n.kind === "service" && (index.entries.get(n.id)?.length ?? 0) === 0 && !busy.has(n.id),
  );
}

/**
 * The band the shared group sits in: the layer of the service using its members most (edges
 * from it into them), Backend when two layers tie for most or nothing uses them.
 */
function sharedLayer(index: HierarchyIndex, members: ReadonlySet<string>): Layer {
  const uses = new Map<string, number>();
  for (const e of index.graph.edges) {
    const from = index.service.get(e.from);
    const to = index.service.get(e.to);
    if (from && to && members.has(to) && !members.has(from)) {
      uses.set(from, (uses.get(from) ?? 0) + 1);
    }
  }
  const most = Math.max(0, ...uses.values());
  const layers = new Set(
    [...uses].filter(([, n]) => n === most).map(([id]) => index.byId.get(id)?.layer ?? "backend"),
  );
  const [only] = layers;
  return layers.size === 1 && only ? only : "backend";
}

/** One group to add: its node, and its members in the order they're drawn in it. */
interface Group {
  node: GraphNode;
  members: readonly GraphNode[];
}

/** The shared packages' group, if the graph has one. */
function sharedGroup(index: HierarchyIndex): Group | undefined {
  const members = sharedServices(index);
  const services = (index.children.get(index.root.id) ?? []).filter((n) => n.kind === "service");
  const [first] = members;
  const loneRoot =
    members.length === 1 && first?.kind === "service" && first.root === "" && services.length > 1;
  if (members.length < MIN_SHARED_GROUP && !loneRoot) return undefined;
  const label = loneRoot ? "Repo root" : `Shared packages · ${members.length}`;
  const layer = sharedLayer(index, new Set(members.map((m) => m.id)));
  return {
    node: { id: SHARED_GROUP, kind: "module", label, parentId: index.root.id, path: "", layer },
    members,
  };
}

/** The prefix of the entry groups: `group:routes/…` and `group:pages/…`. */
export const ENTRY_GROUP_PREFIXES = {
  route: `${GROUP_PREFIX}routes/`,
  page: `${GROUP_PREFIX}pages/`,
} as const;
/**
 * Most entries a service shows ungrouped, and most boxes one level of its entries draws
 * (M10-design B3: "more than 12 entries").
 */
export const MAX_ENTRY_BOXES = 12;

/** A path's segments, without the empty ones around slashes. */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/** Whether a path segment is written out, not a parameter (`:id`) or a catch-all (`*slug`). */
function isLiteral(segment: string): boolean {
  return !/^[:*[]/.test(segment);
}

/** Whether a node is one of a service's route or page groups (`summarizeGraph`). */
export function isEntryGroup(node: Pick<GraphNode, "id">): boolean {
  return entryGroupKind(node) !== undefined;
}

/** The kind a route or page group holds, or undefined for any other node. */
export function entryGroupKind(node: Pick<GraphNode, "id">): EntryNode["kind"] | undefined {
  if (node.id.startsWith(ENTRY_GROUP_PREFIXES.route)) return "route";
  if (node.id.startsWith(ENTRY_GROUP_PREFIXES.page)) return "page";
  return undefined;
}

/**
 * What an entry group's ID says: the kind it groups and its path prefix (undefined for
 * "Other"), or undefined for any other ID.
 */
function entryGroupOf(
  id: string,
): { kind: EntryNode["kind"]; prefix: string | undefined } | undefined {
  const kind = entryGroupKind({ id });
  if (!kind) return undefined;
  const last = id.slice(id.lastIndexOf("#") + 1);
  return { kind, prefix: last === "other" ? undefined : last };
}

/**
 * One group inside a service, nested: its node, its entries, and what's drawn inside it (groups
 * first). An unresolved calls' group has no entries or prefix.
 */
interface EntryGroup {
  node: GraphNode;
  /** The path prefix its entries share ("/api/auth"); "" for "Other". */
  prefix: string;
  /** Every entry under it, at any depth, in entry order. */
  entries: readonly EntryNode[];
  inside: readonly (EntryGroup | GraphNode)[];
}

/** "12 routes", "1 page". */
function entryCountText(kind: EntryNode["kind"], n: number): string {
  return `${n} ${kind}${n === 1 ? "" : "s"}`;
}

/**
 * One level of a service's entries of one kind, grouped (M10-design B3): entries whose paths are
 * the same through their first literal segment from `depth` on (parameters before it included:
 * `/api/workspace/:slug/thread`) go in one group (`/auth · 12 routes`; groups of 1 aren't formed),
 * and the rest stay themselves; a group holding more than {@link MAX_ENTRY_BOXES} breaks down the
 * same way by the literal segment after its prefix. A level of more than {@link MAX_ENTRY_BOXES} boxes keeps its
 * largest groups (ties by prefix) and puts the rest in "Other routes · N", grouped the same way
 * inside, so no level draws more than {@link MAX_ENTRY_BOXES}. Groups come sorted by prefix, then
 * the level's own entries in entry order, then "Other". `id` is the level's frame (the service
 * or a group), `base` the service's group ID prefix.
 */
function entryLevel(
  kind: EntryNode["kind"],
  entries: readonly EntryNode[],
  depth: number,
  id: string,
  base: string,
): (EntryGroup | EntryNode)[] {
  const buckets = new Map<string, EntryNode[]>();
  const loose: EntryNode[] = [];
  for (const e of entries) {
    const parts = segments(e.path);
    const at = parts.findIndex((s, i) => i >= depth && isLiteral(s));
    if (at === -1) {
      loose.push(e);
      continue;
    }
    // Through the next literal segment, past any parameters before it.
    const prefix = `/${parts.slice(0, at + 1).join("/")}`;
    const bucket = buckets.get(prefix) ?? [];
    bucket.push(e);
    buckets.set(prefix, bucket);
  }
  const groups: EntryGroup[] = [];
  for (const [prefix, members] of buckets) {
    if (members.length === 1) {
      loose.push(...members);
      continue;
    }
    const groupId = `${base}#${prefix}`;
    const next = segments(prefix).length;
    groups.push({
      node: {
        id: groupId,
        kind: "module",
        label: `${prefix} · ${entryCountText(kind, members.length)}`,
        parentId: id,
        path: "",
      },
      prefix,
      entries: members,
      inside:
        members.length > MAX_ENTRY_BOXES
          ? entryLevel(kind, members, next, groupId, base)
          : members.map((m) => ({ ...m, parentId: groupId })),
    });
  }
  const byPrefix = (a: EntryGroup, b: EntryGroup) => compareStrings(a.prefix, b.prefix);
  const own = (list: readonly EntryNode[]) =>
    [...list].sort(compareEntries).map((e) => ({ ...e, parentId: id }));
  if (groups.length === 0 || groups.length + loose.length <= MAX_ENTRY_BOXES) {
    return [...groups.sort(byPrefix), ...own(loose)];
  }
  const largest = groups.sort((a, b) => b.entries.length - a.entries.length || byPrefix(a, b));
  const kept = largest.slice(0, MAX_ENTRY_BOXES - 1);
  const rest = [...largest.slice(MAX_ENTRY_BOXES - 1).flatMap((g) => g.entries), ...loose].sort(
    compareEntries,
  );
  const otherId = `${id.startsWith(GROUP_PREFIX) ? id : base}#other`;
  const other: EntryGroup = {
    node: {
      id: otherId,
      kind: "module",
      label: `Other ${kind}s · ${rest.length}`,
      parentId: id,
      path: "",
    },
    prefix: "",
    entries: rest,
    inside: entryLevel(kind, rest, depth, otherId, base),
  };
  return [...kept.sort(byPrefix), other];
}

/**
 * Each service's route and page groups (M10-design B3), for a service with more than
 * {@link MAX_ENTRY_BOXES} entries: its routes grouped by their first segment, and its pages
 * likewise. A first `/api` segment is looked past when every entry of that kind with a segment
 * after it starts with it (wanderlust's routes, and anything-llm's server, whose `robots.txt` and
 * `manifest.json` don't), so `/api/auth/*` groups as `/api/auth`, not all in `/api`.
 */
function entryGroups(index: HierarchyIndex): Map<string, EntryGroup[]> {
  const out = new Map<string, EntryGroup[]>();
  for (const [service, entries] of index.entries) {
    if (entries.length <= MAX_ENTRY_BOXES) continue;
    const groups: EntryGroup[] = [];
    for (const kind of ["page", "route"] as const) {
      const own = entries.filter((e) => e.kind === kind);
      const long = own.map((e) => segments(e.path)).filter((p) => p.length > 1);
      const depth = long.length > 0 && long.every((p) => p[0] === "api") ? 1 : 0;
      const base = `${ENTRY_GROUP_PREFIXES[kind]}${service}`;
      for (const item of entryLevel(kind, own, depth, service, base)) {
        if ("inside" in item) groups.push(item);
      }
    }
    if (groups.length > 0) out.set(service, groups);
  }
  return out;
}

/** The prefix of a service's unresolved calls' groups: `group:unresolved/<service>#<reason>`. */
export const UNRESOLVED_GROUP_PREFIX = `${GROUP_PREFIX}unresolved/`;

/** Whether a node is one of a service's groups of unresolved calls (`summarizeGraph`). */
export function isUnresolvedGroup(node: Pick<GraphNode, "id">): boolean {
  return node.id.startsWith(UNRESOLVED_GROUP_PREFIX);
}

/** What an imports group's ID ends with before its reason: `…#imports/UNKNOWN_SYMBOL`. */
const IMPORTS_MARK = "#imports/";

/** The reason a group of unresolved calls or imports stands for, by its ID. */
function unresolvedReasonOf(id: string): UnresolvedReason | undefined {
  if (!isUnresolvedGroup({ id })) return undefined;
  // `…#DYNAMIC_URL` for calls, `…#imports/UNKNOWN_SYMBOL` for imports.
  const parsed = UnresolvedReason.safeParse(
    id.slice(Math.max(id.lastIndexOf("#"), id.lastIndexOf("/")) + 1),
  );
  return parsed.success ? parsed.data : undefined;
}

/** Whether a node is one of a service's groups of unresolved imports ("Not in the repo"). */
export function isImportsGroup(node: Pick<GraphNode, "id">): boolean {
  return isUnresolvedGroup(node) && node.id.includes(IMPORTS_MARK);
}

/**
 * The unresolved nodes that only stand for imports: every edge into them is an `imports` edge,
 * and there's one at least (documenso's `./+types/root`, a file React Router writes at build time).
 */
function importOnly(index: HierarchyIndex): Set<string> {
  const kinds = new Map<string, boolean>();
  for (const e of index.graph.edges) {
    const target = index.byId.get(e.to);
    if (target?.kind !== "unresolved") continue;
    kinds.set(e.to, (kinds.get(e.to) ?? true) && e.kind === "imports");
  }
  return new Set([...kinds].filter(([, only]) => only).map(([id]) => id));
}

/** An unresolved node. */
export type UnresolvedNode = Extract<GraphNode, { kind: "unresolved" }>;

/**
 * The imports inside an imports group (`isImportsGroup`), by file, then line, then column: what
 * the panel lists. Empty for any other node.
 */
export function importsIn(index: HierarchyIndex, id: string): UnresolvedNode[] {
  if (!isImportsGroup({ id })) return [];
  const at = (n: UnresolvedNode) => n.source ?? { file: "", line: 0, column: 0 };
  return (index.children.get(id) ?? [])
    .filter((n): n is UnresolvedNode => n.kind === "unresolved")
    .sort(
      (a, b) =>
        compareStrings(at(a).file, at(b).file) ||
        at(a).line - at(b).line ||
        at(a).column - at(b).column ||
        compareStrings(a.id, b.id),
    );
}

/** "Not in the repo · 84 imports"; another reason says itself ("Name chosen at runtime · 2 imports"). */
function importsLabel(reason: UnresolvedReason, n: number): string {
  const what = reason === "UNKNOWN_SYMBOL" ? "Not in the repo" : REASON_TEXT[reason];
  return `${what} · ${n} import${n === 1 ? "" : "s"}`;
}

/**
 * Each service's unresolved imports, grouped by reason (M10-design B4): a reason with 2 or more
 * is one box, "Not in the repo · 84 imports", breaking down to each import; one stays itself.
 * Unlike calls, they're grouped at any count: they are rarely the architecture, and the box's
 * subtitle (`commonGeneratedPath`) says what most of them are. Nothing is hidden: each import is
 * inside its box with its file and line, and the panel lists them all.
 */
function importsGroups(
  index: HierarchyIndex,
  imports: ReadonlySet<string>,
): Map<string, EntryGroup[]> {
  const out = new Map<string, EntryGroup[]>();
  for (const service of index.graph.nodes) {
    if (service.kind !== "service") continue;
    const own = (index.children.get(service.id) ?? []).filter((n) => imports.has(n.id));
    const groups = UnresolvedReason.options.flatMap((reason): EntryGroup[] => {
      const members = own.filter((n) => n.kind === "unresolved" && n.reason === reason);
      if (members.length < 2) return [];
      const id = `${UNRESOLVED_GROUP_PREFIX}${service.id}${IMPORTS_MARK}${reason}`;
      return [
        {
          node: {
            id,
            kind: "module",
            label: importsLabel(reason, members.length),
            parentId: service.id,
            path: "",
          },
          prefix: "",
          entries: [],
          inside: members.map((m) => ({ ...m, parentId: id })),
        },
      ];
    });
    if (groups.length > 0) out.set(service.id, groups);
  }
  return out;
}

/**
 * Each service's unresolved calls, grouped by reason (M10-design B3's "calls out"), for a
 * service drawing more than {@link MAX_ENTRY_BOXES} of them directly: anything-llm's server holds
 * 148, which made its broken-down frame 11,436px tall. A reason with 2 or more is one box, "URL
 * built at runtime · 84", breaking down to each call; a reason with 1 stays itself. Reasons in
 * the schema's order. Nothing is hidden: each call is inside its box, with its reason and line.
 * Imports aren't calls (`importsGroups`): they neither count nor go in these boxes.
 */
function unresolvedGroups(
  index: HierarchyIndex,
  imports: ReadonlySet<string>,
): Map<string, EntryGroup[]> {
  const out = new Map<string, EntryGroup[]>();
  for (const service of index.graph.nodes) {
    if (service.kind !== "service") continue;
    const calls = (index.children.get(service.id) ?? []).filter(
      (n) => n.kind === "unresolved" && !imports.has(n.id),
    );
    if (calls.length <= MAX_ENTRY_BOXES) continue;
    const groups = UnresolvedReason.options.flatMap((reason): EntryGroup[] => {
      const members = calls.filter((n) => n.kind === "unresolved" && n.reason === reason);
      if (members.length < 2) return [];
      const id = `${UNRESOLVED_GROUP_PREFIX}${service.id}#${reason}`;
      return [
        {
          node: {
            id,
            kind: "module",
            label: `${REASON_TEXT[reason]} · ${members.length}`,
            parentId: service.id,
            path: "",
          },
          prefix: "",
          entries: [],
          inside: members.map((m) => ({ ...m, parentId: id })),
        },
      ];
    });
    if (groups.length > 0) out.set(service.id, groups);
  }
  return out;
}

/** A group's node and everything inside it, depth first (a frame before its children). */
function flatten(group: EntryGroup): GraphNode[] {
  return [
    group.node,
    ...group.inside.flatMap((item) => ("inside" in item ? flatten(item) : [item])),
  ];
}

/** The outside hosts' groups of {@link MIN_HOST_GROUP} or more, members by most lines first. */
function hostGroups(index: HierarchyIndex): Group[] {
  const lines = new Map<string, number>();
  for (const e of index.graph.edges) lines.set(e.to, (lines.get(e.to) ?? 0) + 1);
  const bySlug = new Map<string, { group: HostGroup; members: GraphNode[] }>();
  for (const n of index.children.get(index.root.id) ?? []) {
    if (n.kind !== "external") continue;
    const group = hostGroupFor(n.host);
    const entry = bySlug.get(group.slug) ?? { group, members: [] };
    entry.members.push(n);
    bySlug.set(group.slug, entry);
  }
  return [...bySlug.values()]
    .filter((g) => g.members.length >= MIN_HOST_GROUP)
    .map(({ group, members }) => ({
      node: {
        id: `${HOSTS_GROUP_PREFIX}${group.slug}`,
        kind: "module",
        label: `${group.title} · ${members.length}`,
        parentId: index.root.id,
        path: "",
        layer: "external",
      },
      members: [...members].sort(
        (a, b) =>
          (lines.get(b.id) ?? 0) - (lines.get(a.id) ?? 0) ||
          compareStrings(
            a.kind === "external" ? a.host : a.id,
            b.kind === "external" ? b.host : b.id,
          ),
      ),
    }));
}

/**
 * The graph with its groups added and their members moved under them (see the module's doc). Each
 * top-level group goes where its first member was in graph order, its members right after it; a
 * service's route and page groups go right after the service, each followed by what's inside it.
 * A graph with nothing to group comes back as is.
 */
export function summarizeGraph(graph: ArchitectureGraph): ArchitectureGraph {
  const index = buildHierarchy(graph);
  const groups = [sharedGroup(index), ...hostGroups(index)].filter((g) => g !== undefined);
  const byService = new Map<string, GraphNode[]>();
  const imports = importOnly(index);
  for (const found of [
    entryGroups(index),
    unresolvedGroups(index, imports),
    importsGroups(index, imports),
  ]) {
    for (const [service, list] of found) {
      byService.set(service, [...(byService.get(service) ?? []), ...list.flatMap(flatten)]);
    }
  }
  if (groups.length === 0 && byService.size === 0) return graph;
  const groupOf = new Map<string, Group>();
  for (const g of groups) for (const m of g.members) groupOf.set(m.id, g);
  const grouped = new Set<string>();
  for (const list of byService.values()) {
    for (const n of list) if (!isGroup(n)) grouped.add(n.id);
  }
  const placed = new Set<Group>();
  const nodes: GraphNode[] = [];
  for (const n of graph.nodes) {
    if (grouped.has(n.id)) continue;
    const group = groupOf.get(n.id);
    if (!group) {
      nodes.push(n, ...(byService.get(n.id) ?? []));
      continue;
    }
    if (placed.has(group)) continue;
    placed.add(group);
    nodes.push(group.node, ...group.members.map((m) => ({ ...m, parentId: group.node.id })));
  }
  return { ...graph, nodes };
}

/** A list in words: "a", "a and b", "a, b and 4 more" (at most three names). */
function names(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length <= 3) return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
  return `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`;
}

/** A group's title inside a sentence: "payments", but "AI models" keeps its acronym. */
function inSentence(title: string): string {
  const second = title.charAt(1);
  return second === second.toLowerCase() ? title.charAt(0).toLowerCase() + title.slice(1) : title;
}

/** The labels of the services with edges into `id`'s inside, most edges first. */
function usersOf(index: HierarchyIndex, id: string): string[] {
  const uses = new Map<string, number>();
  for (const e of index.graph.edges) {
    const from = index.service.get(e.from);
    if (index.service.get(e.to) === id && from && from !== id) {
      uses.set(from, (uses.get(from) ?? 0) + 1);
    }
  }
  return [...uses]
    .sort(([a, x], [b, y]) => y - x || compareStrings(a, b))
    .map(([s]) => index.byId.get(s)?.label ?? s);
}

/**
 * The inspector's lead sentence for a group (it has no fields of its own to describe), or
 * undefined for any other node.
 */
export function groupLead(index: HierarchyIndex, node: GraphNode): string | undefined {
  if (!isGroup(node)) return undefined;
  const reason = unresolvedReasonOf(node.id);
  if (reason && isImportsGroup(node)) {
    const members = importsIn(index, node.id);
    const what = `${members.length} imports`;
    if (reason !== "UNKNOWN_SYMBOL") {
      return `${what} the analysis couldn't link: ${REASON_TEXT[reason].toLowerCase()}.`;
    }
    const common = commonGeneratedPath(members.map((m) => m.expression));
    const most = common
      ? ` ${common.count === members.length ? "All" : `${common.count}`} point to ${common.path.shown}: ${common.path.note}.`
      : "";
    return `${what} of files the analysis couldn't find in the repo.${most}`;
  }
  if (reason) {
    const n = index.children.get(node.id)?.length ?? 0;
    return `${n} calls the analysis couldn't link, all for one reason: ${REASON_TEXT[reason].toLowerCase()}.`;
  }
  const entries = entryGroupOf(node.id);
  if (entries) {
    const inside = countsInside(index, node.id)[entries.kind] ?? 0;
    const what = entryCountText(entries.kind, inside);
    const nested = (index.children.get(node.id) ?? []).some(isGroup)
      ? ", grouped by the next part of the path"
      : "";
    return entries.prefix === undefined
      ? `${what} from smaller groups, kept together so this level draws at most ${MAX_ENTRY_BOXES} boxes.`
      : `${what} whose path starts with ${entries.prefix}${nested}.`;
  }
  const members = index.children.get(node.id) ?? [];
  const labels = members.map((m) => (m.kind === "external" ? m.host : m.label));
  const hosts = hostGroupOf(node.id);
  if (hosts) {
    const purpose = hosts === OTHER_HOSTS ? "with no group" : `for ${inSentence(hosts.title)}`;
    return `${members.length} outside hosts ${purpose}: ${names(labels)}.`;
  }
  if (node.label === "Repo root") {
    return `The repo root's own package, with no routes, pages, or requests: ${names(labels)}.`;
  }
  return `${members.length} packages with no routes, pages, or requests of their own: ${names(labels)}.`;
}

/**
 * Why a node sits in a group, for the inspector (M10-design A3: "Grouped with shared packages: no
 * routes, pages, or requests of its own. Used by remix and api."), or undefined outside one.
 */
export function groupNote(index: HierarchyIndex, node: GraphNode): string | undefined {
  const parent = node.parentId === null ? undefined : index.byId.get(node.parentId);
  if (!parent || !isGroup(parent)) return undefined;
  const reason = unresolvedReasonOf(parent.id);
  if (reason && isImportsGroup(parent)) {
    return reason === "UNKNOWN_SYMBOL"
      ? "Grouped with the service's other imports not found in the repo."
      : "Grouped with the service's other imports for this reason.";
  }
  if (reason) return `Grouped with the service's other calls for this reason.`;
  const entries = entryGroupOf(parent.id);
  if (entries) {
    return entries.prefix === undefined
      ? `Grouped with other ${entries.kind}s from smaller groups.`
      : `Grouped with the ${entries.kind}s under ${entries.prefix}.`;
  }
  const hosts = hostGroupOf(parent.id);
  if (hosts) return `Grouped under ${inSentence(hosts.title)}.`;
  const users = usersOf(index, node.id);
  const used = users.length > 0 ? ` Used by ${names(users)}.` : "";
  const group = parent.label === "Repo root" ? "the repo root" : "shared packages";
  return `Grouped with ${group}: no routes, pages, or requests of its own.${used}`;
}
