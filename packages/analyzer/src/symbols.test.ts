import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "./analyze.js";
import { extractSymbols } from "./symbols.js";

/** `qualified kind exported` for each symbol in `code`, in declaration order. */
function summary(code: string, fileName = "/repo/a.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true);
  return extractSymbols(sourceFile).map(
    (s) => `${s.qualified} ${s.symbolKind}${s.exported ? " exported" : ""}`,
  );
}

describe("extractSymbols", () => {
  it("collects functions, classes, methods, and exported consts", () => {
    expect(
      summary(`
        export function createOrder() {}
        function helper() {}
        export class OrderService {
          constructor() {}
          list() {}
          static create() {}
          handle = async () => {};
          count = 0;
          get size() { return 0; }
          #secret() {}
        }
        export const LIMIT = 10;
        const local = 5;
        const run = () => {};
        export let mutable = 1;
      `),
    ).toEqual([
      "createOrder function exported",
      "helper function",
      "OrderService class exported",
      "OrderService.list method exported",
      "OrderService.create method exported",
      "OrderService.handle method exported",
      "OrderService.#secret method exported",
      "LIMIT variable exported",
      "run function",
      "mutable variable exported",
    ]);
  });

  it("treats function expressions and class expressions in consts by their value", () => {
    expect(
      summary(`
        const a = function () {};
        const b = (async () => {}) as unknown as () => Promise<void>;
        export const C = class { go() {} };
        const D = class {};
        export const memo = wrap(() => {});
      `),
    ).toEqual([
      "a function",
      "b function",
      "C class exported",
      "C.go method exported",
      "D class",
      "memo variable exported",
    ]);
  });

  it("marks names exported through export lists and default exports", () => {
    expect(
      summary(`
        function a() {}
        const b = 1;
        class C {}
        const d = 2;
        export { a, b as renamed };
        export default C;
        export { x } from "./x";
      `),
    ).toEqual(["a function exported", "b variable exported", "C class exported"]);
  });

  it("names default exports", () => {
    expect(summary("export default function () {}")).toEqual(["default function exported"]);
    expect(summary("export default function Page() {}")).toEqual(["Page function exported"]);
    expect(summary("export default class { m() {} }")).toEqual([
      "default class exported",
      "default.m method exported",
    ]);
    expect(summary("export default () => 1;")).toEqual(["default function exported"]);
    expect(summary("export default (class Named extends Base {});")).toEqual([
      "Named class exported",
    ]);
    expect(summary("export default defineConfig({});")).toEqual(["default variable exported"]);
    expect(summary("export default (function named() {});")).toEqual(["named function exported"]);
  });

  it("handles CommonJS exports", () => {
    expect(
      summary(
        `
        function list(req, res) {}
        const LIMIT = 3;
        module.exports = {
          list,
          limit: LIMIT,
          create: async (req, res) => {},
          remove(req, res) {},
          Model: class { save() {} },
          config: { a: 1 },
          ...other,
          [computed]: 1,
        };
        exports.one = function () {};
        module.exports.two = 2;
        exports.three = list;
      `,
        "/repo/a.js",
      ),
    ).toEqual([
      "list function exported",
      "LIMIT variable exported",
      "create function exported",
      "remove function exported",
      "Model class exported",
      "Model.save method exported",
      "config variable exported",
      "one function exported",
      "two variable exported",
    ]);
    expect(
      summary("start(); count += 1; app.locals = {}; module.other = 1;", "/repo/a.js"),
    ).toEqual([]);
    expect(summary("module.exports = function createApp() {};", "/repo/a.js")).toEqual([
      "createApp function exported",
    ]);
    expect(summary("module.exports = express.Router();", "/repo/a.js")).toEqual([
      "default variable exported",
    ]);
  });

  it("collects exported destructured bindings", () => {
    expect(summary("export const { a, b: [c, ...d] } = obj; const { e } = obj;")).toEqual([
      "a variable exported",
      "c variable exported",
      "d variable exported",
    ]);
  });

  it("skips overload signatures, ambient declarations, and declaration files", () => {
    expect(
      summary(`
        export function f(a: string): void;
        export function f(a: number): void;
        export function f(a: unknown) {}
        declare function g(): void;
        declare const h: number;
        export declare class K {}
        abstract class A {
          abstract run(): void;
          m(): void;
          m() {}
        }
      `),
    ).toEqual(["f function exported", "A class", "A.run method", "A.m method"]);
    expect(summary("export function f() {}", "/repo/a.d.ts")).toEqual([]);
  });

  it("keeps the first declaration when names collide", () => {
    expect(
      summary(
        `
        function dup() {}
        var dup = () => {};
        exports.dup = function () {};
        module.exports = { "": () => {} };
      `,
        "/repo/a.js",
      ),
    ).toEqual(["dup function"]);
  });

  it("only looks at top-level statements", () => {
    expect(
      summary(`
        function outer() { function inner() {} }
        namespace N { export function nested() {} }
        if (x) { var hidden = () => {}; }
        interface I {}
        type T = string;
        enum E { A }
      `),
    ).toEqual(["outer function"]);
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-symbols-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
}

describe("symbol nodes", () => {
  it("emits symbol nodes with ids, parents, and source locations", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    await put("apps/api/package.json", JSON.stringify({ name: "api" }));
    await put(
      "apps/api/src/routes/orders.ts",
      [
        "/** Creates an order. */",
        "export async function createOrder() {",
        "  return 1;",
        "}",
        "",
        "export class Orders {",
        "  list() {}",
        "}",
        "",
      ].join("\n"),
    );
    const graph = await analyze(dir);
    const symbols = graph.nodes.filter((n) => n.kind === "symbol");
    expect(symbols).toEqual([
      {
        id: "symbol:api/src/routes/orders.ts#createOrder",
        kind: "symbol",
        label: "createOrder",
        parentId: "file:api/src/routes/orders.ts",
        symbolKind: "function",
        exported: true,
        source: { file: "apps/api/src/routes/orders.ts", line: 2, column: 1, endLine: 4 },
      },
      {
        id: "symbol:api/src/routes/orders.ts#Orders",
        kind: "symbol",
        label: "Orders",
        parentId: "file:api/src/routes/orders.ts",
        symbolKind: "class",
        exported: true,
        source: { file: "apps/api/src/routes/orders.ts", line: 6, column: 1, endLine: 8 },
      },
      {
        id: "symbol:api/src/routes/orders.ts#Orders.list",
        kind: "symbol",
        label: "list",
        parentId: "symbol:api/src/routes/orders.ts#Orders",
        symbolKind: "method",
        exported: true,
        source: { file: "apps/api/src/routes/orders.ts", line: 7, column: 3, endLine: 7 },
      },
    ]);
  });

  it("extracts symbols from JS files and files with syntax errors", async () => {
    await put("server.js", "function start() {}\nmodule.exports = { start };\n");
    await put("broken.ts", "export function ok() {}\nexport const bad = (;\n");
    const graph = await analyze(dir);
    const ids = graph.nodes.filter((n) => n.kind === "symbol").map((n) => n.id);
    expect(ids).toContain("symbol:app/server.js#start");
    expect(ids).toContain("symbol:app/broken.ts#ok");
    expect(graph.warnings.some((w) => w.code === "SYNTAX_ERROR" && w.file === "broken.ts")).toBe(
      true,
    );
  });
});
