import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArchitectureGraph, GraphEdge, SourceLocation } from "@gitinside/schema";
import { analyze, findingsOf, type AnalysisFindings } from "./analyze.js";
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
  "next-connect",
  "next-method-exclusions",
  "next-wrapped-handler",
  "swr-fetchers",
  "rtk-query",
  "tanstack-query-key",
  "next-server-actions",
  "prisma-relations",
  "pnpm-monorepo",
  "syntax-error",
  "no-tsconfig",
  "fetch-template-literal",
  "fetch-event-source",
  "class-field-base",
  "static-member-base",
  "axios-baseurl-instance",
  "env-base-heuristic",
  "env-fallback",
  "env-example-prefix",
  "vite-proxy",
  "next-rewrites",
  "ofetch-client",
  "ky-client",
  "rest-method-spread",
  "url-builders",
  "object-client",
  "config-wrapper",
  "axios-defaults",
  "express-folder-routers",
  "express-class-app",
  "express-inline-calls",
  "express-require-router",
  "sibling-apps",
  "workspace-root-files",
  "nx-standalone",
  "js-global-assignment",
  "fixed-url-helpers",
  "url-alternatives",
  "conditional-urls",
  "origin-parameters",
  "local-helpers",
  "let-query-urls",
  "conditional-spread-method",
  "ambiguous-routes",
  "wrapper-fetch",
  "wrapper-chain",
  "nested-config",
  "external-sdk",
  "typed-sdk-base",
  "sdk-branches",
  "compose-and-env",
  "infra-test-folders",
  "fake-secrets",
  "queues-bullmq",
  "shop-demo",
  "checker-crash",
  "diff-rename-base",
  "diff-rename-head",
  "diff-broken-base",
  "diff-broken-head",
  "diff-export-base",
  "diff-export-head",
];

describe.each(NAMES)("fixture %s", (name) => {
  it("matches expected.json byte for byte, and its last findings are the graph's", async () => {
    const found: AnalysisFindings[] = [];
    const graph = await analyze(join(FIXTURES, name), {
      owner: "fixtures",
      name,
      onFound: (event) => found.push(event),
    });
    const text = serializeGraph(graph);
    const goldenPath = join(FIXTURES, name, "expected.json");
    if (process.env.UPDATE_GOLDEN === "1") await writeFile(goldenPath, text);
    expect(text).toBe(await readFile(goldenPath, "utf8"));
    // Nothing reported along the way that the diagram won't show (#8).
    expect(found.at(-1)).toEqual(findingsOf(graph.nodes));
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

  it("express-inline-calls draws inline handlers' calls from their routes (M6.11d)", async () => {
    const g = await run("express-inline-calls");
    const svc = "express-inline-calls";
    const fn = (name: string) => `symbol:${svc}/src/articles/service.ts#${name}`;
    expect(g.edges.filter((e) => e.kind === "calls").map((e) => `${e.from} -> ${e.to}`)).toEqual([
      `route:${svc}/DELETE /api/articles/:slug -> ${fn("deleteArticle")}`,
      `route:${svc}/GET /api/articles -> ${fn("listArticles")}`,
      `route:${svc}/GET /api/articles -> ${fn("toSlug")}`,
      `route:${svc}/POST /api/articles -> ${fn("createArticle")}`,
      `route:${svc}/POST /api/articles -> ${fn("toSlug")}`,
    ]);
    // The named middleware still handles both routes it guards.
    expect(g.edges.filter((e) => e.kind === "handles").map((e) => e.from)).toEqual([
      `route:${svc}/DELETE /api/articles/:slug`,
      `route:${svc}/POST /api/articles`,
    ]);
  });

  it("express-require-router finds routers created on the require itself (M5C.10c)", async () => {
    const g = await run("express-require-router");
    const svc = "express-require-router";
    expect(ids(g, "route")).toEqual([
      `route:${svc}/GET /api/trips`,
      `route:${svc}/GET /api/trips/:tripId`,
      `route:${svc}/POST /api/trips/:tripId/stops`,
    ]);
    expect(
      g.edges.filter((e) => e.kind === "http").map((e) => `${e.from} -> ${e.to} ${e.confidence}`),
    ).toEqual([
      `symbol:${svc}/client/trips.js#addStop -> route:${svc}/POST /api/trips/:tripId/stops exact`,
      `symbol:${svc}/client/trips.js#loadTrips -> route:${svc}/GET /api/trips exact`,
    ]);
    expect(g.nodes.some((n) => n.kind === "unresolved")).toBe(false);
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

  it("next-connect gives one route per registered method (ADR-0191)", async () => {
    const g = await run("next-connect");
    expect(ids(g, "route")).toEqual([
      "route:notes/DELETE /api/notes/:id",
      "route:notes/GET /api/notes",
      "route:notes/GET /api/notes/:id",
      "route:notes/PATCH /api/notes/:id",
      "route:notes/POST /api/notes",
    ]);
    expect(links(g, "http")).toEqual([
      "symbol:notes/pages/index.tsx#addNote -> route:notes/POST /api/notes exact",
      "symbol:notes/pages/index.tsx#loadNotes -> route:notes/GET /api/notes exact",
      "symbol:notes/pages/index.tsx#removeNote -> route:notes/DELETE /api/notes/:id exact",
      "symbol:notes/pages/index.tsx#replaceNote -> unresolved:notes/pages/index.tsx:14:10 unresolved NO_MATCHING_ROUTE",
    ]);
    expect(links(g, "external_call")).toEqual([
      "route:notes/GET /api/notes/:id -> external:ext/notes-archive.example.com exact",
    ]);
  });

  it("rtk-query makes each RTK Query endpoint a request from its API slice (ADR-0196)", async () => {
    const g = await run("rtk-query");
    expect(links(g, "http")).toEqual([
      "symbol:task-board/hooks/stats.ts#useStats -> route:task-board/ALL /api/stats exact",
      // The URL read from the hook's queryKey (M5C.3f): no route serves /api/stats/trend.
      "symbol:task-board/hooks/stats.ts#useStats -> unresolved:task-board/hooks/stats.ts:8:17 unresolved NO_MATCHING_ROUTE",
      "symbol:task-board/store/api.ts#tasksApi -> route:task-board/GET /api/tasks exact",
      "symbol:task-board/store/api.ts#tasksApi -> route:task-board/GET /api/tasks/:id exact",
      "symbol:task-board/store/api.ts#tasksApi -> route:task-board/PATCH /api/tasks/:id exact",
      "symbol:task-board/store/api.ts#tasksApi -> route:task-board/POST /api/tasks exact",
      "symbol:task-board/store/labels.ts#labelsApi -> unresolved:task-board/store/labels.ts:6:19 unresolved NO_MATCHING_ROUTE",
      // A re-auth base query forwarding to fetchBaseQuery is that fetchBaseQuery (M5C.2), and
      // its own refresh call is a request.
      "symbol:task-board/store/session.ts#baseQueryWithReauth -> route:task-board/ALL /api/session/refresh exact",
      "symbol:task-board/store/session.ts#sessionApi -> route:task-board/DELETE /api/session exact",
      "symbol:task-board/store/session.ts#sessionApi -> route:task-board/GET /api/session exact",
    ]);
    expect(g.nodes.filter((n) => n.kind === "unresolved" && n.id.includes("session"))).toEqual([]);
  });

  it("tanstack-query-key reads each hook's key through its queryFn's context (M5C.3f)", async () => {
    const g = await run("tanstack-query-key");
    const p = "tanstack-query-key";
    const q = `symbol:${p}/src/queries.ts`;
    expect(links(g, "http")).toEqual([
      `${q}#statsOptions -> route:${p}/GET /api/stats heuristic`,
      `${q}#useDrafts -> unresolved:${p}/src/queries.ts:16:10 unresolved NO_MATCHING_ROUTE`,
      `${q}#usePost -> route:${p}/GET /api/posts/:postId heuristic`,
      `${q}#usePosts -> route:${p}/GET /api/posts heuristic`,
      `${q}#useTodos -> route:${p}/GET /api/users/:userId/todos exact`,
    ]);
    const details = g.nodes.flatMap((n) => (n.kind === "unresolved" ? [n.detail] : []));
    expect(details).toEqual(["no route matches GET to /api/drafts"]);
  });

  it("next-method-exclusions reads which way a req.method test points (ADR-0195)", async () => {
    const g = await run("next-method-exclusions");
    expect(ids(g, "route")).toEqual([
      "route:roster/ALL /api/invites",
      "route:roster/ALL /api/members",
      "route:roster/GET /api/teams",
      "route:roster/POST /api/invites",
    ]);
    expect(links(g, "http")).toEqual([
      "symbol:roster/pages/index.tsx#dropMember -> route:roster/ALL /api/members exact",
      "symbol:roster/pages/index.tsx#loadInvites -> route:roster/ALL /api/invites exact",
      "symbol:roster/pages/index.tsx#loadMembers -> route:roster/ALL /api/members exact",
      "symbol:roster/pages/index.tsx#loadTeams -> route:roster/GET /api/teams exact",
      "symbol:roster/pages/index.tsx#renameTeam -> unresolved:roster/pages/index.tsx:22:10 unresolved NO_MATCHING_ROUTE",
      "symbol:roster/pages/index.tsx#sendInvite -> route:roster/POST /api/invites exact",
    ]);
  });

  it("next-wrapped-handler reads req.method tests through a wrapped default export (M5C.7b)", async () => {
    const g = await run("next-wrapped-handler");
    const page = "symbol:pantry/pages/index.tsx";
    expect(ids(g, "route")).toEqual([
      "route:pantry/ALL /api/auth/*auth",
      "route:pantry/DELETE /api/shelves/:id",
      "route:pantry/GET /api/shelves",
      "route:pantry/PATCH /api/stock",
      "route:pantry/POST /api/shelves",
      "route:pantry/PUT /api/shelves/:id",
    ]);
    expect(links(g, "http")).toEqual([
      `${page}#addShelf -> route:pantry/POST /api/shelves exact`,
      `${page}#archiveShelf -> unresolved:pantry/pages/index.tsx:18:10 unresolved NO_MATCHING_ROUTE`,
      `${page}#countStock -> route:pantry/PATCH /api/stock exact`,
      `${page}#loadShelves -> route:pantry/GET /api/shelves exact`,
      `${page}#removeShelf -> route:pantry/DELETE /api/shelves/:id exact`,
      `${page}#renameShelf -> route:pantry/PUT /api/shelves/:id exact`,
      `${page}#signOut -> route:pantry/ALL /api/auth/*auth pattern`,
    ]);
    expect(links(g, "handles")).toContain(
      "route:pantry/GET /api/shelves -> symbol:pantry/pages/api/shelves.ts#shelves exact",
    );
    expect(links(g, "handles")).toContain(
      "route:pantry/PATCH /api/stock -> symbol:pantry/pages/api/stock.ts#guarded exact",
    );
    expect(g.warnings.filter((w) => w.code === "NEXT_WRAPPED_HANDLER")).toHaveLength(1);
  });

  it("swr-fetchers draws each SWR hook's request from the hook's caller (ADR-0193)", async () => {
    const g = await run("swr-fetchers");
    expect(links(g, "http")).toEqual([
      "symbol:reading-list/hooks/books.ts#useAddBook -> route:reading-list/POST /api/books exact",
      "symbol:reading-list/hooks/books.ts#useBook -> route:reading-list/GET /api/books/:id exact",
      "symbol:reading-list/hooks/books.ts#useBookPages -> route:reading-list/GET /api/books exact",
      "symbol:reading-list/hooks/reviews.ts#useAuthor -> route:reading-list/ALL /api/authors/:name exact",
      "symbol:reading-list/hooks/reviews.ts#useReviews -> route:reading-list/ALL /api/books/:id/reviews exact",
      "symbol:reading-list/pages/index.tsx#Home -> route:reading-list/ALL /api/shelves heuristic",
      "symbol:reading-list/pages/index.tsx#Home -> unresolved:reading-list/pages/index.tsx:13:27 unresolved DYNAMIC_URL",
    ]);
  });

  it("next-server-actions labels the browser's calls of server actions (ADR-0203)", async () => {
    const g = await run("next-server-actions");
    const calls = g.edges
      .filter((e) => e.kind === "calls")
      .map((e) => `${e.from} -> ${e.to}${e.label ? ` [${e.label}]` : ""}`);
    expect(calls).toEqual([
      "symbol:todo-actions/app/todos/TodoItem.tsx#TodoItem -> symbol:todo-actions/app/todos/actions.ts#deleteTodo [server action]",
      "symbol:todo-actions/app/todos/TodoItem.tsx#TodoItem -> symbol:todo-actions/app/todos/actions.ts#listTodos [server action]",
      "symbol:todo-actions/app/todos/TodoItem.tsx#TodoItem -> symbol:todo-actions/app/todos/actions.ts#toggleTodo [server action]",
      "symbol:todo-actions/app/todos/page.tsx#TodosPage -> symbol:todo-actions/app/todos/actions.ts#createTodo [server action]",
      // A server component's own call runs on the server.
      "symbol:todo-actions/app/todos/page.tsx#TodosPage -> symbol:todo-actions/app/todos/actions.ts#listTodos",
    ]);
    // The actions' Prisma calls are theirs, so a trace goes on from the form to the model.
    expect(links(g, "reads", "writes")).toEqual([
      "symbol:todo-actions/app/todos/actions.ts#createTodo -> model:todo-actions/Todo exact",
      "symbol:todo-actions/app/todos/actions.ts#deleteTodo -> model:todo-actions/Todo exact",
      "symbol:todo-actions/app/todos/actions.ts#listTodos -> model:todo-actions/Todo exact",
      "symbol:todo-actions/app/todos/actions.ts#toggleTodo -> model:todo-actions/Todo exact",
    ]);
    expect(g.edges.filter((e) => e.kind === "http")).toEqual([]);
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

  it("fetch-event-source: fetchEventSource(url, init) is a fetch, GET by default (M9.1a6)", async () => {
    const g = await run("fetch-event-source");
    const p = "fetch-event-source";
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/stream.ts#streamChat -> route:${p}/POST /api/workspace/:slug/stream-chat exact`,
      `symbol:${p}/src/stream.ts#watchEmbedding -> route:${p}/GET /api/workspace/:slug/embed-progress exact`,
    ]);
  });

  it("class-field-base: an instance field set once in the constructor is the base (M9.1a7a)", async () => {
    const g = await run("class-field-base");
    const api = "symbol:server/utils/collectorApi.js#CollectorApi";
    const llm = "symbol:server/utils/providers.js";
    expect(links(g, "http")).toEqual([
      `${api}.acceptedFileTypes -> route:collector/GET /accepts heuristic`,
      `${api}.processDocument -> route:collector/POST /process heuristic`,
      `${llm}#Mirror.status -> unresolved:server/utils/providers.js:26:23 unresolved DYNAMIC_URL`,
    ]);
    expect(links(g, "external_call")).toEqual([
      `${llm}#RouterLLM.complete -> external:ext/openrouter.ai heuristic`,
    ]);
  });

  it("typed-sdk-base: a typed client's construction is read before its type; unseen and branching bases are unresolved (M9.7d)", async () => {
    const g = await run("typed-sdk-base");
    const llm = "symbol:typed-sdk-base/src/llm.ts";
    const at = "unresolved:typed-sdk-base/src/llm.ts";
    expect(links(g, "http")).toEqual([
      `${llm}#Embedder.embed -> ${at}:33:31 unresolved DYNAMIC_URL`,
      `${llm}#LocalModel.chat -> route:typed-sdk-base/POST /v1/chat/completions heuristic`,
      `${llm}#routedChat -> ${at}:43:34 unresolved DYNAMIC_URL`,
    ]);
    // `lastFastChat` reads a mock's calls, so `fastChat` is groq's only caller. `relay`'s env
    // base is OpenAI's host in `.env.example`, though the repo serves the same path (M9.7e).
    expect(links(g, "external_call")).toEqual([
      `${llm}#fastChat -> external:ext/api.groq.com exact`,
      `symbol:typed-sdk-base/src/upstream.ts#relay -> external:ext/api.openai.com heuristic`,
    ]);
  });

  it("sdk-branches: every write and branch of a client counts; a placeholder example host is no API (M9.7g, M9.7l, M9.7m, M9.7n)", async () => {
    const g = await run("sdk-branches");
    const fields = "symbol:sdk-branches/src/fields.ts";
    const lazy = "symbol:sdk-branches/src/lazy.ts";
    const sw = "symbol:sdk-branches/src/switch.js";
    const warm = "symbol:sdk-branches/src/warm.ts";
    const at = "unresolved:sdk-branches/src";
    // A default-built client beside an unread branch (`repoFor`, `Pluggable`), and a global
    // member no write in the file names (`sharedModels`), are unresolved too (M9.7j). So are
    // a global member whose only write stores an injected client (`assistantModels`), a member
    // of a parameter named `self` (`modelsOf`), and a three-way join with an unread branch
    // (`issuesFor`), whatever its order (M9.7l). A lazy `??=` getter reads what was there
    // before: a variable a setter writes (`clientModels`); a global cached in one file and
    // written with another base in another (`proxiedModels`) has both (M9.7m). A getter's
    // result written back (`warm`) leaves its variable's setter in, whichever call is traced
    // first (`cachedModels`), and a global `var`'s bare-name write is a store (`sharedModels`)
    // (M9.7n).
    expect(links(g, "http")).toEqual([
      `${fields}#Switchable.models -> ${at}/fields.ts:15:27 unresolved DYNAMIC_URL`,
      `${fields}#azureChat -> ${at}/fields.ts:42:33 unresolved NO_MATCHING_ROUTE`,
      `${fields}#issuesFor -> ${at}/fields.ts:59:29 unresolved DYNAMIC_URL`,
      `${fields}#listModels -> ${at}/fields.ts:35:27 unresolved DYNAMIC_URL`,
      `${fields}#repoFor -> ${at}/fields.ts:51:23 unresolved DYNAMIC_URL`,
      `${lazy}#clientModels -> ${at}/lazy.ts:30:29 unresolved DYNAMIC_URL`,
      `${lazy}#proxiedModels -> ${at}/lazy.ts:17:25 unresolved DYNAMIC_URL`,
      `${sw}#LocalOrCloud.models -> ${at}/switch.js:11:27 unresolved DYNAMIC_URL`,
      `${sw}#Pluggable.models -> ${at}/switch.js:47:27 unresolved DYNAMIC_URL`,
      `${sw}#assistantModels -> ${at}/switch.js:66:27 unresolved DYNAMIC_URL`,
      `${sw}#embed -> ${at}/switch.js:33:37 unresolved DYNAMIC_URL`,
      `${sw}#modelsOf -> ${at}/switch.js:73:20 unresolved DYNAMIC_URL`,
      `${sw}#sharedModels -> ${at}/switch.js:55:24 unresolved DYNAMIC_URL`,
      `${warm}#cachedModels -> ${at}/warm.ts:25:29 unresolved DYNAMIC_URL`,
      `${warm}#sharedModels -> ${at}/warm.ts:36:29 unresolved DYNAMIC_URL`,
      `${warm}#warm -> ${at}/warm.ts:21:24 unresolved DYNAMIC_URL`,
    ]);
    expect(links(g, "external_call")).toEqual([
      `${fields}#route -> external:ext/openrouter.ai exact`,
      `${lazy}#lazyModels -> external:ext/api.openai.com exact`,
      `${sw}#Lazy.chat -> external:ext/api.groq.com exact`,
    ]);
  });

  it("static-member-base: static members, #private methods, and an object's own property are bases (M9.1a7b)", async () => {
    const g = await run("static-member-base");
    const engine = "symbol:server/utils/engine.js";
    const remote = "symbol:server/utils/remote.js";
    expect(links(g, "http")).toEqual([
      `${engine}#Engine.isRunning -> route:engine/GET /api/v1/health heuristic`,
      `${engine}#EngineLLM.load -> route:engine/POST /api/v1/load heuristic`,
    ]);
    expect(links(g, "external_call")).toEqual([
      `${remote}#Catalog.models -> external:ext/catalog.example.com heuristic`,
      `${remote}#Hub.explore -> external:ext/hub.example.com heuristic`,
      `${remote}#Mailer.send -> external:ext/script.google.com heuristic`,
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

  it("env-fallback: a literal fallback's path and loopback host reach routes (ADR-0158)", async () => {
    const g = await run("env-fallback");
    expect(links(g, "http")).toEqual([
      "symbol:web/src/client.ts#authenticate -> route:api/POST /api/v2/authenticate heuristic",
      "symbol:web/src/client.ts#loadUser -> route:api/GET /api/v1/users/:id heuristic",
      "symbol:web/src/client.ts#login -> route:api/POST /api/v1/auth/login heuristic",
      "symbol:web/src/client.ts#track -> unresolved:web/src/client.ts:22:9 unresolved NO_MATCHING_ROUTE",
    ]);
  });

  it("env-example-prefix: an example env file's path reaches routes, never the graph (ADR-0202)", async () => {
    const g = await run("env-example-prefix");
    expect(links(g, "http")).toEqual([
      "symbol:client/src/api.js#checkout -> unresolved:client/src/api.js:28:9 unresolved NO_MATCHING_ROUTE",
      "symbol:client/src/api.js#getBlog -> route:server/GET /api/blog/:blogId heuristic",
      "symbol:client/src/api.js#getStats -> route:server/GET /api/stats heuristic",
      "symbol:client/src/api.js#signIn -> route:server/POST /api/auth/login heuristic",
    ]);
    const unresolved = g.nodes.find((n) => n.kind === "unresolved");
    expect(unresolved?.kind === "unresolved" && unresolved.detail).toBe(
      "no route matches POST to {env:VITE_PAYMENTS_API_URL}/checkout",
    );
    expect(serializeGraph(g)).not.toContain("localhost:5000");
  });

  it("vite-proxy: requests match the path a Vite or CRA dev proxy sends (ADR-0204)", async () => {
    const g = await run("vite-proxy");
    const api = "symbol:client/src/api.ts";
    expect(links(g, "http")).toEqual([
      "symbol:admin/src/stats.js#loadStats -> route:server/GET /stats heuristic",
      `${api}#getUser -> route:server/GET /users/:id heuristic`,
      `${api}#listOrders -> unresolved:client/src/api.ts:26:21 unresolved NO_MATCHING_ROUTE`,
      `${api}#listUsers -> route:server/GET /users heuristic`,
      `${api}#signIn -> route:server/POST /auth/login heuristic`,
    ]);
    expect(links(g, "external_call")).toEqual([
      `${api}#forecast -> external:ext/api.weather.example.com heuristic`,
    ]);
    const unresolved = g.nodes.find((n) => n.kind === "unresolved");
    expect(unresolved?.kind === "unresolved" && unresolved.detail).toBe(
      "no route matches GET to /api/orders (sent as /orders by the dev proxy in client/vite.config.ts)",
    );
  });

  it("ofetch-client: ofetch, $fetch, and create() instances reach routes (ADR-0205)", async () => {
    const g = await run("ofetch-client");
    const p = "ofetch-client";
    const users = `symbol:${p}/src/users.ts`;
    expect(links(g, "http")).toEqual([
      `${users}#createUser -> route:${p}/POST /api/users exact`,
      `${users}#getUser -> route:${p}/GET /api/users/:id exact`,
      `${users}#health -> route:${p}/GET /api/health exact`,
      `${users}#listUsers -> route:${p}/GET /api/users exact`,
      `${users}#loadStats -> route:${p}/GET /api/v2/stats exact`,
      `${users}#removeUser -> route:${p}/DELETE /api/users/:id exact`,
      `${users}#signIn -> route:${p}/POST /api/auth/login exact`,
      `${users}#track -> unresolved:${p}/src/users.ts:35:10 unresolved NO_MATCHING_ROUTE`,
    ]);
    const unresolved = g.nodes.find((n) => n.kind === "unresolved");
    expect(unresolved?.kind === "unresolved" && unresolved.detail).toBe(
      "no route matches POST to /api/events",
    );
  });

  it("next-rewrites: requests match under basePath and through rewrites (ADR-0206)", async () => {
    const g = await run("next-rewrites");
    const api = "symbol:web/lib/api.ts";
    expect(links(g, "http")).toEqual([
      `${api}#getItem -> route:web/GET /api/items/:id exact`,
      `${api}#getUser -> route:api/GET /users/:id heuristic`,
      `${api}#listItems -> route:web/GET /api/items exact`,
      `${api}#listItemsUnprefixed -> unresolved:web/lib/api.ts:15:21 unresolved NO_MATCHING_ROUTE`,
      `${api}#listLegacyItems -> route:web/GET /api/items exact`,
      `${api}#listOrders -> route:api/GET /orders heuristic`,
    ]);
    expect(links(g, "external_call")).toEqual([
      `${api}#forecast -> external:ext/api.weather.example.com exact`,
      `${api}#status -> external:ext/status.example.com exact`,
    ]);
    const unresolved = g.nodes.find((n) => n.kind === "unresolved");
    expect(unresolved?.kind === "unresolved" && unresolved.detail).toBe(
      "no route matches GET to /api/items (the Next app's basePath in web/next.config.mjs is /shop)",
    );
  });

  it("ky-client: ky's shorthands, extend/create instances, and its three bases reach routes (ADR-0207)", async () => {
    const g = await run("ky-client");
    const p = "ky-client";
    const notes = `symbol:${p}/src/notes.ts`;
    expect(links(g, "http")).toEqual([
      `${notes}#addNote -> route:${p}/POST /api/notes exact`,
      `${notes}#archive -> unresolved:${p}/src/notes.ts:41:10 unresolved NO_MATCHING_ROUTE`,
      `${notes}#brokenList -> unresolved:${p}/src/notes.ts:36:10 unresolved DYNAMIC_URL`,
      `${notes}#getNote -> route:${p}/GET /api/notes/:noteId exact`,
      `${notes}#listNotes -> route:${p}/GET /api/notes exact`,
      `${notes}#listTags -> route:${p}/GET /api/v1/tags exact`,
      `${notes}#saveNote -> route:${p}/PUT /api/notes/:noteId exact`,
      `${notes}#signIn -> route:${p}/POST /api/session exact`,
      `${notes}#status -> route:${p}/GET /status exact`,
    ]);
    const details = g.nodes.flatMap((n) => (n.kind === "unresolved" ? [n.detail] : []));
    expect(details.sort()).toEqual([
      "ky refuses a URL starting with / under a prefixUrl, so this request fails",
      "no route matches POST to /api/notes/{}/archive",
    ]);
  });

  it("rest-method-spread: the caller's method passes through a rest element; an unread one between methods is unresolved (M5C.7a)", async () => {
    const g = await run("rest-method-spread");
    const p = "rest-method-spread";
    const tokens = `symbol:${p}/src/tokens.ts`;
    expect(links(g, "http")).toEqual([
      `${tokens}#dropToken -> route:${p}/DELETE /api/tokens exact`,
      `${tokens}#readProfile -> route:${p}/GET /api/profile heuristic`,
      `${tokens}#readToken -> route:${p}/GET /api/tokens exact`,
      `${tokens}#storeToken -> route:${p}/PUT /api/tokens exact`,
      `${tokens}#tokenRequest -> unresolved:${p}/src/tokens.ts:16:49 unresolved AMBIGUOUS`,
      `${tokens}#uploadAvatar -> route:${p}/POST /api/avatar exact`,
    ]);
    const details = g.nodes.flatMap((n) => (n.kind === "unresolved" ? [n.detail] : []));
    expect(details).toEqual([
      "the method isn't read, and routes for DELETE, GET, PUT match /api/tokens",
    ]);
  });

  it("url-builders: a URL returned by a repo string builder is read with the call's arguments (M5C.7d)", async () => {
    const g = await run("url-builders");
    const p = "url-builders";
    const library = `symbol:${p}/src/library.ts`;
    const card = `symbol:${p}/src/LoanCard.tsx#LoanCard`;
    expect(links(g, "http")).toEqual([
      `${card} -> route:${p}/GET /api/catalog/search exact`,
      `${card} -> route:${p}/GET /api/loans/:loanId exact`,
      `${library}#addBook -> route:${p}/POST /api/shelves/:shelfId/books exact`,
      `${library}#listBooks -> route:${p}/GET /api/shelves/:shelfId/books exact`,
      `${library}#openShelf -> route:${p}/GET /api/shelves/:shelfId exact`,
      `${library}#returnLoan -> route:${p}/DELETE /api/loans/:loanId exact`,
      `${library}#searchCatalog -> unresolved:${p}/src/library.ts:26:21 unresolved DYNAMIC_URL`,
    ]);
  });

  it("object-client: each call to an exported object's method is its own request (M5A.3b)", async () => {
    const g = await run("object-client");
    const hooks = "symbol:web/src/hooks/use-accounts.ts";
    expect(links(g, "http")).toEqual([
      `${hooks}#createAccount -> route:api/POST /api/v1/accounts heuristic`,
      `${hooks}#deleteAccount -> route:api/DELETE /api/v1/accounts/:id heuristic`,
      `${hooks}#listAccounts -> route:api/GET /api/v1/accounts heuristic`,
      `${hooks}#renameAccount -> route:api/PATCH /api/v1/accounts/:id heuristic`,
    ]);
    expect(
      ids(g, "symbol")
        .filter((id) => id.includes("#apiClient"))
        .sort(),
    ).toEqual([
      "symbol:web/src/lib/api-client.ts#apiClient",
      "symbol:web/src/lib/api-client.ts#apiClient.delete",
      "symbol:web/src/lib/api-client.ts#apiClient.get",
      "symbol:web/src/lib/api-client.ts#apiClient.patch",
      "symbol:web/src/lib/api-client.ts#apiClient.post",
    ]);
  });

  it("config-wrapper: each call reads url and method from its axios config (M5A.3c)", async () => {
    const g = await run("config-wrapper");
    const api = "symbol:web/src/services/api.ts";
    expect(links(g, "http")).toEqual([
      `${api}#forward -> unresolved:web/src/services/api.ts:17:44 unresolved WRAPPER_DEPTH`,
      `${api}#getPost -> route:api/GET /post/:id heuristic`,
      `${api}#login -> route:api/POST /authenticate heuristic`,
      `${api}#logout -> route:api/DELETE /logout heuristic`,
    ]);
  });

  it("axios-defaults: a top-level `defaults.baseURL` prefixes requests; one set later doesn't (M5A.3d)", async () => {
    const g = await run("axios-defaults");
    const web = "symbol:web/src/services";
    expect(links(g, "http")).toEqual([
      `${web}/admin.ts#ban -> route:api/POST /api/admin/users/:id/ban heuristic`,
      `${web}/admin.ts#listUsers -> route:api/GET /api/admin/users heuristic`,
      `${web}/fetcher.ts#getUser -> route:api/GET /api/v1/users/:id heuristic`,
      `${web}/session.ts#refresh -> unresolved:web/src/services/session.ts:9:30 unresolved DYNAMIC_URL`,
    ]);
  });

  it("express-folder-routers: routers from a folder listing are mounted, matched at heuristic (M5A.3e)", async () => {
    const g = await run("express-folder-routers");
    expect(ids(g, "route").sort()).toEqual([
      "route:express-folder-routers/GET /api/robots/:id",
      "route:express-folder-routers/GET /api/v1/users/:id",
      "route:express-folder-routers/GET /health",
      "route:express-folder-routers/GET /legacy/reports/daily",
      "route:express-folder-routers/POST /api/runs",
      "route:express-folder-routers/POST /api/v1/orders",
    ]);
    expect(g.warnings.filter((w) => w.code.startsWith("EXPRESS"))).toEqual([]);
    const client = "symbol:express-folder-routers/src/client.ts";
    const routes = "route:express-folder-routers";
    // `loadRobot` and `startRun` reach `api/`'s routers through `route.default || route`
    // (maxun's loop, M9.1a5).
    expect(links(g, "http")).toEqual([
      `${client}#dailyReport -> ${routes}/GET /legacy/reports/daily heuristic`,
      `${client}#health -> ${routes}/GET /health exact`,
      `${client}#loadRobot -> ${routes}/GET /api/robots/:id heuristic`,
      `${client}#loadUser -> ${routes}/GET /api/v1/users/:id heuristic`,
      `${client}#placeOrder -> ${routes}/POST /api/v1/orders heuristic`,
      `${client}#startRun -> ${routes}/POST /api/runs heuristic`,
    ]);
  });

  it("express-class-app: an app and router assigned in the constructor are followed (M5A.3e1)", async () => {
    const g = await run("express-class-app");
    const routes = "route:express-class-app";
    expect(ids(g, "route").sort()).toEqual([
      `${routes}/GET /api/users/:id`,
      `${routes}/GET /health`,
      `${routes}/POST /admin/cache/flush`,
    ]);
    expect(g.warnings.filter((w) => w.code.startsWith("EXPRESS"))).toEqual([]);
    const client = "symbol:express-class-app/src/client.ts";
    expect(links(g, "http")).toEqual([
      `${client}#flushCache -> ${routes}/POST /admin/cache/flush exact`,
      `${client}#loadUser -> ${routes}/GET /api/users/:id exact`,
    ]);
  });

  it("sibling-apps: folders with their own package.json are services, each with its paths (M5A.3f)", async () => {
    const g = await run("sibling-apps");
    expect(ids(g, "service").sort()).toEqual([
      "service:app/",
      "service:backend/",
      "service:frontend/",
    ]);
    expect(ids(g, "file").sort()).toEqual([
      "file:app/scripts/check.mjs",
      "file:backend/src/routes/posts.ts",
      "file:backend/src/server.ts",
      "file:frontend/src/lib/api.ts",
      "file:frontend/src/posts.ts",
    ]);
    const client = "symbol:frontend/src/posts.ts";
    expect(links(g, "http")).toEqual([
      // Root-relative into another service: `heuristic` (a proxy is assumed, match.ts).
      `${client}#createPost -> route:backend/POST /api/posts heuristic`,
      `${client}#loadPost -> route:backend/GET /api/posts/:id heuristic`,
    ]);
  });

  it("workspace-root-files: a workspace root's tests and scripts are a service; an example app isn't (M5C.7e)", async () => {
    const g = await run("workspace-root-files");
    expect(ids(g, "service").sort()).toEqual(["service:api/", "service:relay-mono/"]);
    expect(ids(g, "file").sort()).toEqual([
      "file:api/src/server.ts",
      "file:relay-mono/scripts/seed.mts",
      "file:relay-mono/tests/e2e/health.spec.ts",
    ]);
    expect(links(g, "http")).toEqual([
      `symbol:relay-mono/scripts/seed.mts#seedOrders -> route:api/POST /api/orders heuristic`,
      `symbol:relay-mono/tests/e2e/health.spec.ts#readHealth -> route:api/GET /api/health heuristic`,
    ]);
    // The example app keeps its own warning: it's another project, not the root's.
    expect(g.warnings.filter((w) => w.code === "FILES_OUTSIDE_SERVICE")).toEqual([
      {
        code: "FILES_OUTSIDE_SERVICE",
        file: "examples",
        message:
          "1 source file under examples/ belongs to no workspace package and is not analyzed (examples/widget/index.ts)",
      },
    ]);
  });

  it("nx-standalone: the root project is a service named by its project.json beside e2e/ (M6.11j)", async () => {
    const g = await run("nx-standalone");
    expect(
      g.nodes.filter((n) => n.kind === "service").map((n) => [n.id, n.label, n.framework]),
    ).toEqual([
      ["service:api/", "api", "express"],
      ["service:e2e/", "api-e2e", undefined],
    ]);
    expect(ids(g, "file").sort()).toEqual([
      "file:api/jest.config.ts",
      "file:api/src/app/routes/routes.ts",
      "file:api/src/app/routes/tag/tag.controller.ts",
      "file:api/src/app/routes/tag/tag.service.ts",
      "file:api/src/main.ts",
      "file:e2e/src/server/server.spec.ts",
    ]);
    expect(ids(g, "route")).toEqual(["route:api/GET /api/tags"]);
    expect(links(g, "calls")).toContain(
      "route:api/GET /api/tags -> symbol:api/src/app/routes/tag/tag.service.ts#getTags exact",
    );
    expect(links(g, "http")).toEqual([
      "symbol:e2e/src/server/server.spec.ts#readTags -> route:api/GET /api/tags heuristic",
    ]);
    expect(g.warnings.filter((w) => w.code === "FILES_OUTSIDE_SERVICE")).toEqual([]);
  });

  it("js-global-assignment: a JS file setting process.env.X doesn't hide env bases elsewhere (M5C.7e2)", async () => {
    const g = await run("js-global-assignment");
    const p = "js-global-assignment";
    expect(links(g, "http")).toEqual([
      `symbol:${p}/scripts/load-check.ts#check -> route:api/GET /api/health/ready heuristic`,
      `symbol:${p}/scripts/load-check.ts#check -> route:api/POST /api/bookings/:slug heuristic`,
      `symbol:${p}/tests/site.ts#readiness -> unresolved:${p}/tests/site.ts:4:10 unresolved NO_MATCHING_ROUTE`,
    ]);
    const unresolved = g.nodes.filter((n) => n.kind === "unresolved");
    expect(unresolved.map((n) => [n.reason, n.detail])).toEqual([
      [
        "NO_MATCHING_ROUTE",
        "the env var PUBLIC_APP_URL isn't named like an API base (*_API_URL, *_API_PATH, …)",
      ],
    ]);
  });

  it("fixed-url-helpers: a helper that fixes its route keeps the request; one taking the path is inlined (M5A.3j)", async () => {
    const g = await run("fixed-url-helpers");
    const p = "fixed-url-helpers";
    const api = `symbol:${p}/src/posts-api.ts`;
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/editor.ts#loadAuthors -> route:${p}/GET /api/authors exact`,
      `${api}#deletePost -> route:${p}/DELETE /api/posts/:postId exact`,
      `${api}#postsApi.comments -> route:${p}/GET /api/posts/:postId/comments exact`,
      `${api}#postsApi.read -> route:${p}/GET /api/posts/:postId exact`,
    ]);
  });

  it("url-alternatives: one request per URL a ternary or a let fixes, at the same call (M5A.3h)", async () => {
    const g = await run("url-alternatives");
    const p = "url-alternatives";
    const j = `symbol:${p}/src/journal.ts`;
    expect(links(g, "http")).toEqual([
      `${j}#loadArchive -> route:${p}/GET /api/archive heuristic`,
      `${j}#loadEntries -> route:${p}/GET /api/entries/featured heuristic`,
      `${j}#loadEntries -> route:${p}/GET /api/entries/topics/:topic heuristic`,
      `${j}#loadMine -> route:${p}/GET /api/drafts heuristic`,
      `${j}#loadMine -> route:${p}/GET /api/entries/:entryId heuristic`,
      `${j}#removeEntry -> route:${p}/DELETE /api/entries/:entryId heuristic`,
      `${j}#removeEntry -> route:${p}/DELETE /api/entries/moderation/:entryId heuristic`,
    ]);
    // Both alternatives of a call share its one site, each edge with the request it matched.
    const removes = g.edges.filter((e) => e.from === `${j}#removeEntry`);
    const at = removes.map((e) => e.sites.map(({ file, line, column }) => [file, line, column]));
    expect(new Set(at.map((s) => JSON.stringify(s)))).toHaveProperty("size", 1);
    expect(removes.map((e) => e.sites.map((s) => s.request))).toEqual([
      ["DELETE {env:VITE_API_PATH}/api/entries/{}"],
      ["DELETE {env:VITE_API_PATH}/api/entries/moderation/{}"],
    ]);
    expect(g.nodes.some((n) => n.kind === "unresolved")).toBe(false);
  });

  it("conditional-urls: a branch-only parameter keeps the request; an argument settles a ternary (M5C.10a)", async () => {
    const g = await run("conditional-urls");
    const p = "conditional-urls";
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/screens.ts#listBooks -> route:${p}/GET /api/books exact`,
      `symbol:${p}/src/screens.ts#listBooksV2 -> route:${p}/GET /api/v2/books exact`,
      `symbol:${p}/src/shelf.ts#openShelf -> route:${p}/GET /api/reading-now exact`,
      `symbol:${p}/src/shelf.ts#openShelf -> route:${p}/GET /api/shelves/:shelfId exact`,
    ]);
    expect(g.nodes.some((n) => n.kind === "unresolved")).toBe(false);
  });

  it("origin-parameters: a port parameter keeps the request where the path is fixed (M5C.10b)", async () => {
    const g = await run("origin-parameters");
    const p = "origin-parameters";
    // Loopback hosts are `heuristic` (ADR-0158); nothing at `waitForStation`'s call of `stationUp`.
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/dashboard.ts#boot -> route:${p}/GET /api/readings heuristic`,
      `symbol:${p}/src/probe.ts#latestReadings -> route:${p}/GET /api/readings heuristic`,
      `symbol:${p}/src/probe.ts#stationUp -> route:${p}/GET /api/health heuristic`,
    ]);
    expect(g.nodes.some((n) => n.kind === "unresolved")).toBe(false);
  });

  it("local-helpers: a helper declared inside a function is a wrapper in its scope (M5C.10d)", async () => {
    const g = await run("local-helpers");
    const p = "local-helpers";
    // Requests sit in the functions that call the helpers; `localhost` is `heuristic` (ADR-0158).
    expect(links(g, "http")).toEqual([
      `file:${p}/test/notes.test.ts -> route:${p}/GET /api/status heuristic`,
      `file:${p}/test/notes.test.ts -> route:${p}/POST /api/notes heuristic`,
      `symbol:${p}/src/notesPanel.ts#notesPanel -> route:${p}/DELETE /api/notes/:noteId exact`,
      `symbol:${p}/src/notesPanel.ts#notesPanel -> route:${p}/GET /api/notes exact`,
      `symbol:${p}/src/notesPanel.ts#notesPanel -> route:${p}/POST /api/notes exact`,
      `symbol:${p}/src/notesPanel.ts#notesPanel -> route:${p}/PUT /api/notes/:noteId/pin exact`,
    ]);
    expect(g.nodes.some((n) => n.kind === "unresolved")).toBe(false);
  });

  it("let-query-urls: a let URL extended inside its query keeps its route (M5C.10e)", async () => {
    const g = await run("let-query-urls");
    const p = "let-query-urls";
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/player.ts#listTracks -> route:${p}/GET /api/tracks exact`,
      `symbol:${p}/src/player.ts#listened -> route:${p}/GET /api/history exact`,
      `symbol:${p}/src/player.ts#playlists -> route:${p}/GET /api/playlists exact`,
      // The append that may change the path stays visible, not matched to `/:owner`.
      `symbol:${p}/src/player.ts#playlists -> unresolved:${p}/src/player.ts:30:10 unresolved DYNAMIC_URL`,
      `symbol:${p}/src/player.ts#showTrack -> route:${p}/GET /api/tracks/:trackId exact`,
    ]);
  });

  it("conditional-spread-method: a method before a conditional spread that can't set it stands (M5C.10e2)", async () => {
    const g = await run("conditional-spread-method");
    const p = "conditional-spread-method";
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/budgets.ts#createBudget -> route:${p}/POST /api/budgets exact`,
      `symbol:${p}/src/budgets.ts#listBudgets -> route:${p}/GET /api/budgets exact`,
      `symbol:${p}/src/budgets.ts#removeBudget -> route:${p}/DELETE /api/budgets/:budgetId exact`,
      // A caller's `override` could set any method, so only the method would pick a route.
      `symbol:${p}/src/budgets.ts#renameBudget -> unresolved:${p}/src/budgets.ts:19:10 unresolved AMBIGUOUS`,
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

  it("wrapper-chain: wrappers over wrappers inline at the outermost caller, up to three deep (M5C.7f)", async () => {
    const g = await run("wrapper-chain");
    const p = "wrapper-chain";
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/api/boards.ts#createBoard -> route:${p}/POST /api/boards exact`,
      `symbol:${p}/src/api/boards.ts#listBoards -> route:${p}/GET /api/boards exact`,
      `symbol:${p}/src/api/boards.ts#loadBoard -> route:${p}/GET /api/boards/:id exact`,
      `symbol:${p}/src/api/boards.ts#loadStats -> route:${p}/GET /api/stats exact`,
      `symbol:${p}/src/api/feed.ts#getTracked -> unresolved:${p}/src/api/feed.ts:5:10 unresolved WRAPPER_DEPTH`,
    ]);
  });

  it("nested-config: a nested config's `paths` resolve the files under it, and only those (M5C.7g)", async () => {
    const g = await run("nested-config");
    const p = "nested-config";
    const notes = `symbol:${p}/web/src/notes/notesApi.js`;
    expect(links(g, "http")).toEqual([
      `symbol:${p}/admin/weekly.ts#weeklyReport -> route:${p}/GET /api/reports/weekly exact`,
      `${notes}#addNote -> route:${p}/POST /api/notes exact`,
      `${notes}#listNotes -> route:${p}/GET /api/notes exact`,
      `${notes}#removeNote -> route:${p}/DELETE /api/notes/:id exact`,
    ]);
    expect(links(g, "imports")).toEqual([
      `file:${p}/admin/weekly.ts -> file:${p}/web/src/lib/client.js exact`,
      `file:${p}/scripts/seed.js -> unresolved:${p}/scripts/seed.js:2:20 unresolved UNKNOWN_SYMBOL`,
      `file:${p}/web/src/notes/notesApi.js -> file:${p}/web/src/lib/client.js exact`,
    ]);
  });

  it("wrapper-fetch: each wrapper call is inlined, also through a wrapper over a wrapper", async () => {
    const g = await run("wrapper-fetch");
    const p = "wrapper-fetch";
    expect(links(g, "http")).toEqual([
      `symbol:${p}/src/projects.ts#createProject -> route:${p}/POST /api/projects exact`,
      `symbol:${p}/src/projects.ts#legacyProjects -> route:${p}/GET /api/projects exact`,
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

  it("infra-test-folders: test and fixture folders' compose and env files draw nothing (M9.3e)", async () => {
    const g = await run("infra-test-folders");
    expect(ids(g, "datastore")).toEqual(["datastore:infra/db"]);
    expect(ids(g, "queue")).toEqual([]);
    expect(links(g, "stores")).toEqual([
      "model:infra-test-folders/Invoice -> datastore:infra/db heuristic",
    ]);
    expect(g.warnings.map((w) => w.code)).toEqual(["TSCONFIG_MISSING"]);
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
    // `.env.example`'s path was tried for matching (ADR-0202), and nothing of it is shown.
    expect(text).toContain("no route matches GET to {env:REPORTS_API_URL}/summary");
    // The output isn't empty because detection failed: each source of secrets was read.
    expect(ids(g, "datastore")).toContain("datastore:infra/env#ANALYTICS_DB_URL");
    expect(ids(g, "datastore")).toContain("datastore:infra/db");
    expect(ids(g, "external")).toContain("external:ext/api.partner.example");
    expect(Object.values(reasons(g)).sort()).toEqual([
      "DYNAMIC_URL",
      "DYNAMIC_URL",
      "NO_MATCHING_ROUTE",
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
  const sites = collectHttpCalls(programs, resolver);
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
        requests.some((r) => at(r.call.site) === at(site.site)),
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
