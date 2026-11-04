import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  edgeId,
  type AnalysisWarning,
  type ArchitectureGraph,
  type GraphNode,
} from "@gitinside/schema";
import { analyze } from "./analyze.js";
import {
  collectCallFacts,
  composeCallEdges,
  createSymbolResolver,
  type CallFacts,
} from "./calls.js";
import { collectHttpCalls } from "./http.js";
import { buildInventory } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
import { collectSymbolNodes } from "./symbols.js";
import { createUrlNormalizer } from "./url.js";
import { detectWorkspace } from "./workspace.js";
import { collectHttpFacts } from "./wrappers.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-calls-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
}

/** `from -> to (confidence)` for each calls edge, with the `symbol:` prefixes dropped. */
function callEdges(graph: ArchitectureGraph): string[] {
  const short = (id: string): string => id.replace(/^symbol:/, "");
  return graph.edges
    .filter((e) => e.kind === "calls")
    .map((e) => `${short(e.from)} -> ${short(e.to)} (${e.confidence})`);
}

describe("call edges", () => {
  it("links calls within a file and across relative imports, merging repeated sites", async () => {
    await put("tsconfig.json", "{}");
    await put(
      "src/orders.ts",
      [
        'import { save, Repo } from "./db";',
        'import * as log from "./log";',
        "",
        "function validate(x: number) { return x > 0; }",
        "",
        "export async function createOrder(x: number) {",
        "  if (!validate(x)) return;",
        "  const repo = new Repo();",
        "  repo.insert(x);",
        "  save(x);",
        "  save(x + 1);",
        "  log.info();",
        "  [x].map((y) => validate(y));",
        "  console.log(x);",
        "}",
        "",
        "createOrder(1);",
        "",
      ].join("\n"),
    );
    await put(
      "src/db.ts",
      [
        "export function save(x: number) { return x; }",
        "export class Repo {",
        "  insert(x: number) { return this.check(x); }",
        "  check(x: number) { return save(x); }",
        "}",
        "",
      ].join("\n"),
    );
    await put("src/log.ts", "export function info() {}\n");
    const graph = await analyze(dir);
    expect(callEdges(graph)).toEqual([
      "app/src/db.ts#Repo.check -> app/src/db.ts#save (exact)",
      "app/src/db.ts#Repo.insert -> app/src/db.ts#Repo.check (exact)",
      "app/src/orders.ts#createOrder -> app/src/db.ts#Repo (exact)",
      "app/src/orders.ts#createOrder -> app/src/db.ts#Repo.insert (exact)",
      "app/src/orders.ts#createOrder -> app/src/db.ts#save (exact)",
      "app/src/orders.ts#createOrder -> app/src/log.ts#info (exact)",
      "app/src/orders.ts#createOrder -> app/src/orders.ts#validate (exact)",
    ]);
    const save = graph.edges.find(
      (e) => e.id === "calls:symbol:app/src/orders.ts#createOrder->symbol:app/src/db.ts#save",
    );
    expect(save).toEqual({
      id: "calls:symbol:app/src/orders.ts#createOrder->symbol:app/src/db.ts#save",
      kind: "calls",
      from: "symbol:app/src/orders.ts#createOrder",
      to: "symbol:app/src/db.ts#save",
      confidence: "exact",
      sites: [
        { file: "src/orders.ts", line: 10, column: 3, args: 1 },
        { file: "src/orders.ts", line: 11, column: 3, args: 1 },
      ],
    });
  });

  it("records each call's argument count, except through a spread", async () => {
    await put(
      "a.ts",
      [
        "export function f(a: number, b?: number, ...rest: number[]) { return a; }",
        "export class C { constructor(public x: number) {} }",
        "export function g(xs: [number]) {",
        "  f(1);",
        "  f(1, 2, 3);",
        "  f(...xs);",
        "  f();",
        "  new C(1);",
        "  // @ts-expect-error: no parentheses",
        "  return new C;",
        "}",
        "",
      ].join("\n"),
    );
    const graph = await analyze(dir);
    const sites = (to: string) =>
      graph.edges
        .find((e) => e.kind === "calls" && e.to === `symbol:app/a.ts#${to}`)
        ?.sites.map((s) => `${s.line}:${s.args ?? "?"}`);
    expect(sites("f")).toEqual(["4:1", "5:3", "6:?", "7:0"]);
    expect(sites("C")).toEqual(["8:1", "10:0"]);
    const required = (name: string) => graph.nodes.find((n) => n.id === `symbol:app/a.ts#${name}`);
    expect(required("f")).toMatchObject({ requiredParams: 1 });
    expect(required("C")).toMatchObject({ requiredParams: 1 });
  });

  it("skips recursion, nested-function callees, computed callees, and top-level calls", async () => {
    await put(
      "a.ts",
      [
        "function helper() { return 1; }",
        "const table: Record<string, () => number> = { helper };",
        "export function walk(n: number, key: string): number {",
        "  function inner() { return 1; }",
        "  (() => helper)()();",
        "  table[key]();",
        "  return n === 0 ? inner() : walk(n - 1, key);",
        "}",
        "walk(3);",
        "",
      ].join("\n"),
    );
    const graph = await analyze(dir);
    expect(callEdges(graph)).toEqual([]);
  });

  it("resolves overloads, re-exports, aliases, and object-literal properties", async () => {
    await put(
      "lib/impl.ts",
      [
        "export function fmt(x: string): string;",
        "export function fmt(x: number): string;",
        "export function fmt(x: unknown) { return String(x); }",
        "function listImpl() {}",
        "function get() {}",
        "export const api = { list: listImpl, get };",
        "export const format = fmt;",
        "",
      ].join("\n"),
    );
    await put(
      "lib/index.ts",
      'export { fmt as formatValue } from "./impl";\nexport * from "./impl";\n',
    );
    await put(
      "main.ts",
      [
        'import { formatValue, api, format } from "./lib";',
        "export function run() {",
        "  formatValue(1);",
        "  api.list();",
        "  api.get();",
        '  api["get"]();',
        "  format(2);",
        "}",
        "",
      ].join("\n"),
    );
    const graph = await analyze(dir);
    expect(callEdges(graph)).toEqual([
      "app/main.ts#run -> app/lib/impl.ts#fmt (exact)",
      "app/main.ts#run -> app/lib/impl.ts#format (exact)",
      "app/main.ts#run -> app/lib/impl.ts#get (exact)",
      "app/main.ts#run -> app/lib/impl.ts#listImpl (exact)",
    ]);
  });

  it("follows CommonJS requires and exported object methods in JS", async () => {
    await put(
      "controller.js",
      [
        "module.exports = {",
        "  list: async (req, res) => res.json(findAll()),",
        "  show(req, res) { res.json(findAll()); },",
        "};",
        "function findAll() { return []; }",
        "",
      ].join("\n"),
    );
    await put("helpers.js", "exports.wrap = function (fn) { return fn; };\n");
    await put(
      "routes.js",
      [
        'const controller = require("./controller");',
        'const { wrap } = require("./helpers");',
        "function register(app) {",
        "  app.get('/', wrap(controller.list));",
        "  controller.show();",
        "}",
        "module.exports = register;",
        "",
      ].join("\n"),
    );
    const graph = await analyze(dir);
    expect(callEdges(graph)).toEqual([
      "app/controller.js#list -> app/controller.js#findAll (exact)",
      "app/controller.js#show -> app/controller.js#findAll (exact)",
      "app/routes.js#register -> app/controller.js#show (exact)",
      "app/routes.js#register -> app/helpers.js#wrap (exact)",
    ]);
  });

  it("attributes calls in class property arrows and exported values", async () => {
    await put(
      "a.ts",
      [
        "function make() { return 1; }",
        "export const value = make();",
        "export class Handler {",
        "  handle = () => make();",
        "  static build() { return new Handler(); }",
        "}",
        "",
      ].join("\n"),
    );
    const graph = await analyze(dir);
    expect(callEdges(graph)).toEqual([
      "app/a.ts#Handler.build -> app/a.ts#Handler (exact)",
      "app/a.ts#Handler.handle -> app/a.ts#make (exact)",
      "app/a.ts#value -> app/a.ts#make (exact)",
    ]);
  });

  describe("cross-workspace packages", () => {
    beforeEach(async () => {
      await put("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
      await put("apps/web/package.json", JSON.stringify({ name: "web" }));
      await put(
        "packages/shared/src/format.ts",
        "export function format(x: number) { return String(x); }\nexport class Client { get() {} }\n",
      );
      await put(
        "packages/shared/src/index.ts",
        'export { format } from "./format";\nexport { Client } from "./format";\nexport default function main() {}\n',
      );
    });

    it("follows named, default, and namespace imports through the package entry", async () => {
      await put(
        "packages/shared/package.json",
        JSON.stringify({ name: "@acme/shared", exports: "./src/index.ts" }),
      );
      await put(
        "apps/web/app.ts",
        [
          'import main, { format, Client } from "@acme/shared";',
          'import * as shared from "@acme/shared";',
          "export function render() {",
          "  format(1);",
          "  shared.format(2);",
          "  main();",
          "  new Client().get();",
          "  shared.missing();",
          "}",
          "",
        ].join("\n"),
      );
      const graph = await analyze(dir);
      expect(callEdges(graph)).toEqual([
        "web/app.ts#render -> shared/src/format.ts#Client (exact)",
        "web/app.ts#render -> shared/src/format.ts#format (exact)",
        "web/app.ts#render -> shared/src/index.ts#main (exact)",
      ]);
      const format = graph.edges.find((e) => e.to === "symbol:shared/src/format.ts#format");
      expect(format?.sites).toEqual([
        { file: "apps/web/app.ts", line: 4, column: 3, args: 1 },
        { file: "apps/web/app.ts", line: 5, column: 10, args: 1 },
      ]);
    });

    it("takes the import's heuristic confidence when the entry points into dist", async () => {
      await put(
        "packages/shared/package.json",
        JSON.stringify({ name: "@acme/shared", main: "dist/index.js" }),
      );
      await put(
        "apps/web/app.ts",
        'import { format } from "@acme/shared";\nexport function render() { format(1); }\n',
      );
      const graph = await analyze(dir);
      expect(callEdges(graph)).toEqual([
        "web/app.ts#render -> shared/src/format.ts#format (heuristic)",
      ]);
    });

    it("produces no edge for an unresolvable package import", async () => {
      await put(
        "packages/shared/package.json",
        JSON.stringify({ name: "@acme/shared", main: "../../nowhere.js" }),
      );
      await put("packages/shared/src/index.ts", "export const x = 1;\n");
      await put(
        "apps/web/app.ts",
        'import { gone } from "@acme/nope";\nimport * as s from "@acme/nope";\nexport function render() { gone(); s.f(); }\n',
      );
      const graph = await analyze(dir);
      expect(callEdges(graph)).toEqual([]);
    });
  });
});

describe("TypeScript failures per asking service (M6.7d3d1)", () => {
  const SHARED_ENTRY = "packages/shared/src/index.ts";

  /**
   * The programs of a web app importing `@acme/shared`, whose entry file TypeScript throws on
   * when asked for its module symbol (as `importTarget` does), and a resolver over them.
   */
  async function setup(web: string) {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
    await put("apps/web/package.json", JSON.stringify({ name: "web" }));
    await put(
      "packages/shared/package.json",
      JSON.stringify({ name: "@acme/shared", exports: "./src/index.ts" }),
    );
    await put(
      SHARED_ENTRY,
      [
        'export const BASE = "https://api.example.com";',
        "export function format(x: number) { return String(x); }",
        'export function get(path: string) { return fetch("/api" + path); }',
        "",
      ].join("\n"),
    );
    await put("apps/web/app.ts", web);
    const inventory = await buildInventory(dir);
    const workspace = await detectWorkspace(dir, inventory.files);
    const programs = buildServicePrograms(dir, workspace, inventory).map((sp) => {
      const checker = sp.program.getTypeChecker();
      const throwing: ts.TypeChecker = {
        ...checker,
        getSymbolAtLocation: (node) => {
          if (ts.isSourceFile(node) && node.fileName.endsWith(SHARED_ENTRY)) {
            throw new TypeError("Cannot read properties of undefined (reading 'id')");
          }
          return checker.getSymbolAtLocation(node);
        },
      };
      return { ...sp, program: { ...sp.program, getTypeChecker: () => throwing } };
    });
    const resolver = createSymbolResolver(programs, workspace);
    const byKey = (key: string) => {
      const sp = programs.find((p) => p.service.key === key);
      if (!sp) throw new Error(`no program for ${key}`);
      return sp;
    };
    return { programs, resolver, web: byKey("web"), shared: byKey("shared") };
  }

  const files = (warnings: readonly AnalysisWarning[]) =>
    warnings.map((w) => `${w.code} ${w.file ?? ""}`);

  it("records a failure in another program's checker as the asking service's", async () => {
    const { resolver, web, shared } = await setup(
      'import { format } from "@acme/shared";\nexport function render() { format(1); }\n',
    );
    const facts = resolver.asking(web, () => collectCallFacts(web, resolver));

    // The import can't be followed, so the call has no edge, and web's facts own the warning.
    expect(facts.calls).toEqual([]);
    expect(files(resolver.warnings(web))).toEqual([`TYPESCRIPT_INTERNAL_ERROR ${SHARED_ENTRY}`]);
    expect(resolver.warnings(shared)).toEqual([]);
  });

  it("records a failure outside any asking service as the checker's program's", async () => {
    const { resolver, web, shared } = await setup(
      'import { format } from "@acme/shared";\nexport function render() { format(1); }\n',
    );
    collectCallFacts(web, resolver);
    expect(resolver.warnings(web)).toEqual([]);
    expect(files(resolver.warnings(shared))).toEqual([`TYPESCRIPT_INTERNAL_ERROR ${SHARED_ENTRY}`]);
  });

  it("restores the outer asking service after a nested one, even when it throws", async () => {
    const { resolver, web, shared } = await setup(
      'import { format } from "@acme/shared";\nexport function render() { format(1); }\n',
    );
    resolver.asking(web, () => {
      expect(() =>
        resolver.asking(shared, () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      collectCallFacts(web, resolver);
    });
    expect(files(resolver.warnings(web))).toEqual([`TYPESCRIPT_INTERNAL_ERROR ${SHARED_ENTRY}`]);
    expect(resolver.warnings(shared)).toEqual([]);
  });

  it("asks as each walked service inside the HTTP stage's whole-repo passes", async () => {
    const { programs, resolver, web, shared } = await setup(
      [
        'import { BASE, get } from "@acme/shared";',
        "export async function load() {",
        '  await fetch(BASE + "/items");',
        '  await get("/users");',
        "}",
        "",
      ].join("\n"),
    );
    const sites = collectHttpCalls(programs, resolver);
    collectHttpFacts(sites, programs, resolver, createUrlNormalizer(resolver));
    expect(files(resolver.warnings(web))).toEqual([`TYPESCRIPT_INTERNAL_ERROR ${SHARED_ENTRY}`]);
    expect(resolver.warnings(shared)).toEqual([]);
  });
});

describe("server actions (ADR-0203)", () => {
  /** `from -> to (confidence)` for each calls edge, then its label if any. */
  function labeled(graph: ArchitectureGraph): string[] {
    const short = (id: string): string => id.replace(/^symbol:app\//, "");
    return graph.edges
      .filter((e) => e.kind === "calls")
      .map((e) => `${short(e.from)} -> ${short(e.to)}${e.label ? ` [${e.label}]` : ""}`);
  }

  beforeEach(async () => {
    await put("tsconfig.json", JSON.stringify({ compilerOptions: { jsx: "preserve" } }));
    await put(
      "app/actions.ts",
      [
        '"use server";',
        "",
        "export async function createTodo(data: FormData) { await save(data); }",
        "export async function deleteTodo(id: string) { await save(id); }",
        "export const archiveTodo = async (id: string, data: FormData) => { await save(id); };",
        "export async function updateTodo(state: unknown, data: FormData) { return state; }",
        "export async function listTodos() { return []; }",
        "async function save(x: unknown) { return x; }",
        "",
      ].join("\n"),
    );
  });

  it("marks a client module's calls of a server action, and not a server component's", async () => {
    await put(
      "app/DeleteButton.tsx",
      [
        '"use client";',
        'import { deleteTodo, listTodos } from "./actions";',
        "",
        "export function DeleteButton({ id }: { id: string }) {",
        "  return <button onClick={() => deleteTodo(id)}>Delete</button>;",
        "}",
        "export async function refresh() { return listTodos(); }",
        "",
      ].join("\n"),
    );
    await put(
      "app/page.tsx",
      [
        'import { listTodos } from "./actions";',
        "",
        "export default async function Page() {",
        "  const todos = await listTodos();",
        "  return <ul>{todos.length}</ul>;",
        "}",
        "",
      ].join("\n"),
    );
    const graph = await analyze(dir);
    expect(labeled(graph)).toEqual([
      "app/DeleteButton.tsx#DeleteButton -> app/actions.ts#deleteTodo [server action]",
      "app/DeleteButton.tsx#refresh -> app/actions.ts#listTodos [server action]",
      "app/actions.ts#archiveTodo -> app/actions.ts#save",
      "app/actions.ts#createTodo -> app/actions.ts#save",
      "app/actions.ts#deleteTodo -> app/actions.ts#save",
      "app/page.tsx#Page -> app/actions.ts#listTodos",
    ]);
  });

  it("links a server action passed to a form, a form button, or useActionState", async () => {
    await put(
      "app/page.tsx",
      [
        'import { createTodo, archiveTodo, listTodos } from "./actions";',
        "",
        "function local(data: FormData) { return data; }",
        "export default function Page({ id }: { id: string }) {",
        "  async function inline() {",
        '    "use server";',
        "    await listTodos();",
        "  }",
        "  return (",
        "    <form action={createTodo}>",
        "      <button formAction={archiveTodo.bind(null, id)}>Archive</button>",
        "      <button formAction={inline}>Inline</button>",
        "      <input formAction={local} />",
        "    </form>",
        "  );",
        "}",
        "",
      ].join("\n"),
    );
    await put(
      "app/EditForm.tsx",
      [
        '"use client";',
        'import { useActionState } from "react";',
        'import * as ReactDom from "react-dom";',
        'import { updateTodo, deleteTodo } from "./actions";',
        "",
        "export function EditForm() {",
        "  const [state, action] = useActionState(updateTodo, null);",
        "  const [, legacy] = ReactDom.useFormState(deleteTodo, null);",
        "  return <form action={action}>{String(state)}{String(legacy)}</form>;",
        "}",
        "",
      ].join("\n"),
    );
    const graph = await analyze(dir);
    expect(labeled(graph)).toEqual([
      "app/EditForm.tsx#EditForm -> app/actions.ts#deleteTodo [server action]",
      "app/EditForm.tsx#EditForm -> app/actions.ts#updateTodo [server action]",
      "app/actions.ts#archiveTodo -> app/actions.ts#save",
      "app/actions.ts#createTodo -> app/actions.ts#save",
      "app/actions.ts#deleteTodo -> app/actions.ts#save",
      // The inline action is nested in Page, so Page owns its call; `local` isn't an action.
      "app/page.tsx#Page -> app/actions.ts#archiveTodo [server action]",
      "app/page.tsx#Page -> app/actions.ts#createTodo [server action]",
      "app/page.tsx#Page -> app/actions.ts#listTodos",
    ]);
    const form = graph.edges.find(
      (e) =>
        e.id ===
        edgeId("calls", "symbol:app/app/page.tsx#Page", "symbol:app/app/actions.ts#createTodo"),
    );
    // React decides the arguments, so the site has no count.
    expect(form?.sites).toEqual([{ file: "app/page.tsx", line: 10, column: 19 }]);
  });

  it('treats a function whose body starts with "use server" as an action', async () => {
    await put(
      "app/ping.ts",
      [
        "export async function ping() {",
        '  "use server";',
        "  return 1;",
        "}",
        "export async function pong() {",
        "  const x = 1;",
        '  "use server";',
        "  return x;",
        "}",
        "",
      ].join("\n"),
    );
    await put(
      "app/Ping.tsx",
      [
        '"use client";',
        'import { ping, pong } from "./ping";',
        "",
        "export function Ping() {",
        "  return <form action={ping}><button onClick={() => pong()}>Pong</button></form>;",
        "}",
        "",
      ].join("\n"),
    );
    const graph = await analyze(dir);
    expect(labeled(graph).filter((e) => e.includes("Ping.tsx"))).toEqual([
      "app/Ping.tsx#Ping -> app/ping.ts#ping [server action]",
      "app/Ping.tsx#Ping -> app/ping.ts#pong",
    ]);
  });
});

describe("call and symbol facts", () => {
  /** Each service's symbol nodes and call facts for the repo at `root`, in program order. */
  async function facts(root: string): Promise<{ symbols: GraphNode[][]; calls: CallFacts[] }> {
    const inventory = await buildInventory(root);
    const workspace = await detectWorkspace(root, inventory.files);
    const programs = buildServicePrograms(root, workspace, inventory);
    const resolver = createSymbolResolver(programs, workspace);
    return {
      symbols: programs.map((sp) => collectSymbolNodes(sp)),
      calls: programs.map((sp) => collectCallFacts(sp, resolver)),
    };
  }

  /** `facts` after a JSON round trip, checked to be unchanged by it. */
  function revived<T>(value: T): T {
    const copy = JSON.parse(JSON.stringify(value)) as T;
    expect(copy).toEqual(value);
    return copy;
  }

  it.each(["shop-demo", "pnpm-monorepo", "express-basic", "next-pages-api"])(
    "composes %s's call edges and symbol nodes from JSON round-tripped facts as analyze does",
    async (name) => {
      const root = join(FIXTURES, name);
      const { symbols, calls } = revived(await facts(root));
      const graph = await analyze(root);
      const edges = composeCallEdges(calls);
      expect(symbols.flat().length).toBeGreaterThan(0);
      expect(edges).toEqual(graph.edges.filter((e) => e.kind === "calls"));
      expect(symbols.flat()).toEqual(graph.nodes.filter((n) => n.kind === "symbol"));
    },
  );

  it("merges one caller's sites across files and keeps the strongest confidence", () => {
    const site = (line: number) => ({ file: "a.ts", line, column: 1, args: 0 });
    const edges = composeCallEdges([
      { service: "a", calls: [{ from: "s:a", to: "s:b", confidence: "heuristic", site: site(9) }] },
      { service: "b", calls: [{ from: "s:a", to: "s:b", confidence: "exact", site: site(2) }] },
    ]);
    expect(edges).toEqual([
      {
        id: edgeId("calls", "s:a", "s:b"),
        kind: "calls",
        from: "s:a",
        to: "s:b",
        confidence: "exact",
        sites: [site(2), site(9)],
      },
    ]);
  });

  it("labels browser calls of another service's server action, and drops passed non-actions", () => {
    const site = (line: number) => ({ file: "a.tsx", line, column: 1 });
    const edges = composeCallEdges([
      {
        service: "web",
        calls: [
          { from: "s:a", to: "s:act", confidence: "exact", site: site(1) },
          { from: "s:a", to: "s:act", confidence: "exact", site: site(2), browser: true },
          {
            from: "s:a",
            to: "s:local",
            confidence: "exact",
            site: site(3),
            browser: true,
            passed: true,
          },
          { from: "s:b", to: "s:local", confidence: "exact", site: site(4), browser: true },
        ],
      },
      { service: "shared", calls: [], actions: ["s:act"] },
    ]);
    expect(edges.map((e) => [e.from, e.to, e.label, e.sites.length])).toEqual([
      ["s:a", "s:act", "server action", 2],
      ["s:b", "s:local", undefined, 1],
    ]);
  });

  it("keeps a package's call facts unchanged when another service starts calling it", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
    await put("apps/web/package.json", JSON.stringify({ name: "web" }));
    await put(
      "packages/shared/package.json",
      JSON.stringify({ name: "@acme/shared", exports: "./src/index.ts" }),
    );
    await put(
      "packages/shared/src/index.ts",
      "function inner() {}\nexport function format() { inner(); }\n",
    );
    await put("apps/web/app.ts", "export function render() {}\n");
    const before = await facts(dir);
    await put(
      "apps/web/app.ts",
      'import { format } from "@acme/shared";\nexport function render() { format(); }\n',
    );
    const after = await facts(dir);
    const of = (all: CallFacts[], service: string) => all.find((f) => f.service === service);
    expect(of(before.calls, "shared")?.calls).toHaveLength(1);
    expect(of(after.calls, "shared")).toEqual(of(before.calls, "shared"));
    expect(of(after.calls, "web")?.calls.map((c) => c.to)).toEqual([
      "symbol:shared/src/index.ts#format",
    ]);
  });
});
