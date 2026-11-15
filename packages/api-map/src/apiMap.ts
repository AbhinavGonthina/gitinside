import {
  compareStrings,
  type ArchitectureGraph,
  type Confidence,
  type GraphNode,
  type GraphRepo,
  type UnresolvedReason,
} from "@gitinside/schema";

/**
 * The API map's data (M11.2, ADR-0299): every route in a graph with the requests that reach it,
 * the routes no request in the repo reaches, and the requests that reach no route, as one
 * deterministic JSON value. Read straight from the graph: a route's callers are the call sites of
 * the `http` edges into it, at those edges' confidence; a request the analyzer matched to nothing
 * is an `http` edge to an `unresolved` node, listed with the analyzer's own reason and words.
 * Nothing is matched again here, and nothing is guessed.
 *
 * Handles: routes (Express, Next route handlers, pages API), `http` edges to routes (ambiguous
 * ones flagged), `http` edges to `unresolved` nodes, and routes whose path the analyzer couldn't
 * read (`DYNAMIC_ROUTE`). Doesn't handle: pages (a browser visits them; they aren't API routes),
 * `external_call` edges (requests to hosts outside the repo), and callers outside the repo, which
 * the graph can't see: a "dead" route is one with no caller **in the repo**.
 *
 * Browser-safe (no Node or DOM types), like `packages/diff`: the website builds it in the visitor's
 * browser from the CDN-cached graph and never stores it (ADR-0295).
 */

/** Bumped when the JSON's shape changes. */
export const API_MAP_FORMAT = 1;

/** Where a call or route is in the repo (repo-relative path, 1-based line and column). */
export interface ApiSite {
  file: string;
  line: number;
  column: number;
}

/** One call site of a request that reaches a route. */
export interface ApiCaller extends ApiSite {
  /** The calling node's ID (a function, a route's inline handler, or a file for top-level code). */
  from: string;
  /** The calling node's name. */
  name: string;
  /** The caller's service ID, or `null` outside every service. */
  service: string | null;
  /** The edge's confidence. */
  confidence: Exclude<Confidence, "unresolved">;
  /** `true` when other routes match the request as well (each gets an edge, ADR-0033). */
  ambiguous: boolean;
  /** The request as the analyzer read it (`POST {env:API_URL}/orders`), when the site says. */
  request?: string;
}

/** A route with its callers in the repo. */
export interface ApiRoute {
  id: string;
  method: string;
  path: string;
  /** The serving service's ID, or `null` outside every service. */
  service: string | null;
  /** Where the route is declared, when the graph says. */
  source?: ApiSite;
  /** Sorted by file, line, column, then calling node. */
  callers: ApiCaller[];
}

/**
 * Why a request reaches no route, as the API map sorts them:
 * - `broken`: the analyzer read the request as aimed at the repo, and no route matches it
 *   (`NO_MATCHING_ROUTE` saying "no route matches …").
 * - `unmatched`: `NO_MATCHING_ROUTE` for a reason that doesn't say a route is missing: only a
 *   catch-all of every path takes it, its env base isn't named like an API base, it's a file next
 *   to the module, a dev proxy or Next rewrite sends it somewhere unread, or its URL names a
 *   loopback host whose server may be one the analyzer doesn't read.
 * - `unread`: the analyzer couldn't read the URL or pick a route (`DYNAMIC_URL`,
 *   `WRAPPER_DEPTH`, `AMBIGUOUS`, …).
 */
export type ApiRequestKind = "broken" | "unmatched" | "unread";

/** A request that reaches no route: one `unresolved` node at its call site. */
export interface ApiRequest extends ApiSite {
  /** The unresolved node's ID. */
  id: string;
  /** `GET`, `POST`, …, or `?` when the method isn't known. */
  method: string;
  /** The URL as the analyzer read it (the node's label after the method). */
  url: string;
  reason: UnresolvedReason;
  /** Why, in the analyzer's words, when it gave any. */
  detail?: string;
  /** The service the request is made in, or `null` outside every service. */
  service: string | null;
  /** The nodes making it (usually one), sorted. */
  callers: string[];
}

/** A route the analyzer found but whose path it couldn't read (`DYNAMIC_ROUTE`). */
export interface ApiUnreadRoute extends ApiSite {
  id: string;
  method: string;
  /** The path as written, e.g. `prefix + "/items"`. */
  expression: string;
  service: string | null;
}

/** A repo's API map. Every list is sorted, so the same graph gives the same JSON. */
export interface ApiMap {
  format: typeof API_MAP_FORMAT;
  repo: GraphRepo;
  analyzerVersion: string;
  /** Services that serve a route or make a listed request, by name, then ID. */
  services: { id: string; name: string }[];
  /** Sorted by path, method, then ID. */
  routes: ApiRoute[];
  /** IDs of routes with no caller in the repo (outside clients aren't visible), in `routes` order. */
  dead: string[];
  /** Requests for a route the repo doesn't have. Sorted by file, line, column, then ID. */
  broken: ApiRequest[];
  /** Requests that match no route for a reason that doesn't say one is missing. */
  unmatched: ApiRequest[];
  /** Requests whose URL or route couldn't be read; none is counted as broken. */
  unread: ApiRequest[];
  /** Routes whose path couldn't be read, so they can't be matched (`DYNAMIC_ROUTE`). */
  unreadRoutes: ApiUnreadRoute[];
  totals: {
    routes: number;
    /** Routes with at least one caller in the repo. */
    called: number;
    dead: number;
    /** Call sites reaching a route. */
    callers: number;
    broken: number;
    unmatched: number;
    unread: number;
    unreadRoutes: number;
  };
}

/**
 * The start of the analyzer's `NO_MATCHING_ROUTE` detail when it read the request as aimed at the
 * repo and found no route (`match.ts`'s `noRoute`). Every other `NO_MATCHING_ROUTE` detail
 * ({@link UNMATCHED_DETAILS}) names a reason that isn't a missing route.
 */
export const BROKEN_DETAIL = "no route matches ";

/**
 * The starts of the analyzer's other `NO_MATCHING_ROUTE` details (`match.ts`, `url.ts`'s
 * `MODULE_FILE_DETAIL`, `analyze.ts`). A detail starting with none of these, or no detail at all,
 * counts as broken: the reason code says no route matched, and that's the claim shown.
 */
export const UNMATCHED_DETAILS = [
  "only a catch-all of every path matches ",
  "the env var ",
  "the URL is a file next to the module ",
  "the dev proxy for ",
  "the rewrite of ",
  "the http stage failed",
] as const;

/**
 * A URL written with a loopback host (`http://localhost:3002/health`, `http://127.0.0.1:{}/…`).
 * The analyzer reads such a request as maybe the repo's own, but whatever listens on that port
 * may be a server no route detector reads (maxun's browser service answers `/health` from a raw
 * `http.createServer`) or a tool run beside the app (Ollama), so no route matching isn't a
 * missing route.
 */
const LOOPBACK_URL = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?:[:/]|$)/i;

/**
 * How the API map sorts a request that reaches no route, from its unresolved node's reason,
 * detail, and URL (the label after the method).
 */
export function requestKind(
  reason: UnresolvedReason,
  detail: string | undefined,
  url: string,
): ApiRequestKind {
  if (reason !== "NO_MATCHING_ROUTE") return "unread";
  const unmatched =
    LOOPBACK_URL.test(url) || UNMATCHED_DETAILS.some((start) => detail?.startsWith(start) === true);
  return unmatched ? "unmatched" : "broken";
}

const bySite = (a: ApiSite, b: ApiSite): number =>
  compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;

/** `GET /a b` → `["GET", "/a b"]`; a label with no space is all URL, method `?`. */
function splitLabel(label: string): [string, string] {
  const space = label.indexOf(" ");
  return space === -1 ? ["?", label] : [label.slice(0, space), label.slice(space + 1)];
}

const siteOf = (s: ApiSite): ApiSite => ({ file: s.file, line: s.line, column: s.column });

/** The API map of a graph (M11.2). Pure and deterministic: input order doesn't matter. */
export function apiMap(graph: ArchitectureGraph): ApiMap {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  /** The nearest `service` ancestor's ID (the node itself if it is one), memoized. */
  const serviceIds = new Map<string, string | null>();
  const serviceOf = (id: string): string | null => {
    const known = serviceIds.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    const found =
      node === undefined
        ? null
        : node.kind === "service"
          ? node.id
          : node.parentId === null
            ? null
            : serviceOf(node.parentId);
    serviceIds.set(id, found);
    return found;
  };

  const callers = new Map<string, ApiCaller[]>();
  const requests = new Map<
    string,
    { node: Extract<GraphNode, { kind: "unresolved" }>; from: Set<string>; site?: ApiSite }
  >();
  for (const edge of graph.edges) {
    if (edge.kind !== "http") continue;
    const to = byId.get(edge.to);
    const from = byId.get(edge.from);
    if (!to || !from) continue;
    if (to.kind === "route" && edge.confidence !== "unresolved") {
      const list = callers.get(to.id) ?? [];
      for (const site of edge.sites) {
        list.push({
          ...siteOf(site),
          from: from.id,
          name: from.label,
          service: serviceOf(from.id),
          confidence: edge.confidence,
          ambiguous: edge.reason === "AMBIGUOUS",
          ...(site.request === undefined ? {} : { request: site.request }),
        });
      }
      callers.set(to.id, list);
    } else if (to.kind === "unresolved") {
      const entry = requests.get(to.id) ?? { node: to, from: new Set<string>() };
      entry.from.add(from.id);
      for (const site of edge.sites)
        if (!entry.site || bySite(site, entry.site) < 0) entry.site = siteOf(site);
      requests.set(to.id, entry);
    }
  }

  const routes: ApiRoute[] = [];
  const unreadRoutes: ApiUnreadRoute[] = [];
  for (const node of graph.nodes) {
    if (node.kind === "route") {
      routes.push({
        id: node.id,
        method: node.method,
        path: node.path,
        service: serviceOf(node.id),
        ...(node.source ? { source: siteOf(node.source) } : {}),
        callers: (callers.get(node.id) ?? []).sort(
          (a, b) => bySite(a, b) || compareStrings(a.from, b.from),
        ),
      });
    } else if (node.kind === "unresolved" && node.reason === "DYNAMIC_ROUTE" && node.source) {
      const [method] = splitLabel(node.label);
      unreadRoutes.push({
        id: node.id,
        method,
        expression: splitLabel(node.expression)[1],
        service: serviceOf(node.id),
        ...siteOf(node.source),
      });
    }
  }
  routes.sort(
    (a, b) =>
      compareStrings(a.path, b.path) ||
      compareStrings(a.method, b.method) ||
      compareStrings(a.id, b.id),
  );
  unreadRoutes.sort((a, b) => bySite(a, b) || compareStrings(a.id, b.id));

  const lists: Record<ApiRequestKind, ApiRequest[]> = { broken: [], unmatched: [], unread: [] };
  for (const { node, from, site } of requests.values()) {
    const where = node.source ?? site;
    // An unresolved node always has a site in practice; one with neither is skipped, not guessed.
    if (!where) continue;
    const [method, url] = splitLabel(node.label);
    lists[requestKind(node.reason, node.detail, url)].push({
      ...siteOf(where),
      id: node.id,
      method,
      url,
      reason: node.reason,
      ...(node.detail === undefined ? {} : { detail: node.detail }),
      service: serviceOf(node.id),
      callers: [...from].sort(compareStrings),
    });
  }
  for (const list of Object.values(lists))
    list.sort((a, b) => bySite(a, b) || compareStrings(a.id, b.id));

  const serviceSet = new Set<string>();
  for (const item of [
    ...routes,
    ...unreadRoutes,
    ...lists.broken,
    ...lists.unmatched,
    ...lists.unread,
  ])
    if (item.service !== null) serviceSet.add(item.service);
  const services = [...serviceSet]
    .map((id) => ({ id, name: byId.get(id)?.label ?? id }))
    .sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.id, b.id));

  const dead = routes.filter((r) => r.callers.length === 0).map((r) => r.id);
  return {
    format: API_MAP_FORMAT,
    repo: {
      owner: graph.repo.owner,
      name: graph.repo.name,
      ...(graph.repo.sha === undefined ? {} : { sha: graph.repo.sha }),
    },
    analyzerVersion: graph.analyzerVersion,
    services,
    routes,
    dead,
    broken: lists.broken,
    unmatched: lists.unmatched,
    unread: lists.unread,
    unreadRoutes,
    totals: {
      routes: routes.length,
      called: routes.length - dead.length,
      dead: dead.length,
      callers: routes.reduce((n, r) => n + r.callers.length, 0),
      broken: lists.broken.length,
      unmatched: lists.unmatched.length,
      unread: lists.unread.length,
      unreadRoutes: unreadRoutes.length,
    },
  };
}
