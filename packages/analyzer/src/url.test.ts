import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSymbolResolver } from "./calls.js";
import { collectHttpCalls } from "./http.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
import {
  createUrlNormalizer,
  formatUrlPattern,
  joinBaseURL,
  leadingHoles,
  originHoles,
  MAX_PATHS,
  patternParts,
  resolveKyBaseUrl,
  resolveURL,
  toUrlPattern,
  type UrlPart,
  withBase,
} from "./url.js";
import { detectWorkspace } from "./workspace.js";

const t = (text: string): UrlPart => ({ kind: "text", text });
const H: UrlPart = { kind: "hole" };
const env = (name: string): UrlPart => ({ kind: "env", name });
/** An env var read with a fallback (`process.env.X ?? "…"`). */
const envOr = (name: string, fallback: UrlPart[]): UrlPart => ({ kind: "env", name, fallback });
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
    [
      "an env base with a fallback's path",
      [envOr("API_URL", [t("http://localhost:4000/api/v1/")]), t("/auth/login")],
      "{env:API_URL}/api/v1/auth/login",
    ],
    [
      "an env base with a root-relative fallback",
      [envOr("API_URL", [t("/api?x=1")]), t("/users")],
      "{env:API_URL}/api/users",
    ],
    [
      "an env base with an origin-only fallback",
      [envOr("API_URL", [t("http://localhost:4000")]), t("/users")],
      "{env:API_URL}/users",
    ],
    [
      "an env base whose fallback's path has a hole",
      [envOr("API_URL", [t("http://localhost:4000/"), H]), t("/users")],
      "{env:API_URL}/users",
    ],
    [
      "an env base whose fallback is another env var",
      [envOr("A", [env("B")]), t("/x")],
      "{env:A}/x",
    ],
    [
      "an env base with a page-relative fallback",
      [envOr("API_URL", [t("api")]), t("/x")],
      "{env:API_URL}/x",
    ],
    [
      "an env var later on with a literal fallback",
      [t("/api/"), envOr("VERSION", [t("v1")]), t("/x")],
      "/api/v1/x",
    ],
    [
      "an env var later on with a fallback holding an env var",
      [t("/api/"), envOr("VERSION", [env("OTHER")]), t("/x")],
      "/api/{}/x",
    ],
    [
      "an env var later on with an absolute URL fallback",
      [env("API_URL"), t("/"), envOr("UPLOAD", [t("http://localhost:5000")]), t("/upload")],
      "{env:API_URL}/{}/upload",
    ],
    [
      "an env var later on with a protocol-relative fallback",
      [t("/api/"), envOr("CDN", [t("//cdn.example.com/x")]), t("/y")],
      "/api/{}/y",
    ],
    [
      "an env var later on with a scheme in a later fallback part",
      [t("/api/"), envOr("CDN", [H, t("://h/x")]), t("/y")],
      "/api/{}/y",
    ],
    [
      "an env var later on with a URL only in its fallback's query",
      [t("/api/"), envOr("VERSION", [t("v1?next=http://h")])],
      "/api/v1",
    ],
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

  it("keeps a literal fallback's host on an env base, and only that", () => {
    const base = (input: UrlPart[]): unknown => {
      const result = toUrlPattern(input);
      return "pattern" in result ? result.pattern.base : result.detail;
    };
    expect(base([envOr("X", [t("HTTP://user:pw@LocalHost:4000/api/v1")]), t("/a")])).toEqual({
      kind: "env",
      name: "X",
      fallbackHost: "localhost:4000",
    });
    expect(base([envOr("X", [t("http://localhost:"), H, t("/api")]), t("/a")])).toEqual({
      kind: "env",
      name: "X",
      fallbackHost: "localhost:{}",
    });
    expect(base([envOr("X", [t("/api")]), t("/a")])).toEqual({ kind: "env", name: "X" });
    expect(base([envOr("X", [t("http://localhost/"), H]), t("/a")])).toEqual({
      kind: "env",
      name: "X",
    });
  });

  it("collapses runaway concatenations to a hole", () => {
    const many = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? t("/a") : H));
    expect(show(many)).toBe("DYNAMIC: the URL starts with a value only known at runtime");
  });
});

describe("leadingHoles (M5A.3j)", () => {
  /** `parts` with `P` marking a parameter hole; the leading ones, in order, as `true`. */
  const P = (): UrlPart => ({ kind: "hole", param: true });
  const leading = (parts: UrlPart[]): boolean[] => {
    const found = leadingHoles(parts);
    return parts.filter((p) => p.kind === "hole" && p.param).map((p) => found.has(p));
  };

  it.each<[string, UrlPart[], boolean[]]>([
    ["the whole URL", [P()], [true]],
    ["the URL then a query", [P(), t("?x=1")], [true]],
    ["right after an env base", [env("API"), P()], [true]],
    ["glued to the path's text", [t("/api"), P()], [true]],
    ["glued after a literal origin's path", [t("https://a.example.com/v1"), P()], [true]],
    ["the first segment after a base", [env("API"), t("/"), P()], [true]],
    ["the first segment of a root path", [t("/"), P()], [true]],
    // Only the origin (M5C.10b): the path after it is fixed.
    ["in the host", [t("https://"), P(), t("/x")], [false]],
    ["in the port", [t("http://localhost:"), P(), t("/x")], [false]],
    ["in a protocol-relative host", [t("//"), P(), t("/x")], [false]],
    ["in a host's label", [t("https://api."), P(), t(".example.com/x")], [false]],
    ["in a password", [t("https://u:"), P(), t("@h/x")], [false]],
    ["a port, then a path glued to it", [t("http://localhost:"), P(), P()], [false, true]],
    ["a host, then a path glued to it", [t("https://"), P(), P()], [false, true]],
    ["a port, then the first segment", [t("http://h:"), P(), t("/"), P()], [false, true]],
    ["glued to a literal host", [t("http://localhost"), P()], [true]],
    ["glued to a literal port", [t("http://localhost:3000"), P()], [true]],
    ["glued to an IPv6 host", [t("http://[::1]"), P()], [true]],
    ["a later segment", [env("API"), t("/conversation/"), P()], [false]],
    ["a later root-relative segment", [t("/api/posts/"), P()], [false]],
    ["a page-relative segment", [t("users/"), P()], [false]],
    ["the query", [t("https://a.example.com/m?key="), P()], [false]],
    ["the fragment", [t("/a#"), P()], [false]],
    ["after another hole in its segment", [t("/c/"), P(), t("-"), P()], [false, false]],
    ["a path, then an id", [env("API"), P(), t("/"), P()], [true, false]],
    ["after a non-parameter hole that starts the URL", [H, P()], [true]],
  ])("%s", (_name, parts, expected) => {
    expect(leading(parts)).toEqual(expected);
  });

  it("ignores holes that aren't parameters", () => {
    expect(leadingHoles([H, t("/x/"), H]).size).toBe(0);
  });
});

describe("originHoles (M5C.10b)", () => {
  const P = (): UrlPart => ({ kind: "hole", param: true });
  const origin = (parts: UrlPart[]): boolean[] => {
    const found = originHoles(parts);
    return parts.filter((p) => p.kind === "hole" && p.param).map((p) => found.has(p));
  };

  it.each<[string, UrlPart[], boolean[]]>([
    ["the port", [t("http://127.0.0.1:"), P(), t("/api/health")], [true]],
    ["the host", [t("https://"), P(), t("/x")], [true]],
    ["a host, then a path glued to it", [t("https://"), P(), P()], [true, false]],
    ["glued to a literal host", [t("http://localhost"), P()], [false]],
    ["the whole URL", [P(), t("/x")], [false]],
    ["after an env base", [env("API"), t(":"), P()], [false]],
    ["in the path", [t("http://h/"), P()], [false]],
    ["in the query", [t("http://h?x="), P()], [false]],
  ])("%s", (_name, parts, expected) => {
    expect(origin(parts)).toEqual(expected);
  });

  it("ignores holes that aren't parameters", () => {
    expect(originHoles([t("http://h:"), H, t("/x")]).size).toBe(0);
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

describe("withBase (ofetch, M5C.3c)", () => {
  it.each<[string, UrlPart[], UrlPart[], string]>([
    ["a URL already under the base", [t("/api")], [t("/api/users")], "/api/users"],
    ["a base with a trailing slash", [t("/api/")], [t("/api/users")], "/api/users"],
    ["a URL under the base, then a hole", [t("/api")], [t("/api/users/"), H], "/api/users/{}"],
    ["a plain prefix test, as ufo's", [t("/api")], [t("/apiary")], "/apiary"],
    ["the root base", [t("/")], [t("/users")], "/users"],
    ["a URL outside the base", [t("/api")], [t("/users")], "/api/users"],
    ["a relative URL", [t("/api")], [t("users")], "/api/users"],
    ["an absolute base", [t("https://h.com/v1")], [t("/v1/x")], "https://h.com/v1/v1/x"],
    [
      "an absolute base, URL under it",
      [t("https://h.com")],
      [t("https://h.com/x")],
      "https://h.com/x",
    ],
    ["an env base (not compared)", [env("API_URL")], [t("/users")], "{env:API_URL}/users"],
    ["a base with a hole (not compared)", [t("/api/"), H], [t("/api/x")], "/api/{}/api/x"],
    ["a URL starting with a hole", [t("/api")], [H], "/api/{}"],
    ["an empty base", [], [t("/users")], "/users"],
  ])("joins %s", (_name, base, url, expected) => {
    expect(partsText(withBase(base, url))).toBe(expected);
  });
});

describe("resolveKyBaseUrl (ky 2's baseUrl, M5C.3e)", () => {
  it.each<[string, UrlPart[], UrlPart[], string]>([
    ["a relative URL on a base with a trailing slash", [t("/api/")], [t("users")], "/api/users"],
    ["a relative URL on a base without one", [t("/api")], [t("users")], "/users"],
    ["a root-relative URL on a relative base", [t("/api/")], [t("/users")], "/users"],
    [
      "a root-relative URL on an absolute base",
      [t("https://h.com/api/")],
      [t("/users")],
      "https://h.com/users",
    ],
    ["a relative URL on a bare origin", [t("https://h.com")], [t("users")], "https://h.com/users"],
    [
      "a relative URL on an absolute base",
      [t("https://h.com/v1/x")],
      [t("users/"), H],
      "https://h.com/v1/users/{}",
    ],
    ["a root-relative URL on an env base", [env("API")], [t("/users")], "{env:API}/users"],
    ["a relative URL on an env base's path", [env("API"), t("/v1/")], [t("u")], "{env:API}/v1/u"],
    ["a relative URL on an env base alone", [env("API")], [t("users")], "{}"],
    ["a relative URL after a hole", [t("/a/"), H], [t("users")], "{}"],
    ["a dot segment", [t("/api/")], [t("./users")], "{}"],
    ["a query", [t("/api/")], [t("?q=1")], "{}"],
    ["a protocol-relative URL", [t("/api/")], [t("//h.com/x")], "{}"],
    ["an empty base", [], [t("users")], "users"],
  ])("resolves %s", (_name, base, url, expected) => {
    expect(partsText(resolveKyBaseUrl(base, url))).toBe(expected);
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

  it("keeps only the origin of an env base's fallback for a root-relative URL", () => {
    const base = [envOr("API", [t("http://localhost:4000/api/v1")])];
    expect(resolveURL([t("/x")], base)).toEqual([
      envOr("API", [t("http://localhost:4000")]),
      t("/x"),
    ]);
    expect(resolveURL([t("/x")], [envOr("API", [t("/api/v1")])])).toEqual([env("API"), t("/x")]);
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
    {
      weight: 1,
      arbitrary: fc
        .array(fc.oneof(urlText.map(t), fc.constant(H)), { maxLength: 3 })
        .map((fallback) => envOr("API_URL", fallback)),
    },
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
  const normalizer = createUrlNormalizer(resolver);
  return collectHttpCalls(programs, resolver).map((site) => {
    const result = normalizer.normalize(site);
    const where = `${site.file}:${site.site.line}`;
    if (!result.resolved) return `${where} DYNAMIC_URL: ${result.detail}`;
    return (
      `${where} ${result.text}` + (result.confidence === "exact" ? "" : ` (${result.confidence})`)
    );
  });
}

/** Like {@link normalized}, with every alternative: `file:line a | b`. */
async function alternativesOf(): Promise<string[]> {
  const inventory = await buildInventory(dir);
  const workspace = await detectWorkspace(dir, inventory.files);
  const programs = buildServicePrograms(dir, workspace, inventory);
  const resolver = createSymbolResolver(programs, workspace);
  const normalizer = createUrlNormalizer(resolver);
  return collectHttpCalls(programs, resolver).map((site) => {
    const shown = normalizer
      .alternatives(site)
      .map((result) => (result.resolved ? result.text : `DYNAMIC_URL: ${result.detail}`));
    return `${site.file}:${site.site.line} ${shown.join(" | ")}`;
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
      "src/api.ts:25 /later",
      "src/api.ts:26 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:27 /deep",
    ]);
  });

  it("reads URLs returned by repo string-builder functions, with the call's arguments (M5C.7d)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/urls.ts", [
      'const API = "/api";',
      "export function userUrl(id: string) {",
      "  return `${API}/users/${id}`;",
      "}",
      "export const postUrl = (id: string) => API + '/posts/' + id;",
      "const chatPath = (chatId: string) => `${API}/chats/${chatId}`;",
      "export const chatUrls = {",
      "  messages: (chatId: string) => `${chatPath(chatId)}/messages`,",
      "  files(chatId: string) { return chatPath(chatId) + '/files'; },",
      "  chatPath,",
      "} as const;",
      "export const withDefault = (page = 'first') => `/api/pages/${page}`;",
      "export const trimmed = (base: string) => base.replace(/x$/, '');",
      "export const twoSteps = (id: string) => { const p = `/api/x/${id}`; return p; };",
      "export const rest = (...parts: string[]) => `/api/${parts[0]}`;",
      "export async function later(id: string) { return `/api/later/${id}`; }",
      'export const loop = (x: string): string => loop(x) + "/a";',
      "export let mutable = (id: string) => `/api/m/${id}`;",
    ]);
    await put("src/api.ts", [
      'import { userUrl, postUrl, chatUrls, withDefault, trimmed } from "./urls";',
      'import { twoSteps, rest, later, loop, mutable } from "./urls";',
      "export async function load(id: string) {",
      "  await fetch(userUrl(id));",
      '  await fetch(userUrl("me"));',
      "  await fetch(postUrl(id));",
      "  await fetch(chatUrls.messages(id));",
      '  await fetch(chatUrls.files("c1"));',
      "  await fetch(chatUrls.chatPath(id));",
      '  await fetch(chatUrls["messages"]("c2"));',
      "  await fetch(withDefault());",
      '  await fetch(withDefault("2"));',
      "  await fetch(`${userUrl(id)}/avatar`);",
      '  await fetch(new URL(userUrl(id), "http://localhost:4000"));',
      '  await fetch(trimmed("/api/t") + "/x");',
      "  await fetch(twoSteps(id));",
      '  await fetch(rest("a"));',
      "  await fetch(later(id) as unknown as string);",
      '  await fetch(loop("/b"));',
      "  await fetch(mutable(id));",
      "  await fetch(userUrl(...[id]));",
      "}",
    ]);
    await put("src/fake.ts", [
      "export function useCallback(fn: unknown, deps: unknown[]) {",
      '  return (path: string) => "/fake" + path;',
      "}",
    ]);
    await put("src/Board.tsx", [
      'import { useCallback, useMemo } from "react";',
      'import * as React from "react";',
      'import { useCallback as useLookAlike } from "./fake";',
      'const API_BASE = "http://localhost:5000/api";',
      "export function Board({ id }: { id: string }) {",
      "  const apiUrl = useCallback((path: string) => `${API_BASE}${path}`, []);",
      "  const roomUrl = useMemo(() => (room: string) => `/api/rooms/${room}`, []);",
      "  const other = React.useCallback((p: string) => '/api/o' + p, []);",
      "  const look = useLookAlike((p: string) => `/api/look${p}`, []);",
      '  void fetch(apiUrl("/realtime/move"));',
      "  void fetch(roomUrl(id));",
      '  void fetch(other("/k"));',
      '  void fetch(look("/l"));',
      "  return null;",
      "}",
    ]);
    const leading = "DYNAMIC_URL: the URL starts with a value only known at runtime";
    expect(await normalized()).toEqual([
      "src/Board.tsx:10 http://localhost:5000/api/realtime/move",
      "src/Board.tsx:11 /api/rooms/{}",
      "src/Board.tsx:12 /api/o/k",
      `src/Board.tsx:13 ${leading}`,
      "src/api.ts:4 /api/users/{}",
      "src/api.ts:5 /api/users/me",
      "src/api.ts:6 /api/posts/{}",
      "src/api.ts:7 /api/chats/{}/messages",
      "src/api.ts:8 /api/chats/c1/files",
      "src/api.ts:9 /api/chats/{}",
      "src/api.ts:10 /api/chats/c2/messages",
      "src/api.ts:11 /api/pages/first",
      "src/api.ts:12 /api/pages/2",
      "src/api.ts:13 /api/users/{}/avatar",
      "src/api.ts:14 http://localhost:4000/api/users/{}",
      `src/api.ts:15 ${leading}`,
      `src/api.ts:16 ${leading}`,
      `src/api.ts:17 ${leading}`,
      `src/api.ts:18 ${leading}`,
      `src/api.ts:19 ${leading}`,
      `src/api.ts:20 ${leading}`,
      `src/api.ts:21 ${leading}`,
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

  it("keeps an env var's literal fallback: its path on a base, its text later on", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/env.ts", [
      'export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";',
      "export const HOST = process.env.REACT_APP_HOST || 'http://localhost:9000';",
      "export const VERSION = process.env.REACT_APP_VERSION || 'v1';",
      "const PORT = 4000;",
      "export const LOCAL = process.env.SERVER_URL ?? `http://localhost:${PORT}/api`;",
    ]);
    await put("src/api.ts", [
      'import { API_URL, HOST, VERSION, LOCAL } from "./env";',
      "declare const runtime: string;",
      "export async function load(id: string) {",
      "  await fetch(`${API_URL}/auth/login`);",
      "  await fetch(`${HOST}/api/${VERSION}/authenticate`);",
      "  await fetch(`${LOCAL}/users/${id}`);",
      "  await fetch(`${process.env.API_URL ?? runtime}/x`);",
      "  await fetch(`/api/${process.env.V ?? runtime}/x`);",
      "  await fetch(new URL('/root', API_URL));",
      "}",
    ]);
    expect(await normalized()).toEqual([
      "src/api.ts:4 {env:NEXT_PUBLIC_API_URL}/api/v1/auth/login",
      "src/api.ts:5 {env:REACT_APP_HOST}/api/v1/authenticate",
      "src/api.ts:6 {env:SERVER_URL}/api/users/{}",
      "src/api.ts:7 {env:API_URL}/x",
      "src/api.ts:8 /api/{}/x",
      "src/api.ts:9 {env:NEXT_PUBLIC_API_URL}/root",
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

  it("keeps globals whose properties a JS file assigns (M5C.7e2)", async () => {
    // TypeScript binds a JS file's top-level `process.env.X = …` as a declaration of
    // `process` in that file; the global is still the global everywhere else.
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("scripts/setup.mjs", [
      'process.env.NODE_ENV = "test";',
      "process.exitCode = 0;",
      'window.title = "x";',
      'location.hash = "";',
      "String.custom = 1;",
      "URL.custom = 1;",
      "export {};",
    ]);
    await put("scripts/plain.js", ['process.env.DEBUG = "1";']);
    await put("src/api.ts", [
      "const base = process.env.LOAD_BASE_URL!;",
      "export async function load(id: string) {",
      "  await fetch(`${base}/api/a`);",
      "  await fetch(`${window.location.origin}/api/b`);",
      "  await fetch(location.origin + '/api/c');",
      "  await fetch(String(`/api/d/${id}`));",
      "  await fetch(new URL('/api/e', new URL(process.env.LOAD_BASE_URL!)));",
      "}",
    ]);
    expect(await normalized()).toEqual([
      "src/api.ts:3 {env:LOAD_BASE_URL}/api/a",
      "src/api.ts:4 /api/b",
      "src/api.ts:5 /api/c",
      "src/api.ts:6 /api/d/{}",
      "src/api.ts:7 {env:LOAD_BASE_URL}/api/e",
    ]);
  });

  it("still treats a JS file's own declaration of process as a look-alike", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("scripts/shadow.js", [
      "var process = { env: { API: '/fake' } };",
      'process.env.NODE_ENV = "test";',
    ]);
    await put("src/api.ts", ["export const load = () => fetch(`${process.env.API}/x`);"]);
    expect(await normalized()).toEqual([
      "src/api.ts:1 DYNAMIC_URL: the URL starts with a value only known at runtime",
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

  it("gives one URL per ternary branch and per value a let may hold (M5A.3h)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      'const BASE = "/api";',
      "declare const runtime: () => string;",
      "export async function load(id: string, flag: boolean, admin: boolean, page?: number) {",
      '  const endpoint = flag ? "/api/featured" : `/api/categories/${id}`;',
      "  await fetch(endpoint);",
      "  await fetch(`/api/sub${page ? '?page=' + page : ''}`);",
      "  let url = `${BASE}/posts/${id}`;",
      "  if (admin) {",
      "    url = `${BASE}/posts/admin/${id}`;",
      "  }",
      "  await fetch(url);",
      "  let only = '/first';",
      "  only = '/second';",
      "  await fetch(only);",
      "  let both;",
      "  if (flag) both = '/yes';",
      "  else both = '/no';",
      "  await fetch(both);",
      "  let early = '/stay';",
      "  if (flag) {",
      "    early = '/left';",
      "    return;",
      "  }",
      "  await fetch(early);",
      "  let q = '/q';",
      "  q = q + '/more';",
      "  await fetch(q);",
      "  await fetch(flag ? '/a' : runtime());",
      "  await fetch(flag ? (admin ? '/x' : '/y') : '/z');",
      "}",
    ]);
    expect(await alternativesOf()).toEqual([
      "src/api.ts:5 /api/featured | /api/categories/{}",
      "src/api.ts:6 /api/sub",
      "src/api.ts:11 /api/posts/{} | /api/posts/admin/{}",
      "src/api.ts:14 /second",
      "src/api.ts:18 /yes | /no",
      "src/api.ts:24 /stay",
      "src/api.ts:27 /q/more",
      "src/api.ts:28 /a | DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:29 /x | /y | /z",
    ]);
    // `normalize` still reads one URL: options that differ are a hole.
    expect(await normalized()).toEqual([
      "src/api.ts:5 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:6 /api/sub{}",
      "src/api.ts:11 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:14 /second",
      "src/api.ts:18 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:24 /stay",
      "src/api.ts:27 /q/more",
      "src/api.ts:28 DYNAMIC_URL: the URL starts with a value only known at runtime",
      "src/api.ts:29 DYNAMIC_URL: the URL starts with a value only known at runtime",
    ]);
  });

  it("leaves a let unknown when a write can't be placed (M5A.3h)", async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      "export let exported = '/e';",
      "declare const items: string[];",
      "export async function load(flag: boolean) {",
      "  let plus = '/p';",
      "  plus += '/x';",
      "  await fetch(plus);",
      "  let later = '/l';",
      "  setTimeout(() => { later = '/t'; });",
      "  await fetch(later);",
      "  let looped = '/one';",
      "  for (const item of items) {",
      "    await fetch(looped);",
      "    looped = '/two';",
      "  }",
      "  let inner = '/i';",
      "  const read = () => fetch(inner);",
      "  await read();",
      "  let unset;",
      "  await fetch(unset);",
      "  let guarded = '/g';",
      "  flag && (guarded = '/h');",
      "  await fetch(guarded);",
      "  await fetch(exported);",
      "  var old = '/v';",
      "  await fetch(old);",
      "  let after = '/before';",
      "  await fetch(after);",
      "  after = '/after';",
      "}",
    ]);
    const dynamic = "DYNAMIC_URL: the URL starts with a value only known at runtime";
    expect(await alternativesOf()).toEqual([
      `src/api.ts:6 ${dynamic}`,
      `src/api.ts:9 ${dynamic}`,
      `src/api.ts:12 ${dynamic}`,
      `src/api.ts:16 ${dynamic}`,
      `src/api.ts:19 ${dynamic}`,
      `src/api.ts:22 ${dynamic}`,
      `src/api.ts:23 ${dynamic}`,
      `src/api.ts:25 ${dynamic}`,
      "src/api.ts:27 /before",
    ]);
  });

  it(`falls back to one URL past ${MAX_PATHS} paths (M5A.3h)`, async () => {
    await put("package.json", JSON.stringify({ name: "web" }));
    await put("src/api.ts", [
      "export async function load(a: boolean, b: boolean, c: boolean, d: boolean) {",
      "  await fetch(`/${a ? 'a' : 'A'}/${b ? 'b' : 'B'}/${c ? 'c' : 'C'}`);",
      "  await fetch(`/${a ? 'a' : 'A'}/${b ? 'b' : 'B'}/${c ? 'c' : 'C'}/${d ? 'd' : 'D'}`);",
      "}",
    ]);
    const [eight, sixteen] = await alternativesOf();
    expect(eight?.split(" | ")).toHaveLength(8);
    expect(sixteen).toBe("src/api.ts:3 DYNAMIC_URL: every path segment is only known at runtime");
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
