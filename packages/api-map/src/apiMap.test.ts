import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  edgeId,
  parseGraph,
  SCHEMA_VERSION,
  SYSTEM_ID,
  type ArchitectureGraph,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { API_MAP_FORMAT, apiMap, BROKEN_DETAIL, requestKind, UNMATCHED_DETAILS } from "./apiMap.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

const fixture = (name: string): ArchitectureGraph =>
  parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));

const FIXTURE_NAMES = readdirSync(FIXTURES)
  .filter((name) => existsSync(join(FIXTURES, name, "expected.json")))
  .sort();

describe("shop-demo: a web app's requests to an API service", () => {
  it("lists both routes with their callers, and the CMS request apart, not as broken", () => {
    expect(apiMap(fixture("shop-demo"))).toEqual({
      format: API_MAP_FORMAT,
      repo: { owner: "fixtures", name: "shop-demo" },
      analyzerVersion: fixture("shop-demo").analyzerVersion,
      services: [
        { id: "service:api/", name: "@shop/api" },
        { id: "service:web/", name: "@shop/web" },
      ],
      routes: [
        {
          id: "route:api/GET /api/orders",
          method: "GET",
          path: "/api/orders",
          service: "service:api/",
          source: { file: "apps/api/src/routes/orders.ts", line: 6, column: 8 },
          callers: [
            {
              file: "apps/web/lib/orders.ts",
              line: 13,
              column: 21,
              from: "symbol:web/lib/orders.ts#listOrders",
              name: "listOrders",
              service: "service:web/",
              confidence: "heuristic",
              ambiguous: false,
              request: "GET {env:NEXT_PUBLIC_API_URL}/api/orders",
            },
          ],
        },
        {
          id: "route:api/POST /api/orders",
          method: "POST",
          path: "/api/orders",
          service: "service:api/",
          source: { file: "apps/api/src/routes/orders.ts", line: 7, column: 8 },
          callers: [
            {
              file: "apps/web/lib/orders.ts",
              line: 5,
              column: 21,
              from: "symbol:web/lib/orders.ts#placeOrder",
              name: "placeOrder",
              service: "service:web/",
              confidence: "heuristic",
              ambiguous: false,
              request: "POST {env:NEXT_PUBLIC_API_URL}/api/orders",
            },
          ],
        },
      ],
      dead: [],
      broken: [],
      unmatched: [
        {
          file: "apps/web/lib/cms.ts",
          line: 3,
          column: 21,
          id: "unresolved:web/lib/cms.ts:3:21",
          method: "GET",
          url: "{env:CMS_URL}/posts",
          reason: "NO_MATCHING_ROUTE",
          detail: "the env var CMS_URL isn't named like an API base (*_API_URL, *_API_PATH, …)",
          service: "service:web/",
          callers: ["symbol:web/lib/cms.ts#latestPosts"],
        },
      ],
      unread: [],
      unreadRoutes: [],
      totals: {
        routes: 2,
        called: 2,
        dead: 0,
        callers: 2,
        broken: 0,
        unmatched: 1,
        unread: 0,
        unreadRoutes: 0,
      },
    });
  });
});

describe("fixtures", () => {
  it("lists requests for routes the repo lacks as broken, and a route nothing calls as dead", () => {
    const map = apiMap(fixture("diff-broken-head"));
    expect(map.broken.map((r) => `${r.method} ${r.url} ${r.callers.join(",")}`)).toEqual([
      "POST /api/orders symbol:diff-broken/src/client.ts#placeOrder",
      "DELETE /api/orders/{} symbol:diff-broken/src/client.ts#cancelOrder",
    ]);
    expect(map.dead).toEqual(["route:diff-broken/PUT /api/orders"]);
    expect(
      map.routes.map((r) => `${r.id} ${r.callers.map((c) => c.confidence).join(",")}`),
    ).toEqual(["route:diff-broken/GET /api/orders exact", "route:diff-broken/PUT /api/orders "]);
    // The unresolved import and Prisma call aren't requests.
    expect([...map.unmatched, ...map.unread]).toEqual([]);
    expect(map.totals).toMatchObject({ routes: 2, called: 1, dead: 1, callers: 1, broken: 2 });
  });

  it("flags a request that matches several routes as ambiguous on each", () => {
    const map = apiMap(fixture("ambiguous-routes"));
    expect(
      map.routes.map((r) => [
        r.path,
        r.callers.map((c) => `${c.name} ${c.confidence} ${c.ambiguous}`),
      ]),
    ).toEqual([
      ["/v1/:org/items", ["acmeItems heuristic true", "orgItems exact false"]],
      ["/v1/acme/:kind", ["acmeItems heuristic true"]],
    ]);
    expect(map.totals).toMatchObject({ called: 2, dead: 0, callers: 3 });
  });

  it("lists a request too deep in wrappers as unread, never broken", () => {
    const map = apiMap(fixture("wrapper-chain"));
    expect(map.unread.map((r) => [r.reason, r.method, r.url])).toEqual([
      ["WRAPPER_DEPTH", "GET", "getCached(path)"],
    ]);
    expect(map.broken).toEqual([]);
    expect(map.dead).toEqual(["route:wrapper-chain/GET /api/feed"]);
  });

  it("lists a font loaded next to its module as unmatched, not broken", () => {
    const map = apiMap(fixture("next-app-router"));
    expect(map.unmatched.map((r) => r.url)).toEqual([
      'new URL("../../../assets/Inter-Regular.ttf", import.meta.url)',
    ]);
    expect(map.broken).toEqual([]);
  });

  it("knows every NO_MATCHING_ROUTE wording the fixtures hold", () => {
    // A new analyzer wording would fall to "broken" by default; this makes it a decision.
    const details = new Set<string>();
    for (const name of FIXTURE_NAMES)
      for (const node of fixture(name).nodes)
        if (node.kind === "unresolved" && node.reason === "NO_MATCHING_ROUTE")
          details.add(node.detail ?? "(none)");
    expect(details.size).toBeGreaterThan(5);
    for (const detail of details)
      expect(
        [BROKEN_DETAIL, ...UNMATCHED_DETAILS].some((start) => detail.startsWith(start)),
        detail,
      ).toBe(true);
  });

  it("gives the same JSON whatever order the graph lists nodes, edges, and sites in", () => {
    for (const name of FIXTURE_NAMES) {
      const graph = fixture(name);
      const reversed: ArchitectureGraph = {
        ...graph,
        repo:
          graph.repo.sha === undefined
            ? { name: graph.repo.name, owner: graph.repo.owner }
            : { sha: graph.repo.sha, name: graph.repo.name, owner: graph.repo.owner },
        nodes: [...graph.nodes].reverse(),
        edges: [...graph.edges].reverse().map((e) => ({ ...e, sites: [...e.sites].reverse() })),
      };
      expect(JSON.stringify(apiMap(reversed)), name).toBe(JSON.stringify(apiMap(graph)));
    }
  });
});

/** A small graph built by hand, for cases no fixture has. */
function graph(nodes: GraphNode[], edges: Omit<GraphEdge, "id">[]): ArchitectureGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo: { owner: "o", name: "r", sha: "abc1234" },
    analyzerVersion: "9.9.9",
    nodes: [{ id: SYSTEM_ID, kind: "system", label: "r", parentId: null }, ...nodes],
    edges: edges.map((e) => ({ ...e, id: edgeId(e.kind, e.from, e.to) })),
    warnings: [],
  };
}

const svc = (key: string): GraphNode => ({
  id: `service:${key}/`,
  kind: "service",
  label: key,
  parentId: SYSTEM_ID,
  root: key,
});
const fn = (id: string, parentId: string): GraphNode => ({
  id,
  kind: "symbol",
  label: id.split("#")[1] ?? id,
  parentId,
  symbolKind: "function",
  exported: true,
});
const unresolved = (
  id: string,
  label: string,
  reason: Extract<GraphNode, { kind: "unresolved" }>["reason"],
  detail?: string,
  source?: { file: string; line: number; column: number },
): GraphNode => ({
  id,
  kind: "unresolved",
  label,
  parentId: "service:web/",
  reason,
  expression: label,
  ...(detail === undefined ? {} : { detail }),
  ...(source === undefined ? {} : { source }),
});
const http = (
  from: string,
  to: string,
  sites: { file: string; line: number; column: number }[],
): Omit<GraphEdge, "id"> => ({
  kind: "http",
  from,
  to,
  confidence: "unresolved",
  reason: "NO_MATCHING_ROUTE",
  sites,
});

describe("hand-built graphs", () => {
  it("lists a route whose path the analyzer couldn't read apart, with its expression", () => {
    const map = apiMap(
      graph(
        [
          svc("api"),
          {
            id: "unresolved:api/src/app.ts:4:9",
            kind: "unresolved",
            label: "GET prefix + /items",
            parentId: "service:api/",
            reason: "DYNAMIC_ROUTE",
            expression: "GET prefix + /items",
            source: { file: "api/src/app.ts", line: 4, column: 9 },
          },
        ],
        [],
      ),
    );
    expect(map.unreadRoutes).toEqual([
      {
        id: "unresolved:api/src/app.ts:4:9",
        method: "GET",
        expression: "prefix + /items",
        service: "service:api/",
        file: "api/src/app.ts",
        line: 4,
        column: 9,
      },
    ]);
    expect(map.services).toEqual([{ id: "service:api/", name: "api" }]);
    expect(map.totals.unreadRoutes).toBe(1);
    expect(map.repo).toEqual({ owner: "o", name: "r", sha: "abc1234" });
  });

  it("merges two callers of one unresolved request, at its earliest site when it has no source", () => {
    const map = apiMap(
      graph(
        [
          svc("web"),
          fn("symbol:web/b.ts#b", "service:web/"),
          fn("symbol:web/a.ts#a", "service:web/"),
          unresolved("unresolved:web/x", "POST /gone", "NO_MATCHING_ROUTE"),
        ],
        [
          http("symbol:web/b.ts#b", "unresolved:web/x", [{ file: "web/b.ts", line: 9, column: 1 }]),
          http("symbol:web/a.ts#a", "unresolved:web/x", [
            { file: "web/b.ts", line: 3, column: 2 },
            { file: "web/b.ts", line: 3, column: 1 },
          ]),
        ],
      ),
    );
    expect(map.broken).toEqual([
      {
        file: "web/b.ts",
        line: 3,
        column: 1,
        id: "unresolved:web/x",
        method: "POST",
        url: "/gone",
        reason: "NO_MATCHING_ROUTE",
        service: "service:web/",
        callers: ["symbol:web/a.ts#a", "symbol:web/b.ts#b"],
      },
    ]);
  });

  it("reads a label with no method as `?`, and a route outside every service as serviceless", () => {
    const map = apiMap(
      graph(
        [
          svc("web"),
          fn("symbol:web/a.ts#a", "service:web/"),
          unresolved("unresolved:web/y", "useSWR(key)", "DYNAMIC_URL", "only known at runtime", {
            file: "web/a.ts",
            line: 2,
            column: 3,
          }),
          {
            id: "route:GET /health",
            kind: "route",
            label: "GET /health",
            parentId: SYSTEM_ID,
            method: "GET",
            path: "/health",
          },
        ],
        [http("symbol:web/a.ts#a", "unresolved:web/y", [])],
      ),
    );
    expect(map.unread).toMatchObject([{ method: "?", url: "useSWR(key)", file: "web/a.ts" }]);
    expect(map.routes).toEqual([
      { id: "route:GET /health", method: "GET", path: "/health", service: null, callers: [] },
    ]);
    expect(map.services).toEqual([{ id: "service:web/", name: "web" }]);
  });

  it("ignores edges that aren't requests, and requests with no site at all", () => {
    const map = apiMap(
      graph(
        [
          svc("web"),
          fn("symbol:web/a.ts#a", "service:web/"),
          unresolved("unresolved:web/z", "GET /nowhere", "NO_MATCHING_ROUTE"),
          unresolved("unresolved:web/i", "./missing.js", "UNKNOWN_SYMBOL", undefined, {
            file: "web/a.ts",
            line: 1,
            column: 1,
          }),
        ],
        [
          http("symbol:web/a.ts#a", "unresolved:web/z", []),
          { ...http("symbol:web/a.ts#a", "unresolved:web/i", []), kind: "imports" },
          http("symbol:web/a.ts#a", "missing:node", []),
        ],
      ),
    );
    expect([...map.broken, ...map.unmatched, ...map.unread]).toEqual([]);
    expect(map.services).toEqual([]);
  });
});

describe("requestKind", () => {
  it("counts only a missing route as broken", () => {
    expect(requestKind("NO_MATCHING_ROUTE", "no route matches GET to /a", "/a")).toBe("broken");
    expect(requestKind("NO_MATCHING_ROUTE", undefined, "/a")).toBe("broken");
    // An unknown wording keeps the reason code's claim.
    expect(requestKind("NO_MATCHING_ROUTE", "something new", "/a")).toBe("broken");
    expect(
      requestKind(
        "NO_MATCHING_ROUTE",
        "only a catch-all of every path matches /me (ALL /*), so it doesn't pick a route",
        "/me",
      ),
    ).toBe("unmatched");
    expect(requestKind("NO_MATCHING_ROUTE", "the http stage failed, so …", "/a")).toBe("unmatched");
    expect(requestKind("DYNAMIC_URL", "no route matches GET to /a", "/a")).toBe("unread");
    expect(requestKind("AMBIGUOUS", undefined, "/a")).toBe("unread");
  });

  it("doesn't call a request to a loopback host broken: its server may be one no detector reads", () => {
    const loopback = (url: string) =>
      requestKind("NO_MATCHING_ROUTE", `no route matches GET to ${url}`, url);
    // maxun's health checks, answered by the browser service's raw `http.createServer`.
    expect(loopback("http://localhost:3002/health")).toBe("unmatched");
    expect(loopback("http://127.0.0.1:{}/api/v1/models")).toBe("unmatched");
    expect(loopback("https://LOCALHOST")).toBe("unmatched");
    expect(loopback("http://0.0.0.0:8080/x")).toBe("unmatched");
    expect(loopback("http://[::1]:5000/x")).toBe("unmatched");
    // Not loopback: the repo's own paths, an env base, and hosts that only start alike.
    expect(loopback("/health")).toBe("broken");
    expect(loopback("{env:VITE_BACKEND_URL}/integration/upload-credentials")).toBe("broken");
    expect(loopback("http://localhost.example.com/x")).toBe("broken");
    expect(loopback("http://127.0.0.1.nip.io/x")).toBe("broken");
    expect(loopback("/proxy/http://localhost:3000")).toBe("broken");
  });
});
