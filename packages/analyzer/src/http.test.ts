import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { collectHttpCalls, type HttpCallSite, type ProgramExpression } from "./http.js";
import { buildInventory } from "./inventory.js";
import { bindOwners } from "./owners.js";
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

/** A collected site with its owners bound to Express's inline handlers, as `analyze` does. */
type BoundSite = Omit<HttpCallSite, "owners"> & { owners: string[] };

/** Run the collector over the temp repo and bind owners like `analyze` does. */
async function collect(): Promise<BoundSite[]> {
  const inventory = await buildInventory(dir);
  const workspace = await detectWorkspace(dir, inventory.files);
  const programs = buildServicePrograms(dir, workspace, inventory);
  const resolver = createSymbolResolver(programs, workspace);
  const express = buildExpressRoutes(programs, resolver);
  return collectHttpCalls(programs, resolver).map((site) => ({
    ...site,
    owners: bindOwners(site.owners, express.inlineHandlers),
  }));
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
function summary(sites: readonly BoundSite[]): string[] {
  return sites.map(
    (s) =>
      `${s.file}:${s.site.line}:${s.site.column} ${s.client} ${s.method ?? "?"} ${text(s.url)}` +
      ` base=${text(s.baseURL)} [${s.owners.join(",")}]` +
      (s.confidence === "exact" ? "" : ` (${s.confidence})`),
  );
}

describe("collectHttpCalls: site", () => {
  it("anchors a site at the call expression's start, not the method name (EVALUATION.md §1)", async () => {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { axios: "1.0.0" } }));
    await put("src/api.ts", [
      'import axios from "axios";',
      "export async function load() {",
      "  await axios",
      '    .get("/a");',
      '  await window.fetch("/b");',
      '  await (axios).post("/c", {});',
      "}",
    ]);
    expect(summary(await collect()).map((s) => s.split(" base=")[0])).toEqual([
      'src/api.ts:3:9 axios GET "/a"',
      'src/api.ts:5:9 fetch GET "/b"',
      'src/api.ts:6:9 axios POST "/c"',
    ]);
  });
});

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

  it("doesn't read a method from a config that is reassigned or mutated (M2 review)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      "export async function load(flag: boolean) {",
      '  const fixed = { method: "PUT" };',
      '  const opts = { method: "GET" };',
      '  if (flag) opts.method = "POST";',
      '  let loose = { method: "GET" };',
      '  const merged = { method: "GET" };',
      '  Object.assign(merged, { method: "DELETE" });',
      '  await fetch("/a", fixed);',
      '  await fetch("/b", opts);',
      '  await fetch("/c", loose);',
      '  await fetch("/d", merged);',
      "  loose = { method: 'PATCH' };",
      "}",
    ]);
    expect(summary(await collect()).map((s) => s.split(" base=")[0])).toEqual([
      'src/api.ts:8:9 fetch PUT "/a"',
      'src/api.ts:9:9 fetch ? "/b"',
      'src/api.ts:10:9 fetch ? "/c"',
      'src/api.ts:11:9 fetch ? "/d"',
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
      'src/a.ts:6:1 fetch GET "/w" base=- []',
      'src/a.ts:7:1 fetch POST "/g" base=- []',
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

  it("keeps window.fetch and fetch global when a JS file assigns their properties (M5C.7e2)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/setup.js", ['window.title = "x";', "fetch.polyfilled = true;"]);
    await put("src/a.ts", ['window.fetch("/w");', 'fetch("/f");']);
    expect(summary(await collect())).toEqual([
      'src/a.ts:1:1 fetch GET "/w" base=- []',
      'src/a.ts:2:1 fetch GET "/f" base=- []',
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
      'src/a.ts:3:9 axios GET "/users" base=- [symbol:web/src/a.ts#all]',
      "src/a.ts:4:9 axios POST `/users/${id}` base=- [symbol:web/src/a.ts#all]",
      'src/a.ts:5:9 axios DELETE "/users/1" base="/v2" [symbol:web/src/a.ts#all]',
      'src/a.ts:6:9 axios PATCH "/form" base=- [symbol:web/src/a.ts#all]',
      'src/a.ts:7:9 axios PUT "/cfg" base=- [symbol:web/src/a.ts#all]',
      'src/a.ts:8:9 axios GET "/plain" base=- [symbol:web/src/a.ts#all]',
      'src/a.ts:9:9 axios POST "/plain-post" base=- [symbol:web/src/a.ts#all]',
      'src/a.ts:10:9 axios DELETE "/req" base="https://api.test" [symbol:web/src/a.ts#all]',
      "src/a.ts:11:9 axios ? ? base=? [symbol:web/src/a.ts#all]",
      "src/a.ts:12:9 axios ? ? base=? [symbol:web/src/a.ts#all]",
      'src/a.ts:13:9 axios GET "/opaque" base=- [symbol:web/src/a.ts#all]',
      'src/a.ts:14:9 axios POST "/spread" base=- [symbol:web/src/a.ts#all]',
      "src/a.ts:15:9 axios GET ? base=- [symbol:web/src/a.ts#all]",
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
      'src/use.ts:4:9 axios GET "/orders" base=API [symbol:web/src/use.ts#run]',
      'src/use.ts:5:9 axios POST "/orders" base="/v2" [symbol:web/src/use.ts#run]',
      'src/use.ts:6:9 axios GET "/child" base=API [symbol:web/src/use.ts#run]',
      'src/use.ts:7:9 axios PUT "/default" base="/shared" [symbol:web/src/use.ts#run]',
      'src/use.ts:8:9 axios GET "/made" base=? [symbol:web/src/use.ts#run]',
      "src/use.ts:9:9 axios HEAD \"/lazy\" base='/lazy' [symbol:web/src/use.ts#run]",
      'src/use.ts:10:9 axios OPTIONS "/given" base=? [symbol:web/src/use.ts#run]',
      'src/use.ts:11:9 axios GET "/override" base="/other" [symbol:web/src/use.ts#run]',
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
      "src/a.ts:14:5 axios GET \"/1\" base='/svc' [symbol:web/src/a.ts#Service.run]",
      'src/a.ts:15:5 axios GET "/2" base=? [symbol:web/src/a.ts#Service.run]',
      'src/a.ts:16:5 axios GET "/3" base="/base" [symbol:web/src/a.ts#Service.run]',
      "src/a.ts:17:5 axios GET \"/4\" base='/other' [symbol:web/src/a.ts#Service.run]",
      "src/a.ts:18:5 axios GET \"/5\" base='/made' [symbol:web/src/a.ts#Service.run]",
      "src/a.ts:19:5 axios GET \"/6\" base='/made' [symbol:web/src/a.ts#Service.run]",
      'src/a.ts:21:5 axios GET "/7" base="/assigned" [symbol:web/src/a.ts#Service.run]',
      'src/a.ts:22:5 axios GET "/8" base="/base" [symbol:web/src/a.ts#Service.run]',
      'src/a.ts:23:5 axios GET "/9" base="/base" [symbol:web/src/a.ts#Service.run]',
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
      'src/cjs.js:5:1 axios GET "/a" base=- []',
      'src/cjs.js:6:1 axios POST "/b" base=- []',
      'src/ns.ts:3:1 axios GET "/d" base=- []',
      'src/ns.ts:4:1 axios GET "/e" base=- []',
      'src/ns.ts:5:1 axios PUT "/f" base=- []',
      "src/use.js:2:1 axios DELETE \"/c\" base='/cjs' []",
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
      'apps/web/src/page.ts:3:26 axios GET "/users" base="/api" [symbol:web/src/page.ts#one]',
      'apps/web/src/page.ts:4:26 axios POST "/users" base="/api" [symbol:web/src/page.ts#two]',
    ]);
    // The base URL lives in the client package, so it carries that package's program.
    expect(sites.map((s) => s.baseURL && s.baseURL.sp.service.key)).toEqual(["client", "client"]);
  });

  it("reads `defaults.baseURL` assigned once at module top level, else unknown (M5A.3d)", async () => {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { axios: "1" } }));
    await put("src/setup.ts", [
      'import axios from "axios";',
      "const API = process.env.NEXT_PUBLIC_API_URL;",
      "axios.defaults.baseURL = `${API}/v1`;",
      "axios.defaults.withCredentials = true;",
      'export const api = axios.create({ baseURL: "/old" });',
      'api.defaults.baseURL = "/api";',
      "export const keyed = axios.create();",
      'keyed.defaults["baseURL"] = "/keyed";',
      "export const twice = axios.create();",
      'twice.defaults.baseURL = "/a";',
      'twice.defaults.baseURL = "/b";',
      "export const later = axios.create();",
      "export function setBase(url: string) { later.defaults.baseURL = url; }",
      'export const plus = axios.create({ baseURL: "/p" });',
      'plus.defaults.baseURL += "/x";',
      'export const swapped = axios.create({ baseURL: "/s" });',
      "swapped.defaults = { ...swapped.defaults };",
      "export const make = () => axios.create();",
      "const made = make();",
      'made.defaults.baseURL = "/made";',
      "export const child = axios.create();",
      'export const own = axios.create({ baseURL: "/own" });',
      'export const v2 = api.create({ baseURL: "/v2" });',
      "export const apiChild = api.create();",
    ]);
    await put("src/use.ts", [
      'import axios from "axios";',
      'import { api, keyed, twice, later, plus, swapped, make, child, own, v2, apiChild } from "./setup";',
      "export async function run() {",
      '  await axios.get("/root");',
      '  await axios.get("/call", { baseURL: "/call" });',
      '  await api.get("/api");',
      '  await keyed.get("/keyed");',
      '  await twice.get("/twice");',
      '  await later.get("/later");',
      '  await plus.get("/plus");',
      '  await swapped.get("/swapped");',
      '  await make().get("/made");',
      '  await child.get("/child");',
      '  await own.get("/own");',
      '  await v2.get("/v2");',
      '  await apiChild.get("/api-child");',
      "}",
    ]);
    const owner = "[symbol:web/src/use.ts#run]";
    expect(summary(await collect())).toEqual([
      `src/use.ts:4:9 axios GET "/root" base=\`\${API}/v1\` ${owner}`,
      `src/use.ts:5:9 axios GET "/call" base="/call" ${owner}`,
      `src/use.ts:6:9 axios GET "/api" base="/api" ${owner}`,
      `src/use.ts:7:9 axios GET "/keyed" base="/keyed" ${owner}`,
      // Assigned twice, inside a function, with `+=`, replaced whole: unknown, never guessed.
      `src/use.ts:8:9 axios GET "/twice" base=? ${owner}`,
      `src/use.ts:9:9 axios GET "/later" base=? ${owner}`,
      `src/use.ts:10:9 axios GET "/plus" base=? ${owner}`,
      `src/use.ts:11:9 axios GET "/swapped" base=? ${owner}`,
      // Every call of a factory makes a new instance: one's assignment says nothing of the next.
      `src/use.ts:12:9 axios GET "/made" base=? ${owner}`,
      // `create()` copies the defaults when it runs, before or after the assignment.
      `src/use.ts:13:9 axios GET "/child" base=? ${owner}`,
      `src/use.ts:14:9 axios GET "/own" base="/own" ${owner}`,
      `src/use.ts:15:9 axios GET "/v2" base="/v2" ${owner}`,
      `src/use.ts:16:9 axios GET "/api-child" base=? ${owner}`,
    ]);
  });

  it("applies the default export's `defaults.baseURL` only within its own service (M5A.3d)", async () => {
    await put(
      "package.json",
      JSON.stringify({ name: "root", private: true, workspaces: ["apps/*"] }),
    );
    await put("apps/web/package.json", JSON.stringify({ name: "web" }));
    await put("apps/web/src/a.ts", [
      'import axios from "axios";',
      'axios.defaults.baseURL = "/api";',
      'export const one = () => axios.get("/users");',
    ]);
    await put("apps/worker/package.json", JSON.stringify({ name: "worker" }));
    await put("apps/worker/src/b.ts", [
      'import axios from "axios";',
      'export const two = () => axios.get("https://example.test/hook");',
    ]);
    expect(summary(await collect())).toEqual([
      'apps/web/src/a.ts:3:26 axios GET "/users" base="/api" [symbol:web/src/a.ts#one]',
      'apps/worker/src/b.ts:2:26 axios GET "https://example.test/hook" base=- [symbol:worker/src/b.ts#two]',
    ]);
  });

  it("applies a `defaults.baseURL` write only to files that import its module (M5A.5d)", async () => {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { axios: "1" } }));
    await put("src/config.ts", ['import axios from "axios";', 'axios.defaults.baseURL = "/api";']);
    await put("src/http.ts", ['import "./config";', "export const ready = true;"]);
    await put("src/client.ts", [
      'import axios from "axios";',
      "export const api = axios.create();",
    ]);
    await put("src/users.ts", [
      'import axios from "axios";',
      'import { api } from "./client";',
      'export const list = () => axios.get("/users");',
      'export const one = () => api.get("/users/1");',
    ]);
    await put("src/pages.ts", [
      'import axios from "axios";',
      'import "./http";',
      'export const pages = () => axios.get("/pages");',
    ]);
    // Test and e2e setup files rebase the client for the tests only.
    await put("test/setup.ts", [
      'import axios from "axios";',
      'import { api } from "../src/client";',
      'axios.defaults.baseURL = "http://localhost:9999";',
      'api.defaults.baseURL = "http://localhost:9999/api";',
    ]);
    await put("test/pages.test.ts", [
      'import axios from "axios";',
      'import "./setup";',
      'import "../src/pages";',
      'export const probe = () => axios.get("/probe");',
    ]);
    expect(summary(await collect())).toEqual([
      // Reaches `config.ts` through `http.ts`, and not the test setup.
      'src/pages.ts:3:28 axios GET "/pages" base="/api" [symbol:web/src/pages.ts#pages]',
      // Reaches neither write: the instance's `create()` copies no assigned defaults either.
      'src/users.ts:3:27 axios GET "/users" base=- [symbol:web/src/users.ts#list]',
      'src/users.ts:4:26 axios GET "/users/1" base=- [symbol:web/src/users.ts#one]',
      // Reaches both writes to the default export: unknown, never guessed.
      'test/pages.test.ts:4:28 axios GET "/probe" base=? [symbol:web/test/pages.test.ts#probe]',
    ]);
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

  it("traces each factory once, however many calls return it (M2 review)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    // Each factory returns ten calls of the one before: 10^7 traces without a cache.
    const lines = ['import axios from "axios";', "declare const c: number;"];
    lines.push('function f0() { return axios.create({ baseURL: "/api" }); }');
    for (let i = 1; i <= 7; i++) {
      const returns = Array.from({ length: 10 }, (_, k) => `if (c === ${k}) return f${i - 1}();`);
      lines.push(`function f${i}() { ${returns.join(" ")} return f${i - 1}(); }`);
    }
    lines.push('export const go = () => f7().get("/x");');
    await put("src/api.ts", lines);
    const started = performance.now();
    expect(summary(await collect())).toEqual([
      'src/api.ts:11:25 axios GET "/x" base="/api" [symbol:web/src/api.ts#go]',
    ]);
    expect(performance.now() - started).toBeLessThan(20_000);
  });
});

describe("collectHttpCalls: ofetch (M5C.3c)", () => {
  it("collects calls of ofetch, $fetch, and create() instances, with their base and method", async () => {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { ofetch: "1" } }));
    await put("src/http.ts", [
      'import { ofetch } from "ofetch";',
      'export const api = ofetch.create({ baseURL: "/api" });',
      'export const v2 = api.create({ baseURL: "/api/v2" });',
      'export const poster = api.create({ method: "POST" });',
      'export function makeClient() { return ofetch.create({ baseURL: "/made" }); }',
    ]);
    await put("src/use.ts", [
      'import { $fetch, ofetch as http } from "ofetch";',
      'import * as of from "ofetch";',
      'import { api, v2, poster, makeClient } from "./http";',
      "export async function run(id: string, opts: object, m: string) {",
      '  await http("/plain");',
      '  await $fetch("/users", { method: "post", baseURL: "/api" });',
      "  await api(`/users/${id}`);",
      '  await api.raw("/users", { method: "DELETE" });',
      '  await v2("/stats");',
      '  await poster("/login");',
      '  await poster("/check", { method: "GET" });',
      '  await poster("/opaque", opts);',
      '  await api("/opaque", opts);',
      '  await api("/m", { method: m });',
      '  await of.$fetch("/ns");',
      '  await makeClient()("/made");',
      '  await api.native("/native", { method: "PUT" });',
      '  await api("/x", { ...opts, method: "PATCH" });',
      "}",
    ]);
    const owner = "[symbol:web/src/use.ts#run]";
    expect(summary(await collect())).toEqual([
      `src/use.ts:5:9 ofetch GET "/plain" base=- ${owner}`,
      `src/use.ts:6:9 ofetch POST "/users" base="/api" ${owner}`,
      `src/use.ts:7:9 ofetch GET \`/users/\${id}\` base="/api" ${owner}`,
      `src/use.ts:8:9 ofetch DELETE "/users" base="/api" ${owner}`,
      `src/use.ts:9:9 ofetch GET "/stats" base="/api/v2" ${owner}`,
      `src/use.ts:10:9 ofetch POST "/login" base="/api" ${owner}`,
      `src/use.ts:11:9 ofetch GET "/check" base="/api" ${owner}`,
      `src/use.ts:12:9 ofetch ? "/opaque" base="/api" ${owner}`,
      `src/use.ts:13:9 ofetch ? "/opaque" base="/api" ${owner}`,
      `src/use.ts:14:9 ofetch ? "/m" base="/api" ${owner}`,
      `src/use.ts:15:9 ofetch GET "/ns" base=- ${owner}`,
      `src/use.ts:16:9 ofetch GET "/made" base="/made" ${owner}`,
      `src/use.ts:17:9 ofetch PUT "/native" base=- ${owner}`,
      `src/use.ts:18:9 ofetch PATCH "/x" base="/api" ${owner}`,
    ]);
    const sites = await collect();
    // Wrapper inlining re-reads an unseen options' method from the caller (M2.3), but not
    // under an instance whose own default `method` would apply instead.
    expect(sites[7]?.methodSource).toBeUndefined();
    expect(sites[8]?.methodSource?.kind).toBe("config");
    expect(sites.map((s) => s.baseJoin ?? "-")).toEqual([
      ...Array<string>(12).fill("withBase"),
      "-",
      "withBase",
    ]);
  });

  it("ignores look-alikes: local or other modules' ofetch, Nuxt's global $fetch, create() itself", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/local.ts", ["export function ofetch(p: string) { return p; }"]);
    await put("src/a.ts", [
      'import { ofetch as other } from "./local";',
      'import { ofetch as mine } from "my-ofetch";',
      'import { ofetch, createFetch } from "ofetch";',
      "declare const $fetch: (p: string) => Promise<unknown>;",
      'other("/local");',
      'mine("/mine");',
      '$fetch("/nuxt-global");',
      'ofetch.create({ baseURL: "/api" });',
      'createFetch()("/created");',
      "const o = { raw: (p: string) => p, native: (p: string) => p };",
      'o.raw("/o");',
      'o.native("/o");',
    ]);
    expect(summary(await collect())).toEqual([]);
  });
});

describe("collectHttpCalls: ky (M5C.3e)", () => {
  it("collects ky calls, shorthands, and extend/create instances, with their base and method", async () => {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { ky: "1" } }));
    await put("src/http.ts", [
      'import ky from "ky";',
      'export const api = ky.create({ prefixUrl: "/api" });',
      'export const v2 = api.extend({ prefixUrl: "/api/v2" });',
      'export const poster = api.extend({ method: "post" });',
      'export const fresh = api.create({ prefix: "/fresh" });',
      'export const based = ky.extend({ baseUrl: "https://h.com/v1/" });',
      'export const viaFn = api.extend((parent) => ({ ...parent, prefixUrl: "/fn" }));',
      'export const both = based.extend({ prefix: "/p" });',
    ]);
    await put("src/use.ts", [
      'import ky from "ky";',
      'import * as k from "ky";',
      'import { api, v2, poster, fresh, based, viaFn, both } from "./http";',
      "export async function run(id: string, opts: object) {",
      '  await ky("/plain");',
      '  await ky.post("/users", { json: {} }).json();',
      "  await api.get(`users/${id}`);",
      '  await api("users", { method: "DELETE" });',
      '  await v2.get("stats");',
      '  await poster("login");',
      '  await poster.get("check", { method: "POST" });',
      '  await poster("opaque", opts);',
      '  await api("opaque", opts);',
      '  await fresh.put("x");',
      '  await based.patch("users");',
      '  await viaFn.head("fn");',
      '  await both("p");',
      '  await k.default.delete("/ns");',
      '  await ky("/own", { prefixUrl: "/api", method: "put" });',
      "}",
    ]);
    const owner = "[symbol:web/src/use.ts#run]";
    const sites = await collect();
    expect(summary(sites)).toEqual([
      `src/use.ts:5:9 ky GET "/plain" base=- ${owner}`,
      `src/use.ts:6:9 ky POST "/users" base=- ${owner}`,
      `src/use.ts:7:9 ky GET \`users/\${id}\` base="/api" ${owner}`,
      `src/use.ts:8:9 ky DELETE "users" base="/api" ${owner}`,
      `src/use.ts:9:9 ky GET "stats" base="/api/v2" ${owner}`,
      `src/use.ts:10:9 ky POST "login" base="/api" ${owner}`,
      `src/use.ts:11:9 ky GET "check" base="/api" ${owner}`,
      `src/use.ts:12:9 ky ? "opaque" base="/api" ${owner}`,
      `src/use.ts:13:9 ky ? "opaque" base="/api" ${owner}`,
      `src/use.ts:14:9 ky PUT "x" base="/fresh" ${owner}`,
      `src/use.ts:15:9 ky PATCH "users" base="https://h.com/v1/" ${owner}`,
      `src/use.ts:16:9 ky HEAD "fn" base=? ${owner}`,
      `src/use.ts:17:9 ky GET ? base=- ${owner}`,
      `src/use.ts:18:9 ky DELETE "/ns" base=- ${owner}`,
      `src/use.ts:19:9 ky PUT "/own" base="/api" ${owner}`,
    ]);
    // Wrapper inlining re-reads an unseen options' method from the caller (M2.3), but not
    // under an instance whose own default `method` would apply instead.
    expect(sites[7]?.methodSource).toBeUndefined();
    expect(sites[8]?.methodSource?.kind).toBe("config");
    expect(sites.map((s) => s.baseJoin ?? "-")).toEqual([
      "-",
      "-",
      ...Array<string>(7).fill("kyPrefixUrl"),
      "kyPrefix",
      "kyBaseUrl",
      "-",
      "-",
      "-",
      "kyPrefixUrl",
    ]);
    expect(sites[12]?.urlDetail).toBe(
      "more than one of ky's prefixUrl, prefix, and baseUrl is set, which isn't followed",
    );
  });

  it("ignores look-alikes: local or other modules' ky, a named import, extend() itself", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/local.ts", ["export default function ky(p: string) { return p; }"]);
    await put("src/a.ts", [
      'import other from "./local";',
      'import mine from "my-ky";',
      'import ky, { HTTPError } from "ky";',
      'other("/local");',
      'mine.get("/mine");',
      'new HTTPError("/x");',
      'ky.extend({ prefixUrl: "/api" });',
      'ky.stop("/stop");',
      "const o = { get: (p: string) => p };",
      'o.get("/o");',
    ]);
    expect(summary(await collect())).toEqual([]);
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
