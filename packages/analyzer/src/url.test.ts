import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { collectHttpCalls } from "./http.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
import {
  createUrlNormalizer,
  formatUrlPattern,
  joinBaseURL,
  patternParts,
  resolveURL,
  toUrlPattern,
  type UrlPart,
} from "./url.js";
import { detectWorkspace } from "./workspace.js";

const t = (text: string): UrlPart => ({ kind: "text", text });
const H: UrlPart = { kind: "hole" };
const env = (name: string): UrlPart => ({ kind: "env", name });
const ORIGIN: UrlPart = { kind: "origin" };

/** `toUrlPattern` as text: the formatted pattern, or `DYNAMIC: <detail>`. */
function show(parts: readonly UrlPart[]): string {
  const result = toUrlPattern(parts);
  return "detail" in result ? `DYNAMIC: ${result.detail}` : formatUrlPattern(result.pattern);
}

/** Parts as compact text: holes `{}`, env vars `{env:X}`, the page origin `{origin}`. */
function partsText(parts: readonly UrlPart[]): string {
  return parts
    .map((p) =>
      p.kind === "text"
        ? p.text
        : p.kind === "hole"
          ? "{}"
          : p.kind === "env"
            ? `{env:${p.name}}`
            : "{origin}",
    )
    .join("");
}

describe("toUrlPattern", () => {
  it.each<[string, UrlPart[], string]>([
    ["a literal path", [t("/api/users")], "/api/users"],
    ["a hole segment", [t("/api/users/"), H], "/api/users/{}"],
    [
      "holes and text in one segment",
      [t("/files/"), H, t("-"), H, t(".json")],
      "/files/{}-{}.json",
    ],
    ["adjacent text", [t("/api"), t("/"), t("orders")], "/api/orders"],
    ["the root", [t("/")], "/"],
    ["a trailing slash", [t("/api/users/")], "/api/users"],
    ["doubled slashes", [t("/api//users")], "/api/users"],
    ["a query string", [t("/search?q="), H, t("&page=2")], "/search"],
    ["a fragment", [t("/docs#intro")], "/docs"],
    ["a query after a hole segment", [t("/u/"), H, t("?x")], "/u/{}"],
    [
      "a literal origin",
      [t("HTTPS://API.Example.com/V1/users")],
      "https://api.example.com/V1/users",
    ],
    ["an origin without a path", [t("https://api.example.com")], "https://api.example.com"],
    ["an origin with a query", [t("https://api.example.com?x=1")], "https://api.example.com"],
    ["a protocol-relative origin", [t("//cdn.example.com/x")], "//cdn.example.com/x"],
    ["a dynamic port", [t("http://localhost:"), H, t("/api")], "http://localhost:{}/api"],
    ["credentials", [t("https://user:pa55@API.x.com/v1")], "https://api.x.com/v1"],
    ["a dynamic password", [t("https://user:"), H, t("@api.x.com/v1")], "https://api.x.com/v1"],
    [
      "a dynamic host",
      [t("https://"), H, t(".example.com/x")],
      "DYNAMIC: the host is only known at runtime",
    ],
    ["an env base", [env("NEXT_PUBLIC_API_URL"), t("/orders")], "{env:NEXT_PUBLIC_API_URL}/orders"],
    ["an env base alone", [env("API_URL")], "{env:API_URL}"],
    ["an env var later on", [t("/api/"), env("VERSION"), t("/x")], "/api/{}/x"],
    ["the page origin", [ORIGIN, t("/api/x")], "/api/x"],
    ["the page origin later on", [t("/a/"), ORIGIN], "/a/{}"],
    ["a page-relative path", [t("api/users")], "./api/users"],
    ["the current page", [], "./"],
    ["only a query", [t("?page=2")], "./"],
    [
      "a leading hole",
      [H, t("/orders")],
      "DYNAMIC: the URL starts with a value only known at runtime",
    ],
    [
      "only holes after a base",
      [env("API_URL"), t("/"), H],
      "DYNAMIC: every path segment is only known at runtime",
    ],
    [
      "only holes on a path",
      [t("/"), H, t("/"), H],
      "DYNAMIC: every path segment is only known at runtime",
    ],
    ["only holes on a host", [t("https://api.stripe.com/"), H], "https://api.stripe.com/{}"],
    ["an empty host", [t("https:///x")], "DYNAMIC: the URL has an empty host"],
    ["only credentials", [t("https://user@/x")], "DYNAMIC: the URL has an empty host"],
    ["only a port", [t("http://:8080/x")], "DYNAMIC: the URL has an empty host"],
  ])("normalizes %s", (_name, parts, expected) => {
    expect(show(parts)).toBe(expected);
  });

  it("collapses runaway concatenations to a hole", () => {
    const many = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? t("/a") : H));
    expect(show(many)).toBe("DYNAMIC: the URL starts with a value only known at runtime");
  });
});

describe("joinBaseURL", () => {
  it.each<[string, UrlPart[], UrlPart[], string]>([
    ["one slash between", [t("/api/")], [t("/users")], "/api/users"],
    ["no slash on either side", [t("/api")], [t("users")], "/api/users"],
    ["a double trailing slash", [t("https://h//")], [t("x")], "https://h/x"],
    ["an absolute URL", [t("/api")], [t("https://other.com/x")], "https://other.com/x"],
    ["a protocol-relative URL", [t("/api")], [t("//other.com/x")], "//other.com/x"],
    ["an empty URL", [t("/api")], [], "/api"],
    ["an empty base", [], [t("/users")], "/users"],
    ["an env base", [env("API_URL")], [t("/users/"), H], "{env:API_URL}/users/{}"],
    ["a URL starting with a hole", [t("/api")], [H], "/api/{}"],
  ])("joins %s", (_name, base, url, expected) => {
    expect(partsText(joinBaseURL(base, url))).toBe(expected);
  });
});

describe("resolveURL", () => {
  it.each<[string, UrlPart[], UrlPart[], string]>([
    ["an absolute URL", [t("https://a.com/x")], [env("API")], "https://a.com/x"],
    ["two literals (root-relative)", [t("/x")], [t("https://h.com/api/")], "https://h.com/x"],
    ["two literals (relative)", [t("x")], [t("https://h.com/api/")], "https://h.com/api/x"],
    ["two literals (relative, no folder)", [t("x")], [t("https://h.com/api")], "https://h.com/x"],
    ["an invalid literal base", [t("x")], [t("/api")], "{}"],
    ["a root-relative URL on an env base", [t("/x/"), H], [env("API")], "{env:API}/x/{}"],
    ["a root-relative URL on the page origin", [t("/x")], [ORIGIN], "{origin}/x"],
    [
      "a root-relative URL on a literal origin",
      [t("/x/"), H],
      [t("https://h.com/api?q")],
      "https://h.com/x/{}",
    ],
    ["a root-relative URL on a host with a hole", [t("/x")], [t("https://h"), H], "{}"],
    ["a root-relative URL on a literal path", [t("/x/"), H], [t("/api")], "{}"],
    ["a relative URL on an env base", [t("x")], [env("API")], "{}"],
    ["a protocol-relative URL on an env base", [t("//h.com/x"), H], [env("API")], "{}"],
    ["a URL starting with a hole", [H], [t("https://h.com")], "{}"],
  ])("resolves %s", (_name, url, base, expected) => {
    expect(partsText(resolveURL(url, base))).toBe(expected);
  });
});

describe("toUrlPattern properties", () => {
  /** Text drawn from URL-ish characters, so slashes, origins, and queries all appear. */
  const urlText = fc
    .array(
      fc.constantFrom(
        "/",
        "//",
        "a",
        "B",
        "api",
        "x:",
        "http://",
        "https://",
        "?",
        "#",
        ":",
        "-",
        ".",
      ),
      { maxLength: 6 },
    )
    .map((pieces) => pieces.join(""));
  const part: fc.Arbitrary<UrlPart> = fc.oneof(
    { weight: 4, arbitrary: urlText.map(t) },
    { weight: 2, arbitrary: fc.constant(H) },
    { weight: 1, arbitrary: fc.constantFrom("API_URL", "X").map(env) },
    { weight: 1, arbitrary: fc.constant(ORIGIN) },
  );
  const parts = fc.array(part, { maxLength: 8 });

  it("is idempotent: a pattern reads back from its own parts unchanged", () => {
    fc.assert(
      fc.property(parts, (input) => {
        const first = toUrlPattern(input);
        if ("detail" in first) return;
        expect(toUrlPattern(patternParts(first.pattern))).toEqual(first);
      }),
      { numRuns: 2000, seed: 20261027 },
    );
  });

  it("never leaves an empty segment, a slash, a query, or a fragment in a segment", () => {
    fc.assert(
      fc.property(parts, (input) => {
        const result = toUrlPattern(input);
        if ("detail" in result) return;
        for (const segment of result.pattern.segments) {
          expect(segment.length).toBeGreaterThan(0);
          for (const p of segment) {
            if (p.kind === "text") expect(p.text).toMatch(/^[^/?#]+$/);
          }
        }
      }),
      { numRuns: 2000, seed: 20261027 },
    );
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-url-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string | string[]): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), Array.isArray(content) ? content.join("\n") + "\n" : content);
}

/** Collect the temp repo's call sites and normalize each: `file:line pattern (confidence)`. */
async function normalized(): Promise<string[]> {
  const inventory = await buildInventory(dir);
  const workspace = await detectWorkspace(dir, inventory.files);
  const programs = buildServicePrograms(dir, workspace, inventory);
  const resolver = createSymbolResolver(programs, workspace);
  const express = buildExpressRoutes(programs, resolver);
  const normalizer = createUrlNormalizer(resolver);
  return collectHttpCalls(programs, resolver, express.inlineHandlers).map((site) => {
    const result = normalizer.normalize(site);
    const where = `${site.file}:${site.site.line}`;
    if (!result.resolved) return `${where} DYNAMIC_URL: ${result.detail}`;
    return (
      `${where} ${result.text}` + (result.confidence === "exact" ? "" : ` (${result.confidence})`)
    );
  });
}

describe("createUrlNormalizer", () => {
  it("normalizes literals, templates, concatenation, consts, enums, and literal types", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/config.ts", [
      'export const API = "/api";',
      'export const ROUTES = { users: "/api/users", nested: { deep: "/deep" } } as const;',
      'export enum Path { Orders = "/api/orders" }',
      "export const PORT = 4000;",
      'declare const DECLARED: "/declared";',
      "export { DECLARED };",
    ]);
    await put("src/api.ts", [
      'import { API, ROUTES, Path, PORT, DECLARED } from "./config";',
      'import * as config from "./config";',
      "const LOCAL = `${API}/local`;",
      "export async function load(id: string, base: string, flag: boolean) {",
      '  await fetch("/api/users");',
      "  await fetch(`/api/users/${id}`);",
      '  await fetch("/api/users/" + id + "/posts");',
      "  await fetch(`${API}/orders`);",
      "  await fetch(LOCAL);",
      "  await fetch(ROUTES.users + `/${id}`);",
      '  await fetch(ROUTES["users"]);',
      "  await fetch(Path.Orders);",
      "  await fetch(`http://localhost:${PORT}/api`);",
      "  await fetch(DECLARED);",
      "  await fetch(config.API + '/ns');",
      '  await fetch(flag ? "/same" : "/same");',
      '  await fetch(flag ? "/a" : "/b");',
      "  await fetch(`${base}/x`);",
      "  await fetch(buildUrl());",
      "  await fetch(`/api/search?q=${id}`);",
      "  await fetch(`/api/${id}/`);",
      "  await fetch(`/${id}`);",
      "  await fetch(String(`/s/${id}`));",
      "  let later = '/later';",
      "  await fetch(later);",
      "  await fetch(ROUTES.missing);",
      "  await fetch(ROUTES.nested.deep);",
      "}",
      "declare function buildUrl(): string;",
    ]);
    expect(await normalized()).toEqual([
      "src/api.ts:5 /api/users",
      "src/api.ts:6 /api/users/{}",
      "src/api.ts:7 /api/users/{}/posts",
      "src/api.ts:8 /api/orders",
      "src/api.ts:9 /api/local",
      "src/api.ts:10 /api/users/{}",
      "src/api.ts:11 /api/users",
      "src/api.ts:12 /api/orders",
      "src/api.ts:13 http://localhost:4000/api",
      "src/api.ts:14 /declared",
      "src/api.ts:15 /api/ns",
      "src/api.ts:16 /same",
      "src/api.ts:17 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:18 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:19 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:20 /api/search",
      "src/api.ts:21 /api/{}",
      "src/api.ts:22 DYNAMIC_URL: every path segment is only known at runtime",
      "src/api.ts:23 /s/{}",
      "src/api.ts:25 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:26 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:27 /deep",
    ]);
  });

  it("reads env bases, the page origin, and new URL", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/env.ts", [
      "export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';",
      "export const { BACKEND_BASE_URL } = process.env;",
      "export const { RENAMED: OTHER = '' } = process.env;",
    ]);
    await put("src/api.ts", [
      'import { API_URL, BACKEND_BASE_URL, OTHER } from "./env";',
      'import { URL as NodeURL } from "node:url";',
      "export async function load(id: string) {",
      "  await fetch(`${process.env.NEXT_PUBLIC_API_URL}/orders`);",
      "  await fetch(process.env['API_URL'] + '/orders/' + id);",
      "  await fetch(`${import.meta.env.VITE_API_URL}/v`);",
      "  await fetch(`${API_URL}/users`);",
      "  await fetch(`${BACKEND_BASE_URL}/b`);",
      "  await fetch(`${OTHER}/o`);",
      "  await fetch(`${process.env.A || process.env.B}/x`);",
      "  await fetch(`/v/${process.env.VERSION}/x`);",
      "  await fetch(`${window.location.origin}/api/me`);",
      "  await fetch(location.origin + '/api/you');",
      "  await fetch(new URL('/api/x', process.env.API_URL));",
      "  await fetch(new URL(`/api/x/${id}`, window.location.origin).toString());",
      "  await fetch(new URL('y', 'https://h.com/api/').href);",
      "  const u = new NodeURL('/node', 'https://n.com');",
      "  await fetch(u.href);",
      "  await fetch(new URL('rel', process.env.API_URL));",
      "  await fetch(new URL('https://abs.com/a'));",
      "  await fetch(`${process.env.API_URL}/${id}`);",
      "}",
    ]);
    expect(await normalized()).toEqual([
      "src/api.ts:4 {env:NEXT_PUBLIC_API_URL}/orders",
      "src/api.ts:5 {env:API_URL}/orders/{}",
      "src/api.ts:6 {env:VITE_API_URL}/v",
      "src/api.ts:7 {env:NEXT_PUBLIC_API_URL}/users",
      "src/api.ts:8 {env:BACKEND_BASE_URL}/b",
      "src/api.ts:9 {env:RENAMED}/o",
      "src/api.ts:10 {env:A}/x",
      "src/api.ts:11 /v/{}/x",
      "src/api.ts:12 /api/me",
      "src/api.ts:13 /api/you",
      "src/api.ts:14 {env:API_URL}/api/x",
      "src/api.ts:15 /api/x/{}",
      "src/api.ts:16 https://h.com/api/y",
      "src/api.ts:18 https://n.com/node",
      "src/api.ts:19 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:20 https://abs.com/a",
      "src/api.ts:21 DYNAMIC_URL: every path segment is only known at runtime",
    ]);
  });

  it("ignores repo-declared look-alikes of process, location, and URL", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      "const process = { env: { API: '/fake' } };",
      "const location = { origin: 'https://fake.com' };",
      "class URL { constructor(public a: string, public b?: string) {} }",
      "export async function load() {",
      "  await fetch(`${process.env.API}/x`);",
      "  await fetch(`${location.origin}/y`);",
      "  await fetch(new URL('/z', 'https://h.com') as unknown as string);",
      "}",
    ]);
    expect(await normalized()).toEqual([
      "src/api.ts:5 /fake/x",
      "src/api.ts:6 https://fake.com/y",
      "src/api.ts:7 DYNAMIC_URL: the URL starts with a value only known at runtime",
    ]);
  });

  it("combines axios baseURLs the way axios does", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      'import axios from "axios";',
      "const api = axios.create({ baseURL: `${process.env.NEXT_PUBLIC_API_URL}/api/` });",
      'const local = axios.create({ baseURL: "/api" });',
      "declare const config: object;",
      "const unknown = axios.create(config);",
      "declare function makeBase(): string;",
      "const runtime = axios.create({ baseURL: makeBase() });",
      'const empty = axios.create({ baseURL: "" });',
      "export async function load(id: string) {",
      "  await api.get(`/users/${id}`);",
      '  await local.post("orders", {});',
      '  await local.get("https://other.com/x");',
      '  await local.get("");',
      '  await unknown.get("/u");',
      '  await unknown.get("https://abs.com/u");',
      '  await runtime.get("/r");',
      '  await empty.get("/e");',
      '  await axios.get("/plain");',
      "}",
    ]);
    expect(await normalized()).toEqual([
      "src/api.ts:10 {env:NEXT_PUBLIC_API_URL}/api/users/{}",
      "src/api.ts:11 /api/orders",
      "src/api.ts:12 https://other.com/x",
      "src/api.ts:13 /api",
      "src/api.ts:14 DYNAMIC_URL: the axios baseURL can't be read statically",
      "src/api.ts:15 https://abs.com/u",
      "src/api.ts:16 DYNAMIC_URL: the axios baseURL starts with a value only known at runtime",
      "src/api.ts:17 /e",
      "src/api.ts:18 /plain",
    ]);
  });

  it("marks unreadable URLs dynamic", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      "export function load(args: [string]) {",
      "  return fetch(...args);",
      "}",
    ]);
    expect(await normalized()).toEqual([
      "src/api.ts:2 DYNAMIC_URL: the URL can't be read statically",
    ]);
  });

  it("gives up on exponentially repeated consts and huge text quickly (M2 review)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    // Each const repeats the last ten times: 10^8 expressions, 10^7 characters if evaluated.
    const lines = ['const a0 = "x";'];
    for (let i = 1; i <= 8; i++) {
      lines.push(`const a${i} = \`${`\${a${i - 1}}`.repeat(10)}\`;`);
    }
    lines.push(
      `const big = "/${"y".repeat(3000)}";`,
      "export const deep = () => fetch('/' + a8);",
      "export const long = () => fetch(big);",
      "export const ok = () => fetch(`/api/${a2}`);",
    );
    await put("src/api.ts", lines);
    const started = performance.now();
    expect(await normalized()).toEqual([
      "src/api.ts:11 DYNAMIC_URL: the URL is too large or too complex to read statically",
      "src/api.ts:12 DYNAMIC_URL: the URL is too large or too complex to read statically",
      `src/api.ts:13 /api/${"x".repeat(100)}`,
    ]);
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it("takes the confidence of a heuristic workspace import a const came through", async () => {
    await put("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    // No `main`/`exports`, so `@acme/config` resolves to `src/index.ts` heuristically (M1.8).
    await put("packages/config/package.json", JSON.stringify({ name: "@acme/config" }));
    await put("packages/config/src/index.ts", [
      'export const API_BASE = "/api";',
      'export const ROUTES = { me: "/api/me" };',
    ]);
    await put(
      "packages/web/package.json",
      JSON.stringify({ name: "web", dependencies: { "@acme/config": "*" } }),
    );
    await put("packages/web/src/api.ts", [
      'import { API_BASE, ROUTES } from "@acme/config";',
      "export async function load() {",
      "  await fetch(`${API_BASE}/users`);",
      "  await fetch(ROUTES.me);",
      '  await fetch("/api/plain");',
      "}",
    ]);
    expect(await normalized()).toEqual([
      "packages/web/src/api.ts:3 /api/users (heuristic)",
      "packages/web/src/api.ts:4 /api/me (heuristic)",
      "packages/web/src/api.ts:5 /api/plain",
    ]);
  });

  it("evaluates expressions to parts for wrapper inlining", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      'const BASE = "/api";',
      "export const load = (p: string) => fetch(BASE + p);",
    ]);
    const inventory = await buildInventory(dir);
    const workspace = await detectWorkspace(dir, inventory.files);
    const programs = buildServicePrograms(dir, workspace, inventory);
    const resolver = createSymbolResolver(programs, workspace);
    const [site] = collectHttpCalls(programs, resolver);
    if (!site?.url) throw new Error("expected one fetch with a URL");
    expect(partsText(createUrlNormalizer(resolver).parts(site.url))).toBe("/api{}");
  });
});
