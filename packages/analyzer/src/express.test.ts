import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchitectureGraph } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { createSymbolResolver } from "./calls.js";
import {
  buildExpressRoutes,
  collectExpressFacts,
  composeExpressRoutes,
  joinPath,
  rootFileServices,
  routerCreations,
  type ExpressFacts,
} from "./express.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
import { detectWorkspace } from "./workspace.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-express-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string | string[]): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), Array.isArray(content) ? content.join("\n") + "\n" : content);
}

/** Route node IDs with the `route:` prefix dropped. */
function routes(graph: ArchitectureGraph): string[] {
  return graph.nodes.filter((n) => n.kind === "route").map((n) => n.id.replace(/^route:/, ""));
}

/** `route -> symbol (confidence)` for each handles edge, prefixes dropped. */
function handles(graph: ArchitectureGraph): string[] {
  return graph.edges
    .filter((e) => e.kind === "handles")
    .map(
      (e) =>
        `${e.from.replace(/^route:/, "")} -> ${e.to.replace(/^symbol:/, "")} (${e.confidence})`,
    );
}

/** `id: expression` for each DYNAMIC_ROUTE unresolved node. */
function dynamic(graph: ArchitectureGraph): string[] {
  return graph.nodes.flatMap((n) =>
    n.kind === "unresolved" && n.reason === "DYNAMIC_ROUTE" ? [`${n.id}: ${n.expression}`] : [],
  );
}

function expressWarnings(graph: ArchitectureGraph): ArchitectureGraph["warnings"] {
  return graph.warnings.filter((w) => w.code.startsWith("EXPRESS"));
}

describe("joinPath", () => {
  it.each([
    ["/", "/", "/"],
    ["/", "/users", "/users"],
    ["/api", "/", "/api"],
    ["/api/", "/users/", "/api/users"],
    ["", "users", "/users"],
    ["/api", "*", "/api/*"],
  ])("joins %j and %j into %j", (prefix, path, expected) => {
    expect(joinPath(prefix, path)).toBe(expected);
  });
});

/** The programs of the repo at `root`, its per-service Express facts, and the composition input. */
async function expressFacts(root: string) {
  const inventory = await buildInventory(root);
  const workspace = await detectWorkspace(root, inventory.files);
  const programs = buildServicePrograms(root, workspace, inventory);
  const resolver = createSymbolResolver(programs, workspace);
  const hasRouters = programs.some((sp) => routerCreations(sp).length > 0);
  return {
    programs,
    resolver,
    workspace,
    rootFiles: rootFileServices(programs),
    facts: programs.map((sp) => collectExpressFacts(sp, resolver, hasRouters)),
  };
}

/** The facts of one service, by key. */
function factsOf(all: readonly ExpressFacts[], service: string): ExpressFacts {
  const found = all.find((f) => f.service === service);
  if (!found) throw new Error(`no facts for ${service}`);
  return found;
}

describe("express facts", () => {
  it.each([
    "express-basic",
    "express-nested-routers",
    "express-folder-routers",
    "ambiguous-routes",
    "shop-demo",
  ])("composes %s from JSON round-tripped facts exactly as the one-shot detector", async (name) => {
    const root = join(FIXTURES, name);
    const { workspace, rootFiles, facts } = await expressFacts(root);
    const revived = JSON.parse(JSON.stringify(facts)) as ExpressFacts[];
    const composed = composeExpressRoutes(revived, workspace.packages, rootFiles);
    const fresh = await expressFacts(root);
    const oneShot = buildExpressRoutes(fresh.programs, fresh.resolver);
    expect(composed.nodes.length).toBeGreaterThan(0);
    expect(composed).toEqual(oneShot);
  });

  it("keeps a router's facts independent of the service that mounts it", async () => {
    await put("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    await put(
      "packages/routes/package.json",
      JSON.stringify({ name: "routes", dependencies: { express: "4" } }),
    );
    await put("packages/routes/src/users.ts", [
      'import { Router } from "express";',
      "export function list() {}",
      "export const users = Router();",
      'users.get("/users", list);',
    ]);
    await put(
      "packages/api/package.json",
      JSON.stringify({ name: "api", dependencies: { express: "4" } }),
    );
    const server = (prefix: string) => [
      'import express from "express";',
      'import { users } from "../../routes/src/users";',
      "const app = express();",
      `app.use("${prefix}", users);`,
    ];
    await put("packages/api/src/server.ts", server("/v1"));
    const before = await expressFacts(dir);
    await put("packages/api/src/server.ts", server("/v2"));
    const after = await expressFacts(dir);

    // The mount moved, but the router's service saw the same thing both times.
    expect(factsOf(after.facts, "routes")).toEqual(factsOf(before.facts, "routes"));
    expect(factsOf(after.facts, "api")).not.toEqual(factsOf(before.facts, "api"));
    const ids = (input: typeof before) =>
      composeExpressRoutes(input.facts, input.workspace.packages, input.rootFiles).nodes.map(
        (n) => n.id,
      );
    expect(ids(before)).toEqual(["route:api/GET /v1/users"]);
    expect(ids(after)).toEqual(["route:api/GET /v2/users"]);
  });

  it("collects only creations when no service creates a router", async () => {
    await put("package.json", JSON.stringify({ name: "plain" }));
    await put("src/index.ts", ["function register(app: unknown) {}", "register({});"]);
    const { facts } = await expressFacts(dir);
    expect(facts).toEqual([
      { service: "plain", creations: [], scanned: false, bindings: [], registrations: [] },
    ]);
  });
});

describe("express routes", () => {
  it("stops composing exponentially shared mounts with a warning instead of hanging", async () => {
    // r0 → r1 → … → r19, each under two prefixes: 2^19 paths to the one route at the bottom.
    const levels = 20;
    await put("package.json", JSON.stringify({ name: "api", dependencies: { express: "4" } }));
    await put("src/server.ts", [
      'import express, { Router } from "express";',
      "export function h() {}",
      "const app = express();",
      ...Array.from({ length: levels }, (_, i) => `const r${i} = Router();`),
      'app.use("/", r0);',
      ...Array.from({ length: levels - 1 }, (_, i) => `r${i}.use(["/a", "/b"], r${i + 1});`),
      `r${levels - 1}.get("/x", h);`,
    ]);
    const start = performance.now();
    const graph = await analyze(dir);
    expect(performance.now() - start).toBeLessThan(20_000);
    expect(routes(graph).length).toBeGreaterThan(0);
    expect(routes(graph).length).toBeLessThanOrEqual(20_000);
    expect(expressWarnings(graph)).toEqual([
      {
        code: "EXPRESS_ROUTE_LIMIT",
        message:
          "mount composition stopped after 20000 steps (routers shared under many prefixes); some Express routes are missing",
      },
    ]);
  });

  it("detects methods, route chains, static paths, and handlers on one app", async () => {
    await put("package.json", JSON.stringify({ name: "api", dependencies: { express: "4" } }));
    await put("src/handlers.ts", [
      "export function listUsers() {}",
      "export function auth() {}",
      "function show() {}",
      "const remove = () => {};",
      "export const users = { show, remove };",
    ]);
    await put("src/server.ts", [
      'import express from "express";',
      'import { listUsers, auth, users } from "./handlers";',
      "",
      'const USERS = "/users";',
      "const app = express();",
      'app.get("env");',
      "app.get(USERS, auth, listUsers);",
      "app.post(`${USERS}/:id`, [auth, users.show]);",
      'app.route("/items/:id").get(users.show).delete(users.remove);',
      'app.all(["/a", "/b/"], (req, res) => res.end());',
      'app.patch("/x", () => undefined).put("/y", listUsers);',
      "app.listen(3000);",
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual([
      "api/ALL /a",
      "api/ALL /b",
      "api/DELETE /items/:id",
      "api/GET /items/:id",
      "api/GET /users",
      "api/PATCH /x",
      "api/POST /users/:id",
      "api/PUT /y",
    ]);
    expect(handles(graph)).toEqual([
      "api/DELETE /items/:id -> api/src/handlers.ts#remove (exact)",
      "api/GET /items/:id -> api/src/handlers.ts#show (exact)",
      "api/GET /users -> api/src/handlers.ts#auth (exact)",
      "api/GET /users -> api/src/handlers.ts#listUsers (exact)",
      "api/POST /users/:id -> api/src/handlers.ts#auth (exact)",
      "api/POST /users/:id -> api/src/handlers.ts#show (exact)",
      "api/PUT /y -> api/src/handlers.ts#listUsers (exact)",
    ]);
    const getUsers = graph.nodes.find((n) => n.id === "route:api/GET /users");
    expect(getUsers).toEqual({
      id: "route:api/GET /users",
      kind: "route",
      label: "GET /users",
      parentId: "file:api/src/server.ts",
      layer: "backend",
      method: "GET",
      path: "/users",
      source: { file: "src/server.ts", line: 7, column: 5 },
    });
    expect(
      graph.edges.find((e) => e.id.startsWith("handles:route:api/GET /users->"))?.sites,
    ).toEqual([{ file: "src/server.ts", line: 7, column: 16 }]);
    expect(expressWarnings(graph)).toEqual([]);
  });

  it("composes mounts across ES modules: nested routers, sub-apps, double mounts", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put("src/users.ts", [
      'import { Router } from "express";',
      "export function list() {}",
      "const users = Router();",
      'users.get("/", list);',
      'users.get("/:id", list);',
      "export default users;",
    ]);
    await put("src/routes/index.ts", [
      'import * as express from "express";',
      'import users from "../users";',
      "export const api = express.Router();",
      'api.use("/users", users);',
      'api.use("/people/", users);',
    ]);
    await put("src/admin.ts", [
      'import express = require("express");',
      "const admin = express();",
      'admin.get("/stats", () => 1);',
      "export { admin };",
    ]);
    await put("src/main.ts", [
      'import express from "express";',
      'import { api } from "./routes";',
      'import { admin } from "./admin";',
      "const app = express();",
      "app.use(express.json());",
      'app.use("/api", api);',
      'app.use("/admin", admin);',
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual([
      "api/GET /admin/stats",
      "api/GET /api/people",
      "api/GET /api/people/:id",
      "api/GET /api/users",
      "api/GET /api/users/:id",
    ]);
    expect(handles(graph)).toEqual([
      "api/GET /api/people -> api/src/users.ts#list (exact)",
      "api/GET /api/people/:id -> api/src/users.ts#list (exact)",
      "api/GET /api/users -> api/src/users.ts#list (exact)",
      "api/GET /api/users/:id -> api/src/users.ts#list (exact)",
    ]);
    expect(graph.nodes.find((n) => n.id === "route:api/GET /api/users")?.parentId).toBe(
      "file:api/src/users.ts",
    );
    expect(expressWarnings(graph)).toEqual([]);
  });

  it("follows CommonJS routers, inline requires, and destructured Router", async () => {
    await put("controllers/orders.js", [
      "module.exports = {",
      "  list(req, res) { res.json([]); },",
      "  create: async (req, res) => res.status(201).end(),",
      "};",
    ]);
    await put("routes/orders.js", [
      'const { Router } = require("express");',
      'const orders = require("../controllers/orders");',
      "const router = Router();",
      'router.route("/").get(orders.list).post(orders.create);',
      "module.exports = router;",
    ]);
    await put("routes/health.js", [
      'const Router = require("express").Router;',
      "const r = Router();",
      'r.get("/health", function health(req, res) { res.end(); });',
      "exports.health = r;",
    ]);
    await put("app.js", [
      'const express = require("express");',
      'const { health } = require("./routes/health");',
      "const app = express();",
      'app.use("/orders", require("./routes/orders"));',
      "app.use(health);",
      "module.exports = app;",
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual(["app/GET /health", "app/GET /orders", "app/POST /orders"]);
    expect(handles(graph)).toEqual([
      "app/GET /orders -> app/controllers/orders.js#list (exact)",
      "app/POST /orders -> app/controllers/orders.js#create (exact)",
    ]);
  });

  it("binds routers passed to functions, typed parameters, factories, and class properties", async () => {
    await put("src/register.ts", [
      'import type { Express } from "express";',
      "export function registerRoutes(app) {",
      '  app.get("/ping", ping);',
      "}",
      "export function registerTyped(app: Express) {",
      '  app.get("/typed", ping);',
      "}",
      "function ping() {}",
    ]);
    await put("src/factory.ts", [
      'import express from "express";',
      "export function makeRouter() {",
      "  const r = express.Router();",
      '  r.get("/made", () => 1);',
      "  return r;",
      "}",
      "export class Controller {",
      "  router = express.Router();",
      '  constructor() { this.router.get("/cls", () => 1); }',
      "}",
    ]);
    await put("src/main.ts", [
      'import express from "express";',
      'import { registerRoutes } from "./register";',
      'import { makeRouter, Controller } from "./factory";',
      "const app = express();",
      "registerRoutes(app);",
      'app.use("/v1", makeRouter());',
      'app.use("/c", new Controller().router);',
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual([
      "app/GET /c/cls",
      "app/GET /ping",
      "app/GET /typed",
      "app/GET /v1/made",
    ]);
    expect(handles(graph)).toEqual([
      "app/GET /ping -> app/src/register.ts#ping (exact)",
      "app/GET /typed -> app/src/register.ts#ping (exact)",
    ]);
    expect(expressWarnings(graph)).toEqual([]);
  });

  it("follows an app or router assigned once in the constructor to a property without a value", async () => {
    await put("src/server.ts", [
      'import express, { Router } from "express";',
      "function health() {}",
      "export class Server {",
      "  public app: express.Application;",
      "  private api!: Router;",
      "  #admin: Router;",
      "  constructor() {",
      "    this.app = express();",
      "    this.api = Router();",
      "    this.#admin = Router();",
      "    this.routes();",
      "  }",
      "  private routes() {",
      '    this.api.get("/users", () => 1);',
      '    this.#admin.post("/flush", () => 1);',
      '    this.app.use("/api", this.api);',
      '    this.app.use("/admin", this.#admin);',
      '    this.app.get("/health", health);',
      "  }",
      "}",
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual([
      "app/GET /api/users",
      "app/GET /health",
      "app/POST /admin/flush",
    ]);
    expect(handles(graph)).toEqual(["app/GET /health -> app/src/server.ts#health (exact)"]);
    expect(expressWarnings(graph)).toEqual([]);
  });

  it("leaves a property unknown when it is assigned twice, outside the constructor, or elsewhere", async () => {
    await put("src/servers.ts", [
      'import express from "express";',
      "export class Twice {",
      "  app: express.Express;",
      "  constructor() {",
      "    this.app = express();",
      '    this.app.get("/twice", () => 1);',
      "  }",
      "  reset() { this.app = express(); }",
      "}",
      "export class Later {",
      "  app: express.Express;",
      "  init() {",
      "    this.app = express();",
      '    this.app.get("/later", () => 1);',
      "  }",
      "}",
      "export class Nested {",
      "  app: express.Express;",
      "  constructor(on: boolean) {",
      "    if (on) this.app = express();",
      '    this.app.get("/nested", () => 1);',
      "  }",
      "}",
      "export class Outside {",
      "  app: express.Express;",
      "  constructor() {",
      "    this.app = express();",
      '    this.app.get("/outside", () => 1);',
      "  }",
      "}",
    ]);
    await put("src/main.ts", [
      'import express from "express";',
      'import { Outside } from "./servers";',
      "const server = new Outside();",
      "server.app = express();",
      'express().get("/kept", () => 1);',
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual(["app/GET /kept"]);
  });

  it("records dynamic paths and prefixes as DYNAMIC_ROUTE unresolved nodes", async () => {
    await put("src/a.ts", [
      'import express, { Router } from "express";',
      "const app = express();",
      "const r = Router();",
      "let base = '/x';",
      "r.get(base, () => 1);",
      'r.get("/fixed", () => 1);',
      "app.get(/^\\/re/, () => 1);",
      'app.use("/static", r);',
      "app.use(process.env.PREFIX, r);",
      "for (const p of ['/a']) app.get(p, () => 1);",
      "const n = Router();",
      'r.use("/n", n);',
      'n.get("/y", () => 1);',
      "app.use(`/t/${base}`, n);",
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual(["app/GET /static/fixed", "app/GET /static/n/y"]);
    // Line 5 is reached twice (static and dynamic mount); the smaller expression is kept.
    expect(dynamic(graph)).toEqual([
      "unresolved:app/src/a.ts:10:33: GET p",
      "unresolved:app/src/a.ts:13:7: GET `/t/${base}` + /y",
      "unresolved:app/src/a.ts:5:7: GET /static + base",
      "unresolved:app/src/a.ts:6:7: GET process.env.PREFIX + /fixed",
      "unresolved:app/src/a.ts:7:9: GET /^\\/re/",
    ]);
    const node = graph.nodes.find((n) => n.id === "unresolved:app/src/a.ts:7:9");
    expect(node?.parentId).toBe("service:app/");
    expect(node?.source).toEqual({ file: "src/a.ts", line: 7, column: 9 });
  });

  it("resolves concatenated, imported, and property paths, merging repeated routes", async () => {
    await put("src/paths.ts", [
      'export const BASE = "/v2";',
      'export const ROUTES = { users: "/users" };',
    ]);
    await put("src/server.ts", [
      'import express, { Router } from "express";',
      'import { BASE, ROUTES } from "./paths";',
      "function h() {}",
      "function make() { return 42; }",
      "const app = express();",
      "app.get(BASE + ROUTES.users, h);",
      'app.get("/v2/users", h);',
      'app.use("/n", make());',
      "const users = Router();",
      'users.get("/", h);',
      "const routers = { users };",
      'app.use("/u", routers.users);',
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual(["app/GET /u", "app/GET /v2/users"]);
    expect(graph.nodes.find((n) => n.id === "route:app/GET /v2/users")?.source).toEqual({
      file: "src/server.ts",
      line: 6,
      column: 5,
    });
    expect(graph.edges.find((e) => e.from === "route:app/GET /v2/users")?.sites).toEqual([
      { file: "src/server.ts", line: 6, column: 30 },
      { file: "src/server.ts", line: 7, column: 22 },
    ]);
  });

  it("follows CommonJS exports of chained, inline-created routers", async () => {
    await put("z.js", [
      'const express = require("express");',
      'module.exports = express.Router().get("/z", zHandler);',
      "function zHandler() {}",
    ]);
    await put("y.js", [
      'const { Router } = require("express");',
      'exports.y = Router().post("/y", () => 1);',
    ]);
    await put("app.js", [
      'const express = require("express");',
      "const app = express();",
      'app.use("/z", require("./z"));',
      'app.use(require("./y").y);',
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual(["app/GET /z/z", "app/POST /y"]);
    expect(handles(graph)).toEqual(["app/GET /z/z -> app/z.js#zHandler (exact)"]);
  });

  it("emits routes of routers mounted only inside a cycle, with a warning", async () => {
    await put("src/r.ts", [
      'import { Router } from "express";',
      "const a = Router();",
      "const b = Router();",
      'a.use("/b", b);',
      'b.use("/a", a);',
      'a.get("/x", () => 1);',
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual(["app/GET /x"]);
    expect(expressWarnings(graph).map((w) => w.message)).toEqual([
      "router at 2:11 is never mounted on an app; its routes use paths relative to the router",
    ]);
  });

  it("warns about routers that are never mounted and keeps their relative paths", async () => {
    await put("src/r.ts", [
      'import { Router } from "express";',
      "export const r = Router();",
      'r.get("/orphan", () => 1);',
      "export const empty = Router();",
    ]);
    await put("src/attach.ts", [
      'import * as ex from "express";',
      'export function attach(x: ex.Router) { x.get("/q", () => 1); }',
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual(["app/GET /orphan", "app/GET /q"]);
    expect(expressWarnings(graph)).toEqual([
      {
        code: "EXPRESS_UNMOUNTED_ROUTER",
        file: "src/attach.ts",
        message:
          "router at 2:24 is never mounted on an app; its routes use paths relative to the router",
      },
      {
        code: "EXPRESS_UNMOUNTED_ROUTER",
        file: "src/r.ts",
        message:
          "router at 2:18 is never mounted on an app; its routes use paths relative to the router",
      },
    ]);
  });

  it("ignores route-like calls on objects that aren't Express apps or routers", async () => {
    await put("src/a.ts", [
      "const cache = new Map<string, number>();",
      'cache.get("/x");',
      "const http = { get(path: string, cb: () => void) {} };",
      'http.get("/y", () => undefined);',
      "function express() { return http; }",
      'express().get("/z", () => undefined);',
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual([]);
    expect(dynamic(graph)).toEqual([]);
  });

  it("keys routes by the root app's service across workspace packages", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    await put("apps/api/package.json", JSON.stringify({ name: "api" }));
    await put("apps/api/server.ts", [
      'import express from "express";',
      'import { mount } from "../worker/routes";',
      "const app = express();",
      "mount(app);",
    ]);
    await put("apps/worker/package.json", JSON.stringify({ name: "worker" }));
    await put("apps/worker/routes.ts", [
      "export function handler() {}",
      'export function mount(app) { app.post("/jobs", handler); }',
    ]);
    const graph = await analyze(dir);
    expect(routes(graph)).toEqual(["api/POST /jobs"]);
    expect(graph.nodes.find((n) => n.kind === "route")?.parentId).toBe("file:worker/routes.ts");
    expect(handles(graph)).toEqual(["api/POST /jobs -> worker/routes.ts#handler (exact)"]);
  });
});

describe("routers loaded from a folder listing (M5A.3e, ADR-0162)", () => {
  /** The composed routes of the repo at `dir`, and those reached only through a listing. */
  async function composed() {
    const { programs, resolver } = await expressFacts(dir);
    const result = buildExpressRoutes(programs, resolver);
    return {
      routes: result.nodes.flatMap((n) => (n.kind === "route" ? [n.id] : [])),
      listed: result.listedRoutes,
      warnings: result.warnings,
    };
  }

  it("mounts every router a glob listing requires and reduces onto one router", async () => {
    await put("src/routes/createRouter.ts", [
      'import { Router } from "express";',
      'import glob from "glob";',
      'const dev = process.env.NODE_ENV === "dev";',
      "const routers = glob",
      '  .sync(`**/*.${dev ? "ts" : "js"}`, { cwd: `${__dirname}/` })',
      "  .map((filename: string) => require(`./${filename}`))",
      "  .filter((r: any) => r.default && Object.getPrototypeOf(r.default) === Router)",
      "  .reduce((root: Router, r: any) => root.use(r.default), Router({ mergeParams: true }));",
      "export default routers;",
    ]);
    await put("src/routes/v1/users.ts", [
      'import { Router } from "express";',
      "const router = Router();",
      'router.get("/v1/users/:id", () => 1);',
      "export default router;",
    ]);
    await put("src/routes/v1/orders.ts", [
      'import { Router } from "express";',
      "const router = Router();",
      'router.post("/v1/orders", () => 1);',
      "export default router;",
    ]);
    await put("src/routes/helpers.ts", ["export const notARouter = 1;"]);
    await put("src/server.ts", [
      'import express from "express";',
      'import routers from "./routes/createRouter";',
      "const app = express();",
      'app.use("/api", routers);',
      'app.get("/health", () => 1);',
    ]);
    const { routes, listed, warnings } = await composed();
    expect(routes).toEqual([
      "route:app/GET /api/v1/users/:id",
      "route:app/GET /health",
      "route:app/POST /api/v1/orders",
    ]);
    expect(listed).toEqual(["route:app/GET /api/v1/users/:id", "route:app/POST /api/v1/orders"]);
    expect(warnings).toEqual([]);
  });

  it("mounts CommonJS routers from readdirSync in forEach and for-of, prefixes from file names", async () => {
    await put("legacy/index.js", [
      'const fs = require("fs");',
      'const path = require("path");',
      "module.exports = function mount(app) {",
      "  fs.readdirSync(__dirname)",
      '    .filter((file) => file !== "index.js")',
      "    .forEach((file) => {",
      '      const name = path.basename(file, ".js");',
      "      app.use(`/legacy/${name}`, require(path.join(__dirname, file)));",
      "    });",
      "};",
    ]);
    await put("legacy/reports.js", [
      'const { Router } = require("express");',
      "const r = Router();",
      'r.get("/daily", () => 1);',
      "module.exports = r;",
    ]);
    await put("legacy/admin/index.js", [
      'const express = require("express");',
      "const r = express.Router();",
      'r.get("/stats", () => 1);',
      "module.exports = r;",
    ]);
    await put("api/ping.js", [
      'const { Router } = require("express");',
      'module.exports = Router().get("/ping", () => 1);',
    ]);
    await put("app.js", [
      'const express = require("express");',
      'const { readdirSync } = require("node:fs");',
      "const app = express();",
      'require("./legacy")(app);',
      'for (const file of readdirSync(__dirname + "/api")) {',
      '  app.use("/api", require("./api/" + file.slice(0, -3)));',
      "}",
    ]);
    const { routes, listed, warnings } = await composed();
    expect(routes).toEqual([
      "route:app/GET /api/ping",
      "route:app/GET /legacy/admin/stats",
      "route:app/GET /legacy/reports/daily",
    ]);
    expect(listed).toEqual(routes);
    expect(warnings).toEqual([]);
  });

  it("reads __dirname and relative requires in a const from another file against that file", async () => {
    await put("src/config/paths.ts", [
      'import path from "path";',
      'export const ROUTES_DIR = path.join(__dirname, "..", "routes");',
    ]);
    await put("src/plugins/index.ts", [
      'import { readdirSync } from "fs";',
      "export const plugins = readdirSync(__dirname)",
      '  .filter((f) => f !== "index.ts")',
      '  .map((f) => require("./" + f));',
    ]);
    for (const name of ["users", "orders"]) {
      await put(`src/routes/${name}.ts`, [
        'import { Router } from "express";',
        `export default Router().get("/${name}", () => 1);`,
      ]);
    }
    await put("src/plugins/audit.ts", [
      'import { Router } from "express";',
      'export default Router().get("/audit", () => 1);',
    ]);
    // Same-named folders next to the using file: read against it, they would mount these.
    await put("routes/decoy.ts", [
      'import { Router } from "express";',
      'export default Router().get("/decoy", () => 1);',
    ]);
    await put("plugins/decoy.ts", [
      'import { Router } from "express";',
      'export default Router().get("/decoy-plugin", () => 1);',
    ]);
    await put("server.ts", [
      'import express from "express";',
      'import fs from "fs";',
      'import path from "path";',
      'import { ROUTES_DIR } from "./src/config/paths";',
      'import { plugins } from "./src/plugins";',
      "const app = express();",
      "for (const file of fs.readdirSync(ROUTES_DIR)) {",
      '  app.use("/api", require(path.join(ROUTES_DIR, file)).default);',
      "}",
      'plugins.forEach((p) => app.use("/plugins", p.default));',
    ]);
    const { routes, listed, warnings } = await composed();
    expect(listed).toEqual([
      "route:app/GET /api/orders",
      "route:app/GET /api/users",
      "route:app/GET /plugins/audit",
    ]);
    // The decoys stay unmounted, at their own paths.
    expect(routes).toEqual([
      "route:app/GET /api/orders",
      "route:app/GET /api/users",
      "route:app/GET /decoy",
      "route:app/GET /decoy-plugin",
      "route:app/GET /plugins/audit",
    ]);
    expect(warnings.map((w) => `${w.code} ${w.file}`)).toEqual([
      "EXPRESS_UNMOUNTED_ROUTER plugins/decoy.ts",
      "EXPRESS_UNMOUNTED_ROUTER routes/decoy.ts",
    ]);
  });

  it("keeps a route reached both ways out of the listed set", async () => {
    await put("routes/users.js", [
      'const { Router } = require("express");',
      'module.exports = Router().get("/users", () => 1);',
    ]);
    await put("app.js", [
      'const express = require("express");',
      'const fs = require("fs");',
      "const app = express();",
      'fs.readdirSync(__dirname + "/routes").forEach((f) => app.use(require("./routes/" + f)));',
      'app.use(require("./routes/users.js"));',
    ]);
    const { routes, listed } = await composed();
    expect(routes).toEqual(["route:app/GET /users"]);
    expect(listed).toEqual([]);
  });

  it("leaves listings it can't read unmounted, and a prefix it can't read dynamic", async () => {
    await put("plugins/a.js", [
      'const { Router } = require("express");',
      'module.exports = Router().get("/a", () => 1);',
    ]);
    await put("app.js", [
      'const express = require("express");',
      'const fs = require("fs");',
      'const glob = require("glob");',
      "const app = express();",
      // The folder comes from the environment, and a glob without `cwd` lists from wherever
      // the process starts: neither can be read from the repo.
      "fs.readdirSync(process.env.PLUGINS).forEach((f) => app.use(require(f)));",
      'glob.sync("plugins/*.js").forEach((f) => app.use(require(f)));',
      // A prefix computed by a call we don't evaluate.
      'fs.readdirSync(__dirname + "/plugins").forEach((f) => {',
      '  app.use("/" + f.toUpperCase(), require("./plugins/" + f));',
      "});",
    ]);
    const { routes, listed, warnings } = await composed();
    expect(routes).toEqual([]);
    expect(listed).toEqual([]);
    expect(warnings).toEqual([]);
    const graph = await analyze(dir);
    expect(dynamic(graph)).toEqual([
      'unresolved:app/plugins/a.js:2:31: GET "/" + f.toUpperCase() + /a',
    ]);
  });
});
