/**
 * Route matcher (M2.4, DESIGN.md §7.4): matches each {@link HttpRequest} to the `route` nodes
 * it can reach and turns the matches into `http` edges, each with a confidence level.
 *
 * A request matches a route when all three of these align; the match's confidence is the
 * weakest of the three, and then no stronger than the request's own confidence:
 * 1. **Base.** Root-relative (`/api/x`) and `location.origin` URLs are `exact` for routes in
 *    the caller's own service and `heuristic` for routes in other services (it assumes a proxy
 *    or rewrite sends them there). Page-relative URLs (`api/x`) are `heuristic`: the page's
 *    folder is unknown, so the path is read from the root. An env-var base is `heuristic` when
 *    its name is on the list of API-base names ({@link API_BASE_ENV_ENDINGS}: `API_URL`,
 *    `VITE_API_PATH`, `NEXT_PUBLIC_BACKEND_URL`, …, ADR-0165) or the code's fallback for it is
 *    a loopback URL (`?? "http://localhost:9000"`, ADR-0158);
 *    any other env var matches nothing. When a committed example env file gives such a base
 *    a URL path (`VITE_API_URL=http://localhost:5000/api` in `.env.example`), the path is
 *    tried in front of the request's first, then the request alone (`envExamples.ts`,
 *    ADR-0202); the path is never written into the graph. A literal loopback host (`localhost`, `127.0.0.1`,
 *    `[::1]`, `0.0.0.0`, `*.localhost`, any port) is `heuristic` against every service; any
 *    other literal host is an external API and is never matched to a route.
 *    A root-relative request from an app with a dev proxy (Vite's `server.proxy`, CRA's
 *    `"proxy"`, `devProxy.ts`, ADR-0204) that takes its path is matched by the path the proxy
 *    sends (its `rewrite` applied, the target's path in front), `heuristic` for routes in
 *    every service, its own included; a target outside the repo (a dotted host that isn't
 *    loopback) makes it an external call, also `heuristic`. A rewrite that isn't read leaves
 *    it unresolved rather than matching the unrewritten path.
 *    A Next app's routes are matched under its literal `basePath` (`nextConfig.ts`, ADR-0206),
 *    and its own root-relative requests go through its static `rewrites` in Next's order: one
 *    rewritten to another path of the app is matched there as before, one sent to a loopback
 *    or single-label host or an API-named env var is `heuristic` in every service, and one
 *    sent to another literal host is an external call. A destination that isn't read leaves
 *    it unresolved with a reason.
 * 2. **Method.** Equal methods, an `ALL` route, or a `HEAD` request to a `GET` route are
 *    `exact`. A request whose method can't be read matches every method at `heuristic`.
 *    A route reached only through routers loaded from a folder listing (`listed`, ADR-0162)
 *    is `heuristic` at best too: the listing is read from the repo, but filters on it aren't.
 * 3. **Path**, segment by segment:
 *    - A literal matches the identical literal (`exact`).
 *    - A hole (`{}`) matches a param (`:id`, `exact`); a literal or partly literal segment
 *      matches a param too, as a possible match (`pattern`).
 *    - A partly literal segment (`user-{}`) matches a literal it can spell (`pattern`). A pure
 *      hole never matches a literal: nothing says the runtime value is that literal.
 *    - A wildcard (`*`, `*rest`, `:p*`, `:p+`) takes the rest of its segments (`pattern`).
 *    - An optional param (`:id?`) may be absent (`exact`).
 *
 * Choosing among matches: only the strongest level counts. At that level, the strongest path
 * alignment wins (under an env-var base every match is `heuristic`, but `/api/users/me` still
 * picks the literal route over `/api/users/:id`), and then a route with the request's own
 * method beats an `ALL` route (the pages router's fall-through route is the
 * same handler). If several routes are still left, the request links to all of them with the
 * confidence one level weaker (never below `heuristic`, which still points at real routes) and
 * the edge records `AMBIGUOUS`.
 *
 * Routes are indexed by method, then by their first literal segment (routes starting with a
 * param or wildcard go in a catch-all bucket), so a request only aligns against routes that
 * can match: near-linear instead of requests × routes.
 *
 * Patterns not handled:
 * - Express path syntax beyond named params, optional params, and wildcards (`/ab?cd`,
 *   `:from-:to`, regexes, Express 5 `{braces}`): such a segment matches any single segment at
 *   `pattern`. Case-insensitive and trailing-slash routing options are not read.
 * - The `next.config` forms listed as not handled in `nextConfig.ts` (a computed `basePath`,
 *   rewrites built by code or with conditions, chained rewrites, other services' requests
 *   through a Next app's rewrites), the dev proxies listed as not handled in
 *   `devProxy.ts` (webpack-dev-server, CRA's `setupProxy.js`, regex keys, …), and env values
 *   other than an example file's URL path: an env var's real value is never read, only its
 *   name (values may be secrets).
 * - Which service a loopback port belongs to (compose ports, M2.7; a dev proxy's target):
 *   no service records the port it listens on, so every service is a candidate.
 * - A hole that spans several segments (`/api/${path}` with `path = "a/b"`).
 *
 * Requests that match nothing are {@link RouteMatch} outcomes too (`external` for a literal
 * host outside the repo, `unresolved` with a reason and detail), and {@link buildHttpEdges}
 * (M2.5) turns them into `external` and `unresolved` nodes, so no request is dropped.
 */
import {
  ALIGN,
  alignSegments,
  compareStrings,
  edgeId,
  isHole,
  isText,
  nodeId,
  parseRoutePath,
  segmentText,
  SYSTEM_ID,
  type CallSite,
  type Confidence,
  type GraphEdge,
  type GraphNode,
  type HttpMethod,
  type RouteSegment,
  type UrlSegment,
  type SourceLocation,
  type UnresolvedReason,
} from "@gitinside/schema";
import { formatProxyPath, proxyRequest, type DevProxies } from "./devProxy.js";
import type { EnvPrefixes } from "./envExamples.js";
import { fileNodeId, withinService } from "./files.js";
import { rewriteRequest, type NextConfigs } from "./nextConfig.js";
import type { UrlBase } from "./url.js";
import { clip, CONFIDENCE_RANK, weaker } from "./values.js";
import { serviceForFile, type Workspace } from "./workspace.js";
import type { HttpRequest } from "./wrappers.js";

// The path grammar lives in the schema, shared with the diff's re-resolution (ADR-0087).
export { alignSegments, parseRoutePath, type RouteSegment } from "@gitinside/schema";

/** What a request matched. */
export type RouteMatch =
  | {
      kind: "routes";
      /** Route node IDs, sorted. */
      routes: string[];
      confidence: Exclude<Confidence, "unresolved">;
      /** True when several routes matched equally well. */
      ambiguous: boolean;
    }
  /**
   * A literal host outside the repo (an external API, M2.5). `confidence` caps the edge's
   * (`heuristic` for a dev proxy's target, ADR-0204); absent means `exact`.
   */
  | {
      kind: "external";
      scheme: string | null;
      host: string;
      confidence?: Exclude<Confidence, "unresolved">;
    }
  | {
      kind: "unresolved";
      reason: "DYNAMIC_URL" | "WRAPPER_DEPTH" | "NO_MATCHING_ROUTE";
      /** Why, in words shown to the user. */
      detail: string;
    };

/** The parts of an {@link HttpRequest} the matcher reads. */
export type MatchInput = Pick<HttpRequest, "file" | "method" | "url" | "confidence">;

/** Matches requests against the repo's routes. */
export interface RouteMatcher {
  match(request: MatchInput): RouteMatch;
  /** The label of a route node the matcher knows (`GET /api/users`). */
  label(id: string): string | undefined;
}

/** A route ready for matching. */
interface IndexedRoute {
  id: string;
  /** Key of the service that serves it, if known. */
  service: string | undefined;
  method: HttpMethod;
  segments: RouteSegment[];
}

/** The `next.config`s of the repo's Next apps, and the nodes their `basePath` applies to. */
export interface NextApps {
  configs: NextConfigs;
  /** The Next detector's `route` and `page` nodes (not a custom server's Express routes). */
  nodes: readonly GraphNode[];
}

const NO_NEXT_APPS: NextApps = { configs: () => undefined, nodes: [] };

/** Bucket key for routes whose first segment isn't a literal. */
const ANY = "\0";

/** A level that can't match. */
const FAIL = ALIGN.FAIL;

const LEVELS = ["exact", "pattern", "heuristic"] as const;
const EXACT = CONFIDENCE_RANK.exact;
const HEURISTIC = CONFIDENCE_RANK.heuristic;

/**
 * Endings of env var names read as "the base URL of an API in this repo" (DESIGN.md §7.2,
 * ADR-0165). A name matches when it is one of these, or ends with `_` and one of these
 * (`VITE_API_PATH`, `NEXT_PUBLIC_BACKEND_URL`). Case-sensitive: env names are upper case by
 * convention. Not listed, on purpose: a bare host or URL (`*_HOST`, `*_URL`: `ANALYTICS_HOST`,
 * `CMS_URL`), `*_APP_URL` (often the site's own origin), `*_BASE_PATH` (Next's page prefix),
 * and API settings that aren't a base (`*_API_KEY`, `*_API_VERSION`).
 */
const API_BASE_ENV_ENDINGS = [
  "API",
  "API_URL",
  "API_URI",
  "API_PATH",
  "API_HOST",
  "API_ORIGIN",
  "API_ROOT",
  "API_BASE",
  "API_ENDPOINT",
  "BASE_URL",
  "SERVER_URL",
  "BACKEND_URL",
] as const;

const API_BASE_ENV = new RegExp(`^(?:.+_)?(?:${API_BASE_ENV_ENDINGS.join("|")})$`);

/** The start of the list, shown when an env var's name isn't on it. */
const API_BASE_ENV_HINT = "*_API_URL, *_API_PATH, …";

/** True when a host (with optional port) is the local machine. */
export function isLoopbackHost(host: string): boolean {
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name === "0.0.0.0" ||
    name === "[::1]" ||
    (name?.endsWith(".localhost") ?? false)
  );
}

/**
 * True when a dev proxy's target may be a server in this repo: the local machine, or a
 * single-label host such as a docker-compose service name (`http://api:5000`, ADR-0204).
 */
function mayBeInRepo(host: string): boolean {
  return isLoopbackHost(host) || (!host.startsWith("[") && !host.split(":")[0]?.includes("."));
}

/**
 * True when an env-var base may point at this repo: its name looks like an API base, or the
 * code's fallback for it is a loopback host (ADR-0158).
 */
function reachesRepo(base: Extract<UrlBase, { kind: "env" }>): boolean {
  if (API_BASE_ENV.test(base.name)) return true;
  return base.fallbackHost !== undefined && isLoopbackHost(base.fallbackHost);
}

/** The key of the service a route node ID belongs to: the longest workspace key it starts with. */
function routeService(id: string, keys: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const key of keys) {
    if (id.startsWith(`route:${key}/`) && (best === undefined || key.length > best.length)) {
      best = key;
    }
  }
  return best;
}

/** The bucket a route's first segment puts it in. */
const bucketOf = (segments: readonly RouteSegment[]): string => {
  const first = segments[0];
  if (!first) return "";
  return first.kind === "literal" ? first.text : ANY;
};

/**
 * Build a matcher over the `route` nodes in `nodes` (other kinds are ignored). The first node
 * with a given ID wins, as in graph assembly. Routes in `listed` (`ExpressRoutes.listedRoutes`)
 * match at `heuristic` at best. `envPrefix` gives an env base's path from example env files
 * (`envExamples.ts`, ADR-0202), `devProxy` the dev proxy a calling file's app sends
 * root-relative requests through (`devProxy.ts`, ADR-0204), and `next` the Next apps'
 * `basePath` and rewrites (`nextConfig.ts`, ADR-0206).
 */
export function createRouteMatcher(
  nodes: readonly GraphNode[],
  workspace: Workspace,
  listed: ReadonlySet<string> = new Set(),
  envPrefix: EnvPrefixes = () => undefined,
  devProxy: DevProxies = () => undefined,
  next: NextApps = NO_NEXT_APPS,
): RouteMatcher {
  const keys = workspace.packages.map((p) => p.key);
  const nextNodes = new Set(next.nodes);
  /** A node's path segments, under its app's `basePath` when Next serves it. */
  const segmentsOf = (node: GraphNode & { path: string }, service: string | undefined) => {
    const segments = parseRoutePath(node.path);
    const base =
      nextNodes.has(node) && service !== undefined ? next.configs(service)?.basePath : [];
    return base && base.length > 0
      ? [...base.map((text): RouteSegment => ({ kind: "literal", text })), ...segments]
      : segments;
  };
  /** Service key ⇒ the paths its Next routes and pages serve, and whether each is static. */
  const served = new Map<string, { segments: RouteSegment[]; static: boolean }[]>();
  for (const node of next.nodes) {
    if (node.kind !== "route" && node.kind !== "page") continue;
    const service = routeService(node.id.replace(/^page:/, "route:"), keys);
    if (service === undefined) continue;
    const segments = segmentsOf(node, service);
    const list = served.get(service) ?? [];
    list.push({ segments, static: segments.every((s) => s.kind === "literal") });
    served.set(service, list);
  }
  /** method ⇒ first literal segment (or {@link ANY}) ⇒ routes. */
  const index = new Map<HttpMethod, Map<string, IndexedRoute[]>>();
  const labels = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind !== "route" || labels.has(node.id)) continue;
    labels.set(node.id, node.label);
    const service = routeService(node.id, keys);
    const route: IndexedRoute = {
      id: node.id,
      service,
      method: node.method,
      segments: segmentsOf(node, service),
    };
    const byFirst = index.get(route.method) ?? new Map<string, IndexedRoute[]>();
    const bucket = bucketOf(route.segments);
    byFirst.set(bucket, [...(byFirst.get(bucket) ?? []), route]);
    index.set(route.method, byFirst);
  }

  /** Routes a request with this method and first segment could match. */
  const candidates = (method: HttpMethod | null, first: UrlSegment | undefined): IndexedRoute[] => {
    const methods: HttpMethod[] =
      method === null
        ? [...index.keys()]
        : method === "HEAD"
          ? ["HEAD", "GET", "ALL"]
          : method === "ALL"
            ? [...index.keys()]
            : [method, "ALL"];
    const out: IndexedRoute[] = [];
    for (const m of methods) {
      const byFirst = index.get(m);
      if (!byFirst) continue;
      if (first === undefined) {
        out.push(...(byFirst.get("") ?? []), ...(byFirst.get(ANY) ?? []));
      } else if (isText(first)) {
        out.push(...(byFirst.get(segmentText(first)) ?? []), ...(byFirst.get(ANY) ?? []));
      } else if (isHole(first)) {
        out.push(...(byFirst.get(ANY) ?? []));
      } else {
        for (const bucket of byFirst.values()) out.push(...bucket);
      }
    }
    return out;
  };

  /**
   * The level the base gives a route, or {@link FAIL} when it can't reach it. `caller` is
   * undefined for a request a dev proxy sends on: its server's service isn't known.
   */
  const baseLevel = (base: UrlBase, caller: string | undefined, route: IndexedRoute): number => {
    switch (base.kind) {
      case "path":
        return caller !== undefined && caller === route.service ? EXACT : HEURISTIC;
      case "page":
        return HEURISTIC;
      case "env":
        return reachesRepo(base) ? HEURISTIC : FAIL;
      case "host":
        return isLoopbackHost(base.host) ? HEURISTIC : FAIL;
    }
  };

  const methodLevel = (method: HttpMethod | null, route: IndexedRoute): number => {
    if (method === null) return HEURISTIC;
    if (method === route.method || route.method === "ALL" || method === "ALL") return EXACT;
    return method === "HEAD" && route.method === "GET" ? EXACT : FAIL;
  };

  return {
    label: (id) => labels.get(id),
    match(request) {
      const { url } = request;
      if (!url.resolved) return { kind: "unresolved", reason: url.reason, detail: url.detail };
      const { base, segments } = url.pattern;
      if (base.kind === "host" && !isLoopbackHost(base.host)) {
        return { kind: "external", scheme: base.scheme, host: base.host };
      }
      if (base.kind === "env" && !reachesRepo(base)) {
        return {
          kind: "unresolved",
          reason: "NO_MATCHING_ROUTE",
          detail: `the env var ${base.name} isn't named like an API base (${API_BASE_ENV_HINT})`,
        };
      }
      const own = serviceForFile(workspace, request.file)?.key;

      /** The routes `path` from `caller`'s service matches, or undefined when none does. */
      const rank = (
        path: readonly UrlSegment[],
        caller: string | undefined,
      ): RouteMatch | undefined => {
        // Ranked by overall level, then by path level: the base and method assumptions are
        // shared, so a literal path match still beats a param match under an env-var base.
        let best = FAIL;
        let bestPath = FAIL;
        let matched: IndexedRoute[] = [];
        for (const route of candidates(request.method, path[0])) {
          const aligned = alignSegments(path, route.segments);
          const level = Math.max(
            baseLevel(base, caller, route),
            methodLevel(request.method, route),
            aligned,
            listed.has(route.id) ? HEURISTIC : EXACT,
          );
          if (level === FAIL) continue;
          if (level < best || (level === best && aligned < bestPath)) {
            best = level;
            bestPath = aligned;
            matched = [route];
          } else if (level === best && aligned === bestPath) {
            matched.push(route);
          }
        }
        if (best === FAIL) return undefined;
        // The request's own method beats an `ALL` route at the same level.
        if (request.method !== null && request.method !== "ALL") {
          const specific = matched.filter((r) => r.method !== "ALL");
          if (specific.length > 0) matched = specific;
        }
        const ambiguous = matched.length > 1;
        const level = LEVELS[Math.min(best + (ambiguous ? 1 : 0), HEURISTIC)] ?? "heuristic";
        const confidence = weaker(level, request.confidence);
        return {
          kind: "routes",
          routes: [...new Set(matched.map((r) => r.id))].sort(compareStrings),
          confidence: confidence === "unresolved" ? "heuristic" : confidence,
          ambiguous,
        };
      };

      // A root-relative request goes to the app's dev server, which may proxy it (ADR-0204).
      const proxy = base.kind === "path" ? devProxy(request.file) : undefined;
      const sent = proxy ? proxyRequest(proxy, segments) : undefined;
      if (proxy && sent?.kind === "proxied") {
        const { context, target } = sent.rule;
        if (target.kind === "host" && !mayBeInRepo(target.host)) {
          const { scheme, host } = target;
          return { kind: "external", scheme, host, confidence: "heuristic" };
        }
        if (!sent.segments) {
          return {
            kind: "unresolved",
            reason: "NO_MATCHING_ROUTE",
            detail: clip(
              `the dev proxy for ${context ?? "this path"} in ${proxy.config} rewrites the path in a way that isn't read`,
            ),
          };
        }
        return (
          rank(sent.segments, undefined) ?? {
            kind: "unresolved",
            reason: "NO_MATCHING_ROUTE",
            detail: clip(
              `no route matches ${request.method ?? "a request"} to ${url.text} (sent as ${formatProxyPath(sent.segments)} by the dev proxy in ${proxy.config})`,
            ),
          }
        );
      }

      // A root-relative request from a Next app goes through its rewrites (ADR-0206).
      const app = base.kind === "path" && own !== undefined ? next.configs(own) : undefined;
      const rewritten =
        app && own !== undefined
          ? rewriteRequest(app, segments, (path, staticOnly) =>
              (served.get(own) ?? []).some(
                (r) => (!staticOnly || r.static) && alignSegments(path, r.segments) !== FAIL,
              ),
            )
          : undefined;
      if (app && rewritten?.kind === "rewritten") {
        const { rule } = rewritten;
        const { target } = rule;
        const what = `the rewrite of ${rule.text ?? "this path"} in ${app.config}`;
        if (target.kind === "host" && !mayBeInRepo(target.host)) {
          return { kind: "external", scheme: target.scheme, host: target.host };
        }
        const unread = (detail: string): RouteMatch => ({
          kind: "unresolved",
          reason: "NO_MATCHING_ROUTE",
          detail: clip(detail),
        });
        if (target.kind === "unknown")
          return unread(`${what} sends it to an address that isn't read`);
        if (target.kind === "env" && !API_BASE_ENV.test(target.name)) {
          return unread(
            `${what} sends it to the env var ${target.name}, not named like an API base`,
          );
        }
        if (!rewritten.segments) return unread(`${what} builds a path that isn't read`);
        // Another path of the app keeps the caller's own routes `exact`; a server elsewhere
        // is any service's, as for a dev proxy's target.
        return (
          rank(rewritten.segments, target.kind === "internal" ? own : undefined) ??
          unread(
            `no route matches ${request.method ?? "a request"} to ${url.text} (rewritten to ${formatProxyPath(rewritten.segments)} by ${app.config})`,
          )
        );
      }

      // An example env file's path for the base goes in front first (ADR-0202); it stays in
      // here, so the detail below and every graph string are built without it.
      const prefix = base.kind === "env" ? envPrefix(base.name, request.file) : undefined;
      const prefixed =
        prefix && prefix.length > 0
          ? rank([...prefix.map((text): UrlSegment => [{ kind: "text", text }]), ...segments], own)
          : undefined;
      const underBase = app?.basePath.every((text, i) => {
        const s = segments[i];
        return s !== undefined && isText(s) && segmentText(s) === text;
      });
      const hint =
        app && app.basePath.length > 0 && !underBase
          ? ` (the Next app's basePath in ${app.config} is /${app.basePath.join("/")})`
          : "";
      return (
        prefixed ??
        rank(segments, own) ?? {
          kind: "unresolved",
          reason: "NO_MATCHING_ROUTE",
          detail: clip(`no route matches ${request.method ?? "a request"} to ${url.text}${hint}`),
        }
      );
    },
  };
}

const compareLocations = (a: SourceLocation, b: SourceLocation): number =>
  compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;

/** Ports dropped from external hosts when they are the scheme's default. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  http: "80",
  https: "443",
  ws: "80",
  wss: "443",
};

/**
 * The host an `external` node is keyed by: the literal host without its scheme's default
 * port, so `https://api.x.com:443` and `https://api.x.com` are one node. A protocol-relative
 * URL (`scheme` `null`) keeps any port.
 */
export function externalHost(scheme: string | null, host: string): string {
  const port = scheme === null ? undefined : DEFAULT_PORTS[scheme];
  return port !== undefined && host.endsWith(`:${port}`) ? host.slice(0, -port.length - 1) : host;
}

/**
 * The `external` node for a host (already passed through {@link externalHost}). Every pass
 * builds it here, so a `fetch` and an SDK call to one host produce identical nodes that
 * assembly merges silently.
 */
export function externalNode(host: string): GraphNode {
  return {
    id: nodeId("external", "ext", host),
    kind: "external",
    label: host,
    parentId: SYSTEM_ID,
    layer: "external",
    host,
  };
}

/** The graph output of the HTTP stage, plus every request's match. */
export interface HttpEdges {
  /** `external` and `unresolved` nodes, sorted by ID. */
  nodes: GraphNode[];
  /** `http` and `external_call` edges, sorted by ID. */
  edges: GraphEdge[];
  /** One entry per request, in request order. */
  matches: { request: HttpRequest; match: RouteMatch }[];
}

/**
 * Match every request and draw edges from each of its owners (or, for top-level code, its
 * file node), so every request is in the graph (ROADMAP M2: no call site dropped):
 * - Matched routes: an `http` edge to each route, each site carrying the request's `label`
 *   as `request`, so the diff can find the same call unresolved in head however the path
 *   was matched (an example env path, a dev proxy, `basePath`, rewrites; ADR-0087).
 * - A literal external host: an `external` node (`external:ext/<host>`, under the system)
 *   and an `external_call` edge to it, `exact` unless the request itself is weaker.
 * - Anything else: an `unresolved` node at the request's site (the wrapper call when
 *   inlined) with the reason and its detail, the request's `label` and `expression`, and an
 *   `unresolved` `http` edge to it. The node is kept even when the request has no source node.
 *
 * Requests with the same (kind, source, target) merge into one edge listing every site, at
 * the strongest confidence; the edge keeps a reason only when every site gave it (so
 * `AMBIGUOUS` means every site was ambiguous). Several requests at one site (a wrapper with
 * two `fetch` calls in its body) share that site's unresolved node, and the first request's
 * reason wins. Files outside every service belong to no program, so they make no requests.
 */
export function buildHttpEdges(
  requests: readonly HttpRequest[],
  matcher: RouteMatcher,
  workspace: Workspace,
): HttpEdges {
  const matches = requests.map((request) => ({ request, match: matcher.match(request) }));
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addEdge = (
    kind: "http" | "external_call",
    from: string,
    to: string,
    confidence: Confidence,
    site: CallSite,
    reason: UnresolvedReason | undefined,
    label: string | undefined,
  ): void => {
    const id = edgeId(kind, from, to);
    const existing = edges.get(id);
    if (!existing) {
      edges.set(id, {
        id,
        kind,
        from,
        to,
        confidence,
        ...(label ? { label } : {}),
        ...(reason ? { reason } : {}),
        sites: [site],
      });
      return;
    }
    if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[existing.confidence]) {
      existing.confidence = confidence;
    }
    if (existing.reason !== reason) delete existing.reason;
    if (!existing.sites.some((s) => compareLocations(s, site) === 0)) existing.sites.push(site);
  };

  for (const { request, match } of matches) {
    const service = serviceForFile(workspace, request.file);
    const sources =
      request.owners.length > 0
        ? request.owners
        : service
          ? [fileNodeId(service, request.file)]
          : [];
    switch (match.kind) {
      case "routes": {
        // The request's text, so the diff can tell head's unresolved call is this one.
        const site = { ...request.site, request: request.label };
        for (const from of sources) {
          for (const to of match.routes) {
            const reason = match.ambiguous ? "AMBIGUOUS" : undefined;
            addEdge("http", from, to, match.confidence, site, reason, matcher.label(to));
          }
        }
        break;
      }
      case "external": {
        const host = externalHost(match.scheme, match.host);
        const node = externalNode(host);
        const to = node.id;
        if (!nodes.has(to)) nodes.set(to, node);
        const level = weaker(match.confidence ?? "exact", request.confidence);
        const confidence = level === "unresolved" ? "heuristic" : level;
        for (const from of sources) {
          addEdge("external_call", from, to, confidence, request.site, undefined, undefined);
        }
        break;
      }
      case "unresolved": {
        if (!service) break;
        const { line, column } = request.site;
        const to = nodeId(
          "unresolved",
          service.key,
          `${withinService(service, request.file)}:${line}:${column}`,
        );
        let node = nodes.get(to);
        if (node?.kind !== "unresolved") {
          node = {
            id: to,
            kind: "unresolved",
            label: request.label,
            parentId: nodeId("service", service.key, ""),
            reason: match.reason,
            expression: request.expression,
            detail: match.detail,
            source: request.site,
          };
          nodes.set(to, node);
        }
        for (const from of sources) {
          addEdge("http", from, to, "unresolved", request.site, node.reason, undefined);
        }
        break;
      }
    }
  }
  const out = [...edges.values()].sort((a, b) => compareStrings(a.id, b.id));
  for (const edge of out) edge.sites.sort(compareLocations);
  return {
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
    edges: out,
    matches,
  };
}
