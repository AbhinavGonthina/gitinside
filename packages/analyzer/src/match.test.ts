import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Confidence, GraphNode, HttpMethod } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { serializeGraph } from "./assemble.js";
import {
  alignSegments,
  buildHttpEdges,
  createRouteMatcher,
  externalHost,
  isLoopbackHost,
  parseRoutePath,
  type MatchInput,
  type RouteMatch,
} from "./match.js";
import { parsePattern, type NextRewrite } from "./nextConfig.js";
import { formatUrlPattern, toUrlPattern, type UrlPart } from "./url.js";
import type { Workspace } from "./workspace.js";
import type { HttpRequest } from "./wrappers.js";

const workspace: Workspace = {
  tools: ["pnpm"],
  packages: [
    { key: "api", dir: "apps/api", name: "api", dependencies: [] },
    { key: "web", dir: "apps/web", name: "web", dependencies: [] },
  ],
  warnings: [],
};

/** A route node in `service` (`"GET /api/users/:id"`); `path` overrides the spec's path. */
function route(service: string, spec: string, override?: string): GraphNode {
  const [method = "GET", specPath = "/"] = spec.split(" ");
  const path = override ?? specPath;
  return {
    id: `route:${service}/${spec}`,
    kind: "route",
    label: spec,
    parentId: `file:${service}/server.ts`,
    method: method as HttpMethod,
    path,
  };
}

/** URL parts from text where `{}` is a hole and a leading `{env:X}` an env var. */
function parts(url: string): UrlPart[] {
  const out: UrlPart[] = [];
  const env = /^\{env:(\w+)\}/.exec(url);
  if (env?.[1]) out.push({ kind: "env", name: env[1] });
  (env ? url.slice(env[0].length) : url).split("{}").forEach((piece, i) => {
    if (i > 0) out.push({ kind: "hole" });
    out.push({ kind: "text", text: piece });
  });
  return out;
}

/** A request from `apps/web` (or `file`) for `"GET /api/users/{}"`; `?` is an unknown method. */
function request(spec: string, file = "apps/web/src/client.ts", confidence: Confidence = "exact") {
  const [method = "GET", url = "/"] = spec.split(" ");
  const result = toUrlPattern(parts(url));
  if (!("pattern" in result)) throw new Error(`test URL doesn't normalize: ${url}`);
  const input: MatchInput = {
    file,
    method: method === "?" ? null : (method as HttpMethod),
    url: {
      resolved: true,
      pattern: result.pattern,
      text: formatUrlPattern(result.pattern),
      confidence: "exact",
    },
    confidence,
  };
  return input;
}

/** `confidence route,route [AMBIGUOUS]`, or the outcome's kind and reason. */
function show(match: RouteMatch): string {
  if (match.kind === "external") return `external ${match.host}`;
  if (match.kind === "unresolved") return `${match.reason}: ${match.detail}`;
  return `${match.confidence} ${match.routes.join(",")}` + (match.ambiguous ? " AMBIGUOUS" : "");
}

describe("parseRoutePath", () => {
  it.each([
    ["/", []],
    [
      "/api/users",
      [
        { kind: "literal", text: "api" },
        { kind: "literal", text: "users" },
      ],
    ],
    [
      "/users/:id",
      [
        { kind: "literal", text: "users" },
        { kind: "param", optional: false },
      ],
    ],
    [
      "/users/:id(\\d+)",
      [
        { kind: "literal", text: "users" },
        { kind: "param", optional: false },
      ],
    ],
    [
      "/users/:id?",
      [
        { kind: "literal", text: "users" },
        { kind: "param", optional: true },
      ],
    ],
    [
      "/files/*rest",
      [
        { kind: "literal", text: "files" },
        { kind: "wildcard", min: 0 },
      ],
    ],
    ["/*", [{ kind: "wildcard", min: 0 }]],
    [
      "/p/:path+",
      [
        { kind: "literal", text: "p" },
        { kind: "wildcard", min: 1 },
      ],
    ],
    [
      "/p/:path*",
      [
        { kind: "literal", text: "p" },
        { kind: "wildcard", min: 0 },
      ],
    ],
    ["/:from-:to", [{ kind: "complex" }]],
    ["/ab?cd", [{ kind: "complex" }]],
    ["/data.json", [{ kind: "literal", text: "data.json" }]],
  ])("%s", (path, expected) => {
    expect(parseRoutePath(path)).toEqual(expected);
  });
});

describe("isLoopbackHost", () => {
  it.each([
    ["localhost", true],
    ["localhost:3000", true],
    ["127.0.0.1:8080", true],
    ["0.0.0.0", true],
    ["[::1]:4000", true],
    ["api.localhost", true],
    ["api.example.com", false],
    ["localhost.example.com", false],
  ])("%s ⇒ %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("alignSegments", () => {
  const call = (url: string) => {
    const result = toUrlPattern(parts(url));
    if (!("pattern" in result)) throw new Error(url);
    return result.pattern.segments;
  };
  it.each([
    ["/api/users", "/api/users", 0],
    ["/api/users/{}", "/api/users/:id", 0],
    ["/api/users/42", "/api/users/:id", 1],
    ["/api/users/u-{}", "/api/users/:id", 1],
    ["/api/users/{}", "/api/users/me", Infinity],
    ["/api/files/{}.json", "/api/files/data.json", 1],
    ["/api/files/{}.csv", "/api/files/data.json", Infinity],
    ["/api/a/b/c", "/api/*rest", 1],
    ["/api", "/api/*rest", 1],
    ["/api", "/api/:p+", Infinity],
    ["/api/users", "/api/users/:id?", 0],
    ["/api/users/{}", "/api/users/:id?", 0],
    ["/api/users/{}/posts", "/api/users/:id", Infinity],
    ["/api/users", "/api/users/:id", Infinity],
    ["/", "/", 0],
    ["/x/y", "/:a-:b/y", 1],
  ])("%s vs %s ⇒ %s", (url, path, level) => {
    expect(alignSegments(call(url), parseRoutePath(path))).toBe(level);
  });

  it("stays fast on long paths with many wildcards", () => {
    const segments = call("/" + Array.from({ length: 200 }, (_, i) => `s${i}`).join("/") + "/z");
    const pattern = parseRoutePath("/" + Array.from({ length: 50 }, () => "*").join("/") + "/y");
    const start = performance.now();
    expect(alignSegments(segments, pattern)).toBe(Infinity);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("createRouteMatcher", () => {
  const routes = [
    route("api", "GET /api/users"),
    route("api", "POST /api/users"),
    route("api", "GET /api/users/:id"),
    route("api", "GET /api/users/me"),
    route("api", "DELETE /api/users/:id"),
    route("api", "GET /api/files/*rest"),
    route("web", "GET /api/session"),
    route("web", "ALL /api/legacy"),
    route("web", "GET /api/legacy"),
    route("web", "ALL /api/hooks"),
    route("api", "GET /v1/:org/items"),
    route("api", "GET /v1/:org/:kind"),
  ];
  const matcher = createRouteMatcher(routes, workspace);
  const m = (spec: string, file?: string, confidence?: Confidence) =>
    show(matcher.match(request(spec, file, confidence)));

  it("matches literals and holes exactly within the caller's service", () => {
    expect(m("GET /api/session")).toBe("exact route:web/GET /api/session");
    expect(m("GET /api/users", "apps/api/src/self.ts")).toBe("exact route:api/GET /api/users");
    expect(m("GET /api/users/{}", "apps/api/src/self.ts")).toBe(
      "exact route:api/GET /api/users/:id",
    );
  });

  it("is heuristic for a root-relative URL served by another service", () => {
    expect(m("GET /api/users")).toBe("heuristic route:api/GET /api/users");
  });

  it("is heuristic for a page-relative URL", () => {
    expect(m("GET api/session")).toBe("heuristic route:web/GET /api/session");
  });

  it("matches by method", () => {
    expect(m("POST /api/users", "apps/api/a.ts")).toBe("exact route:api/POST /api/users");
    expect(m("DELETE /api/users/{}", "apps/api/a.ts")).toBe(
      "exact route:api/DELETE /api/users/:id",
    );
    expect(m("PUT /api/users", "apps/api/a.ts")).toBe(
      "NO_MATCHING_ROUTE: no route matches PUT to /api/users",
    );
    expect(m("HEAD /api/session")).toBe("exact route:web/GET /api/session");
  });

  it("matches ALL routes, but the request's own method wins at the same level", () => {
    expect(m("PATCH /api/legacy")).toBe("exact route:web/ALL /api/legacy");
    expect(m("GET /api/legacy")).toBe("exact route:web/GET /api/legacy");
    expect(m("POST /api/hooks")).toBe("exact route:web/ALL /api/hooks");
  });

  it("is heuristic when the method is unknown, and unresolved when only the method would pick (M5C.7a)", () => {
    expect(m("? /api/session")).toBe("heuristic route:web/GET /api/session");
    expect(m("? /api/hooks")).toBe("heuristic route:web/ALL /api/hooks");
    expect(m("? /api/users", "apps/api/a.ts")).toBe(
      "AMBIGUOUS: the method isn't read, and routes for GET, POST match /api/users",
    );
    expect(m("? /api/legacy")).toBe(
      "AMBIGUOUS: the method isn't read, and routes for ALL, GET match /api/legacy",
    );
    // Routes of one method that tie on the path are still linked, as for a known method.
    expect(m("? /v1/acme/items", "apps/api/a.ts")).toBe(
      "heuristic route:api/GET /v1/:org/:kind,route:api/GET /v1/:org/items AMBIGUOUS",
    );
  });

  it("prefers a literal over a param, and a hole never matches a literal", () => {
    expect(m("GET /api/users/me", "apps/api/a.ts")).toBe("exact route:api/GET /api/users/me");
    expect(m("GET /api/users/42", "apps/api/a.ts")).toBe("pattern route:api/GET /api/users/:id");
    expect(m("GET /api/users/{}", "apps/api/a.ts")).toBe("exact route:api/GET /api/users/:id");
  });

  it("matches wildcards at pattern level", () => {
    expect(m("GET /api/files/a/b.png", "apps/api/a.ts")).toBe(
      "pattern route:api/GET /api/files/*rest",
    );
  });

  it("doesn't match a wholly unknown part to catch-alls of every path alone (M5C.7c)", () => {
    const spa = createRouteMatcher(
      [
        route("api", "GET /*splat"),
        route("api", "GET /api/items/:id"),
        route("api", "GET /api/teams/:id/*rest"),
        route("web", "GET /docs/*slug"),
        route("web", "ALL /files/*"),
      ],
      workspace,
    );
    const s = (spec: string, file = "apps/web/src/client.ts") =>
      show(spa.match(request(spec, file)));
    expect(s("GET /api/{}")).toBe(
      "NO_MATCHING_ROUTE: only a catch-all of every path matches /api/{} (GET /*splat), so its unknown part doesn't pick a route",
    );
    expect(s("GET /v/{}/{}", "apps/api/a.ts")).toBe(
      "NO_MATCHING_ROUTE: only a catch-all of every path matches /v/{}/{} (GET /*splat), so its unknown part doesn't pick a route",
    );
    const express = createRouteMatcher(
      [route("api", "ALL *"), route("api", "GET /:a/*b")],
      workspace,
    );
    expect(show(express.match(request("POST /api/{}", "apps/api/a.ts")))).toBe(
      "NO_MATCHING_ROUTE: only a catch-all of every path matches /api/{} (ALL *), so its unknown part doesn't pick a route",
    );
    expect(show(express.match(request("GET /api/{}", "apps/api/a.ts")))).toBe(
      "NO_MATCHING_ROUTE: only a catch-all of every path matches /api/{} (ALL *, GET /:a/*b), so its unknown part doesn't pick a route",
    );
    // A catch-all under a literal (Next's `pages/api/[...slug]`) takes the unknown part: the
    // request named its prefix.
    expect(s("GET /docs/{}")).toBe("pattern route:web/GET /docs/*slug");
    expect(s("POST /files/{}")).toBe("pattern route:web/ALL /files/*");
    // A literal path under a catch-all, a param taking the unknown part, and a partly
    // literal segment still match.
    expect(s("GET /api/health")).toBe("heuristic route:api/GET /*splat");
    expect(s("GET /docs/intro")).toBe("pattern route:web/GET /docs/*slug");
    expect(s("GET /docs/v-{}")).toBe("pattern route:web/GET /docs/*slug");
    expect(s("GET /api/items/{}")).toBe("heuristic route:api/GET /api/items/:id");
    expect(s("GET /api/teams/{}", "apps/api/a.ts")).toBe(
      "pattern route:api/GET /api/teams/:id/*rest",
    );
    // Other failures keep their own detail.
    expect(s("POST /api/{}")).toBe("NO_MATCHING_ROUTE: no route matches POST to /api/{}");
  });

  it("links every equally good route, one level weaker, and records AMBIGUOUS", () => {
    expect(m("GET /v1/{}/items", "apps/api/a.ts")).toBe("exact route:api/GET /v1/:org/items");
    expect(m("GET /v1/acme/{}", "apps/api/a.ts")).toBe("pattern route:api/GET /v1/:org/:kind");
    // Both need a literal-to-param alignment, so neither is a better match.
    expect(m("GET /v1/acme/items", "apps/api/a.ts")).toBe(
      "heuristic route:api/GET /v1/:org/:kind,route:api/GET /v1/:org/items AMBIGUOUS",
    );
  });

  it("downgrades exact ambiguity to pattern", () => {
    const twin = createRouteMatcher(
      [route("api", "GET /a/:x/b"), route("api", "GET /a/:y/:z")],
      workspace,
    );
    expect(show(twin.match(request("GET /a/{}/b", "apps/api/a.ts")))).toBe(
      "exact route:api/GET /a/:x/b",
    );
    expect(show(twin.match(request("GET /a/{}/{}", "apps/api/a.ts")))).toBe(
      "exact route:api/GET /a/:y/:z",
    );
    const same = createRouteMatcher(
      [route("api", "GET /a/:x"), route("web", "GET /a/:y")],
      workspace,
    );
    expect(show(same.match(request("GET /a/{}", "apps/other/x.ts")))).toBe(
      "heuristic route:api/GET /a/:x,route:web/GET /a/:y AMBIGUOUS",
    );
    const exactTwins = createRouteMatcher(
      [route("api", "GET /a/:x"), route("api", "GET /a/:y")],
      workspace,
    );
    expect(show(exactTwins.match(request("GET /a/{}", "apps/api/a.ts")))).toBe(
      "pattern route:api/GET /a/:x,route:api/GET /a/:y AMBIGUOUS",
    );
  });

  it("reads env-var bases by name only", () => {
    expect(m("GET {env:NEXT_PUBLIC_API_URL}/api/users/me")).toBe(
      "heuristic route:api/GET /api/users/me",
    );
    expect(m("GET {env:BASE_URL}/api/session")).toBe("heuristic route:web/GET /api/session");
    expect(m("GET {env:ANALYTICS_HOST}/api/session")).toBe(
      "NO_MATCHING_ROUTE: the env var ANALYTICS_HOST isn't named like an API base (*_API_URL, *_API_PATH, …)",
    );
  });

  it("knows the documented list of API-base env names (ADR-0165)", () => {
    const accepted = [
      "API",
      "REACT_APP_API",
      "API_URL",
      "NEXT_PUBLIC_API_URL",
      "VITE_API_URI",
      "VITE_API_PATH",
      "NEXT_PUBLIC_API_HOST",
      "API_ORIGIN",
      "REACT_APP_API_ROOT",
      "VITE_API_BASE",
      "API_ENDPOINT",
      "BASE_URL",
      "VITE_API_BASE_URL",
      "SERVER_URL",
      "VITE_SERVER_URL",
      "BACKEND_URL",
      "NEXT_PUBLIC_BACKEND_URL",
    ];
    for (const name of accepted) {
      expect(`${name}: ${m(`GET {env:${name}}/api/session`)}`).toBe(
        `${name}: heuristic route:web/GET /api/session`,
      );
    }
    const refused = [
      "ANALYTICS_HOST",
      "CMS_URL",
      "STRIPE_API_KEY",
      "REACT_APP_FOODIE_API_VERSION",
      "NEXT_PUBLIC_APP_URL",
      "RAPIDAPI",
      "MAPI_URL",
      "SERVER_PORT",
      "VITE_SERVER",
      "BASE_PATH",
      "api_url",
    ];
    for (const name of refused) {
      expect(`${name}: ${m(`GET {env:${name}}/api/session`)}`).toMatch(
        new RegExp(`^${name}: NO_MATCHING_ROUTE: the env var ${name} isn't named like an API base`),
      );
    }
  });

  it("reads any env base with a loopback fallback as this repo, at heuristic", () => {
    /** `GET <env ?? fallback><path>` from `apps/web`. */
    const withFallback = (name: string, fallback: string, path: string): string => {
      const result = toUrlPattern([
        { kind: "env", name, fallback: [{ kind: "text", text: fallback }] },
        { kind: "text", text: path },
      ]);
      if (!("pattern" in result)) throw new Error(`test URL doesn't normalize: ${path}`);
      return show(
        matcher.match({
          file: "apps/web/src/client.ts",
          method: "GET",
          url: {
            resolved: true,
            pattern: result.pattern,
            text: formatUrlPattern(result.pattern),
            confidence: "exact",
          },
          confidence: "exact",
        }),
      );
    };
    expect(withFallback("REACT_APP_FOODIE_URL", "http://localhost:9000/api", "/users/me")).toBe(
      "heuristic route:api/GET /api/users/me",
    );
    expect(withFallback("NEXT_PUBLIC_API_URL", "http://127.0.0.1/api", "/users/me")).toBe(
      "heuristic route:api/GET /api/users/me",
    );
    expect(withFallback("ANALYTICS_HOST", "https://stats.example.com", "/api/session")).toBe(
      "NO_MATCHING_ROUTE: the env var ANALYTICS_HOST isn't named like an API base (*_API_URL, *_API_PATH, …)",
    );
    expect(withFallback("ANALYTICS_HOST", "/api", "/session")).toBe(
      "NO_MATCHING_ROUTE: the env var ANALYTICS_HOST isn't named like an API base (*_API_URL, *_API_PATH, …)",
    );
  });

  it("treats loopback hosts as this repo and other hosts as external", () => {
    expect(m("GET http://localhost:4000/api/users/me")).toBe(
      "heuristic route:api/GET /api/users/me",
    );
    expect(m("GET https://api.stripe.com/v1/charges")).toBe("external api.stripe.com");
  });

  it("passes unresolved URLs through and never beats the request's own confidence", () => {
    expect(
      show(
        matcher.match({
          file: "apps/web/a.ts",
          method: "GET",
          url: {
            resolved: false,
            reason: "DYNAMIC_URL",
            detail: "the URL can't be read statically",
          },
          confidence: "exact",
        }),
      ),
    ).toBe("DYNAMIC_URL: the URL can't be read statically");
    expect(m("GET /api/session", undefined, "heuristic")).toBe(
      "heuristic route:web/GET /api/session",
    );
    expect(m("GET /api/users/42", "apps/api/a.ts", "heuristic")).toBe(
      "heuristic route:api/GET /api/users/:id",
    );
  });

  it("matches routes reached only through a folder listing at heuristic at best (ADR-0162)", () => {
    const listed = createRouteMatcher(
      [route("api", "GET /listed/:id"), route("api", "GET /coded/:id")],
      workspace,
      new Set(["route:api/GET /listed/:id"]),
    );
    const from = (spec: string) => show(listed.match(request(spec, "apps/api/a.ts")));
    expect(from("GET /listed/{}")).toBe("heuristic route:api/GET /listed/:id");
    expect(from("GET /coded/{}")).toBe("exact route:api/GET /coded/:id");
  });

  it("tries an example env file's path in front of an env base first, never showing it (ADR-0202)", () => {
    const asked: string[] = [];
    const prefixed = createRouteMatcher(
      [
        route("api", "POST /api/auth/login"),
        route("api", "GET /users"),
        route("api", "GET /api/users"),
      ],
      workspace,
      new Set(),
      (name, file) => {
        asked.push(`${name} ${file}`);
        return name === "VITE_SERVER_BASE_URL" || name === "ANALYTICS" ? ["api"] : undefined;
      },
    );
    const from = (spec: string) => show(prefixed.match(request(spec)));
    expect(from("POST {env:VITE_SERVER_BASE_URL}/auth/login")).toBe(
      "heuristic route:api/POST /api/auth/login",
    );
    // The prefixed path wins over the bare one; the bare one is the fallback.
    expect(from("GET {env:VITE_SERVER_BASE_URL}/users")).toBe("heuristic route:api/GET /api/users");
    expect(from("GET {env:VITE_SERVER_BASE_URL}/api/auth/login")).toBe(
      "NO_MATCHING_ROUTE: no route matches GET to {env:VITE_SERVER_BASE_URL}/api/auth/login",
    );
    expect(from("POST {env:VITE_SERVER_BASE_URL}/api/auth/login")).toBe(
      "heuristic route:api/POST /api/auth/login",
    );
    // No match either way: the detail is the request's own URL, without the env path.
    expect(from("GET {env:VITE_SERVER_BASE_URL}/nope")).toBe(
      "NO_MATCHING_ROUTE: no route matches GET to {env:VITE_SERVER_BASE_URL}/nope",
    );
    // An env var not named like an API base stays unmatched, prefix or not.
    expect(from("GET {env:ANALYTICS}/users")).toMatch(/isn't named like an API base/);
    // Root-relative requests never ask.
    expect(from("GET /users")).toBe("heuristic route:api/GET /users");
    expect(asked.every((a) => a.endsWith(" apps/web/src/client.ts"))).toBe(true);
    expect(asked.some((a) => a.startsWith("ANALYTICS"))).toBe(false);
  });

  it("matches a request sent through a dev proxy by the path the proxy sends (ADR-0204)", () => {
    const host = (h: string, path = "") =>
      ({ kind: "host", scheme: h.startsWith("api.") ? "https" : "http", host: h, path }) as const;
    const proxied = createRouteMatcher(
      [
        route("api", "GET /users"),
        route("api", "GET /api/users"),
        route("api", "GET /users/:id"),
        route("web", "GET /auth/session"),
        route("web", "GET /health"),
      ],
      workspace,
      new Set(),
      undefined,
      (file) =>
        file.startsWith("apps/web/")
          ? {
              config: "apps/web/vite.config.ts",
              rules: [
                {
                  context: "/api",
                  rewrite: { from: "/api", to: "", anchored: true },
                  target: host("localhost:5000"),
                },
                { context: "/auth", rewrite: undefined, target: host("127.0.0.1:5000") },
                { context: "/maps", rewrite: undefined, target: host("api.maps.example.com") },
                { context: "/svc", rewrite: undefined, target: host("backend:4000") },
                { context: "/odd", rewrite: "unknown", target: host("localhost:5000") },
                { context: "/env", rewrite: undefined, target: { kind: "unknown" } },
                { context: undefined, rewrite: undefined, target: { kind: "unknown" } },
              ],
            }
          : undefined,
    );
    const from = (spec: string, file?: string) => show(proxied.match(request(spec, file)));
    // The rewrite strips `/api`, so `/api/users` reaches `/users`, not the `/api/users` route.
    expect(from("GET /api/users")).toBe("heuristic route:api/GET /users");
    expect(from("GET /api/users/{}")).toBe("heuristic route:api/GET /users/:id");
    // A proxied request leaves its own service, so even its routes are only heuristic.
    expect(from("GET /auth/session")).toBe("heuristic route:web/GET /auth/session");
    // A literal outside host is an external API; a single-label host may be a compose service.
    expect(from("GET /maps/tiles")).toBe("external api.maps.example.com");
    expect(from("GET /svc/users")).toBe(
      "NO_MATCHING_ROUTE: " +
        "no route matches GET to /svc/users (sent as /svc/users by the dev proxy in apps/web/vite.config.ts)",
    );
    expect(from("GET /env/users/{}")).toBe(
      "NO_MATCHING_ROUTE: no route matches GET to /env/users/{} (sent as /env/users/{} by the dev proxy in apps/web/vite.config.ts)",
    );
    // No fallback to the unrewritten path: that would be a guess.
    expect(from("GET /api/nope")).toBe(
      "NO_MATCHING_ROUTE: no route matches GET to /api/nope (sent as /nope by the dev proxy in apps/web/vite.config.ts)",
    );
    expect(from("GET /odd/users")).toBe(
      "NO_MATCHING_ROUTE: the dev proxy for /odd in apps/web/vite.config.ts rewrites the path in a way that isn't read",
    );
    // Past an unread entry, or for another service's files, matching is as before.
    expect(from("GET /health")).toBe("exact route:web/GET /health");
    expect(from("GET /users", "apps/api/a.ts")).toBe("exact route:api/GET /users");
    // Only root-relative requests go through the dev server.
    expect(from("GET http://localhost:5000/api/users")).toBe("heuristic route:api/GET /api/users");
  });

  it("gives a proxied external call no more than heuristic confidence", () => {
    const proxied = createRouteMatcher([], workspace, new Set(), undefined, () => ({
      config: "vite.config.ts",
      rules: [
        {
          context: "/",
          rewrite: undefined,
          target: { kind: "host", scheme: "https", host: "api.example.com", path: "" },
        },
      ],
    }));
    const match = proxied.match(request("GET /x"));
    expect(match).toEqual({
      kind: "external",
      scheme: "https",
      host: "api.example.com",
      confidence: "heuristic",
    });
    const site = { file: "apps/web/a.ts", line: 1, column: 1 };
    // Only the fields the edge builder reads.
    const sent = { ...request("GET /x"), owners: ["symbol:web/a.ts#f"], site } as unknown;
    const built = buildHttpEdges([sent as HttpRequest], proxied, workspace);
    expect(built.edges.map((e) => `${e.kind} ${e.to} ${e.confidence}`)).toEqual([
      "external_call external:ext/api.example.com heuristic",
    ]);
  });

  it("matches a Next app's routes under its basePath, from any service (ADR-0206)", () => {
    const next = [route("web", "GET /api/items"), route("web", "GET /api/items/:id")];
    // A custom server's Express route in the same service isn't under basePath.
    const custom = route("web", "GET /healthz");
    const page: GraphNode = {
      id: "page:web//about",
      kind: "page",
      label: "/about",
      parentId: "service:web/",
      layer: "frontend",
      path: "/about",
    };
    const matcher = createRouteMatcher(
      [custom, ...next],
      workspace,
      new Set(),
      undefined,
      undefined,
      {
        configs: (s) =>
          s === "web"
            ? {
                config: "apps/web/next.config.js",
                basePath: ["shop"],
                beforeFiles: [],
                afterFiles: [],
                fallback: [],
              }
            : undefined,
        nodes: [...next, page],
      },
    );
    const from = (spec: string, file?: string) => show(matcher.match(request(spec, file)));
    expect(from("GET /shop/api/items")).toBe("exact route:web/GET /api/items");
    expect(from("GET /shop/api/items/{}")).toBe("exact route:web/GET /api/items/:id");
    expect(from("GET /healthz")).toBe("exact route:web/GET /healthz");
    expect(from("GET /api/items")).toBe(
      "NO_MATCHING_ROUTE: no route matches GET to /api/items (the Next app's basePath in apps/web/next.config.js is /shop)",
    );
    // Another service reaches it under basePath too, and gets no basePath hint.
    expect(from("GET http://localhost:3000/shop/api/items", "apps/api/a.ts")).toBe(
      "heuristic route:web/GET /api/items",
    );
    expect(from("GET /api/items", "apps/api/a.ts")).toBe(
      "NO_MATCHING_ROUTE: no route matches GET to /api/items",
    );
  });

  it("sends a Next app's own root-relative requests through its rewrites (ADR-0206)", () => {
    const rewrite = (
      text: string,
      target: NextRewrite["target"],
      destination: string | undefined,
    ): NextRewrite => ({
      text,
      source: parsePattern(text),
      target,
      destination: destination === undefined ? undefined : parsePattern(destination),
      basePath: true,
      conditional: false,
    });
    const matcher = createRouteMatcher(
      [
        route("web", "GET /api/items"),
        route("api", "GET /users/:id"),
        route("api", "GET /api/users/:id"),
      ],
      workspace,
      new Set(),
      undefined,
      undefined,
      {
        configs: (s) =>
          s === "web"
            ? {
                config: "apps/web/next.config.js",
                basePath: [],
                beforeFiles: [],
                afterFiles: [
                  rewrite("/old/items", { kind: "internal" }, "/api/items"),
                  rewrite(
                    "/api/:path*",
                    { kind: "host", scheme: "http", host: "localhost:4000" },
                    "/:path*",
                  ),
                  rewrite(
                    "/maps/:p*",
                    { kind: "host", scheme: "https", host: "maps.example.com" },
                    "/:p*",
                  ),
                  rewrite("/env/:p*", { kind: "env", name: "BACKEND_URL" }, "/api/:p*"),
                  rewrite("/cms/:p*", { kind: "env", name: "CMS_HOST" }, "/:p*"),
                  rewrite(
                    "/odd/:p*",
                    { kind: "host", scheme: "http", host: "localhost:4000" },
                    undefined,
                  ),
                  rewrite("/who/:p*", { kind: "unknown" }, "/:p*"),
                ],
                fallback: [],
              }
            : undefined,
        nodes: [route("web", "GET /api/items")],
      },
    );
    const from = (spec: string, file?: string) => show(matcher.match(request(spec, file)));
    // An internal destination keeps the app's own routes exact.
    expect(from("GET /old/items")).toBe("exact route:web/GET /api/items");
    // The app's static route is served before afterFiles; the rest goes to the server.
    expect(from("GET /api/items")).toBe("exact route:web/GET /api/items");
    expect(from("GET /api/users/{}")).toBe("heuristic route:api/GET /users/:id");
    expect(from("GET /api/nope")).toBe(
      "NO_MATCHING_ROUTE: no route matches GET to /api/nope (rewritten to /nope by apps/web/next.config.js)",
    );
    // A literal outside host is exact: rewrites apply in production too.
    expect(matcher.match(request("GET /maps/x"))).toEqual({
      kind: "external",
      scheme: "https",
      host: "maps.example.com",
    });
    expect(from("GET /env/users/{}")).toBe("heuristic route:api/GET /api/users/:id");
    expect(from("GET /cms/x")).toBe(
      "NO_MATCHING_ROUTE: the rewrite of /cms/:p* in apps/web/next.config.js sends it to the env var CMS_HOST, not named like an API base",
    );
    expect(from("GET /odd/x")).toBe(
      "NO_MATCHING_ROUTE: the rewrite of /odd/:p* in apps/web/next.config.js builds a path that isn't read",
    );
    expect(from("GET /who/x")).toBe(
      "NO_MATCHING_ROUTE: the rewrite of /who/:p* in apps/web/next.config.js sends it to an address that isn't read",
    );
    // Other services' requests and absolute URLs don't go through the app's rewrites.
    expect(from("GET /api/users/{}", "apps/api/a.ts")).toBe("exact route:api/GET /api/users/:id");
    expect(from("GET http://localhost:3000/old/items")).toBe(
      "NO_MATCHING_ROUTE: no route matches GET to http://localhost:3000/old/items",
    );
  });

  it("only aligns against routes from the index bucket", () => {
    // A request whose first segment is a hole can't reach a literal-first route.
    expect(m("GET /{}/users")).toBe("NO_MATCHING_ROUTE: no route matches GET to /{}/users");
    const wild = createRouteMatcher([route("api", "GET /:tenant/users")], workspace);
    expect(show(wild.match(request("GET /acme/users", "apps/api/a.ts")))).toBe(
      "pattern route:api/GET /:tenant/users",
    );
  });

  it("keeps the first route node with a given ID and knows route labels", () => {
    const dup = createRouteMatcher(
      [route("api", "GET /x"), route("api", "GET /x", "/y")],
      workspace,
    );
    expect(show(dup.match(request("GET /x", "apps/api/a.ts")))).toBe("exact route:api/GET /x");
    expect(dup.label("route:api/GET /x")).toBe("GET /x");
    expect(dup.label("route:api/GET /nope")).toBeUndefined();
  });
});

describe("buildHttpEdges", () => {
  const matcher = createRouteMatcher(
    [route("api", "GET /a/:x"), route("api", "GET /:y/b"), route("api", "GET /c")],
    workspace,
  );
  const req = (spec: string, owners: string[], line: number, file = "apps/api/f.ts") =>
    ({
      ...request(spec, file),
      owners,
      site: { file, line, column: 1 },
    }) as unknown as HttpRequest; // only the fields the edge builder reads

  it("draws one edge per owner and route, merging sites at the strongest confidence", () => {
    const { edges, matches } = buildHttpEdges(
      [
        req("GET /c", ["symbol:api/f.ts#one", "symbol:api/f.ts#two"], 3),
        req("GET /c", ["symbol:api/f.ts#one"], 1),
        req("GET /c", ["symbol:api/f.ts#one"], 1),
        req("GET /c", [], 9),
        req("GET /c", [], 9, "elsewhere/x.ts"),
        req("GET /a/b", ["symbol:api/f.ts#amb"], 5),
        req("GET /a/{}", ["symbol:api/f.ts#amb"], 6),
      ],
      matcher,
      workspace,
    );
    expect(matches).toHaveLength(7);
    expect(
      edges.map(
        (e) =>
          `${e.from} -> ${e.to} ${e.confidence}${e.reason ? " " + e.reason : ""} ` +
          e.sites.map((s) => `${s.file}:${s.line}`).join(","),
      ),
    ).toEqual([
      "file:api/f.ts -> route:api/GET /c exact apps/api/f.ts:9",
      "symbol:api/f.ts#amb -> route:api/GET /:y/b heuristic AMBIGUOUS apps/api/f.ts:5",
      "symbol:api/f.ts#amb -> route:api/GET /a/:x exact apps/api/f.ts:5,apps/api/f.ts:6",
      "symbol:api/f.ts#one -> route:api/GET /c exact apps/api/f.ts:1,apps/api/f.ts:3",
      "symbol:api/f.ts#two -> route:api/GET /c exact apps/api/f.ts:3",
    ]);
    expect(edges.find((e) => e.to === "route:api/GET /c")?.label).toBe("GET /c");
  });

  it("links literal external hosts to one external node per host", () => {
    const { nodes, edges } = buildHttpEdges(
      [
        req("GET https://api.stripe.com/v1/charges", ["symbol:api/f.ts#pay"], 1),
        req("POST https://api.stripe.com:443/v1/refunds", ["symbol:api/f.ts#pay"], 2),
        { ...req("GET //cdn.x.com:8080/a", [], 3), confidence: "heuristic" } as HttpRequest,
      ],
      matcher,
      workspace,
    );
    expect(nodes).toEqual([
      {
        id: "external:ext/api.stripe.com",
        kind: "external",
        label: "api.stripe.com",
        parentId: "system:root",
        layer: "external",
        host: "api.stripe.com",
      },
      {
        id: "external:ext/cdn.x.com:8080",
        kind: "external",
        label: "cdn.x.com:8080",
        parentId: "system:root",
        layer: "external",
        host: "cdn.x.com:8080",
      },
    ]);
    expect(
      edges.map((e) => `${e.id} ${e.confidence} ${e.sites.map((s) => s.line).join(",")}`),
    ).toEqual([
      "external_call:file:api/f.ts->external:ext/cdn.x.com:8080 heuristic 3",
      "external_call:symbol:api/f.ts#pay->external:ext/api.stripe.com exact 1,2",
    ]);
  });
});

describe("externalHost", () => {
  it.each([
    ["https", "api.x.com:443", "api.x.com"],
    ["wss", "api.x.com:443", "api.x.com"],
    ["http", "api.x.com:80", "api.x.com"],
    ["ws", "api.x.com:80", "api.x.com"],
    ["http", "api.x.com:443", "api.x.com:443"],
    ["https", "api.x.com:8443", "api.x.com:8443"],
    ["https", "[2001:db8::1]:443", "[2001:db8::1]"],
    [null, "cdn.x.com:443", "cdn.x.com:443"],
    ["ftp", "files.x.com:21", "files.x.com:21"],
  ] as const)("%s://%s ⇒ %s", (scheme, host, expected) => {
    expect(externalHost(scheme, host)).toBe(expected);
  });
});

describe("analyze: http edges", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gitinside-match-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const put = async (path: string, content: string[]): Promise<void> => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content.join("\n") + "\n");
  };

  it("keeps empty hosts and long URLs as valid, short nodes (M2 review)", async () => {
    await put("package.json", [JSON.stringify({ name: "web" })]);
    await put("src/api.ts", [
      'export const a = () => fetch("https:///x");',
      'export const b = () => fetch("https://user@/x");',
      `export const c = () => fetch("/${"long/".repeat(60)}");`,
    ]);
    // `serializeGraph` validates, so an empty label or host would throw here.
    const graph = JSON.parse(serializeGraph(await analyze(dir))) as { nodes: GraphNode[] };
    const unresolved = graph.nodes.filter((n) => n.kind === "unresolved");
    expect(unresolved.map((n) => n.kind === "unresolved" && [n.reason, n.detail])).toEqual([
      ["DYNAMIC_URL", "the URL has an empty host"],
      ["DYNAMIC_URL", "the URL has an empty host"],
      ["NO_MATCHING_ROUTE", expect.stringMatching(/^no route matches GET to \/long\/.*…$/)],
    ]);
    for (const n of unresolved) expect(n.label.length).toBeLessThanOrEqual(120);
    expect(graph.nodes.some((n) => n.kind === "external")).toBe(false);
  });

  it("links frontend fetch and axios calls to Express and Next routes", async () => {
    await put("package.json", [JSON.stringify({ name: "shop", workspaces: ["apps/*"] })]);
    await put("apps/api/package.json", [
      JSON.stringify({ name: "api", dependencies: { express: "4" } }),
    ]);
    await put("apps/api/src/server.ts", [
      'import express from "express";',
      "const app = express();",
      "export function listOrders() {}",
      "export function getOrder() {}",
      'app.get("/api/orders", listOrders);',
      'app.get("/api/orders/:id", getOrder);',
      "app.listen(3000);",
    ]);
    await put("apps/web/package.json", [
      JSON.stringify({ name: "web", dependencies: { next: "14", axios: "1" } }),
    ]);
    await put("apps/web/app/api/me/route.ts", ["export async function GET() {}"]);
    await put("apps/web/lib/client.ts", [
      'import axios from "axios";',
      "const api = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL });",
      "export async function me() {",
      '  return fetch("/api/me");',
      "}",
      "export async function order(id: string) {",
      "  return api.get(`/api/orders/${id}`);",
      "}",
      "export async function orders() {",
      '  return fetch("http://localhost:3000/api/orders");',
      "}",
      "export async function missing() {",
      '  return fetch("/api/nothing");',
      "}",
    ]);

    const graph = await analyze(dir);
    const http = graph.edges
      .filter((e) => e.kind === "http")
      .map((e) => `${e.from} -> ${e.to} ${e.confidence} ${e.label ?? ""}`);
    expect(http).toEqual([
      "symbol:web/lib/client.ts#me -> route:web/GET /api/me exact GET /api/me",
      "symbol:web/lib/client.ts#missing -> unresolved:web/lib/client.ts:13:10 unresolved ",
      "symbol:web/lib/client.ts#order -> route:api/GET /api/orders/:id heuristic GET /api/orders/:id",
      "symbol:web/lib/client.ts#orders -> route:api/GET /api/orders heuristic GET /api/orders",
    ]);
    const me = graph.edges.find((e) => e.from === "symbol:web/lib/client.ts#me");
    // The site keeps the request's text for the diff (ADR-0087's M6.11c amendment).
    expect(me?.sites).toEqual([
      { file: "apps/web/lib/client.ts", line: 4, column: 10, request: "GET /api/me" },
    ]);
  });

  it("keeps unmatched requests as unresolved nodes and literal hosts as external nodes", async () => {
    await put("package.json", [JSON.stringify({ name: "shop", workspaces: ["apps/*"] })]);
    await put("apps/api/package.json", [
      JSON.stringify({ name: "api", dependencies: { express: "4" } }),
    ]);
    await put("apps/api/src/server.ts", [
      'import express from "express";',
      "const app = express();",
      'app.get("/api/orders", (req, res) => {',
      '  void fetch("https://hooks.slack.com/services/x", { method: "POST" });',
      "});",
    ]);
    await put("apps/web/package.json", [JSON.stringify({ name: "web" })]);
    await put("apps/web/lib/client.ts", [
      "declare function buildUrl(): string;",
      "export async function missing() {",
      '  return fetch("/api/nothing");',
      "}",
      "export async function dynamic() {",
      "  return fetch(buildUrl());",
      "}",
      "export async function pay() {",
      '  await fetch("https://user:s3cret@API.Stripe.com:443/v1/charges", { method: "POST" });',
      '  return fetch("https://api.stripe.com/v1/refunds");',
      "}",
      "export async function get(path: string) {",
      "  return fetch(path);",
      "}",
      "export async function deeper(p: string) {",
      "  return get(p);",
      "}",
      "export async function other() {",
      '  return fetch(process.env.ANALYTICS + "/e");',
      "}",
      'void fetch("/api/top-level");',
    ]);

    const graph = await analyze(dir);
    const unresolved = graph.nodes
      .filter((n) => n.kind === "unresolved")
      .map((n) => n.kind === "unresolved" && `${n.id} | ${n.label} | ${n.reason}: ${n.detail}`);
    expect(unresolved).toEqual([
      "unresolved:web/lib/client.ts:16:10 | GET get(p) | WRAPPER_DEPTH: the URL starts with a parameter of the calling function, and no call to that function was followed",
      "unresolved:web/lib/client.ts:19:10 | GET {env:ANALYTICS}/e | NO_MATCHING_ROUTE: the env var ANALYTICS isn't named like an API base (*_API_URL, *_API_PATH, …)",
      "unresolved:web/lib/client.ts:21:6 | GET /api/top-level | NO_MATCHING_ROUTE: no route matches GET to /api/top-level",
      "unresolved:web/lib/client.ts:3:10 | GET /api/nothing | NO_MATCHING_ROUTE: no route matches GET to /api/nothing",
      "unresolved:web/lib/client.ts:6:10 | GET buildUrl() | DYNAMIC_URL: the URL starts with a value only known at runtime",
    ]);
    const dynamic = graph.nodes.find((n) => n.id === "unresolved:web/lib/client.ts:6:10");
    expect(dynamic).toMatchObject({
      parentId: "service:web/",
      expression: "fetch(buildUrl())",
      source: { file: "apps/web/lib/client.ts", line: 6, column: 10 },
    });

    expect(
      graph.nodes.filter((n) => n.kind === "external").map((n) => n.kind === "external" && n.host),
    ).toEqual(["api.stripe.com", "hooks.slack.com"]);

    const edges = graph.edges
      .filter((e) => e.kind === "http" || e.kind === "external_call")
      .map((e) => `${e.from} -> ${e.to} ${e.confidence}${e.reason ? " " + e.reason : ""}`);
    expect(edges).toEqual([
      "route:api/GET /api/orders -> external:ext/hooks.slack.com exact",
      "symbol:web/lib/client.ts#pay -> external:ext/api.stripe.com exact",
      "file:web/lib/client.ts -> unresolved:web/lib/client.ts:21:6 unresolved NO_MATCHING_ROUTE",
      "symbol:web/lib/client.ts#deeper -> unresolved:web/lib/client.ts:16:10 unresolved WRAPPER_DEPTH",
      "symbol:web/lib/client.ts#dynamic -> unresolved:web/lib/client.ts:6:10 unresolved DYNAMIC_URL",
      "symbol:web/lib/client.ts#missing -> unresolved:web/lib/client.ts:3:10 unresolved NO_MATCHING_ROUTE",
      "symbol:web/lib/client.ts#other -> unresolved:web/lib/client.ts:19:10 unresolved NO_MATCHING_ROUTE",
    ]);
    // Credentials in a literal URL never reach the graph.
    expect(JSON.stringify(graph)).not.toContain("s3cret");
  });
});
