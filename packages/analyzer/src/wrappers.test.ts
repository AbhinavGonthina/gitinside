import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { collectHttpCalls } from "./http.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
import { createUrlNormalizer } from "./url.js";
import { inlineWrappers, type HttpRequest } from "./wrappers.js";
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
  const sites = collectHttpCalls(programs, resolver, express.inlineHandlers);
  return inlineWrappers(
    sites,
    programs,
    resolver,
    createUrlNormalizer(resolver),
    express.inlineHandlers,
  );
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
