import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { collectHttpCalls } from "./http.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms, type ServiceProgram } from "./program.js";
import { createUrlNormalizer, DYNAMIC_URL_DETAIL } from "./url.js";
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

  it("inlines a wrapper whose URL goes through a repo string builder (M5C.7d)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      'const API = "/api";',
      "const url = (path: string) => `${API}${path}`;",
      "export function get(path: string) {",
      "  return fetch(url(path));",
      "}",
    ]);
    await put("src/users.ts", [
      'import { get } from "./http";',
      "export const load = (id: string) => get(`/users/${id}`);",
    ]);
    expect(await summary()).toEqual(["src/users.ts:2 GET /api/users/{} [load] <- src/http.ts:4"]);
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
      "src/api.ts:8 ? WRAPPER_DEPTH: the axios config is a parameter of the calling function, and no call to that function was followed [pass] <- src/fetcher.ts:6",
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
    // `get` inlines at line 8; `apiGet` and `call` pass their parameter on, so they're
    // wrappers over `get` (M5C.7f), and `load` over `apiGet`: with no callers, `call` and
    // `load` keep their requests at lines 11 and 17. `nowhere` has no callers, so its own
    // site stays.
    expect(await summary()).toEqual([
      "src/http.ts:8 GET /api/users/{} [loadUser] <- src/http.ts:2",
      "src/http.ts:11 GET /api{} [call] <- src/http.ts:2",
      "src/http.ts:14 GET DYNAMIC_URL: the URL starts with a value only known at runtime [nowhere]",
      "src/http.ts:17 GET /api{} [load] <- src/http.ts:2",
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
      "src/based.ts:6 GET WRAPPER_DEPTH: the axios baseURL starts with a parameter of the calling function, and no call to that function was followed [forward] <- src/based.ts:3",
      "src/based.ts:8 GET https://b.example.com/y [fixed] <- src/based.ts:3",
      "src/http.ts:5 GET WRAPPER_DEPTH: the URL starts with a parameter of the calling function, and no call to that function was followed [get] <- src/http.ts:2",
      "src/http.ts:8 GET /api/users [users] <- src/http.ts:2",
    ]);
  });

  it("reports WRAPPER_DEPTH when a returned function's own parameter leads the inlined URL (M5A.5c)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/client.ts", [
      "export function createClient(base: string) {",
      "  return {",
      '    get: (path: string) => fetch(base + "/" + path),',
      "    glued: (path: string) => fetch(base + path),",
      "    one: (id: string) => fetch(`${base}/users/${id}`),",
      "  };",
      "}",
      "export function load() {",
      '  const api = createClient("/api");',
      '  return api.get("users");',
      "}",
    ]);
    // `get` and `glued` take their route from `path`, which only `api.get(…)` supplies (a
    // second call); `one` fixes `/users`, so its `id` is just a later hole.
    const deeper =
      "WRAPPER_DEPTH: the URL's leading part is a parameter of a function inside the wrapper, a wrapper more than one call deep";
    expect(await summary()).toEqual([
      `src/client.ts:9 GET ${deeper} [load] <- src/client.ts:3`,
      `src/client.ts:9 GET ${deeper} [load] <- src/client.ts:4`,
      "src/client.ts:9 GET /api/users/{} [load] <- src/client.ts:5",
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

  it("reads the caller's method through a rest element of the init (M5C.7a)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      "type Init = RequestInit & { json?: unknown };",
      "export async function send(url: string, init: Init = {}) {",
      "  const { json, headers, ...rest } = init;",
      "  return fetch(url, { ...rest, headers, body: JSON.stringify(json) });",
      "}",
      "export function inParams(url: string, { json, ...rest }: Init = {}) {",
      "  return fetch(url, { ...rest, body: JSON.stringify(json) });",
      "}",
      "export function named(url: string, init: Init) {",
      "  const { method, ...rest } = init;",
      '  return fetch(url, { method: "POST", ...rest });',
      "}",
      "export function computed(url: string, init: Init, key: string) {",
      "  const { [key]: dropped, ...rest } = init;",
      "  return fetch(url, { ...rest });",
      "}",
      "export function reassignable(url: string, init: Init) {",
      "  let { json, ...rest } = init;",
      "  return fetch(url, { ...rest });",
      "}",
      'const PUT = { method: "PUT" } as const;',
      "export async function use(dynamicInit: Init) {",
      '  await send("/api/key");',
      '  await send("/api/key", { method: "PUT", json: {} });',
      '  await send("/api/key", { method: "DELETE" });',
      '  await send("/api/key", PUT);',
      '  await send("/api/key", dynamicInit);',
      '  await inParams("/api/key", { method: "PATCH" });',
      '  await inParams("/api/key");',
      '  await named("/api/key", { method: "DELETE" });',
      '  await computed("/api/key", { method: "DELETE" }, "x");',
      '  await reassignable("/api/key", { method: "DELETE" });',
      "}",
    ]);
    expect(await summary()).toEqual([
      "src/http.ts:23 GET /api/key [use] <- src/http.ts:4",
      "src/http.ts:24 PUT /api/key [use] <- src/http.ts:4",
      "src/http.ts:25 DELETE /api/key [use] <- src/http.ts:4",
      "src/http.ts:26 PUT /api/key [use] <- src/http.ts:4",
      "src/http.ts:27 ? /api/key [use] <- src/http.ts:4",
      "src/http.ts:28 PATCH /api/key [use] <- src/http.ts:7",
      "src/http.ts:29 GET /api/key [use] <- src/http.ts:7",
      // `method` is taken out of `rest`, so the literal before the spread stands.
      "src/http.ts:30 POST /api/key [use] <- src/http.ts:11",
      // A computed key could be `method`; a `let` could be reassigned.
      "src/http.ts:31 ? /api/key [use] <- src/http.ts:15",
      "src/http.ts:32 ? /api/key [use] <- src/http.ts:19",
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
      "export const both = (path: string, id: string) => fetch(`${API_BASE}${path}/${id}`);",
    ]);
    await put("src/use.ts", [
      'import { both, conversationApi, deletePost, first, glued, models } from "./api";',
      "export async function run() {",
      '  await conversationApi.get("c1");',
      '  await conversationApi.list("c1", 2);',
      '  await conversationApi.pin("c1", "s");',
      '  await deletePost("p1");',
      '  await models("secret");',
      '  await first("users");',
      '  await glued("/teams");',
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
      "src/use.ts:10 GET {env:VITE_API_URL}/orders/7 [run] <- src/api.ts:14",
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

describe("a URL picked by a condition (M5C.10a)", () => {
  it("keeps the request at its own call when no branch's parameter is leading", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/match.ts", [
      "export function join(slug?: string) {",
      '  const url = slug ? `/api/x/${slug}` : "/api/y";',
      "  return fetch(url);",
      "}",
      "export function joinLet(slug?: string) {",
      '  let url = "/api/y";',
      "  if (slug) url = `/api/x/${slug}`;",
      "  return fetch(url);",
      "}",
      "export function pick(admin: boolean) {",
      '  return fetch(admin ? "/api/admin" : "/api/user");',
      "}",
      "export const a = () => join();",
      'export const b = () => join("s");',
      'export const c = () => joinLet("s");',
      "export const d = () => pick(true);",
    ]);
    // One request per branch at the helper's own `fetch`, nothing at the callers.
    expect(await summary()).toEqual([
      "src/match.ts:3 GET /api/x/{} [join]",
      "src/match.ts:3 GET /api/y [join]",
      "src/match.ts:8 GET /api/y [joinLet]",
      "src/match.ts:8 GET /api/x/{} [joinLet]",
      "src/match.ts:11 GET /api/admin [pick]",
      "src/match.ts:11 GET /api/user [pick]",
    ]);
  });

  it("still makes a wrapper when a branch's parameter is leading", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      "export function load(path?: string) {",
      '  return fetch(path ? `/api${path}` : "/api/home");',
      "}",
      'export const a = () => load("/users");',
      "export const b = () => load();",
      "declare const p: string | undefined;",
      "export const c = () => load(p);",
    ]);
    expect(await summary()).toEqual([
      "src/http.ts:4 GET /api/users [a] <- src/http.ts:2",
      "src/http.ts:5 GET /api/home [b] <- src/http.ts:2",
      // Unknown at runtime: both branches.
      "src/http.ts:7 GET /api{} [c] <- src/http.ts:2",
      "src/http.ts:7 GET /api/home [c] <- src/http.ts:2",
    ]);
  });

  it("prunes a branch whose condition the caller's argument settles", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      "export function request(path: string, version?: string) {",
      "  const url = version ? `/api/${version}${path}` : `/api${path}`;",
      "  return fetch(url);",
      "}",
      'export const a = () => request("/users");',
      'export const b = () => request("/teams", "v2");',
      "declare const v: string | undefined;",
      'export const c = () => request("/items", v);',
      "export function flag(path: string, legacy = false) {",
      "  return fetch(legacy ? `/old${path}` : `/api${path}`);",
      "}",
      'export const d = () => flag("/x");',
      'export const e = () => flag("/y", true);',
      "export function neg(path: string, fresh?: boolean) {",
      "  return fetch(!fresh ? `/cache${path}` : `/api${path}`);",
      "}",
      'export const f = () => neg("/z");',
      'export const g = () => request("/empty", "");',
      'export const h = () => request("/null", undefined);',
    ]);
    expect(await summary()).toEqual([
      // A missing argument is `undefined`, so falsy.
      "src/http.ts:5 GET /api/users [a] <- src/http.ts:3",
      // A non-empty string literal is truthy.
      "src/http.ts:6 GET /api/v2/teams [b] <- src/http.ts:3",
      // A value only known at runtime keeps both branches.
      "src/http.ts:8 GET /api/{}/items [c] <- src/http.ts:3",
      "src/http.ts:8 GET /api/items [c] <- src/http.ts:3",
      // The parameter's default when the argument is missing.
      "src/http.ts:12 GET /api/x [d] <- src/http.ts:10",
      "src/http.ts:13 GET /old/y [e] <- src/http.ts:10",
      // `!` flips it.
      "src/http.ts:17 GET /cache/z [f] <- src/http.ts:15",
      "src/http.ts:18 GET /api/empty [g] <- src/http.ts:3",
      "src/http.ts:19 GET /api/null [h] <- src/http.ts:3",
    ]);
  });
});

describe("a parameter that fills only the origin (M5C.10b)", () => {
  it("keeps the request at its own call when the path after the origin is fixed", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/daemon.ts", [
      "export function isUp(port: number) {",
      "  return fetch(`http://127.0.0.1:${port}/api/health`);",
      "}",
      "export async function waitUntilUp(port: number) {",
      "  while (!(await isUp(port)).ok) await new Promise((r) => setTimeout(r, 100));",
      "}",
      "export const status = (host: string) => fetch(`https://${host}/status`);",
      "export const start = () => waitUntilUp(4000);",
      'export const check = () => status("status.example.com");',
    ]);
    // Nothing at `waitUntilUp`'s call of `isUp`, nor at `start` or `check`.
    expect(await summary()).toEqual([
      "src/daemon.ts:2 GET http://127.0.0.1:{}/api/health [isUp]",
      `src/daemon.ts:7 GET DYNAMIC_URL: ${DYNAMIC_URL_DETAIL.host} [status]`,
    ]);
  });

  it("still makes a wrapper when a parameter also fills the path, and binds the port", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/client.ts", [
      "export function call(port: number, path: string) {",
      "  return fetch(`http://localhost:${port}${path}`);",
      "}",
      "export function health(port: number) {",
      '  return call(port, "/api/health");',
      "}",
      "export function get(port: number, path: string) {",
      "  return call(port, path);",
      "}",
      'export const a = () => call(3000, "/api/users");',
      "export const b = () => health(3000);",
      'export const c = () => get(8080, "/api/teams");',
    ]);
    // `health` passes only the port on and fixes the path: its call of `call` is the request.
    expect(await summary()).toEqual([
      "src/client.ts:5 GET http://localhost:{}/api/health [health] <- src/client.ts:2",
      "src/client.ts:10 GET http://localhost:3000/api/users [a] <- src/client.ts:2",
      "src/client.ts:12 GET http://localhost:8080/api/teams [c] <- src/client.ts:2",
    ]);
  });
});

describe("wrappers calling wrappers (M5C.7f)", () => {
  it("inlines a path-taking wrapper's call to another at the outer wrapper's callers", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      "async function send(path: string, init: RequestInit) {",
      '  return fetch("/api/" + path, { ...init });',
      "}",
      "function getJson(path: string, query?: string) {",
      '  return send(query ? `${path}?${query}` : path, { method: "GET" });',
      "}",
      "export function postJson(path: string, body: unknown) {",
      '  return send(path, { method: "POST", body: JSON.stringify(body) });',
      "}",
      'export const loadTeam = (id: string) => getJson("teams/" + id);',
      'export const listTeams = () => getJson("teams", "page=1");',
      'export const saveTeam = (team: unknown) => postJson("teams", team);',
    ]);
    // Nothing is left at `send`'s calls inside `getJson` and `postJson` (lines 5 and 8).
    expect(await summary()).toEqual([
      "src/http.ts:10 GET /api/teams/{} [loadTeam] <- src/http.ts:2",
      "src/http.ts:11 GET /api/teams [listTeams] <- src/http.ts:2",
      "src/http.ts:12 POST /api/teams [saveTeam] <- src/http.ts:2",
    ]);
  });

  it("follows three wrappers deep, and marks a fourth WRAPPER_DEPTH", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      'export function l1(path: string) { return fetch("/api" + path); }',
      "export function l2(path: string) { return l1(path); }",
      "export function l3(path: string) { return l2(path); }",
      "export function l4(path: string) { return l3(path); }",
      'export const three = () => l3("/three");',
      'export const four = () => l4("/four");',
    ]);
    expect(await summary()).toEqual([
      "src/http.ts:4 GET WRAPPER_DEPTH: the URL's leading part is a parameter of the calling function, a wrapper more than three calls deep [l4] <- src/http.ts:1",
      "src/http.ts:5 GET /api/three [three] <- src/http.ts:1",
    ]);
  });

  it("reads a method passed down through both wrappers", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      "function request(method: string, path: string, init?: RequestInit) {",
      '  return fetch("/api" + path, { ...init, method });',
      "}",
      "function call(method: string, path: string, init?: RequestInit) {",
      "  return request(method, path, init);",
      "}",
      'export const remove = () => call("DELETE", "/teams/1");',
      'export const unknown = (m: string) => call(m, "/teams");',
    ]);
    expect(await summary()).toEqual([
      "src/http.ts:7 DELETE /api/teams/1 [remove] <- src/http.ts:2",
      "src/http.ts:8 ? /api/teams [unknown] <- src/http.ts:2",
    ]);
  });

  it("ends a cycle of wrappers calling each other, keeping every site", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/http.ts", [
      "export function ping(path: string, n: number): Promise<Response> {",
      '  return n > 0 ? pong(path, n - 1) : fetch("/api" + path);',
      "}",
      "export function pong(path: string, n: number): Promise<Response> {",
      "  return ping(path, n);",
      "}",
      'export const go = () => pong("/x", 2);',
    ]);
    expect(await summary()).toEqual([
      "src/http.ts:2 GET /api{} [ping] <- src/http.ts:2",
      "src/http.ts:7 GET /api/x [go] <- src/http.ts:2",
    ]);
  });

  it("collapses a call's requests to one per site past the budget", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    // 11 × 11 = 121 requests per call to `l3`, past MAX_CHAIN_REQUESTS (100).
    const fan = (name: string, callee: string): string[] => [
      `export function ${name}(path: string) {`,
      ...Array.from({ length: 11 }, (_, i) => `  ${callee}(path + "/x${i}");`),
      "}",
    ];
    await put("src/http.ts", [
      'export function l1(path: string) { return fetch("/api" + path); }',
      ...fan("l2", "l1"),
      ...fan("l3", "l2"),
      'export const run = () => l3("/a");',
      'export const few = () => l2("/b");',
    ]);
    const all = await summary();
    expect(all.filter((r) => r.includes("[run]"))).toEqual([
      `src/http.ts:28 GET DYNAMIC_URL: ${DYNAMIC_URL_DETAIL.tooComplex} [run] <- src/http.ts:1`,
    ]);
    expect(all.filter((r) => r.includes("[few]"))).toHaveLength(11);
  });

  it("keeps a wrapper over a wrapper as a fact of its service, also when only known by ID", async () => {
    await put("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    await put("packages/sdk/package.json", JSON.stringify({ name: "@acme/sdk" }));
    await put("packages/sdk/src/index.ts", [
      "function request(path: string) {",
      '  return fetch("/api" + path);',
      "}",
      "export function getJson(path: string) {",
      "  return request(path);",
      "}",
    ]);
    await put(
      "packages/web/package.json",
      JSON.stringify({ name: "web", dependencies: { "@acme/sdk": "*" } }),
    );
    await put("packages/web/src/page.ts", [
      'import { getJson } from "../../sdk/src/index";',
      'export const load = () => getJson("/teams");',
    ]);
    const all = await facts();
    const sdkProgram = all.programs.find((p) =>
      p.rootFiles.some((f) => f.startsWith("packages/sdk/")),
    );
    const webProgram = all.programs.find((p) =>
      p.rootFiles.some((f) => f.startsWith("packages/web/")),
    );
    if (!sdkProgram || !webProgram) throw new Error("no programs");
    const sdk = all.facts.find((f) => f.service === sdkProgram.service.key);
    const web = all.facts.find((f) => f.service === webProgram.service.key);
    expect(sdk?.wrappers.map((w) => [w.name, w.inner ?? [], w.requests.map(brief)])).toEqual([
      [
        "getJson",
        ["symbol:sdk/src/index.ts#request"],
        ["packages/sdk/src/index.ts:5 GET /api{} <- request"],
      ],
      ["request", [], ["packages/sdk/src/index.ts:2 GET /api{}"]],
    ]);
    // `getJson`'s call to `request` is its own request, not a call fact.
    expect(sdk?.calls).toEqual([]);
    expect(web?.calls.map((c) => [c.wrapper, c.requests.map(brief)])).toEqual([
      ["symbol:sdk/src/index.ts#getJson", ["packages/web/src/page.ts:2 GET /api/teams <- getJson"]],
    ]);
    expect(bindWrappers(all.facts).map(brief)).toEqual([
      "packages/web/src/page.ts:2 GET /api/teams <- getJson",
    ]);
    const keys = (set: ReadonlySet<ServiceProgram>) => [...set].map((p) => p.service.key);
    expect(keys(all.resolver.reached(webProgram))).toEqual([sdkProgram.service.key]);
    // A run that reuses the SDK's facts finds its wrappers only when the web app calls one.
    const inventory = await buildInventory(dir);
    const workspace = await detectWorkspace(dir, inventory.files);
    const programs = buildServicePrograms(dir, workspace, inventory);
    const resolver = createSymbolResolver(programs, workspace);
    const reusedSdk = programs.find((p) => p.service.key === sdkProgram.service.key);
    const onlyWeb = programs.find((p) => p.service.key === webProgram.service.key);
    if (!reusedSdk || !onlyWeb) throw new Error("no programs");
    const partial = collectHttpFacts(
      collectHttpCalls(programs, resolver),
      programs,
      resolver,
      createUrlNormalizer(resolver),
      {
        only: new Set([onlyWeb]),
        known: new Map([[reusedSdk, sdk?.wrappers.map((w) => w.id) ?? []]]),
      },
    );
    expect(partial).toEqual([web]);
  });
});

describe("SWR fetchers (ADR-0193)", () => {
  /** The fetchers' own requests, kept when no hook or call passes them a URL. */
  const FETCHER =
    "src/lib/fetcher.ts:2 GET DYNAMIC_URL: the URL starts with a value only known at runtime [fetcher]";
  const SEND =
    "src/lib/fetcher.ts:4 POST DYNAMIC_URL: the URL starts with a value only known at runtime [send]";

  /** A repo fetcher (`fetcher(url)`) and a mutation fetcher (`send(url, { arg })`). */
  async function fetchers(): Promise<void> {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { swr: "2" } }));
    await put("src/lib/fetcher.ts", [
      'import axios from "axios";',
      "export const fetcher = (url: string) => axios.get(url).then((r) => r.data);",
      "export async function send(url: string, { arg }: { arg: unknown }) {",
      "  return axios.post(url, arg);",
      "}",
    ]);
  }

  it("inlines a hook's fetcher at the hook with each key it may pass", async () => {
    await fetchers();
    await put("src/hooks.ts", [
      'import useSWR, { preload } from "swr";',
      'import useSWRImmutable from "swr/immutable";',
      'import useSWRInfinite from "swr/infinite";',
      'import useSWRMutation from "swr/mutation";',
      'import { fetcher, send } from "./lib/fetcher";',
      "",
      "export function usePosts(id?: string, ready?: boolean) {",
      '  useSWR("/api/me", fetcher);',
      "  useSWR(id ? `/api/posts/${id}` : null, fetcher);",
      '  useSWR(ready && "/api/feed", fetcher);',
      "  useSWR(() => `/api/users/${id}`, fetcher);",
      '  useSWR(["/api/token", id], fetcher);',
      "  useSWR(id, fetcher);",
      '  useSWRImmutable("/api/config", { fetcher });',
      "  useSWRInfinite((index: number, previous: unknown[] | null) =>",
      "    previous && !previous.length ? null : `/api/items?page=${index}`, fetcher);",
      '  useSWRMutation("/api/posts", send);',
      '  useSWR("/api/cache-only", null);',
      "  useSWR(null, fetcher);",
      "}",
      'preload("/api/me", fetcher);',
    ]);
    const via = " <- src/lib/fetcher.ts:2";
    expect(await summary()).toEqual([
      `src/hooks.ts:8 GET /api/me [usePosts]${via}`,
      `src/hooks.ts:9 GET /api/posts/{} [usePosts]${via}`,
      `src/hooks.ts:10 GET /api/feed [usePosts]${via}`,
      `src/hooks.ts:11 GET /api/users/{} [usePosts]${via}`,
      `src/hooks.ts:12 GET DYNAMIC_URL: the SWR key is an array, which the fetcher may take whole or spread [usePosts]${via}`,
      `src/hooks.ts:13 GET WRAPPER_DEPTH: the URL starts with a parameter of the calling function, and no call to that function was followed [usePosts]${via}`,
      `src/hooks.ts:14 GET /api/config [usePosts]${via}`,
      `src/hooks.ts:15 GET /api/items [usePosts]${via}`,
      "src/hooks.ts:17 POST /api/posts [usePosts] <- src/lib/fetcher.ts:4",
      `src/hooks.ts:21 GET /api/me []${via}`,
    ]);
  });

  it("uses SWRConfig's fetcher for hooks given none, heuristically, when it is the only one", async () => {
    await fetchers();
    await put("src/app.tsx", [
      'import { SWRConfig } from "swr";',
      'import { fetcher } from "./lib/fetcher";',
      "export function App({ children }: { children: unknown }) {",
      "  return <SWRConfig value={{ fetcher, revalidateOnFocus: false }}>{children}</SWRConfig>;",
      "}",
    ]);
    await put("src/feed.ts", [
      'import useSWR from "swr";',
      'export const useFeed = () => useSWR("/api/feed");',
      'export const useOther = () => useSWR("/api/other", { refreshInterval: 1000 });',
    ]);
    const via = " <- src/lib/fetcher.ts:2 (heuristic)";
    expect(await summary()).toEqual([
      `src/feed.ts:2 GET /api/feed [useFeed]${via}`,
      `src/feed.ts:3 GET /api/other [useOther]${via}`,
      SEND,
    ]);

    // A second config with another fetcher: which one a hook renders under isn't known.
    await put("src/lib/other.ts", [
      "export const other = (url: string) => fetch(url).then((r) => r.json());",
    ]);
    await put("src/admin.tsx", [
      'import { SWRConfig } from "swr";',
      'import { other } from "./lib/other";',
      "export const Admin = () => <SWRConfig value={{ fetcher: other }} />;",
    ]);
    expect(await summary()).toEqual([
      FETCHER,
      SEND,
      "src/lib/other.ts:1 GET DYNAMIC_URL: the URL starts with a value only known at runtime [other]",
    ]);
  });

  it("leaves other libraries' hooks, and hooks with no key, to the fetcher's own request", async () => {
    await fetchers();
    await put("src/hooks.ts", [
      'import useSWR from "swr";',
      'import { fetcher } from "./lib/fetcher";',
      "function useLocal(key: string, f: (key: string) => unknown) {",
      "  return f(key);",
      "}",
      "export function useNothing() {",
      '  useLocal("/api/local", fetcher);',
      "  useSWR(null, fetcher);",
      "}",
    ]);
    expect(await summary()).toEqual([FETCHER, SEND]);
  });

  it("inlines a fetcher written at the hook (M5B.2b)", async () => {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { swr: "2" } }));
    await put("src/hooks.ts", [
      'import axios from "axios";',
      'import useSWR from "swr";',
      'import useSWRMutation from "swr/mutation";',
      "",
      "export function useBooks(id?: string) {",
      '  useSWR("/api/books", (url: string) => fetch(url).then((r) => r.json()));',
      "  useSWR(id ? `/api/books/${id}` : null, async (url: string) => {",
      "    const res = await fetch(url);",
      "    return res.json();",
      "  });",
      '  useSWR("/api/shelves", { fetcher: (url: string) => axios.get(url) });',
      '  useSWR("/api/tags", (url: string) => fetch(`${url}?all=1`));',
      '  useSWRMutation("/api/books", (url: string, { arg }: { arg: unknown }) =>',
      '    fetch(url, { method: "POST", body: JSON.stringify(arg) }));',
      '  useSWR(["/api/token", id], (url: string) => fetch(url));',
      '  useSWR("/api/raw", (url: string) => fetch("/api/fixed"));',
      "}",
      "function run(key: string, f: (key: string) => unknown) {",
      "  return f(key);",
      "}",
      'run("/api/local", (url: string) => fetch(url));',
    ]);
    expect(await summary()).toEqual([
      "src/hooks.ts:6 GET /api/books [useBooks]",
      "src/hooks.ts:7 GET /api/books/{} [useBooks]",
      "src/hooks.ts:11 GET /api/shelves [useBooks]",
      "src/hooks.ts:12 GET /api/tags [useBooks]",
      "src/hooks.ts:13 POST /api/books [useBooks]",
      "src/hooks.ts:15 GET DYNAMIC_URL: the SWR key is an array, which the fetcher may take whole or spread [useBooks]",
      "src/hooks.ts:16 GET /api/fixed [useBooks]",
      "src/hooks.ts:21 GET DYNAMIC_URL: the URL starts with a value only known at runtime []",
    ]);
  });

  it("reads the key through a fetcher's rest parameter, as in SWR's docs (M5B.2b)", async () => {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { swr: "2" } }));
    await put("src/lib/fetcher.ts", [
      "export const fetcher = (...args: Parameters<typeof fetch>) =>",
      "  fetch(...args).then((r) => r.json());",
    ]);
    await put("src/hooks.ts", [
      'import useSWR from "swr";',
      'import useSWRMutation from "swr/mutation";',
      'import { fetcher } from "./lib/fetcher";',
      "export function useMe(id?: string) {",
      '  useSWR("/api/me", fetcher);',
      '  useSWR(["/api/token", id], fetcher);',
      '  useSWRMutation("/api/posts", fetcher);',
      '  useSWR("/api/inline", (...args: [string]) => fetch(...args));',
      '  fetcher("/api/sessions", { method: "DELETE" });',
      "  fetcher(...[`/api/users/${id}`]);",
      "}",
    ]);
    const via = " <- src/lib/fetcher.ts:2";
    expect(await summary()).toEqual([
      `src/hooks.ts:5 GET /api/me [useMe]${via}`,
      `src/hooks.ts:6 GET DYNAMIC_URL: the SWR key is an array, which the fetcher may take whole or spread [useMe]${via}`,
      `src/hooks.ts:7 ? /api/posts [useMe]${via}`,
      "src/hooks.ts:8 GET /api/inline [useMe]",
      `src/hooks.ts:9 DELETE /api/sessions [useMe]${via}`,
      `src/hooks.ts:10 ? DYNAMIC_URL: the URL can't be read statically [useMe]${via}`,
    ]);

    // Nothing passes the fetcher a URL: its own request, which can't be read.
    await put("src/hooks.ts", ["export const none = 1;"]);
    expect(await summary()).toEqual([
      "src/lib/fetcher.ts:2 ? DYNAMIC_URL: the URL can't be read statically [fetcher]",
    ]);
  });

  it("uses a fetcher written in SWRConfig's value for hooks given none (M5B.2b)", async () => {
    await put("package.json", JSON.stringify({ name: "web", dependencies: { swr: "2" } }));
    await put("src/app.tsx", [
      'import { SWRConfig } from "swr";',
      "export function App({ children }: { children: unknown }) {",
      "  return (",
      "    <SWRConfig value={{ fetcher: (url: string) => fetch(url).then((r) => r.json()) }}>",
      "      {children}",
      "    </SWRConfig>",
      "  );",
      "}",
    ]);
    await put("src/feed.ts", [
      'import useSWR from "swr";',
      'export const useFeed = () => useSWR("/api/feed");',
    ]);
    expect(await summary()).toEqual(["src/feed.ts:2 GET /api/feed [useFeed] (heuristic)"]);

    await put("src/feed.ts", ["export const none = 1;"]);
    expect(await summary()).toEqual([
      "src/app.tsx:4 GET DYNAMIC_URL: the URL starts with a value only known at runtime [App]",
    ]);
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

describe("RTK Query endpoints (ADR-0196)", () => {
  it("makes each endpoint's query a request through fetchBaseQuery's baseUrl", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      'import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";',
      "export const api = createApi({",
      '  baseQuery: fetchBaseQuery({ baseUrl: "/api/" }),',
      "  endpoints: (builder) => ({",
      '    posts: builder.query<unknown, void>({ query: () => "posts" }),',
      "    post: builder.query({ query: (id: string) => `/posts/${id}` }),",
      "    add: builder.mutation({",
      '      query: (body: unknown) => ({ url: "posts", method: "POST", body }),',
      "    }),",
      "    remove: builder.mutation({",
      "      query(id: string) {",
      '        return { url: `posts/${id}`, method: "delete" };',
      "      },",
      "    }),",
      "    touch: builder.mutation({ query: (id: string) => ({ url: `posts/${id}/touch` }) }),",
      "    any: builder.query({ query: (path: string) => path }),",
      "    local: builder.query({ queryFn: () => ({ data: 1 }) }),",
      "  }),",
      "});",
    ]);
    expect(await summary()).toEqual([
      "src/api.ts:5 GET /api/posts [api]",
      "src/api.ts:6 GET /api/posts/{} [api]",
      "src/api.ts:7 POST /api/posts [api]",
      "src/api.ts:10 DELETE /api/posts/{} [api]",
      "src/api.ts:15 GET /api/posts/{}/touch [api]",
      // An absolute URL would ignore the base, so a parameter leading the URL can't be read.
      "src/api.ts:16 GET DYNAMIC_URL: the URL starts with a value only known at runtime [api]",
    ]);
  });

  it("reads the base from a const, through retry, for endpoints injected from another file", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/base.ts", [
      'import { fetchBaseQuery, retry } from "@reduxjs/toolkit/query";',
      'export const baseQuery = retry(fetchBaseQuery({ baseUrl: "https://api.example.com/v1" }));',
    ]);
    await put("src/api.ts", [
      'import { createApi } from "@reduxjs/toolkit/query/react";',
      'import { baseQuery } from "./base";',
      "export const api = createApi({ baseQuery, endpoints: () => ({}) });",
    ]);
    await put("src/users.ts", [
      'import { api } from "./api";',
      "export const usersApi = api.injectEndpoints({",
      "  endpoints(build) {",
      '    return { me: build.query({ query: () => "users/me" }) };',
      "  },",
      "});",
    ]);
    expect(await summary()).toEqual([
      "src/users.ts:4 GET https://api.example.com/v1/users/me [usersApi]",
    ]);
  });

  it("shows endpoints under a base query that isn't fetchBaseQuery as unresolved, not as nothing", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      'import { createApi, retry } from "@reduxjs/toolkit/query/react";',
      'import { createApi as other } from "./mine";',
      "const custom = async (url: string) => ({ data: await fetch(url) });",
      "export const a = createApi({",
      "  baseQuery: custom,",
      '  endpoints: (b) => ({ x: b.query({ query: () => "x" }) }),',
      "});",
      "export const c = other({",
      "  baseQuery: () => ({ data: 1 }),",
      '  endpoints: (b: any) => ({ y: b.query({ query: () => "y" }) }),',
      "});",
      "const axiosBaseQuery = (o: { baseUrl: string }) => async () => ({ data: o });",
      "export const d = createApi({",
      '  baseQuery: retry(axiosBaseQuery({ baseUrl: "/z" })),',
      "  endpoints: (b) => ({",
      '    z: b.mutation({ query: () => ({ url: "z", method: "POST" }) }),',
      "    local: b.query({ queryFn: () => ({ data: 1 }) }),",
      "  }),",
      "});",
    ]);
    await put("src/mine.ts", "export const createApi = (o: unknown) => o;\n");
    const unfollowed = `DYNAMIC_URL: ${DYNAMIC_URL_DETAIL.rtkBaseQuery}`;
    expect(await summary()).toEqual([
      "src/api.ts:3 GET DYNAMIC_URL: the URL starts with a value only known at runtime [custom]",
      // The base query decides the method too, so it isn't read from `query`.
      `src/api.ts:6 ? ${unfollowed} [a]`,
      `src/api.ts:16 ? ${unfollowed} [d]`,
    ]);
  });

  it("follows a base query that passes its arguments on to a fetchBaseQuery (RTK's re-auth example)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/base.ts", [
      'import { fetchBaseQuery } from "@reduxjs/toolkit/query";',
      'export const raw = fetchBaseQuery({ baseUrl: "/api/" });',
    ]);
    await put("src/api.ts", [
      'import { createApi, retry } from "@reduxjs/toolkit/query/react";',
      'import { raw } from "./base";',
      "declare const mutex: { runExclusive(f: () => Promise<void>): Promise<void> };",
      "async function withReauth(args: any, api: any, extraOptions: any) {",
      "  let result = await raw(args, api, extraOptions);",
      "  if (result.error) {",
      '    const refreshed = await raw("auth/refresh", api, extraOptions);',
      '    await raw({ url: "auth/logout", method: "POST" }, api, extraOptions);',
      "    if (refreshed.data) {",
      "      await mutex.runExclusive(async () => {",
      "        result = await raw(args, api, extraOptions);",
      "      });",
      "    }",
      "  }",
      "  return result;",
      "}",
      "export const a = createApi({",
      "  baseQuery: retry(withReauth),",
      "  endpoints: (b) => ({",
      '    me: b.query({ query: () => "users/me" }),',
      '    rename: b.mutation({ query: (name: string) => ({ url: `users/${name}`, method: "PUT" }) }),',
      "  }),",
      "});",
    ]);
    expect(await summary()).toEqual([
      // The wrapper's own calls with a URL fixed there are requests; its forwarding calls aren't.
      "src/api.ts:7 GET /api/auth/refresh [withReauth]",
      "src/api.ts:8 POST /api/auth/logout [withReauth]",
      "src/api.ts:20 GET /api/users/me [a]",
      "src/api.ts:21 PUT /api/users/{} [a]",
    ]);
  });

  it("doesn't follow a base query that changes its arguments, picks a base, or hands them elsewhere", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      'import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";',
      'const raw = fetchBaseQuery({ baseUrl: "/api/" });',
      'const other = fetchBaseQuery({ baseUrl: "/other/" });',
      "declare const log: (x: unknown) => void;",
      "const rewrites = (args: any, api: any, extra: any) =>",
      '  raw(typeof args === "string" ? `v2/${args}` : args, api, extra);',
      "const reassigns = (args: any, api: any, extra: any) => {",
      '  args = { url: "fixed" };',
      "  return raw(args, api, extra);",
      "};",
      "const picks = (args: any, api: any, extra: any) =>",
      "  api.endpoint === 'x' ? raw(args, api, extra) : other(args, api, extra);",
      "const logs = (args: any, api: any, extra: any) => {",
      "  log(args);",
      "  return raw(args, api, extra);",
      "};",
      "export const a = createApi({ baseQuery: rewrites, endpoints: (b) => ({ x: b.query({ query: () => 'x' }) }) });",
      "export const c = createApi({ baseQuery: reassigns, endpoints: (b) => ({ x: b.query({ query: () => 'x' }) }) });",
      "export const d = createApi({ baseQuery: picks, endpoints: (b) => ({ x: b.query({ query: () => 'x' }) }) });",
      "export const e = createApi({ baseQuery: logs, endpoints: (b) => ({ x: b.query({ query: () => 'x' }) }) });",
    ]);
    const unfollowed = `? DYNAMIC_URL: ${DYNAMIC_URL_DETAIL.rtkBaseQuery}`;
    expect(await summary()).toEqual([
      // A call of the fetchBaseQuery result with a computed argument is a request whose URL
      // can't be read, never the endpoint's.
      "src/api.ts:6 ? DYNAMIC_URL: the URL can't be read statically [rewrites]",
      `src/api.ts:17 ${unfollowed} [a]`,
      `src/api.ts:18 ${unfollowed} [c]`,
      `src/api.ts:19 ${unfollowed} [d]`,
      `src/api.ts:20 ${unfollowed} [e]`,
    ]);
  });

  it("reads a destructured endpoint builder", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      'import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";',
      "export const api = createApi({",
      '  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),',
      "  endpoints: ({ query, mutation: send }) => ({",
      '    posts: query({ query: () => "posts" }),',
      '    add: send({ query: () => ({ url: "posts", method: "POST" }) }),',
      "  }),",
      "});",
      // Not the builder: a function of the same name.
      "const query = (o: unknown) => o;",
      'query({ query: () => "nope" });',
    ]);
    expect(await summary()).toEqual([
      "src/api.ts:5 GET /api/posts [api]",
      "src/api.ts:6 POST /api/posts [api]",
    ]);
  });
});

describe("TanStack Query's key in context (M5C.3f, ADR-0196)", () => {
  const LEADING = "DYNAMIC_URL: the URL starts with a value only known at runtime";

  it("reads a queryFn written at the hook with the hook's key", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/todos.ts", [
      'import { useQuery, useInfiniteQuery } from "@tanstack/react-query";',
      'const LIST = ["/api/lists"] as const;',
      "export function useTodos(id: string) {",
      '  useQuery({ queryKey: ["todos"], queryFn: () => fetch("/api/todos") });',
      "  useQuery({",
      '    queryKey: ["/api/todos", id],',
      "    queryFn: ({ queryKey }) => fetch(String(queryKey[0])),",
      "  });",
      "  useQuery({",
      '    queryKey: ["/api/users", id],',
      "    queryFn: ({ queryKey: [path, key] }) => fetch(`${path}/${key}`),",
      "  });",
      "  useInfiniteQuery({",
      "    queryKey: LIST,",
      "    queryFn: (ctx) => fetch(`${ctx.queryKey[0]}?page=${ctx.pageParam}`),",
      "  });",
      "}",
      "export function useApi(key: string[]) {",
      "  return useQuery({ queryKey: key, queryFn: ({ queryKey }) => fetch(String(queryKey[0])) });",
      "}",
    ]);
    expect(await summary()).toEqual([
      "src/todos.ts:4 GET /api/todos [useTodos]",
      "src/todos.ts:5 GET /api/todos [useTodos]",
      "src/todos.ts:9 GET /api/users/{} [useTodos]",
      "src/todos.ts:13 GET /api/lists [useTodos]",
      // The custom hook's own parameter: only its callers know the key.
      "src/todos.ts:19 GET WRAPPER_DEPTH: the URL starts with a parameter of the calling function, and no call to that function was followed [useApi]",
    ]);
  });

  it("uses the QueryClient's default queryFn for options without one, at heuristic", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/client.ts", [
      'import { QueryClient } from "@tanstack/react-query";',
      "export const defaultQueryFn = async ({ queryKey }: { queryKey: readonly unknown[] }) =>",
      "  (await fetch(`/api${queryKey[0]}`)).json();",
      "export const client = new QueryClient({ defaultOptions: { queries: { queryFn: defaultQueryFn } } });",
      "export const tests = new QueryClient();",
    ]);
    await put("src/posts.ts", [
      'import { queryOptions, useQuery } from "@tanstack/react-query";',
      "const opts = { queryKey: ['/stats'] };",
      "export function usePosts(postId: string, more: object) {",
      '  useQuery({ queryKey: ["/posts"] });',
      "  useQuery({ queryKey: [`/posts/${postId}`], enabled: !!postId });",
      "  useQuery(opts);",
      "  useQuery({ ...more, queryKey: ['/never'] });",
      "  return queryOptions({ queryKey: ['/drafts'] });",
      "}",
      "export function useApi(key: string[]) {",
      "  return useQuery({ queryKey: key });",
      "}",
    ]);
    expect(await summary()).toEqual([
      "src/posts.ts:4 GET /api/posts [usePosts] <- src/client.ts:3 (heuristic)",
      "src/posts.ts:5 GET /api/posts/{} [usePosts] <- src/client.ts:3 (heuristic)",
      "src/posts.ts:6 GET /api/stats [usePosts] <- src/client.ts:3 (heuristic)",
      "src/posts.ts:8 GET /api/drafts [usePosts] <- src/client.ts:3 (heuristic)",
      // The custom hook's key glued after `/api`: a hole there, as for any wrapper.
      "src/posts.ts:11 GET /api{} [useApi] <- src/client.ts:3 (heuristic)",
    ]);
  });

  it("follows no default when QueryClients set different ones", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/client.ts", [
      'import { QueryClient } from "@tanstack/react-query";',
      "export const a = async ({ queryKey }: any) => fetch(String(queryKey[0]));",
      "export const b = async ({ queryKey }: any) => fetch(`/v2${queryKey[0]}`);",
      "export const one = new QueryClient({ defaultOptions: { queries: { queryFn: a } } });",
      "export const two = new QueryClient({ defaultOptions: { queries: { queryFn: b } } });",
    ]);
    await put("src/posts.ts", [
      'import { useQuery } from "@tanstack/react-query";',
      'export const usePosts = () => useQuery({ queryKey: ["/posts"] });',
    ]);
    expect(await summary()).toEqual([
      `src/client.ts:2 GET ${LEADING} [a]`,
      "src/client.ts:3 GET /v2{} [b]",
    ]);
  });

  it("leaves look-alikes and unread shapes as they were", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/todos.ts", [
      'import { useQuery as useTanstack } from "@tanstack/react-query";',
      "const useQuery = (o: any) => o;",
      "const keys = { all: () => ['/api/all'] };",
      "export function useTodos() {",
      // Not TanStack's: a repo function of the same name.
      "  useQuery({ queryKey: ['/api/a'], queryFn: ({ queryKey }: any) => fetch(queryKey[0]) });",
      // v4's positional form isn't read.
      "  useTanstack(['/api/b'] as any, ({ queryKey }: any) => fetch(queryKey[0]));",
      // A key built by a call, and one read with `.join()`, can't be read.
      "  useTanstack({ queryKey: keys.all(), queryFn: ({ queryKey }: any) => fetch(queryKey[0]) });",
      "  useTanstack({ queryKey: ['api', 'c'], queryFn: ({ queryKey }: any) => fetch(queryKey.join('/')) });",
      "}",
    ]);
    expect(await summary()).toEqual([
      `src/todos.ts:5 GET ${LEADING} [useTodos]`,
      `src/todos.ts:6 GET ${LEADING} [useTodos]`,
      `src/todos.ts:7 GET ${LEADING} [useTodos]`,
      `src/todos.ts:8 GET ${LEADING} [useTodos]`,
    ]);
  });
});
