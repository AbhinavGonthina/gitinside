import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchitectureGraph } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { joinPath } from "./express.js";

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
