import type { GraphNode } from "@gitinside/schema";
import { brandForFramework, brandForHost } from "../icons/brands.js";
import { textWidth } from "../image/markup.js";
import { commonGeneratedPath } from "../model/generatedPaths.js";
import {
  entryGroupKind,
  HOSTS_GROUP_PREFIX,
  importsIn,
  isEntryGroup,
  isImportsGroup,
  isUnresolvedGroup,
} from "../model/groups.js";
import { countsInside, type HierarchyIndex } from "../model/hierarchy.js";
import type { NodeCount, NodeText } from "./describe.js";

/**
 * The prototype's cards (M10.3b3, M10-design B7 and B8), for the explorer's `design="prototype"`
 * only. Everything is a fact of the graph, so the same graph always draws the same cards:
 *
 * - **A count row on every service:** its pages, routes, models, outside APIs (distinct outside
 *   hosts called from inside it), and unresolved calls; a service with none of those shows its
 *   file count ("38 files").
 * - **Its role in the subtitle:** the framework by name, then what the service is by its
 *   entries: "app" with pages, "API" with routes, "package" when other services import or call
 *   it, else by its layer ("app", "server", "worker"), "package" with none ("Next.js app",
 *   "Express API", "React package").
 * - **Duplicate names:** when two services have the same name, each card shows its folder as the
 *   name (the repo root's as "repo root") and the package name as the subtitle's code.
 * - **A host group's tile:** a closed group of outside hosts is a circle tile with up to 4 of its
 *   members' logos (distinct brands, members by most lines first), not a folder.
 *
 * - **An unlinked datastore's caption** (M10.3c2, M10-design A4): a datastore no connection of
 *   any kind reaches or leaves (wanderlust's and maxun's compose databases, which no detector
 *   links to code yet) says "Not linked to code" under its name. It's never moved toward a
 *   service it might belong to.
 *
 * - **A route or page group** (M10.3d3, M10-design B3) is a capsule, like a route, on a closed
 *   frame's stacked edge; its name already holds its count ("/api/auth · 7 routes"). A group of
 *   a service's unresolved calls says so in its subtitle, dotted like the calls it holds.
 * - **Imports not in the repo** (M10.3d4, M10-design B4): dotted too, its subtitle naming the
 *   generated folder at least half its imports point to ("React Router types `./+types/*`").
 *
 * Names wrap rather than end in "…" ({@link nameLines}); the shared `@scope/` stays in the name,
 * muted (nodes.css).
 *
 * Not handled: modules, files, and the other kinds keep their cards; a duplicate name among
 * datastores (documenso's three PostgreSQL `database`s) isn't told apart, since the design asks
 * it of services only.
 */

/** What a prototype card draws in place of the shipped card's text and badges. */
export interface CardLook {
  /** The name drawn instead of the label (a duplicate name's folder). */
  name?: string;
  /** The line under the name, instead of `nodeSubtitle`'s. */
  subtitle?: NodeText;
  /** The count row; services always have one. */
  counts?: readonly NodeCount[];
  /** A closed host group's logo tile: up to {@link MAX_LOGOS} members with distinct brands. */
  logos?: readonly GraphNode[];
  /** A line under the subtitle, set apart by a dotted rule: {@link UNLINKED_CAPTION}. */
  caption?: string;
  /** The outline instead of `nodeShape`'s: a closed route or page group is a capsule stack. */
  shape?: "capsule";
  /** The glyph instead of the node's own: a group shows its members' ("route", not a folder). */
  glyph?: "route" | "page" | "unresolved";
  /** A dotted outline, like an unresolved node's: a group of unresolved calls or imports. */
  dotted?: true;
}

/** What an unlinked datastore's card says (M10-design A4). */
export const UNLINKED_CAPTION = "Not linked to code";

/** Most logos a host group's tile shows (a 2×2 grid). */
export const MAX_LOGOS = 4;

/** What's known about each service from the whole graph, worked out once per index. */
interface ServiceFacts {
  /** Distinct outside hosts called from inside each service. */
  hosts: ReadonlyMap<string, number>;
  /** Services another service imports or calls into. */
  used: ReadonlySet<string>;
  /** Service labels held by more than one service. */
  duplicates: ReadonlySet<string>;
  /** Nodes some connection starts or ends at. */
  linked: ReadonlySet<string>;
}

const FACTS = new WeakMap<HierarchyIndex, ServiceFacts>();

function factsOf(index: HierarchyIndex): ServiceFacts {
  const known = FACTS.get(index);
  if (known) return known;
  const hosts = new Map<string, Set<string>>();
  const used = new Set<string>();
  const linked = new Set<string>();
  for (const e of index.graph.edges) {
    linked.add(e.from);
    linked.add(e.to);
    const from = index.service.get(e.from);
    if (!from) continue;
    if (index.byId.get(e.to)?.kind === "external") {
      const set = hosts.get(from) ?? new Set<string>();
      set.add(e.to);
      hosts.set(from, set);
    }
    const to = index.service.get(e.to);
    if ((e.kind === "imports" || e.kind === "calls") && to && to !== from) used.add(to);
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const n of index.graph.nodes) {
    if (n.kind !== "service") continue;
    if (seen.has(n.label)) duplicates.add(n.label);
    seen.add(n.label);
  }
  const facts = {
    hosts: new Map([...hosts].map(([id, set]) => [id, set.size])),
    used,
    duplicates,
    linked,
  };
  FACTS.set(index, facts);
  return facts;
}

/**
 * A service's count row: pages, routes, models, outside APIs, unresolved calls (kinds with none
 * left out), or its files when it has none of those.
 */
export function serviceCounts(index: HierarchyIndex, id: string): NodeCount[] {
  const inside = countsInside(index, id);
  const counts: NodeCount[] = [
    { value: inside.page ?? 0, noun: "page" },
    { value: inside.route ?? 0, noun: "route" },
    { value: inside.model ?? 0, noun: "model" },
    { value: factsOf(index).hosts.get(id) ?? 0, noun: "outside API" },
    { value: inside.unresolved ?? 0, noun: "unresolved call", unresolved: true },
  ].filter((c) => c.value > 0);
  return counts.length > 0 ? counts : [{ value: inside.file ?? 0, noun: "file" }];
}

/** What a service is, in words: its framework and its role ("Next.js app", "Package"). */
export function serviceRole(index: HierarchyIndex, node: GraphNode): string {
  if (node.kind !== "service") return "";
  const inside = countsInside(index, node.id);
  const noun =
    (inside.page ?? 0) > 0
      ? "app"
      : (inside.route ?? 0) > 0
        ? "API"
        : factsOf(index).used.has(node.id)
          ? "package"
          : node.layer === "frontend"
            ? "app"
            : node.layer === "backend"
              ? "server"
              : node.layer === "infra"
                ? "worker"
                : "package";
  const framework = node.framework
    ? (brandForFramework(node.framework)?.title ?? node.framework)
    : undefined;
  return framework ? `${framework} ${noun}` : noun.charAt(0).toUpperCase() + noun.slice(1);
}

/** Whether a node is a group of outside hosts (`summarizeGraph`). */
export function isHostGroup(node: Pick<GraphNode, "id">): boolean {
  return node.id.startsWith(HOSTS_GROUP_PREFIX);
}

/** Up to {@link MAX_LOGOS} of a host group's members with a logo, one per brand, in member order. */
export function groupLogos(index: HierarchyIndex, id: string): GraphNode[] {
  const brands = new Set<string>();
  const out: GraphNode[] = [];
  for (const m of index.children.get(id) ?? []) {
    const brand = m.kind === "external" ? brandForHost(m.host) : undefined;
    if (!brand || brands.has(brand.slug)) continue;
    brands.add(brand.slug);
    out.push(m);
    if (out.length === MAX_LOGOS) break;
  }
  return out;
}

/**
 * The prototype's look for a closed box (see the module's doc), or undefined for a node it
 * doesn't change. An open box keeps the shipped header.
 */
export function cardLook(index: HierarchyIndex, node: GraphNode): CardLook | undefined {
  if (node.kind === "service") {
    const role = serviceRole(index, node);
    const counts = serviceCounts(index, node.id);
    if (factsOf(index).duplicates.has(node.label)) {
      return {
        name: node.root || "repo root",
        subtitle: { text: role, code: node.label },
        counts,
      };
    }
    return { subtitle: { text: role, ...(node.root ? { code: node.root } : {}) }, counts };
  }
  if (isHostGroup(node)) {
    return { subtitle: { text: "Outside hosts" }, counts: [], logos: groupLogos(index, node.id) };
  }
  // Their names already say how many: "/api/auth · 7 routes", "URL built at runtime · 84".
  if (isEntryGroup(node)) {
    return { counts: [], shape: "capsule", glyph: entryGroupKind(node) ?? "route" };
  }
  if (isImportsGroup(node)) {
    const common = commonGeneratedPath(importsIn(index, node.id).map((m) => m.expression));
    return {
      subtitle: common
        ? { text: common.path.note, code: common.path.shown }
        : { text: "Unresolved imports" },
      counts: [],
      glyph: "unresolved",
      dotted: true,
    };
  }
  if (isUnresolvedGroup(node)) {
    return {
      subtitle: { text: "Unresolved calls" },
      counts: [],
      glyph: "unresolved",
      dotted: true,
    };
  }
  if (node.kind === "datastore" && !factsOf(index).linked.has(node.id)) {
    return { caption: UNLINKED_CAPTION };
  }
  return undefined;
}

/** Characters a long name may break after, besides spaces and hyphens: paths, hosts, scopes. */
const BREAK_AFTER = /(?<=[/._ -])/;

/** A name's pieces, each ending where a line may break. */
export function namePieces(name: string): string[] {
  return name.split(BREAK_AFTER).filter((p) => p.length > 0);
}

/**
 * How many lines `name` takes at `size` px in `width` px, breaking greedily after
 * {@link namePieces}' ends, and anywhere inside a piece wider than the line (CSS
 * `overflow-wrap: anywhere`), as the browser does. The estimate is a little wide
 * ({@link textWidth}), so the browser never needs more lines than this.
 */
export function nameLines(name: string, size: number, width: number): number {
  if (width <= 0) return 1;
  let lines = 1;
  let used = 0;
  for (const piece of namePieces(name)) {
    const w = textWidth(piece, size);
    if (used + w <= width) {
      used += w;
      continue;
    }
    if (w <= width) {
      lines += used > 0 ? 1 : 0;
      used = w;
      continue;
    }
    // Too wide for any line: it starts a line of its own and breaks inside.
    if (used > 0) lines += 1;
    const whole = Math.ceil(w / width);
    lines += whole - 1;
    used = w - (whole - 1) * width;
  }
  return lines;
}
