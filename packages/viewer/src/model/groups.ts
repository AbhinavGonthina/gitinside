import { compareStrings } from "@gitinside/schema";
import type { ArchitectureGraph, EdgeKind, GraphNode, Layer } from "@gitinside/schema";
import { HOST_GROUPS, hostGroupFor, OTHER_HOSTS, type HostGroup } from "../icons/hostGroups.js";
import { buildHierarchy, type HierarchyIndex } from "./hierarchy.js";

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
 * Not handled: a shared service nested below the top level (none are), and groups inside a
 * broken-down service (B3, M10.3d). A closed host group's logo tile is `cardLook`'s (M10.3b3).
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
 * group goes where its first member was in graph order, its members right after it; a graph with
 * nothing to group comes back as is.
 */
export function summarizeGraph(graph: ArchitectureGraph): ArchitectureGraph {
  const index = buildHierarchy(graph);
  const groups = [sharedGroup(index), ...hostGroups(index)].filter((g) => g !== undefined);
  if (groups.length === 0) return graph;
  const groupOf = new Map<string, Group>();
  for (const g of groups) for (const m of g.members) groupOf.set(m.id, g);
  const placed = new Set<Group>();
  const nodes: GraphNode[] = [];
  for (const n of graph.nodes) {
    const group = groupOf.get(n.id);
    if (!group) {
      nodes.push(n);
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
  const hosts = hostGroupOf(parent.id);
  if (hosts) return `Grouped under ${inSentence(hosts.title)}.`;
  const users = usersOf(index, node.id);
  const used = users.length > 0 ? ` Used by ${names(users)}.` : "";
  const group = parent.label === "Repo root" ? "the repo root" : "shared packages";
  return `Grouped with ${group}: no routes, pages, or requests of its own.${used}`;
}
