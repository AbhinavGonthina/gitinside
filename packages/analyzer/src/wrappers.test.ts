import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { collectHttpCalls } from "./http.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms, type ServiceProgram } from "./program.js";
import { createUrlNormalizer } from "./url.js";
import {
  bindWrappers,
  collectHttpFacts,
  inlineWrappers,
  type HttpFacts,
  type HttpRequest,
} from "./wrappers.js";
import { detectWorkspace } from "./workspace.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-wrappers-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string | string[]): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), Array.isArray(content) ? content.join("\n") + "\n" : content);
}

/** Collect, then inline wrappers over the temp repo, as `analyze` will. */
async function requests(): Promise<HttpRequest[]> {
  const inventory = await buildInventory(dir);
  const workspace = await detectWorkspace(dir, inventory.files);
  const programs = buildServicePrograms(dir, workspace, inventory);
  const resolver = createSymbolResolver(programs, workspace);
  const express = buildExpressRoutes(programs, resolver);
  const sites = collectHttpCalls(programs, resolver);
  return inlineWrappers(
    sites,
    programs,
    resolver,
    createUrlNormalizer(resolver),
    express.inlineHandlers,
  );
}

/** The per-service facts of the temp repo, with the programs and resolver behind them. */
async function facts() {
  const inventory = await buildInventory(dir);
  const workspace = await detectWorkspace(dir, inventory.files);
  const programs = buildServicePrograms(dir, workspace, inventory);
  const resolver = createSymbolResolver(programs, workspace);
  const express = buildExpressRoutes(programs, resolver);
  const sites = collectHttpCalls(programs, resolver);
  const normalizer = createUrlNormalizer(resolver);
  return {
    programs,
    resolver,
    inlineHandlers: express.inlineHandlers,
    facts: collectHttpFacts(sites, programs, resolver, normalizer),
  };
}

/** `file:line METHOD url`, plus `<- wrapper` when inlined. */
const brief = (r: Omit<HttpRequest, "owners">): string =>
  `${r.file}:${r.site.line} ${r.method ?? "?"} ${r.url.resolved ? r.url.text : r.url.reason}` +
  (r.via ? ` <- ${r.via.slice(r.via.lastIndexOf("#") + 1)}` : "");

/** A workspace with an SDK of wrappers and a web app calling one of them. */
async function sdkAndWeb(importPath: string): Promise<void> {
  await put("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  await put("packages/sdk/package.json", JSON.stringify({ name: "@acme/sdk" }));
  await put("packages/sdk/src/index.ts", [
    "export function getJson(path: string) {",
    "  return fetch(`/api${path}`);",
    "}",
    "export function unused(path: string) {",
    "  return fetch(`/other${path}`);",
    "}",
    'export const ping = () => fetch("/api/ping");',
  ]);
  await put(
    "packages/web/package.json",
    JSON.stringify({ name: "web", dependencies: { "@acme/sdk": "*" } }),
  );
  await put("packages/web/src/page.ts", [
    `import { getJson } from "${importPath}";`,
    'export const load = () => getJson("/teams");',
  ]);
}

/**
 * `file:line METHOD url [owners]`, then `<- file:line` of the fetch/axios call when inlined,
 * and the confidence when it isn't `exact`.
 */
async function summary(): Promise<string[]> {
  return (await requests()).map((r) => {
    const url = r.url.resolved ? r.url.text : `${r.url.reason}: ${r.url.detail}`;
    const owners = r.owners.map((o) => o.slice(o.lastIndexOf("#") + 1)).join(",");
    return (
      `${r.file}:${r.site.line} ${r.method ?? "?"} ${url} [${owners}]` +
      (r.via ? ` <- ${r.call.file}:${r.call.site.line}` : "") +
      (r.confidence === "exact" ? "" : ` (${r.confidence})`)
    );
  });
}

describe("inlineWrappers", () => {
  it("inlines each call to a one-level wrapper with the caller's arguments", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      'const BASE = "/api";',
      "export function get(path: string) {",
      "  return fetch(BASE + path);",
      "}",
      "export const post = (path: string, body: unknown) =>",
      '  fetch(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body) });',
      "export default function del(path: string) {",
      '  return fetch(BASE + path, { method: "DELETE" });',
      "}",
    ]);
    await put("src/users.ts", [
      'import del, { get, post as send } from "./http";',
      'import * as http from "./http";',
      "export async function loadUser(id: string) {",
      "  return get(`/users/${id}`);",
      "}",
      "export async function save() {",
      '  await send("/users", { name: "a" });',
      '  await http.get("/me");',
      '  await del("/users/1");',
      "}",
    ]);
    expect(await summary()).toEqual([
      "src/users.ts:4 GET /api/users/{} [loadUser] <- src/http.ts:3",
      "src/users.ts:7 POST /api/users [save] <- src/http.ts:6",
      "src/users.ts:8 GET /api/me [save] <- src/http.ts:3",
      "src/users.ts:9 DELETE /api/users/1 [save] <- src/http.ts:8",
    ]);
  });

  it("inlines methods called on class instances and axios wrappers", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/client.ts", [
      'import axios from "axios";',
      'const client = axios.create({ baseURL: "https://api.example.com/v1" });',
      "export class Api {",
      "  get(url: string) {",
      "    return client.get(url);",
      "  }",
      "  remove = (url: string) => client.delete(url);",
      "}",
      "export const api = new Api();",
    ]);
    await put("src/use.ts", [
      'import { api } from "./client";',
      "export async function run() {",
      '  await api.get("/orders");',
      '  await api.remove("orders/2");',
      "}",
    ]);
    expect(await summary()).toEqual([
      "src/use.ts:3 GET https://api.example.com/v1/orders [run] <- src/client.ts:5",
      "src/use.ts:4 DELETE https://api.example.com/v1/orders/2 [run] <- src/client.ts:7",
    ]);
  });

  it("inlines methods of an exported const object literal (M5A.3b)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api-client.ts", [
      'const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";',
      "export const apiClient = {",
      "  async get(endpoint: string, params?: Record<string, string>) {",
      "    const url = new URL(`${BASE_URL}${endpoint}`);",
      "    if (params) {",
      "      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));",
      "    }",
      '    return fetch(url.toString(), { method: "GET" });',
      "  },",
      "  post: (endpoint: string, body?: unknown) =>",
      '    fetch(`${BASE_URL}${endpoint}`, { method: "POST", body: JSON.stringify(body) }),',
      "  delete: async function (endpoint: string) {",
      '    return fetch(`${BASE_URL}${endpoint}`, { method: "DELETE" });',
      "  },",
      "};",
      "const local = {",
      '  get: (endpoint: string) => fetch("/local" + endpoint),',
      "};",
      'export const useLocal = () => local.get("/x");',
    ]);
    await put("src/hooks.ts", [
      'import { apiClient } from "./api-client";',
      "export async function load(id: string) {",
      '  await apiClient.get(`/accounts/${id}`, { page: "1" });',
      '  await apiClient.post("/accounts", { name: "a" });',
      "  await apiClient.delete(`/accounts/${id}`);",
      "}",
    ]);
    expect(await summary()).toEqual([
      // An unexported object's methods aren't symbols: the site stays as it is.
      "src/api-client.ts:17 GET /local{} []",
      "src/hooks.ts:3 GET {env:NEXT_PUBLIC_API_URL}/api/v1/accounts/{} [load] <- src/api-client.ts:8",
      "src/hooks.ts:4 POST {env:NEXT_PUBLIC_API_URL}/api/v1/accounts [load] <- src/api-client.ts:11",
      "src/hooks.ts:5 DELETE {env:NEXT_PUBLIC_API_URL}/api/v1/accounts/{} [load] <- src/api-client.ts:13",
    ]);
  });

  it("reads url, baseURL, and method from the caller's axios config (M5A.3c)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/fetcher.ts", [
      'import axios, { AxiosRequestConfig } from "axios";',
      'const api = axios.create({ baseURL: "https://api.example.com/v1" });',
      "const httpRequest = <T>(req: AxiosRequestConfig): Promise<T> => {",
      "  return new Promise(async (resolve, reject) => {",
      "    try {",
      "      const res = await axios(req);",
      "      resolve(res.data);",
      "    } catch (e) {",
      "      reject(e);",
      "    }",
      "  });",
      "};",
      "export default httpRequest;",
      "export function viaInstance(config: AxiosRequestConfig) {",
      "  return api.request(config);",
      "}",
    ]);
    await put("src/api.ts", [
      'import httpRequest, { viaInstance } from "./fetcher";',
      'const LOGOUT = { method: "DELETE", url: "/logout" } as const;',
      "export const login = (username: string) =>",
      '  httpRequest({ method: "POST", url: "/authenticate", data: { username } });',
      "export const getPost = (id: string) => httpRequest({ url: `/post/${id}` });",
      "export const logout = () => httpRequest(LOGOUT);",
      'export const other = () => httpRequest({ baseURL: "https://other.example.com", url: "/x" });',
      "export const pass = (config: object) => httpRequest(config);",
      'export const noUrl = () => httpRequest({ method: "GET" });',
      "export const spread = (extra: object) => httpRequest({ ...extra });",
      'export const users = () => viaInstance({ url: "/users" });',
      'export const absolute = () => viaInstance({ url: "/u", baseURL: "https://b.example.com" });',
    ]);
    expect(await summary()).toEqual([
      "src/api.ts:4 POST /authenticate [login] <- src/fetcher.ts:6",
      "src/api.ts:5 GET /post/{} [getPost] <- src/fetcher.ts:6",
      "src/api.ts:6 DELETE /logout [logout] <- src/fetcher.ts:6",
      "src/api.ts:7 GET https://other.example.com/x [other] <- src/fetcher.ts:6",
      "src/api.ts:8 ? WRAPPER_DEPTH: the axios config is a parameter of the calling function, a wrapper more than one call deep [pass] <- src/fetcher.ts:6",
      "src/api.ts:9 GET DYNAMIC_URL: the URL can't be read statically [noUrl] <- src/fetcher.ts:6",
      "src/api.ts:10 ? DYNAMIC_URL: the URL can't be read statically [spread] <- src/fetcher.ts:6",
      "src/api.ts:11 GET https://api.example.com/v1/users [users] <- src/fetcher.ts:15",
      "src/api.ts:12 GET https://b.example.com/u [absolute] <- src/fetcher.ts:15",
    ]);
  });

  it("shows the caller's url but masks the rest of its config on an unresolved request", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/fetcher.ts", [
      'import axios from "axios";',
      "export const send = (req: object) => axios(req);",
    ]);
    await put("src/api.ts", [
      'import { send } from "./fetcher";',
      "export const login = (base: string) =>",
      '  send({ method: "POST", url: `${base}/login?k=secret`, data: { password: "hunter2" } });',
    ]);
    const [request] = await requests();
    expect(request?.url.resolved).toBe(false);
    expect(request?.expression).toBe(
      'send({ method: "POST", url: `${base}/login?…`, data: { password: "…" } })',
    );
  });

  it("marks a URL that starts with the caller's own parameter WRAPPER_DEPTH", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      "export function get(path: string) {",
      '  return fetch("/api" + path);',
      "}",
      "export function apiGet(path: string) {",
      "  return get(path);",
      "}",
      "export function loadUser(id: string) {",
      "  return get(`/users/${id}`);",
      "}",
      "export function call(url: string) {",
      "  return get(`${url}`);",
      "}",
      "export function nowhere(url: string) {",
      "  return fetch(url);",
      "}",
      "export function load(other: string) {",
      "  return apiGet(other);",
      "}",
    ]);
    // `get` inlines at lines 5, 8, and 11; `apiGet` is not inlined at line 17 (two levels);
    // `nowhere` has no callers, so its own site stays.
    expect(await summary()).toEqual([
      "src/http.ts:5 GET /api{} [apiGet] <- src/http.ts:2",
      "src/http.ts:8 GET /api/users/{} [loadUser] <- src/http.ts:2",
      "src/http.ts:11 GET /api{} [call] <- src/http.ts:2",
      "src/http.ts:14 GET DYNAMIC_URL: the URL starts with a value only known at runtime [nowhere]",
    ]);
  });

  it("reports WRAPPER_DEPTH when the inlined URL still starts with a parameter", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      "export function request(url: string) {",
      "  return fetch(url);",
      "}",
      "export function get(path: string) {",
      "  return request(path);",
      "}",
      "export function users() {",
      '  return request("/api/users");',
      "}",
    ]);
    await put("src/based.ts", [
      'import axios from "axios";',
      "export function fromBase(base: string, path: string) {",
      "  return axios.get(path, { baseURL: base });",
      "}",
      "export function forward(base: string) {",
      '  return fromBase(base, "/x");',
      "}",
      'export const fixed = () => fromBase("https://b.example.com", "/y");',
    ]);
    expect(await summary()).toEqual([
      "src/based.ts:6 GET WRAPPER_DEPTH: the axios baseURL starts with a parameter of the calling function, a wrapper more than one call deep [forward] <- src/based.ts:3",
      "src/based.ts:8 GET https://b.example.com/y [fixed] <- src/based.ts:3",
      "src/http.ts:5 GET WRAPPER_DEPTH: the URL starts with a parameter of the calling function, a wrapper more than one call deep [get] <- src/http.ts:2",
      "src/http.ts:8 GET /api/users [users] <- src/http.ts:2",
    ]);
  });

  it("binds methods, defaults, missing arguments, and spreads", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      'const BASE = "https://api.example.com";',
      'const OPTS = { method: "PUT" } as const;',
      "export function call(method: string, path: string) {",
      "  return fetch(BASE + path, { method });",
      "}",
      "export function api(path: string, init?: RequestInit) {",
      "  return fetch(BASE + path, init);",
      "}",
      'export function withDefault(path = "/default", verb = "PATCH") {',
      "  return fetch(BASE + path, { method: verb });",
      "}",
      "export async function use(args: [string, string], dynamicInit: RequestInit) {",
      '  await call("POST", "/a");',
      '  await api("/b", { method: "DELETE" });',
      '  await api("/c");',
      '  await api("/d", OPTS);',
      '  await api("/e", dynamicInit);',
      "  await withDefault();",
      "  await call(...args);",
      '  await api("/f", { ...dynamicInit });',
      "}",
    ]);
    expect(await summary()).toEqual([
      "src/http.ts:13 POST https://api.example.com/a [use] <- src/http.ts:4",
      "src/http.ts:14 DELETE https://api.example.com/b [use] <- src/http.ts:7",
      "src/http.ts:15 GET https://api.example.com/c [use] <- src/http.ts:7",
      "src/http.ts:16 PUT https://api.example.com/d [use] <- src/http.ts:7",
      "src/http.ts:17 ? https://api.example.com/e [use] <- src/http.ts:7",
      "src/http.ts:18 PATCH https://api.example.com/default [use] <- src/http.ts:10",
      "src/http.ts:19 ? DYNAMIC_URL: the host is only known at runtime [use] <- src/http.ts:4",
      "src/http.ts:20 ? https://api.example.com/f [use] <- src/http.ts:7",
    ]);
  });

  it("reads a method that a spread parameter overrides", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      "export const fetcher = async (endpoint: string, init?: RequestInit) =>",
      "  fetch(`https://api.daily.co/v1${endpoint}`, {",
      '    method: "GET",',
      '    headers: { "Content-Type": "application/json", ...init?.headers },',
      "    ...init,",
      "  });",
      "export const plain = (path: string, extra: RequestInit) => fetch(path, { ...extra });",
      'const POST = { method: "POST" } as const;',
      "export async function use(dynamicInit: RequestInit) {",
      '  await fetcher("/rooms");',
      '  await fetcher("/rooms", { method: "POST", body: "{}" });',
      '  await fetcher("/rooms", { body: "{}" });',
      '  await fetcher("/rooms", POST);',
      '  await fetcher("/rooms", dynamicInit);',
      '  await plain("/p", { headers: {} });',
      "}",
    ]);
    expect(await summary()).toEqual([
      "src/http.ts:10 GET https://api.daily.co/v1/rooms [use] <- src/http.ts:2",
      "src/http.ts:11 POST https://api.daily.co/v1/rooms [use] <- src/http.ts:2",
      "src/http.ts:12 GET https://api.daily.co/v1/rooms [use] <- src/http.ts:2",
      "src/http.ts:13 POST https://api.daily.co/v1/rooms [use] <- src/http.ts:2",
      "src/http.ts:14 ? https://api.daily.co/v1/rooms [use] <- src/http.ts:2",
      "src/http.ts:15 GET /p [use] <- src/http.ts:7",
    ]);
  });

  it("keeps a request at its site when a parameter only fills a later hole or the query (M5A.3j)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      'const API_BASE = process.env.VITE_API_URL ?? "http://localhost:5500";',
      'const ENDPOINT = "https://models.example.com/v1/models";',
      "export const conversationApi = {",
      "  get: (id: string) => fetch(`${API_BASE}/conversation/${id}`),",
      "  list: (id: string, page = 1) => fetch(`${API_BASE}/message/${id}?page=${page}`),",
      "  pin: (id: string, slug: string) => fetch(`${API_BASE}/c/${id}-${slug}`),",
      "};",
      "export function deletePost(postId: string) {",
      '  return fetch(`/api/posts/${postId}`, { method: "DELETE" });',
      "}",
      "export const models = (key: string) => fetch(`${ENDPOINT}?key=${key}`);",
      // Each of these takes part of the leading path, so it stays a wrapper.
      "export const first = (resource: string) => fetch(`${API_BASE}/${resource}`);",
      "export const glued = (path: string) => fetch(`https://api.example.com/v1${path}`);",
      "export const host = (h: string) => fetch(`https://${h}/status`);",
      "export const both = (path: string, id: string) => fetch(`${API_BASE}${path}/${id}`);",
    ]);
    await put("src/use.ts", [
      'import { both, conversationApi, deletePost, first, glued, host, models } from "./api";',
      "export async function run() {",
      '  await conversationApi.get("c1");',
      '  await conversationApi.list("c1", 2);',
      '  await conversationApi.pin("c1", "s");',
      '  await deletePost("p1");',
      '  await models("secret");',
      '  await first("users");',
      '  await glued("/teams");',
      '  await host("status.example.com");',
      '  await both("/orders", "7");',
      "}",
    ]);
    expect(await summary()).toEqual([
      "src/api.ts:4 GET {env:VITE_API_URL}/conversation/{} [conversationApi.get]",
      "src/api.ts:5 GET {env:VITE_API_URL}/message/{} [conversationApi.list]",
      "src/api.ts:6 GET {env:VITE_API_URL}/c/{}-{} [conversationApi.pin]",
      "src/api.ts:9 DELETE /api/posts/{} [deletePost]",
      "src/api.ts:11 GET https://models.example.com/v1/models [models]",
      "src/use.ts:8 GET {env:VITE_API_URL}/users [run] <- src/api.ts:12",
      "src/use.ts:9 GET https://api.example.com/v1/teams [run] <- src/api.ts:13",
      "src/use.ts:10 GET https://status.example.com/status [run] <- src/api.ts:14",
      "src/use.ts:11 GET {env:VITE_API_URL}/orders/7 [run] <- src/api.ts:15",
    ]);
  });

  it("leaves nested functions, unrelated parameters, and uncalled wrappers alone", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      "export function outer() {",
      "  const inner = (path: string) => fetch(path);",
      '  return inner("/x");',
      "}",
      "export function fixed(id: string) {",
      '  return fetch("/api/fixed");',
      "}",
      'export function unused(path: string) { return fetch("/api" + path); }',
      "export const run = () => fixed('1');",
    ]);
    expect(await summary()).toEqual([
      "src/http.ts:2 GET DYNAMIC_URL: the URL starts with a value only known at runtime [outer]",
      "src/http.ts:6 GET /api/fixed [fixed]",
      "src/http.ts:8 GET /api{} [unused]",
    ]);
  });

  it("follows calls into workspace packages at the import's confidence", async () => {
    await put("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    // No `main`/`exports`, so `@acme/sdk` resolves to `src/index.ts` heuristically (M1.8).
    await put("packages/sdk/package.json", JSON.stringify({ name: "@acme/sdk" }));
    await put("packages/sdk/src/index.ts", [
      "export function getJson(path: string) {",
      "  return fetch(`/api${path}`);",
      "}",
    ]);
    await put(
      "packages/web/package.json",
      JSON.stringify({ name: "web", dependencies: { "@acme/sdk": "*" } }),
    );
    await put("packages/web/src/page.ts", [
      'import { getJson } from "@acme/sdk";',
      'export const load = () => getJson("/teams");',
    ]);
    expect(await summary()).toEqual([
      "packages/web/src/page.ts:2 GET /api/teams [load] <- packages/sdk/src/index.ts:2 (heuristic)",
    ]);
  });

  it("attributes calls in inline Express handlers to the route", async () => {
    await put("package.json", JSON.stringify({ name: "api", dependencies: { express: "*" } }));
    await put("src/app.ts", [
      'import express from "express";',
      "function upstream(path: string) {",
      '  return fetch("https://up.example.com" + path);',
      "}",
      "const app = express();",
      'app.get("/proxy", async (_req, res) => { res.json(await upstream("/data")); });',
      "app.listen(3000);",
    ]);
    const [request] = await requests();
    expect(request?.owners).toEqual(["route:api/GET /proxy"]);
    expect(request?.url.resolved && request.url.text).toBe("https://up.example.com/data");
  });
});

describe("collectHttpFacts + bindWrappers (M6.7c)", () => {
  /** The facts of the service whose files are under `folder`. */
  const of = (all: Awaited<ReturnType<typeof facts>>, folder: string): HttpFacts => {
    const sp = all.programs.find((p) => p.rootFiles.some((f) => f.startsWith(folder)));
    const found = all.facts.find((f) => f.service === sp?.service.key);
    if (!found) throw new Error(`no facts for ${folder}`);
    return found;
  };

  it("keeps a wrapper's own requests in its service and its calls in the caller's", async () => {
    await sdkAndWeb("@acme/sdk");
    const all = await facts();
    expect(all.facts.map((f) => f.service)).toEqual(all.programs.map((p) => p.service.key));
    const sdk = of(all, "packages/sdk/");
    const web = of(all, "packages/web/");
    expect(sdk.requests.map(brief)).toEqual(["packages/sdk/src/index.ts:7 GET /api/ping"]);
    expect(sdk.wrappers.map((w) => [w.name, w.requests.map(brief)])).toEqual([
      ["getJson", ["packages/sdk/src/index.ts:2 GET /api{}"]],
      ["unused", ["packages/sdk/src/index.ts:5 GET /other{}"]],
    ]);
    expect(sdk.calls).toEqual([]);
    expect(web.requests).toEqual([]);
    expect(web.wrappers).toEqual([]);
    expect(web.calls.map((c) => c.requests.map(brief))).toEqual([
      ["packages/web/src/page.ts:2 GET /api/teams <- getJson"],
    ]);
    // A called wrapper's own request is dropped; an uncalled one's stays.
    expect(bindWrappers(all.facts).map(brief)).toEqual([
      "packages/sdk/src/index.ts:5 GET /other{}",
      "packages/sdk/src/index.ts:7 GET /api/ping",
      "packages/web/src/page.ts:2 GET /api/teams <- getJson",
    ]);
  });

  it("binds facts that went through JSON to the same requests", async () => {
    await sdkAndWeb("@acme/sdk");
    await put("packages/web/src/more.ts", [
      'import axios from "axios";',
      'const api = axios.create({ baseURL: "https://api.example.com" });',
      "export const send = (path: string, method: string) => api.request({ url: path, method });",
      'export const a = () => send("/x?token=abc", "POST");',
      "export const b = (u: string) => fetch(u);",
    ]);
    const { facts: live, inlineHandlers } = await facts();
    const copied = JSON.parse(JSON.stringify(live)) as HttpFacts[];
    expect(copied).toEqual(live);
    expect(bindWrappers(copied, inlineHandlers)).toEqual(bindWrappers(live, inlineHandlers));
    // Nothing secret survives into the text an unresolved node would show.
    expect(JSON.stringify(live)).not.toContain("token=abc");
  });

  it("records a wrapper in another service's program as reached by its caller", async () => {
    // A relative import TypeScript resolves itself, so the resolver records no hop.
    await sdkAndWeb("../../sdk/src/index");
    const all = await facts();
    const web = all.programs.find((p) => p.rootFiles.some((f) => f.startsWith("packages/web/")));
    const sdk = all.programs.find((p) => p.rootFiles.some((f) => f.startsWith("packages/sdk/")));
    expect(web && sdk).toBeTruthy();
    if (!web || !sdk) return;
    expect(of(all, "packages/web/").calls.map((c) => c.wrapper)).toEqual([
      "symbol:sdk/src/index.ts#getJson",
    ]);
    const keys = (set: ReadonlySet<ServiceProgram>) => [...set].map((p) => p.service.key);
    expect(keys(all.resolver.reached(web))).toEqual([sdk.service.key]);
    expect(keys(all.resolver.reached(sdk))).toEqual([]);
  });

  it("keeps an inline handler's requests unchanged when another service remounts it", async () => {
    await put("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    await put(
      "packages/routes/package.json",
      JSON.stringify({ name: "routes", dependencies: { express: "4" } }),
    );
    await put("packages/routes/src/users.ts", [
      'import { Router } from "express";',
      "export const users = Router();",
      'users.get("/users", async (_req, res) => {',
      '  res.json(await fetch("https://up.example.com/u"));',
      "});",
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
    const before = await facts();
    await put("packages/api/src/server.ts", server("/v2"));
    const after = await facts();

    // The request's facts name the handler by node key, not by the routes it serves.
    const routes = of(before, "packages/routes/");
    expect(of(after, "packages/routes/")).toEqual(routes);
    expect(routes.requests.map((r) => [r.owners.handlers.length, r.owners.ids])).toEqual([[1, []]]);
    const owners = (all: typeof before) =>
      bindWrappers(all.facts, all.inlineHandlers).map((r) => r.owners);
    expect(owners(before)).toEqual([["route:api/GET /v1/users"]]);
    expect(owners(after)).toEqual([["route:api/GET /v2/users"]]);
    // Without Express's map, the request is top-level code.
    expect(bindWrappers(after.facts).map((r) => r.owners)).toEqual([[]]);
  });
});
