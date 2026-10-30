import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareStrings, type ArchitectureGraph } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { createSymbolResolver } from "./calls.js";
import { buildInventory } from "./inventory.js";
import {
  checkedMethods,
  collectNextFacts,
  composeNextRoutes,
  handledMethods,
  segmentsToPath,
  type NextFacts,
} from "./next.js";
import { buildServicePrograms } from "./program.js";
import { detectWorkspace } from "./workspace.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-next-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string | string[]): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), Array.isArray(content) ? content.join("\n") + "\n" : content);
}

async function nextApp(dependencies: Record<string, string> = { next: "15" }): Promise<void> {
  await put("package.json", JSON.stringify({ name: "web", dependencies }));
}

/** Route and page node IDs with the kind prefix kept. */
function entries(graph: ArchitectureGraph): string[] {
  return graph.nodes.filter((n) => n.kind === "route" || n.kind === "page").map((n) => n.id);
}

/** `kind from -> to (confidence)` for each handles/renders edge, sorted. */
function links(graph: ArchitectureGraph): string[] {
  return graph.edges
    .filter((e) => e.kind === "handles" || e.kind === "renders")
    .map((e) => `${e.kind} ${e.from} -> ${e.to} (${e.confidence})`)
    .sort(compareStrings);
}

function nextWarnings(graph: ArchitectureGraph): ArchitectureGraph["warnings"] {
  return graph.warnings.filter((w) => w.code.startsWith("NEXT"));
}

describe("segmentsToPath", () => {
  it.each([
    [[], "app", "/"],
    [["blog", "[slug]"], "app", "/blog/:slug"],
    [["docs", "[...rest]"], "app", "/docs/*rest"],
    [["shop", "[[...filters]]"], "app", "/shop/*filters"],
    [["(marketing)", "about"], "app", "/about"],
    [["@modal", "login"], "app", "/login"],
    [["_lib", "x"], "app", undefined],
    [["_lib", "x"], "pages", "/_lib/x"],
    [["feed", "(.)photo"], "app", undefined],
    [["feed", "(..)photo"], "app", undefined],
    [["feed", "(...)photo"], "app", undefined],
    [["feed", "(..)(..)photo"], "app", undefined],
  ] as const)("maps %j (%s) to %j", (segments, router, expected) => {
    expect(segmentsToPath(segments, router)).toBe(expected);
  });
});

describe("checkedMethods", () => {
  const handler = (code: string): ts.SignatureDeclaration => {
    const sourceFile = ts.createSourceFile("h.ts", code, ts.ScriptTarget.ES2022, true);
    const statement = sourceFile.statements[0];
    if (!statement || !ts.isFunctionDeclaration(statement)) throw new Error("no function");
    return statement;
  };

  it.each([
    ['function h(req, res) { if (req.method === "POST") {} }', ["POST"]],
    ['function h(req, res) { if (req.method !== "post") return; }', ["POST"]],
    ['function h(req, res) { if ("GET" == req.method) {} }', ["GET"]],
    [
      'function h(req, res) { switch (req.method) { case "GET": break; case "DELETE": break; default: } }',
      ["DELETE", "GET"],
    ],
    ['function h(req, res) { if (!["PUT", "PATCH"].includes(req.method)) {} }', ["PATCH", "PUT"]],
    ['function h(req, res) { const { method } = req; if (method === "GET") {} }', ["GET"]],
    ['function h(req, res) { const m = req.method; if (m === "PUT") {} }', ["PUT"]],
    ['function h({ method: m }, res) { if (m === "PATCH") {} }', ["PATCH"]],
    ['function h(req, res) { if (req.method === "BREW") {} }', []],
    ['function h(req, res) { if (other.method === "GET") {} }', []],
    ["function h() {}", []],
  ])("finds the methods %s checks", (code, expected) => {
    expect(checkedMethods(handler(code))).toEqual(expected);
  });

  it.each([
    // Open: other methods can reach real code after (or beside) the checks.
    ['function h(req, res) { if (req.method === "GET") return list(); return create(); }', true],
    ['function h(req, res) { if (req.method === "GET") { list(); } else { create(); } }', true],
    [
      'function h(req, res) { if (req.method === "GET") a(); else if (req.method === "PUT") b(); else c(); }',
      true,
    ],
    ['function h(req, res) { switch (req.method) { case "GET": return a(); } create(); }', true],
    ['function h(req, res) { const get = req.method === "GET"; work(get); }', true],
    ['function h(req, res) { try { if (req.method === "GET") a(); } catch {} done(); }', true],
    // Closed: the remainder is rejected, or nothing runs for other methods.
    ['function h(req, res) { if (req.method === "GET") a(); res.status(405).end(); }', false],
    ['function h(req, res) { if (req.method !== "POST") return; create(); }', false],
    ['function h(req, res) { if (!["GET"].includes(req.method)) return; a(); }', false],
    [
      'function h(req, res) { switch (req.method) { case "GET": return a(); default: return no(); } }',
      false,
    ],
    ['function h(req, res) { setup(); if (req.method === "GET") a(); }', false],
    ['function h(req, res) { switch (req.method) { case "POST": return a(); } }', false],
    [
      'function h(req, res) { if (req.method === "GET") a(); res.setHeader("Allow", ["GET"]); }',
      false,
    ],
    ['function h(req, res) { if (req.method === "BREW") a(); create(); }', false],
  ])("%s leaves other methods open: %s", (code, open) => {
    expect(handledMethods(handler(code)).open).toBe(open);
  });
});

describe("next.js facts", () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

  async function nextFacts(root: string): Promise<NextFacts[]> {
    const inventory = await buildInventory(root);
    const workspace = await detectWorkspace(root, inventory.files);
    const programs = buildServicePrograms(root, workspace, inventory);
    const resolver = createSymbolResolver(programs, workspace);
    return programs.map((sp) => collectNextFacts(sp, resolver));
  }

  /** The Next.js part of `analyze`'s graph (no Express routes in these repos). */
  function nextPart(graph: ArchitectureGraph) {
    return {
      nodes: graph.nodes.filter((n) => n.kind === "route" || n.kind === "page"),
      edges: graph.edges.filter((e) => e.kind === "handles" || e.kind === "renders"),
      warnings: nextWarnings(graph),
    };
  }

  it.each(["next-app-router", "next-pages-api"])(
    "composes %s from JSON round-tripped facts exactly as analyze does",
    async (name) => {
      const root = join(FIXTURES, name);
      const facts = await nextFacts(root);
      const revived = JSON.parse(JSON.stringify(facts)) as NextFacts[];
      expect(revived).toEqual(facts);
      const composed = composeNextRoutes(revived);
      expect(composed.nodes.length).toBeGreaterThan(0);
      expect(composed.edges.length).toBeGreaterThan(0);
      expect(composed).toEqual(nextPart(await analyze(root)));
    },
  );

  it("keeps a service's facts unchanged when another service adds a route", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    for (const name of ["web", "admin"]) {
      await put(
        `apps/${name}/package.json`,
        JSON.stringify({ name, dependencies: { next: "15" } }),
      );
    }
    await put("apps/api/package.json", JSON.stringify({ name: "api" }));
    await put("apps/web/app/api/users/route.ts", "export function GET() {}\n");
    await put("apps/web/app/(group)/api/users/route.ts", "export function GET() {}\n");
    await put("apps/admin/app/page.tsx", "export default function Home() { return null; }\n");
    const before = await nextFacts(dir);
    await put("apps/admin/app/api/users/route.ts", "export function POST() {}\n");
    const after = await nextFacts(dir);
    const of = (all: NextFacts[], service: string) => all.find((f) => f.service === service);
    expect(of(before, "web")?.warnings.map((w) => w.code)).toEqual(["NEXT_DUPLICATE_ROUTE"]);
    expect(of(after, "web")).toEqual(of(before, "web"));
    expect(of(after, "admin")).not.toEqual(of(before, "admin"));
    expect(of(after, "api")).toEqual({ service: "api", nodes: [], edges: [], warnings: [] });
    const composed = composeNextRoutes(after);
    expect(composed.nodes.map((n) => n.id)).toEqual([
      "page:admin//",
      "route:admin/POST /api/users",
      "route:web/GET /api/users",
    ]);
    expect(composed).toEqual(nextPart(await analyze(dir)));
  });
});

describe("next.js routes", () => {
  it("detects app router route handlers in every export form, with handles edges", async () => {
    await nextApp();
    await put("app/api/users/route.ts", [
      'import { NextResponse } from "next/server";',
      "export async function GET() { return NextResponse.json([]); }",
      "export const POST = async (req: Request) => new Response();",
      "export function helper() {}",
    ]);
    await put("app/api/users/[id]/route.ts", [
      "const handler = async () => new Response();",
      "export { handler as PUT, handler as DELETE };",
    ]);
    await put("app/api/auth/[...nextauth]/route.ts", [
      'import { handlers } from "@/auth";',
      "export const { GET, POST } = handlers;",
    ]);
    await put("app/(admin)/api/stats/route.ts", 'export { GET } from "./impl";\n');
    await put("app/(admin)/api/stats/impl.ts", "export function GET() {}\n");
    await put("app/api/reexported/route.ts", 'export * from "../users/route";\n');
    const graph = await analyze(dir);
    expect(entries(graph)).toEqual([
      "route:web/DELETE /api/users/:id",
      "route:web/GET /api/auth/*nextauth",
      "route:web/GET /api/reexported",
      "route:web/GET /api/stats",
      "route:web/GET /api/users",
      "route:web/POST /api/auth/*nextauth",
      "route:web/POST /api/reexported",
      "route:web/POST /api/users",
      "route:web/PUT /api/users/:id",
    ]);
    expect(links(graph)).toEqual([
      "handles route:web/DELETE /api/users/:id -> symbol:web/app/api/users/[id]/route.ts#handler (exact)",
      "handles route:web/GET /api/auth/*nextauth -> symbol:web/app/api/auth/[...nextauth]/route.ts#GET (exact)",
      "handles route:web/GET /api/reexported -> symbol:web/app/api/users/route.ts#GET (exact)",
      "handles route:web/GET /api/stats -> symbol:web/app/(admin)/api/stats/impl.ts#GET (exact)",
      "handles route:web/GET /api/users -> symbol:web/app/api/users/route.ts#GET (exact)",
      "handles route:web/POST /api/auth/*nextauth -> symbol:web/app/api/auth/[...nextauth]/route.ts#POST (exact)",
      "handles route:web/POST /api/reexported -> symbol:web/app/api/users/route.ts#POST (exact)",
      "handles route:web/POST /api/users -> symbol:web/app/api/users/route.ts#POST (exact)",
      "handles route:web/PUT /api/users/:id -> symbol:web/app/api/users/[id]/route.ts#handler (exact)",
    ]);
    expect(graph.nodes.find((n) => n.id === "route:web/GET /api/users")).toEqual({
      id: "route:web/GET /api/users",
      kind: "route",
      label: "GET /api/users",
      parentId: "file:web/app/api/users/route.ts",
      layer: "backend",
      method: "GET",
      path: "/api/users",
      source: { file: "app/api/users/route.ts", line: 2, column: 23 },
    });
    expect(graph.nodes.find((n) => n.id === "route:web/GET /api/reexported")?.source).toEqual({
      file: "app/api/reexported/route.ts",
      line: 1,
      column: 1,
    });
    expect(nextWarnings(graph)).toEqual([]);
  });

  it("detects app router pages with renders edges and skips non-route files", async () => {
    await nextApp();
    await put(
      "app/layout.tsx",
      "export default function RootLayout({ children }) { return children; }\n",
    );
    await put("app/page.tsx", "export default function Home() { return <main />; }\n");
    await put("app/(shop)/products/[id]/page.tsx", [
      "function Product() { return <div />; }",
      "export default Product;",
    ]);
    await put("app/blog/page.jsx", "export default () => <div />;\n");
    await put(
      "app/@modal/settings/page.tsx",
      "export default function Settings() { return null; }\n",
    );
    await put("app/feed/(.)photo/page.tsx", "export default function Photo() { return null; }\n");
    await put("app/_components/page.tsx", "export default function Hidden() { return null; }\n");
    await put("app/loading.tsx", "export default function Loading() { return null; }\n");
    await put("app/empty/page.tsx", "const x = 1;\n");
    await put("app/types.d.ts", "export declare const x: number;\n");
    await put("app/utils.mjs", "export default 1;\n");
    const graph = await analyze(dir);
    expect(entries(graph)).toEqual([
      "page:web//",
      "page:web//blog",
      "page:web//empty",
      "page:web//products/:id",
      "page:web//settings",
    ]);
    expect(links(graph)).toEqual([
      "renders page:web// -> symbol:web/app/page.tsx#Home (exact)",
      "renders page:web//blog -> symbol:web/app/blog/page.jsx#default (exact)",
      "renders page:web//products/:id -> symbol:web/app/(shop)/products/[id]/page.tsx#Product (exact)",
      "renders page:web//settings -> symbol:web/app/@modal/settings/page.tsx#Settings (exact)",
    ]);
    expect(graph.nodes.find((n) => n.id === "page:web//")).toEqual({
      id: "page:web//",
      kind: "page",
      label: "/",
      parentId: "file:web/app/page.tsx",
      layer: "frontend",
      path: "/",
      source: { file: "app/page.tsx", line: 1, column: 25 },
    });
    expect(graph.nodes.find((n) => n.id === "page:web//empty")?.source).toEqual({
      file: "app/empty/page.tsx",
      line: 1,
      column: 1,
    });
  });

  it("detects pages router pages and API routes with statically visible methods", async () => {
    await nextApp();
    await put("pages/_app.tsx", "export default function App() { return null; }\n");
    await put("pages/_document.tsx", "export default function Doc() { return null; }\n");
    await put("pages/index.tsx", "export default function Home() { return null; }\n");
    await put("pages/blog/[slug].tsx", "export default function Post() { return null; }\n");
    await put("pages/docs/[[...path]].tsx", "export default function Docs() { return null; }\n");
    await put("pages/404.tsx", "export default function NotFound() { return null; }\n");
    await put("pages/api/index.ts", "export default function health(req, res) { res.end(); }\n");
    await put("pages/api/users/[id].ts", [
      "export default async function handler(req, res) {",
      '  if (req.method === "GET") return res.json({});',
      '  if (req.method === "DELETE") return res.end();',
      "  res.status(405).end();",
      "}",
    ]);
    await put("pages/api/orders.ts", [
      "const orders = (req, res) => {",
      "  switch (req.method) {",
      '    case "POST":',
      "      return res.end();",
      "  }",
      "};",
      "export default orders;",
    ]);
    await put("pages/api/items.ts", [
      "export default function items(req, res) {",
      '  if (req.method === "GET") return res.json([]);',
      "  return res.status(201).end();",
      "}",
    ]);
    await put("pages/api/wrapped.ts", [
      "function inner(req, res) { if (req.method === 'PUT') res.end(); }",
      "const wrap = (f) => f;",
      "export default wrap(inner);",
    ]);
    const graph = await analyze(dir);
    expect(entries(graph)).toEqual([
      "page:web//",
      "page:web//404",
      "page:web//blog/:slug",
      "page:web//docs/*path",
      "route:web/ALL /api",
      "route:web/ALL /api/items",
      "route:web/ALL /api/wrapped",
      "route:web/DELETE /api/users/:id",
      "route:web/GET /api/items",
      "route:web/GET /api/users/:id",
      "route:web/POST /api/orders",
    ]);
    expect(links(graph)).toEqual([
      "handles route:web/ALL /api -> symbol:web/pages/api/index.ts#health (exact)",
      "handles route:web/ALL /api/items -> symbol:web/pages/api/items.ts#items (exact)",
      "handles route:web/ALL /api/wrapped -> symbol:web/pages/api/wrapped.ts#default (exact)",
      "handles route:web/DELETE /api/users/:id -> symbol:web/pages/api/users/[id].ts#handler (exact)",
      "handles route:web/GET /api/items -> symbol:web/pages/api/items.ts#items (exact)",
      "handles route:web/GET /api/users/:id -> symbol:web/pages/api/users/[id].ts#handler (exact)",
      "handles route:web/POST /api/orders -> symbol:web/pages/api/orders.ts#orders (exact)",
      "renders page:web// -> symbol:web/pages/index.tsx#Home (exact)",
      "renders page:web//404 -> symbol:web/pages/404.tsx#NotFound (exact)",
      "renders page:web//blog/:slug -> symbol:web/pages/blog/[slug].tsx#Post (exact)",
      "renders page:web//docs/*path -> symbol:web/pages/docs/[[...path]].tsx#Docs (exact)",
    ]);
  });

  it("uses src/ only when app/ and pages/ are absent at the service root", async () => {
    await nextApp();
    await put("src/app/page.tsx", "export default function Home() { return null; }\n");
    await put("src/pages/api/ping.ts", "export default function ping(req, res) {}\n");
    expect(entries(await analyze(dir))).toEqual(["page:web//", "route:web/ALL /api/ping"]);

    await put("pages/about.tsx", "export default function About() { return null; }\n");
    expect(entries(await analyze(dir))).toEqual(["page:web//about"]);
  });

  it("ignores services that don't depend on next", async () => {
    await nextApp({ react: "19" });
    await put("app/page.tsx", "export default function Home() { return null; }\n");
    await put("pages/api/x.ts", "export default function x() {}\n");
    expect(entries(await analyze(dir))).toEqual([]);
  });

  it("warns about route files without methods and about duplicate routes", async () => {
    await nextApp();
    await put("app/api/none/route.ts", "export function helper() {}\n");
    await put("app/api/typed/route.ts", "export type GET = () => Response;\n");
    await put("app/api/unknown/route.ts", 'export * from "some-package";\n');
    await put("app/(a)/about/page.tsx", "export default function A() { return null; }\n");
    await put("app/(b)/about/page.tsx", "export default function B() { return null; }\n");
    await put("app/api/x/route.ts", "export function GET() {}\n");
    await put(
      "pages/api/x.ts",
      "export default function x(req) { if (req.method === 'GET') {} }\n",
    );
    const graph = await analyze(dir);
    expect(entries(graph)).toEqual(["page:web//about", "route:web/GET /api/x"]);
    expect(links(graph)).toEqual([
      "handles route:web/GET /api/x -> symbol:web/app/api/x/route.ts#GET (exact)",
      "renders page:web//about -> symbol:web/app/(a)/about/page.tsx#A (exact)",
    ]);
    expect(nextWarnings(graph)).toEqual([
      {
        code: "NEXT_DUPLICATE_ROUTE",
        file: "app/(b)/about/page.tsx",
        message: "/about is also defined by app/(a)/about/page.tsx; keeping app/(a)/about/page.tsx",
      },
      {
        code: "NEXT_ROUTE_NO_METHODS",
        file: "app/api/none/route.ts",
        message: "route handler file exports no HTTP method (GET, POST, …); no route was created",
      },
      {
        code: "NEXT_ROUTE_NO_METHODS",
        file: "app/api/typed/route.ts",
        message: "route handler file exports no HTTP method (GET, POST, …); no route was created",
      },
      {
        code: "NEXT_ROUTE_NO_METHODS",
        file: "app/api/unknown/route.ts",
        message: "route handler file exports no HTTP method (GET, POST, …); no route was created",
      },
      {
        code: "NEXT_DUPLICATE_ROUTE",
        file: "pages/api/x.ts",
        message: "GET /api/x is also defined by app/api/x/route.ts; keeping app/api/x/route.ts",
      },
    ]);
  });

  it("keeps the Express route when a custom server registers the same route", async () => {
    await nextApp({ next: "15", express: "4" });
    await put("server.ts", [
      'import express from "express";',
      "function health() {}",
      "const app = express();",
      'app.get("/api/health", health);',
    ]);
    await put("app/api/health/route.ts", "export function GET() {}\n");
    const graph = await analyze(dir);
    expect(entries(graph)).toEqual(["route:web/GET /api/health"]);
    expect(graph.nodes.find((n) => n.kind === "route")?.parentId).toBe("file:web/server.ts");
    expect(links(graph)).toEqual([
      "handles route:web/GET /api/health -> symbol:web/app/api/health/route.ts#GET (exact)",
      "handles route:web/GET /api/health -> symbol:web/server.ts#health (exact)",
    ]);
    expect(graph.warnings.filter((w) => w.code === "DUPLICATE_NODE")).toEqual([
      {
        code: "DUPLICATE_NODE",
        file: "app/api/health/route.ts",
        message:
          "route:web/GET /api/health is produced by both express and next; keeping express's",
      },
    ]);
  });

  it("keys routes by the owning workspace service", async () => {
    await put("package.json", JSON.stringify({ private: true, workspaces: ["apps/*"] }));
    await put(
      "apps/web/package.json",
      JSON.stringify({ name: "@acme/web", dependencies: { next: "15" } }),
    );
    await put("apps/web/app/api/health/route.ts", "export function GET() {}\n");
    await put("apps/docs/package.json", JSON.stringify({ name: "docs" }));
    await put("apps/docs/app/page.tsx", "export default function D() { return null; }\n");
    const graph = await analyze(dir);
    expect(entries(graph)).toEqual(["route:web/GET /api/health"]);
    expect(graph.nodes.find((n) => n.kind === "route")?.source).toEqual({
      file: "apps/web/app/api/health/route.ts",
      line: 1,
      column: 17,
    });
  });
});
