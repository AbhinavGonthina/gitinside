import {
  compareStrings,
  type ArchitectureGraph,
  type Confidence,
  type GraphNode,
  type UnresolvedReason,
} from "@gitinside/schema";

/**
 * The M10 prototype's API map (M10-design §3.3, M10.3f3): every route in a stored graph with the
 * requests that reach it, and the requests that reach none. Read straight from the graph's `http`
 * edges, standing in for M11.2's engine until that's built (ADR-0292). Nothing is guessed: a
 * route's callers are the call sites of the edges into it, at those edges' confidence, and a request
 * the analyzer couldn't match is listed with the analyzer's own reason, never matched here.
 */

/** One request that reaches a route: where it's made, by what, and how sure the analyzer is. */
export interface ApiCaller {
  file: string;
  line: number;
  column: number;
  /** The edge's confidence: `exact`, `pattern`, or `heuristic`. */
  confidence: Exclude<Confidence, "unresolved">;
  /** The calling node's name (a function, a route's inline handler, a file). */
  name: string;
  /** The caller's service, by name. */
  service: string;
}

/** A route with its callers, sorted by file, line, then column. */
export interface ApiRoute {
  id: string;
  method: string;
  path: string;
  serviceId: string;
  service: string;
  callers: readonly ApiCaller[];
}

/** A request that matches no route, as the analyzer read it. */
export interface ApiCall {
  /** The unresolved node's ID. */
  id: string;
  /** `GET`, `POST`, …, or `?` when the method isn't known. */
  method: string;
  /** The URL as GitInside read it (the unresolved node's label after the method). */
  url: string;
  reason: UnresolvedReason;
  /** Why, in the analyzer's words. */
  detail: string | undefined;
  serviceId: string;
  service: string;
  file: string;
  line: number;
  column: number;
}

/** A repo's API map, every list sorted so the page is deterministic. */
export interface ApiMap {
  /** Sorted by path, then method. */
  routes: readonly ApiRoute[];
  /** Requests for a route the repo doesn't have (`NO_MATCHING_ROUTE`): the broken calls. */
  broken: readonly ApiCall[];
  /** Requests whose URL couldn't be read (`DYNAMIC_URL`, `WRAPPER_DEPTH`, …): never counted as broken. */
  unread: readonly ApiCall[];
  /** The services that serve a route or make an unmatched request, `[id, name]`, by name. */
  services: readonly (readonly [string, string])[];
  /** The methods of the routes and requests, sorted. */
  methods: readonly string[];
}

/** The service a node sits in (its nearest `service` ancestor), or undefined at the system level. */
function serviceOf(
  byId: ReadonlyMap<string, GraphNode>,
  id: string,
): Extract<GraphNode, { kind: "service" }> | undefined {
  let node = byId.get(id);
  while (node && node.kind !== "service")
    node = node.parentId ? byId.get(node.parentId) : undefined;
  return node;
}

const bySite = (a: { file: string; line: number; column: number }, b: typeof a) =>
  compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;

/** The API map of a graph (M10-design §3.3). */
export function apiMap(graph: ArchitectureGraph): ApiMap {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const services = new Map<string, string>();
  const methods = new Set<string>();
  const serviceName = (id: string) => {
    const service = serviceOf(byId, id);
    return { serviceId: service?.id ?? "", service: service?.label ?? "" };
  };

  const callers = new Map<string, ApiCaller[]>();
  const unmatched: ApiCall[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "http") continue;
    const to = byId.get(edge.to);
    const from = byId.get(edge.from);
    if (!to || !from) continue;
    if (to.kind === "route" && edge.confidence !== "unresolved") {
      const list = callers.get(to.id) ?? [];
      const { service } = serviceName(from.id);
      for (const site of edge.sites) {
        list.push({
          file: site.file,
          line: site.line,
          column: site.column,
          confidence: edge.confidence,
          name: from.label,
          service,
        });
      }
      callers.set(to.id, list);
    } else if (to.kind === "unresolved") {
      const [method = "?", ...rest] = to.label.split(" ");
      const where = to.source ?? edge.sites[0];
      if (!where) continue;
      const service = serviceName(to.id);
      unmatched.push({
        id: to.id,
        method,
        url: rest.join(" "),
        reason: to.reason,
        detail: to.detail,
        ...service,
        file: where.file,
        line: where.line,
        column: where.column,
      });
    }
  }

  const routes: ApiRoute[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "route") continue;
    const service = serviceName(node.id);
    routes.push({
      id: node.id,
      method: node.method,
      path: node.path,
      ...service,
      callers: (callers.get(node.id) ?? []).sort(bySite),
    });
  }
  routes.sort(
    (a, b) =>
      compareStrings(a.path, b.path) ||
      compareStrings(a.method, b.method) ||
      compareStrings(a.id, b.id),
  );
  unmatched.sort((a, b) => bySite(a, b) || compareStrings(a.id, b.id));

  for (const item of [...routes, ...unmatched]) {
    if (item.serviceId !== "") services.set(item.serviceId, item.service);
    methods.add(item.method);
  }
  return {
    routes,
    broken: unmatched.filter((c) => c.reason === "NO_MATCHING_ROUTE"),
    unread: unmatched.filter((c) => c.reason !== "NO_MATCHING_ROUTE"),
    services: [...services].sort(
      (a, b) => compareStrings(a[1], b[1]) || compareStrings(a[0], b[0]),
    ),
    methods: [...methods].sort(compareStrings),
  };
}

/** The API map's tabs: every route, routes no request in the repo reaches, and broken calls. */
export const API_TABS = ["all", "dead", "broken"] as const;
export type ApiTab = (typeof API_TABS)[number];

/** What the page shows, as its URL says (`?tab=&q=&service=&method=`). */
export interface ApiQuery {
  tab: ApiTab;
  /** Search text, matched case-insensitively. */
  q: string;
  /** A service's ID, or "" for every service. */
  service: string;
  /** A method, or "" for every method. */
  method: string;
}

export const DEFAULT_API_QUERY: ApiQuery = { tab: "all", q: "", service: "", method: "" };

/** The parameters {@link apiQueryString} writes, in its order. */
export const API_QUERY_PARAMS = ["tab", "q", "service", "method"] as const;

/** A page's query read from its search params; anything repeated or unknown is the default. */
export function parseApiQuery(params: Record<string, string | string[] | undefined>): ApiQuery {
  const one = (name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : "";
  };
  const tab = API_TABS.find((t) => t === one("tab")) ?? "all";
  return { tab, q: one("q"), service: one("service"), method: one("method").toUpperCase() };
}

/** A value with `/`, `:`, and `@` left readable, as the explorer's links write node IDs. */
function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/%(2F|3A|40)/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** The query's non-default parts as `tab=…&q=…`, without a leading `&` (empty for the default). */
export function apiQueryString(query: ApiQuery): string {
  return API_QUERY_PARAMS.filter((p) => query[p] !== DEFAULT_API_QUERY[p])
    .map((p) => `${p}=${encodeValue(query[p])}`)
    .join("&");
}

const matches = (query: ApiQuery, item: ApiRoute | ApiCall, words: readonly string[]) =>
  (query.service === "" || item.serviceId === query.service) &&
  (query.method === "" || item.method === query.method) &&
  words.every(
    (w) => w === "" || item.method.toLowerCase().includes(w) || haystack(item).includes(w),
  );

function haystack(item: ApiRoute | ApiCall): string {
  return (
    "path" in item ? `${item.path} ${item.service}` : `${item.url} ${item.service} ${item.file}`
  ).toLowerCase();
}

/** What the page lists under a query: each list with the service, method, and search applied. */
export interface ApiView {
  all: readonly ApiRoute[];
  dead: readonly ApiRoute[];
  broken: readonly ApiCall[];
  unread: readonly ApiCall[];
}

/** The routes and requests that pass a query's service, method, and search (every tab's). */
export function filterApiMap(map: ApiMap, query: ApiQuery): ApiView {
  const words = query.q.toLowerCase().trim().split(/\s+/);
  const all = map.routes.filter((r) => matches(query, r, words));
  return {
    all,
    dead: all.filter((r) => r.callers.length === 0),
    broken: map.broken.filter((c) => matches(query, c, words)),
    unread: map.unread.filter((c) => matches(query, c, words)),
  };
}

const CONFIDENCE_ORDER = ["exact", "pattern", "heuristic"] as const;

/**
 * A route's Callers cell (M10-design §3.3): "No caller in the repo", "2 · exact", or
 * "5 · 3 exact, 2 heuristic" (strongest first).
 */
export function callersText(callers: readonly ApiCaller[]): string {
  if (callers.length === 0) return "No caller in the repo";
  const counts = CONFIDENCE_ORDER.flatMap((c) => {
    const n = callers.filter((x) => x.confidence === c).length;
    return n === 0 ? [] : [[c, n] as const];
  });
  const [first] = counts;
  if (counts.length === 1 && first) return `${callers.length} · ${first[0]}`;
  return `${callers.length} · ${counts.map(([c, n]) => `${n} ${c}`).join(", ")}`;
}
