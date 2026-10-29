import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArchitectureGraph, GraphEdge, SourceLocation } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { serializeGraph } from "./assemble.js";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { collectHttpCalls, type HttpCallSite } from "./http.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
import { createUrlNormalizer } from "./url.js";
import { detectWorkspace } from "./workspace.js";
import { inlineWrappers, type HttpRequest } from "./wrappers.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

/** Analyze `fixtures/<name>` with a fixed repo identity so goldens don't depend on the checkout path. */
async function run(name: string): Promise<ArchitectureGraph> {
  return analyze(join(FIXTURES, name), { owner: "fixtures", name });
}

const NAMES = [
  "express-basic",
  "express-nested-routers",
  "next-app-router",
  "next-pages-api",
  "prisma-relations",
  "pnpm-monorepo",
  "syntax-error",
  "no-tsconfig",
  "fetch-template-literal",
  "axios-baseurl-instance",
  "env-base-heuristic",
  "ambiguous-routes",
  "wrapper-fetch",
  "external-sdk",
  "compose-and-env",
  "fake-secrets",
  "queues-bullmq",
  "shop-demo",
  "checker-crash",
];

describe.each(NAMES)("fixture %s", (name) => {
  it("matches expected.json byte for byte", async () => {
    const text = serializeGraph(await run(name));
    const goldenPath = join(FIXTURES, name, "expected.json");
    if (process.env.UPDATE_GOLDEN === "1") await writeFile(goldenPath, text);
    expect(text).toBe(await readFile(goldenPath, "utf8"));
  });
});

/** Ids of nodes of one kind. */
function ids(graph: ArchitectureGraph, kind: string): string[] {
  return graph.nodes.filter((n) => n.kind === kind).map((n) => n.id);
}

describe("fixture contents (guards against blindly regenerated goldens)", () => {
  it("express-basic finds three routes; imported handlers get handles edges", async () => {
    const g = await run("express-basic");
    expect(ids(g, "route")).toHaveLength(3);
    // The inline /health handler has no symbol to link; the two imported ones do.
    expect(g.edges.filter((e) => e.kind === "handles")).toHaveLength(2);
  });

  it("express-nested-routers composes mount prefixes", async () => {
    const g = await run("express-nested-routers");
    const routes = ids(g, "route").join("\n");
    expect(routes).toContain("/api/ping");
    expect(routes).toContain("/api/orders/:id");
  });

  it("next-app-router strips route groups and keeps dynamic segments", async () => {
    const g = await run("next-app-router");
    const all = [...ids(g, "route"), ...ids(g, "page")].join("\n");
    expect(all).toContain("/products/:id");
    expect(all).not.toContain("(shop)");
    expect(ids(g, "route").filter((id) => id.includes("/api/items"))).toHaveLength(2);
  });

  it("next-pages-api finds the pages and API routes", async () => {
    const g = await run("next-pages-api");
    expect(ids(g, "route").join("\n")).toContain("/api/hello");
    expect(ids(g, "route").join("\n")).toContain("/api/echo/:id");
    expect(ids(g, "page").length).toBeGreaterThanOrEqual(1);
  });

  it("prisma-relations finds models, a datastore, and an unresolved raw query", async () => {
    const g = await run("prisma-relations");
    expect(ids(g, "model")).toHaveLength(2);
    expect(ids(g, "datastore")).toHaveLength(1);
    expect(g.nodes.some((n) => n.kind === "unresolved" && n.reason === "RAW_QUERY")).toBe(true);
    expect(g.edges.some((e) => e.kind === "reads")).toBe(true);
    expect(g.edges.some((e) => e.kind === "writes")).toBe(true);
  });

  it("pnpm-monorepo has two services and a cross-service import", async () => {
    const g = await run("pnpm-monorepo");
    expect(ids(g, "service")).toHaveLength(2);
    expect(g.edges.some((e) => e.kind === "imports" && e.to.includes("shared"))).toBe(true);
  });

  it("syntax-error still analyzes and warns", async () => {
    const g = await run("syntax-error");
    expect(g.warnings.some((w) => w.code === "SYNTAX_ERROR")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "symbol" && n.label === "fine")).toBe(true);
  });

  it("no-tsconfig resolves the CommonJS require", async () => {
    const g = await run("no-tsconfig");
    expect(g.warnings.some((w) => w.code === "TSCONFIG_MISSING")).toBe(true);
    expect(g.edges.some((e) => e.kind === "imports")).toBe(true);
  });
});

/** `from -> to confidence [reason]` per edge of the given kinds, sorted. */
function links(graph: ArchitectureGraph, ...kinds: GraphEdge["kind"][]): string[] {
  return graph.edges
    .filter((e) => kinds.includes(e.kind))
    .map((e) => `${e.from} -> ${e.to} ${e.confidence}${e.reason ? ` ${e.reason}` : ""}`)
    .sort();
}

/** The reason of each unresolved node, keyed by ID. */
function reasons(graph: ArchitectureGraph): Record<string, string> {
  return Object.fromEntries(
    graph.nodes.flatMap((n) => (n.kind === "unresolved" ? [[n.id, n.reason]] : [])),
  );
}

describe("M2 pattern fixtures produce the expected edge and confidence", () => {
  it("fetch-template-literal: holes match params, queries are dropped, misses stay visible", async () => {
    const g = await run("fetch-template-literal");
    const p = "fetch-template-literal";
    expect(links(g, "http")).toEqual([
      `file:${p}/src/client.ts -> route:${p}/GET /api/users exact`,
      `symbol:${p}/src/client.ts#listUsers -> route:${p}/GET /api/users exact`,
      `symbol:${p}/src/client.ts#loadTeams -> unresolved:${p}/src/client.ts:15:21 unresolved NO_MATCHING_ROUTE`,
      `symbol:${p}/src/client.ts#loadUser -> route:${p}/GET /api/users/:id exact`,
    ]);
  });

  it("axios-baseurl-instance: the imported instance's baseURL prefixes each request", async () => {
    const g = await run("axios-baseurl-instance");
    const p = "axios-baseurl-instance";
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/orders.ts#createOrder -> route:${p}/POST /api/orders exact`,
      `symbol:${p}/src/orders.ts#getOrder -> route:${p}/GET /api/orders/:id exact`,
    ]);
  });

  it("env-base-heuristic: API-named env bases are heuristic across services; others unresolved", async () => {
    const g = await run("env-base-heuristic");
    expect(links(g, "http")).toEqual([
      "symbol:web/src/users.ts#loadMe -> route:api/GET /users/me heuristic",
      "symbol:web/src/users.ts#loadUser -> route:api/GET /users/:id heuristic",
      "symbol:web/src/users.ts#track -> unresolved:web/src/users.ts:17:9 unresolved NO_MATCHING_ROUTE",
    ]);
  });

  it("ambiguous-routes: a tie links to every candidate, weaker, with AMBIGUOUS", async () => {
    const g = await run("ambiguous-routes");
    const p = "ambiguous-routes";
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/client.ts#acmeItems -> route:${p}/GET /v1/:org/items heuristic AMBIGUOUS`,
      `symbol:${p}/src/client.ts#acmeItems -> route:${p}/GET /v1/acme/:kind heuristic AMBIGUOUS`,
      `symbol:${p}/src/client.ts#orgItems -> route:${p}/GET /v1/:org/items exact`,
    ]);
  });

  it("wrapper-fetch: one level is inlined per caller; a second level is WRAPPER_DEPTH", async () => {
    const g = await run("wrapper-fetch");
    const p = "wrapper-fetch";
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/http.ts#requestVia -> unresolved:${p}/src/http.ts:15:10 unresolved WRAPPER_DEPTH`,
      `symbol:${p}/src/projects.ts#createProject -> route:${p}/POST /api/projects exact`,
      `symbol:${p}/src/projects.ts#listProjects -> route:${p}/GET /api/projects exact`,
    ]);
  });

  it("external-sdk: SDK calls and a literal fetch share one node per API host", async () => {
    const g = await run("external-sdk");
    const p = "symbol:external-sdk/src/billing.ts";
    expect(links(g, "external_call", "http")).toEqual([
      `${p}#archive -> external:ext/s3.amazonaws.com exact`,
      `${p}#charge -> external:ext/api.stripe.com exact`,
      `${p}#sendReceipt -> external:ext/api.resend.com exact`,
    ]);
    const charge = g.edges.find((e) => e.from === `${p}#charge`);
    expect(charge?.sites).toHaveLength(2); // the SDK call and the fetch merged
    expect(g.warnings.some((w) => w.code === "DUPLICATE_NODE")).toBe(false);
  });

  it("compose-and-env: compose datastores, the Prisma link by host, and an env-only datastore", async () => {
    const g = await run("compose-and-env");
    expect(ids(g, "datastore").sort()).toEqual([
      "datastore:infra/cache",
      "datastore:infra/db",
      "datastore:infra/env#SEARCH_DB_URL",
    ]);
    expect(ids(g, "queue")).toEqual(["queue:infra/broker"]);
    expect(links(g, "stores")).toEqual(["model:compose-and-env/Todo -> datastore:infra/db exact"]);
  });

  it("queues-bullmq: producer and worker meet at the queue name; runtime names are unresolved", async () => {
    const g = await run("queues-bullmq");
    expect(links(g, "publishes", "consumes")).toEqual([
      "symbol:web/src/signup.ts#signup -> queue:infra/redis#email exact",
      "symbol:web/src/signup.ts#signup -> unresolved:web/src/queues.ts:8:38 unresolved DYNAMIC_NAME",
      "symbol:worker/src/main.ts#sendEmail -> queue:infra/redis#email exact",
    ]);
    expect(g.edges.find((e) => e.from.endsWith("#sendEmail"))?.kind).toBe("consumes");
  });

  it("checker-crash: the route survives zod's safeParse shape, and storybook-static is skipped (M5.8c)", async () => {
    const g = await run("checker-crash");
    expect(ids(g, "route")).toEqual(["route:checker-crash/POST /echo"]);
    expect(g.nodes.some((n) => "path" in n && String(n.path).startsWith("storybook-static"))).toBe(
      false,
    );
    expect(g.warnings).toEqual([]);
  });

  it("shop-demo: one request path from a page to the database and Stripe (the viewer prototype's graph)", async () => {
    const g = await run("shop-demo");
    expect(
      links(g, "renders", "calls", "http", "handles", "writes", "stores", "external_call"),
    ).toEqual([
      "model:api/Order -> datastore:infra/db exact",
      "page:web// -> symbol:web/app/page.tsx#Home exact",
      "page:web//checkout -> symbol:web/app/checkout/page.tsx#Checkout exact",
      "page:web//orders -> symbol:web/app/orders/page.tsx#Orders exact",
      "route:api/GET /api/orders -> symbol:api/src/orders/handlers.ts#listOrders exact",
      "route:api/POST /api/orders -> symbol:api/src/orders/handlers.ts#createOrder exact",
      "symbol:api/src/billing/stripe.ts#chargeOrder -> external:ext/api.stripe.com exact",
      "symbol:api/src/orders/handlers.ts#createOrder -> model:api/Order exact",
      "symbol:api/src/orders/handlers.ts#createOrder -> symbol:api/src/billing/stripe.ts#chargeOrder exact",
      "symbol:web/app/checkout/page.tsx#Checkout -> symbol:web/lib/orders.ts#placeOrder exact",
      "symbol:web/app/orders/page.tsx#Orders -> symbol:web/lib/orders.ts#listOrders exact",
      "symbol:web/app/page.tsx#Home -> symbol:web/lib/cms.ts#latestPosts exact",
      "symbol:web/lib/cms.ts#latestPosts -> unresolved:web/lib/cms.ts:3:21 unresolved NO_MATCHING_ROUTE",
      "symbol:web/lib/orders.ts#listOrders -> route:api/GET /api/orders heuristic",
      "symbol:web/lib/orders.ts#placeOrder -> route:api/POST /api/orders heuristic",
    ]);
    expect(g.warnings).toEqual([]);
    expect(serializeGraph(g)).not.toContain("shop:shop");
  });
});

describe("secret-leak test (SECURITY.md T5)", () => {
  it("fake-secrets: no planted value reaches the graph, and the detectors still ran", async () => {
    const g = await run("fake-secrets");
    const text = serializeGraph(g);
    // Every planted value contains gi_fake / gi-fake; hosts from env values are never written.
    expect(text).not.toMatch(/gi[_-]fake/i);
    expect(text).not.toContain("hooks.example.com");
    // The output isn't empty because detection failed: each source of secrets was read.
    expect(ids(g, "datastore")).toContain("datastore:infra/env#ANALYTICS_DB_URL");
    expect(ids(g, "datastore")).toContain("datastore:infra/db");
    expect(ids(g, "external")).toContain("external:ext/api.partner.example");
    expect(Object.values(reasons(g)).sort()).toEqual([
      "DYNAMIC_URL",
      "DYNAMIC_URL",
      "NO_MATCHING_ROUTE",
      "WRAPPER_DEPTH",
    ]);
  });

  it.each(NAMES)("%s: no value from an env file reaches the graph", async (name) => {
    const text = serializeGraph(await run(name));
    expect(text).not.toContain("app:app");
    expect(text).not.toContain("search.example.internal");
    expect(text).not.toMatch(/gi[_-]fake/i);
  });
});

/** Collect HTTP call sites and inline wrappers for a fixture, as `analyze` does. */
async function httpRequests(
  name: string,
): Promise<{ sites: HttpCallSite[]; requests: HttpRequest[] }> {
  const dir = join(FIXTURES, name);
  const inventory = await buildInventory(dir);
  const workspace = await detectWorkspace(dir, inventory.files);
  const programs = buildServicePrograms(dir, workspace, inventory);
  const resolver = createSymbolResolver(programs, workspace);
  const express = buildExpressRoutes(programs, resolver);
  const sites = collectHttpCalls(programs, resolver, express.inlineHandlers);
  const normalizer = createUrlNormalizer(resolver);
  return {
    sites,
    requests: inlineWrappers(sites, programs, resolver, normalizer, express.inlineHandlers),
  };
}

const at = (s: SourceLocation): string => `${s.file}:${s.line}:${s.column}`;

describe('"no call site dropped" (ROADMAP M2)', () => {
  it.each(NAMES)("%s: every collected HTTP call yields an edge", async (name) => {
    const { sites, requests } = await httpRequests(name);
    // Every site is represented by a request: its own, or one per inlined wrapper call.
    for (const site of sites) {
      expect(
        requests.some((r) => r.call === site),
        `site ${at(site.site)}`,
      ).toBe(true);
    }
    // Every request has an http or external_call edge (resolved or unresolved) at its site.
    const g = await run(name);
    const edgeSites = new Set(
      g.edges
        .filter((e) => e.kind === "http" || e.kind === "external_call")
        .flatMap((e) => e.sites.map(at)),
    );
    for (const request of requests) {
      expect(edgeSites.has(at(request.site)), `request ${at(request.site)}`).toBe(true);
    }
  });

  it("the M2 fixtures exercise every request outcome", async () => {
    const all = await Promise.all(NAMES.map(async (name) => (await httpRequests(name)).requests));
    const requests = all.flat();
    expect(requests.length).toBeGreaterThanOrEqual(20);
    expect(requests.some((r) => r.via)).toBe(true);
    expect(requests.some((r) => r.owners.length === 0)).toBe(true);
    expect(requests.some((r) => r.call.client === "axios")).toBe(true);
    expect(requests.some((r) => !r.url.resolved && r.url.reason === "WRAPPER_DEPTH")).toBe(true);
    expect(requests.some((r) => !r.url.resolved && r.url.reason === "DYNAMIC_URL")).toBe(true);
  });
});
