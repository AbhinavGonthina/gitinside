import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { collectHttpCalls, type HttpCallSite, type ProgramExpression } from "./http.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
import { detectWorkspace } from "./workspace.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-http-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string | string[]): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), Array.isArray(content) ? content.join("\n") + "\n" : content);
}

/** Run the collector over the temp repo, with Express inline handlers like `analyze` has. */
async function collect(): Promise<HttpCallSite[]> {
  const inventory = await buildInventory(dir);
  const workspace = await detectWorkspace(dir, inventory.files);
  const programs = buildServicePrograms(dir, workspace, inventory);
  const resolver = createSymbolResolver(programs, workspace);
  const express = buildExpressRoutes(programs, resolver);
  return collectHttpCalls(programs, resolver, express.inlineHandlers);
}

function text(value: ProgramExpression | null | undefined): string {
  if (value === undefined) return "-";
  if (value === null) return "?";
  return value.expression.getText();
}

/**
 * `line:column client METHOD url base=… [owners]`, with `?` for unknown, `-` for absent,
 * and the confidence when it isn't `exact`.
 */
function summary(sites: readonly HttpCallSite[]): string[] {
  return sites.map(
    (s) =>
      `${s.file}:${s.site.line}:${s.site.column} ${s.client} ${s.method ?? "?"} ${text(s.url)}` +
      ` base=${text(s.baseURL)} [${s.owners.join(",")}]` +
      (s.confidence === "exact" ? "" : ` (${s.confidence})`),
  );
}

describe("collectHttpCalls: fetch", () => {
  it("reads the method from init, consts, objects, and enums, and marks the rest unknown", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/methods.ts", [
      'export const POST = "POST";',
      'export const METHODS = { put: "put" } as const;',
      'export enum Verb { Patch = "PATCH" }',
    ]);
    await put("src/api.ts", [
      'import { POST, METHODS, Verb } from "./methods";',
      'const DELETE = "delete";',
      "export async function load(id: string, m: string, opts: RequestInit) {",
      '  await fetch("/api/users");',
      "  await fetch(`/api/users/${id}`, { method: POST, body: '{}' });",
      '  await fetch("/a", { method: METHODS.put });',
      '  await fetch("/b", { method: Verb.Patch });',
      '  await fetch("/c", { method: DELETE });',
      '  await fetch("/d", { method: m });',
      '  await fetch("/e", opts);',
      '  await fetch("/f", { ...opts });',
      '  await fetch("/g", { ...opts, method: "head" });',
      '  await fetch("/h", { method: "TRACE" });',
      "  const method = 'options';",
      '  await fetch("/i", { method });',
      '  await fetch("/j", { headers: {} });',
      "}",
    ]);
    expect(summary(await collect())).toEqual([
      'src/api.ts:4:9 fetch GET "/api/users" base=- [symbol:web/src/api.ts#load]',
      "src/api.ts:5:9 fetch POST `/api/users/${id}` base=- [symbol:web/src/api.ts#load]",
      'src/api.ts:6:9 fetch PUT "/a" base=- [symbol:web/src/api.ts#load]',
      'src/api.ts:7:9 fetch PATCH "/b" base=- [symbol:web/src/api.ts#load]',
      'src/api.ts:8:9 fetch DELETE "/c" base=- [symbol:web/src/api.ts#load]',
      'src/api.ts:9:9 fetch ? "/d" base=- [symbol:web/src/api.ts#load]',
      'src/api.ts:10:9 fetch ? "/e" base=- [symbol:web/src/api.ts#load]',
      'src/api.ts:11:9 fetch ? "/f" base=- [symbol:web/src/api.ts#load]',
      'src/api.ts:12:9 fetch HEAD "/g" base=- [symbol:web/src/api.ts#load]',
      'src/api.ts:13:9 fetch ? "/h" base=- [symbol:web/src/api.ts#load]',
      'src/api.ts:15:9 fetch OPTIONS "/i" base=- [symbol:web/src/api.ts#load]',
      'src/api.ts:16:9 fetch GET "/j" base=- [symbol:web/src/api.ts#load]',
    ]);
  });

  it("recognizes global objects, fetch packages, and Request objects, but not local fetch functions", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/a.ts", [
      'import nodeFetch from "node-fetch";',
      'import { fetch as undiciFetch } from "undici";',
      'import { other } from "cross-fetch";',
      'const required = require("isomorphic-fetch");',
      'const { fetch: notTraced } = require("node-fetch");',
      'window.fetch("/w");',
      'globalThis.fetch("/g", { method: "POST" });',
      'nodeFetch("/n");',
      'undiciFetch("/u");',
      'required("/r");',
      'other("/o");',
      'fetch(new Request("/req", { method: "PUT" }));',
      'fetch(new Request("/req2", { method: "PUT" }), { method: "DELETE" });',
      "fetch(new Request(...parts));",
      "fetch(...args);",
      "fetch();",
      'notTraced("/x");',
    ]);
    await put("src/b.ts", [
      "function fetch(path: string) { return path; }",
      'export function local() { return fetch("/not-a-request"); }',
      "const window = { fetch: (p: string) => p };",
      'export function shadowed() { return window.fetch("/nope"); }',
    ]);
    expect(summary(await collect())).toEqual([
      'src/a.ts:6:8 fetch GET "/w" base=- []',
      'src/a.ts:7:12 fetch POST "/g" base=- []',
      'src/a.ts:8:1 fetch GET "/n" base=- []',
      'src/a.ts:9:1 fetch GET "/u" base=- []',
      'src/a.ts:10:1 fetch GET "/r" base=- []',
      'src/a.ts:12:1 fetch PUT "/req" base=- []',
      'src/a.ts:13:1 fetch DELETE "/req2" base=- []',
      "src/a.ts:14:1 fetch ? ? base=- []",
      "src/a.ts:15:1 fetch ? ? base=- []",
      "src/a.ts:16:1 fetch GET ? base=- []",
    ]);
  });
});

describe("collectHttpCalls: axios", () => {
  it("collects shorthand, config, and request forms on the default export", async () => {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { axios: "1" } }));
    await put("src/a.ts", [
      'import axios from "axios";',
      "export async function all(id: string, cfg: object) {",
      '  await axios.get("/users");',
      "  await axios.post(`/users/${id}`, { name: 'x' });",
      '  await axios.delete("/users/1", { baseURL: "/v2" });',
      '  await axios.patchForm("/form", {});',
      '  await axios({ url: "/cfg", method: "put" });',
      '  await axios("/plain");',
      '  await axios("/plain-post", { method: "post" });',
      '  await axios.request({ url: "/req", method: "delete", baseURL: "https://api.test" });',
      "  await axios.request(cfg);",
      "  await axios(cfg);",
      '  await axios.get("/opaque", cfg);',
      '  await axios.post("/spread", {}, { ...cfg });',
      "  await axios.get(...[]);",
      '  axios.getUri({ url: "/not-a-request" });',
      "}",
    ]);
    expect(summary(await collect())).toEqual([
      'src/a.ts:3:15 axios GET "/users" base=- [symbol:web/src/a.ts#all]',
      "src/a.ts:4:15 axios POST `/users/${id}` base=- [symbol:web/src/a.ts#all]",
      'src/a.ts:5:15 axios DELETE "/users/1" base="/v2" [symbol:web/src/a.ts#all]',
      'src/a.ts:6:15 axios PATCH "/form" base=- [symbol:web/src/a.ts#all]',
      'src/a.ts:7:9 axios PUT "/cfg" base=- [symbol:web/src/a.ts#all]',
      'src/a.ts:8:9 axios GET "/plain" base=- [symbol:web/src/a.ts#all]',
      'src/a.ts:9:9 axios POST "/plain-post" base=- [symbol:web/src/a.ts#all]',
      'src/a.ts:10:15 axios DELETE "/req" base="https://api.test" [symbol:web/src/a.ts#all]',
      "src/a.ts:11:15 axios ? ? base=? [symbol:web/src/a.ts#all]",
      "src/a.ts:12:9 axios ? ? base=? [symbol:web/src/a.ts#all]",
      'src/a.ts:13:15 axios GET "/opaque" base=- [symbol:web/src/a.ts#all]',
      'src/a.ts:14:15 axios POST "/spread" base=- [symbol:web/src/a.ts#all]',
      "src/a.ts:15:15 axios GET ? base=- [symbol:web/src/a.ts#all]",
    ]);
  });

  it("follows instances from create() through imports, nesting, and factories", async () => {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { axios: "1" } }));
    await put("src/http.ts", [
      'import axios from "axios";',
      "const API = process.env.NEXT_PUBLIC_API_URL;",
      "export const api = axios.create({ baseURL: API, timeout: 5000 });",
      'export const v2 = api.create({ baseURL: "/v2" });',
      "export const child = api.create({ timeout: 1 });",
      'const shared = { baseURL: "/shared" };',
      "export default axios.create(shared);",
      "export function makeClient() { return axios.create({ ...shared }); }",
      "export const lazy = globalThis.x ?? axios.create({ baseURL: '/lazy' });",
    ]);
    await put("src/use.ts", [
      'import client, { api, v2, child, makeClient, lazy } from "./http";',
      'import type { AxiosInstance } from "axios";',
      "export async function run(given: AxiosInstance) {",
      '  await api.get("/orders");',
      '  await v2.post("/orders", {});',
      '  await child.get("/child");',
      '  await client.put("/default", {});',
      '  await makeClient().get("/made");',
      '  await lazy.head("/lazy");',
      '  await given.options("/given");',
      '  await api.get("/override", { baseURL: "/other" });',
      "}",
    ]);
    expect(summary(await collect())).toEqual([
      'src/use.ts:4:13 axios GET "/orders" base=API [symbol:web/src/use.ts#run]',
      'src/use.ts:5:12 axios POST "/orders" base="/v2" [symbol:web/src/use.ts#run]',
      'src/use.ts:6:15 axios GET "/child" base=API [symbol:web/src/use.ts#run]',
      'src/use.ts:7:16 axios PUT "/default" base="/shared" [symbol:web/src/use.ts#run]',
      'src/use.ts:8:22 axios GET "/made" base=? [symbol:web/src/use.ts#run]',
      "src/use.ts:9:14 axios HEAD \"/lazy\" base='/lazy' [symbol:web/src/use.ts#run]",
      'src/use.ts:10:15 axios OPTIONS "/given" base=? [symbol:web/src/use.ts#run]',
      'src/use.ts:11:13 axios GET "/override" base="/other" [symbol:web/src/use.ts#run]',
    ]);
  });

  it("follows class properties, object properties, operators, and arrow factories", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/a.ts", [
      'import axios, { type AxiosInstance } from "axios";',
      'const base = axios.create({ baseURL: "/base" });',
      "const make = () => axios.create({ baseURL: '/made' });",
      "const notAxios = () => new Map();",
      "const clients = { base, other: axios.create({ baseURL: '/other' }), make };",
      "let assigned;",
      "const picked = globalThis.flag ? base : axios;",
      "const both = globalThis.flag && base;",
      "let loop: any = loop;",
      "class Service {",
      "  private http = axios.create({ baseURL: '/svc' });",
      "  constructor(private readonly typed: AxiosInstance) {}",
      "  run() {",
      '    this.http.get("/1");',
      '    this.typed.get("/2");',
      '    clients.base.get("/3");',
      '    clients.other.get("/4");',
      '    clients.make().get("/5");',
      '    make().get("/6");',
      '    notAxios().get("/no");',
      '    (assigned = axios.create({ baseURL: "/assigned" })).get("/7");',
      '    picked.get("/8");',
      '    both.get("/9");',
      '    loop.get("/no");',
      "  }",
      "}",
    ]);
    expect(summary(await collect())).toEqual([
      "src/a.ts:14:15 axios GET \"/1\" base='/svc' [symbol:web/src/a.ts#Service.run]",
      'src/a.ts:15:16 axios GET "/2" base=? [symbol:web/src/a.ts#Service.run]',
      'src/a.ts:16:18 axios GET "/3" base="/base" [symbol:web/src/a.ts#Service.run]',
      "src/a.ts:17:19 axios GET \"/4\" base='/other' [symbol:web/src/a.ts#Service.run]",
      "src/a.ts:18:20 axios GET \"/5\" base='/made' [symbol:web/src/a.ts#Service.run]",
      "src/a.ts:19:12 axios GET \"/6\" base='/made' [symbol:web/src/a.ts#Service.run]",
      'src/a.ts:21:57 axios GET "/7" base="/assigned" [symbol:web/src/a.ts#Service.run]',
      'src/a.ts:22:12 axios GET "/8" base="/base" [symbol:web/src/a.ts#Service.run]',
      'src/a.ts:23:10 axios GET "/9" base="/base" [symbol:web/src/a.ts#Service.run]',
    ]);
  });

  it("recognizes CommonJS, namespace, and import-equals forms", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/cjs.js", [
      'const axios = require("axios");',
      'const ax2 = require("axios").default;',
      "const inst = axios.create({ baseURL: '/cjs' });",
      "module.exports = inst;",
      'axios.get("/a");',
      'ax2.post("/b");',
    ]);
    await put("src/use.js", ['const inst = require("./cjs");', 'inst.delete("/c");']);
    await put("src/ns.ts", [
      'import * as axios from "axios";',
      'import ax = require("axios");',
      'axios.get("/d");',
      'axios.default.get("/e");',
      'ax.put("/f");',
    ]);
    expect(summary(await collect())).toEqual([
      'src/cjs.js:5:7 axios GET "/a" base=- []',
      'src/cjs.js:6:5 axios POST "/b" base=- []',
      'src/ns.ts:3:7 axios GET "/d" base=- []',
      'src/ns.ts:4:15 axios GET "/e" base=- []',
      'src/ns.ts:5:4 axios PUT "/f" base=- []',
      "src/use.js:2:6 axios DELETE \"/c\" base='/cjs' []",
    ]);
  });

  it("follows an instance exported from another workspace package", async () => {
    await put(
      "package.json",
      JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "packages/*"] }),
    );
    await put(
      "packages/client/package.json",
      JSON.stringify({ name: "@acme/client", main: "src/index.ts", dependencies: { axios: "1" } }),
    );
    await put("packages/client/src/index.ts", [
      'import axios from "axios";',
      'export const api = axios.create({ baseURL: "/api" });',
    ]);
    await put(
      "apps/web/package.json",
      JSON.stringify({ name: "web", dependencies: { "@acme/client": "workspace:*" } }),
    );
    await put("apps/web/src/page.ts", [
      'import { api } from "@acme/client";',
      'import * as c from "@acme/client";',
      'export const one = () => api.get("/users");',
      'export const two = () => c.api.post("/users");',
    ]);
    const sites = await collect();
    expect(summary(sites)).toEqual([
      'apps/web/src/page.ts:3:30 axios GET "/users" base="/api" [symbol:web/src/page.ts#one]',
      'apps/web/src/page.ts:4:32 axios POST "/users" base="/api" [symbol:web/src/page.ts#two]',
    ]);
    // The base URL lives in the client package, so it carries that package's program.
    expect(sites.map((s) => s.baseURL && s.baseURL.sp.service.key)).toEqual(["client", "client"]);
  });

  it("ignores look-alike methods on non-axios values", async () => {
    await put("package.json", JSON.stringify({ name: "api", dependencies: { express: "4" } }));
    await put("src/server.ts", [
      'import express from "express";',
      "const app = express();",
      "const map = new Map<string, number>();",
      'app.get("/health", (req, res) => { res.json(map.get("x")); });',
      "const params = new URLSearchParams();",
      'params.delete("q");',
      "export default app;",
    ]);
    expect(await collect()).toEqual([]);
  });
});

describe("collectHttpCalls: owners", () => {
  it("attributes calls to inline Express routes, the innermost symbol, or nothing at top level", async () => {
    await put("package.json", JSON.stringify({ name: "api", dependencies: { express: "4" } }));
    await put("src/server.ts", [
      'import express from "express";',
      "const app = express();",
      'app.get("/proxy", async (req, res) => { res.json(await fetch("/upstream")); });',
      "class Client {",
      '  load() { return fetch("/in-method"); }',
      "}",
      'fetch("/top");',
      "export default app;",
    ]);
    expect(summary(await collect())).toEqual([
      'src/server.ts:3:56 fetch GET "/upstream" base=- [route:api/GET /proxy]',
      'src/server.ts:5:19 fetch GET "/in-method" base=- [symbol:api/src/server.ts#Client.load]',
      'src/server.ts:7:1 fetch GET "/top" base=- []',
    ]);
  });
});
