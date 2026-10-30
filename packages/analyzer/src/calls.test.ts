import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchitectureGraph } from "@gitinside/schema";
import { analyze } from "./analyze.js";

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
