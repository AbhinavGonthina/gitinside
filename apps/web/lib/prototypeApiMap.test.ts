import { describe, expect, it } from "vitest";
import {
  apiMap,
  apiQueryString,
  callersText,
  DEFAULT_API_QUERY,
  filterApiMap,
  parseApiQuery,
} from "./prototypeApiMap";
import { apiMapGraph as graph } from "./prototypeApiMap.testkit";

describe("apiMap (M10.3f3)", () => {
  it("lists every route by path then method, with its service and its callers' sites", () => {
    const map = apiMap(graph());
    expect(map.routes.map((r) => `${r.method} ${r.path} · ${r.service}`)).toEqual([
      "GET /api/orders · @shop/api",
      "POST /api/orders · @shop/api",
      "DELETE /api/orders/:id · @shop/api",
    ]);
    const [get, post, del] = map.routes;
    // Every site of every edge in, sorted by file then line, at its edge's confidence.
    expect(get?.callers).toEqual([
      {
        file: "apps/web/lib/cms.ts",
        line: 7,
        column: 3,
        confidence: "exact",
        name: "latestPosts",
        service: "@shop/web",
      },
      {
        file: "apps/web/lib/cms.ts",
        line: 9,
        column: 3,
        confidence: "exact",
        name: "latestPosts",
        service: "@shop/web",
      },
      {
        file: "apps/web/lib/orders.ts",
        line: 13,
        column: 21,
        confidence: "heuristic",
        name: "listOrders",
        service: "@shop/web",
      },
    ]);
    expect(post?.callers).toHaveLength(1);
    expect(del?.callers).toEqual([]);
  });

  it("keeps broken calls apart from requests it couldn't read, each as the analyzer read it", () => {
    const map = apiMap(graph());
    expect(map.broken).toEqual([
      {
        id: "unresolved:web/lib/cms.ts:3:21",
        method: "GET",
        url: "{env:CMS_URL}/posts",
        reason: "NO_MATCHING_ROUTE",
        detail: "the env var CMS_URL isn't named like an API base (*_API_URL, *_API_PATH, …)",
        serviceId: "service:web/",
        service: "@shop/web",
        file: "apps/web/lib/cms.ts",
        line: 3,
        column: 21,
      },
    ]);
    expect(map.unread.map((c) => [c.reason, c.url, c.file, c.line])).toEqual([
      ["DYNAMIC_URL", "base", "apps/web/lib/orders.ts", 20],
    ]);
    expect(map.services).toEqual([
      ["service:api/", "@shop/api"],
      ["service:web/", "@shop/web"],
    ]);
    expect(map.methods).toEqual(["DELETE", "GET", "POST"]);
  });

  it("gives the same map for the same graph, whatever order its nodes and edges come in", () => {
    const g = graph();
    const shuffled = { ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() };
    expect(apiMap(shuffled)).toEqual(apiMap(g));
  });
});

describe("the API map's query (M10.3f3)", () => {
  it("reads the tab, search, service, and method from the URL, defaulting anything else", () => {
    expect(
      parseApiQuery({ tab: "dead", q: "orders", service: "service:api/", method: "get" }),
    ).toEqual({ tab: "dead", q: "orders", service: "service:api/", method: "GET" });
    expect(parseApiQuery({ tab: "nope", q: ["a", "b"] })).toEqual(DEFAULT_API_QUERY);
  });

  it("writes only what isn't the default, IDs left readable", () => {
    expect(apiQueryString(DEFAULT_API_QUERY)).toBe("");
    expect(apiQueryString({ tab: "broken", q: "a b", service: "service:web/", method: "" })).toBe(
      "tab=broken&q=a%20b&service=service:web/",
    );
  });

  it("filters every tab by service, method, and each word of the search", () => {
    const map = apiMap(graph());
    const view = (q: Partial<typeof DEFAULT_API_QUERY>) =>
      filterApiMap(map, { ...DEFAULT_API_QUERY, ...q });
    expect(view({}).all).toHaveLength(3);
    expect(view({}).dead.map((r) => r.path)).toEqual(["/api/orders/:id"]);
    expect(view({ method: "GET" }).all.map((r) => r.method)).toEqual(["GET"]);
    expect(view({ q: "post orders" }).all.map((r) => r.method)).toEqual(["POST"]);
    expect(view({ q: ":ID" }).all.map((r) => r.method)).toEqual(["DELETE"]);
    // A route is matched by its service's name, a request by its file too.
    expect(view({ q: "shop/api" }).all).toHaveLength(3);
    expect(view({ q: "cms.ts" }).broken).toHaveLength(1);
    expect(view({ service: "service:api/" }).broken).toEqual([]);
    expect(view({ service: "service:web/" }).all).toEqual([]);
    expect(view({ method: "POST" }).unread).toEqual([]);
  });
});

describe("callersText (M10.3f3)", () => {
  const caller = (confidence: "exact" | "pattern" | "heuristic") => ({
    file: "a.ts",
    line: 1,
    column: 1,
    confidence,
    name: "f",
    service: "web",
  });

  it("says a route has no caller in the repo, or counts its callers by confidence", () => {
    expect(callersText([])).toBe("No caller in the repo");
    expect(callersText([caller("exact"), caller("exact")])).toBe("2 · exact");
    expect(
      callersText([caller("heuristic"), caller("exact"), caller("heuristic"), caller("exact")]),
    ).toBe("4 · 2 exact, 2 heuristic");
    expect(callersText([caller("pattern")])).toBe("1 · pattern");
  });
});
