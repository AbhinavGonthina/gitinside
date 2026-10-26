import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchitectureGraph } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { extractImports } from "./imports.js";

function specifiers(code: string, fileName = "/repo/a.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true);
  return extractImports(sourceFile).map((s) => s.specifier);
}

describe("extractImports", () => {
  it("collects static, re-export, require, and literal dynamic imports in source order", () => {
    expect(
      specifiers(`
        import a from "./a";
        import "./side-effect";
        import type { T } from "./types";
        export { b } from "./b";
        export * from "./c";
        import d = require("./d");
        const e = require("./e");
        function later() {
          return import("./f");
        }
        const g = require(\`./g\`);
      `),
    ).toEqual(["./a", "./side-effect", "./types", "./b", "./c", "./d", "./e", "./f", "./g"]);
  });

  it("ignores computed specifiers and other calls", () => {
    expect(
      specifiers(`
        const name = "./x";
        require(name);
        import(\`./\${name}\`);
        require("./a", "extra");
        load("./b");
        type Lazy = typeof import("./types");
        export { local };
      `),
    ).toEqual([]);
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-imports-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
}

/** `from -> to (confidence)` for each imports edge. */
function importEdges(graph: ArchitectureGraph): string[] {
  return graph.edges
    .filter((e) => e.kind === "imports")
    .map((e) => `${e.from} -> ${e.to} (${e.confidence})`);
}

describe("import edges", () => {
  it("links relative imports, index files, .js specifiers, and merges repeated sites", async () => {
    await put("tsconfig.json", "{}");
    await put(
      "src/server.ts",
      [
        'import { db } from "./db";',
        'import { list } from "./routes";',
        'import { helper } from "./util.js";',
        'export { db as database } from "./db";',
        'import express from "express";',
        'import "./styles.css";',
        "",
      ].join("\n"),
    );
    await put("src/db.ts", "export const db = 1;\n");
    await put("src/routes/index.ts", "export function list() {}\n");
    await put("src/util.ts", "export function helper() {}\n");
    const graph = await analyze(dir);
    expect(importEdges(graph)).toEqual([
      "file:app/src/server.ts -> file:app/src/db.ts (exact)",
      "file:app/src/server.ts -> file:app/src/routes/index.ts (exact)",
      "file:app/src/server.ts -> file:app/src/util.ts (exact)",
    ]);
    const db = graph.edges.find((e) => e.to === "file:app/src/db.ts");
    expect(db).toEqual({
      id: "imports:file:app/src/server.ts->file:app/src/db.ts",
      kind: "imports",
      from: "file:app/src/server.ts",
      to: "file:app/src/db.ts",
      confidence: "exact",
      sites: [
        { file: "src/server.ts", line: 1, column: 20 },
        { file: "src/server.ts", line: 4, column: 32 },
      ],
    });
    expect(graph.nodes.some((n) => n.kind === "unresolved")).toBe(false);
  });

  it("links CommonJS requires in JS files", async () => {
    await put("server.js", 'const routes = require("./routes");\nmodule.exports = routes;\n');
    await put("routes.js", "module.exports = {};\n");
    const graph = await analyze(dir);
    expect(importEdges(graph)).toEqual(["file:app/server.js -> file:app/routes.js (exact)"]);
  });

  it("resolves tsconfig paths aliases", async () => {
    await put(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
    );
    await put("src/app.ts", 'import { a } from "@/lib/a";\n');
    await put("src/lib/a.ts", "export const a = 1;\n");
    const graph = await analyze(dir);
    expect(importEdges(graph)).toEqual(["file:app/src/app.ts -> file:app/src/lib/a.ts (exact)"]);
  });

  it("shows local imports that don't resolve as unresolved nodes", async () => {
    await put(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["./lib/*"], "*": ["./x/*"] } } }),
    );
    await put(
      "src/app.ts",
      [
        'import { gone } from "./missing";',
        'import { alias } from "@lib/nothing";',
        'import { at } from "@/nope";',
        'import lodash from "lodash";',
        "",
      ].join("\n"),
    );
    const graph = await analyze(dir);
    expect(importEdges(graph)).toEqual([
      "file:app/src/app.ts -> unresolved:app/src/app.ts:1:22 (unresolved)",
      "file:app/src/app.ts -> unresolved:app/src/app.ts:2:23 (unresolved)",
      "file:app/src/app.ts -> unresolved:app/src/app.ts:3:20 (unresolved)",
    ]);
    expect(graph.nodes.find((n) => n.id === "unresolved:app/src/app.ts:1:22")).toEqual({
      id: "unresolved:app/src/app.ts:1:22",
      kind: "unresolved",
      label: "./missing",
      parentId: "service:app/",
      reason: "UNKNOWN_SYMBOL",
      expression: "./missing",
      source: { file: "src/app.ts", line: 1, column: 22 },
    });
    expect(
      graph.edges.every((e) => e.confidence !== "unresolved" || e.reason === "UNKNOWN_SYMBOL"),
    ).toBe(true);
  });

  it("treats an import of a skipped generated file as unresolved", async () => {
    await put("src/app.ts", 'import { schema } from "./schema";\n');
    await put("src/schema.ts", "// @generated\nexport const schema = 1;\n");
    const graph = await analyze(dir);
    expect(importEdges(graph)).toEqual([
      "file:app/src/app.ts -> unresolved:app/src/app.ts:1:24 (unresolved)",
    ]);
  });

  describe("cross-workspace packages", () => {
    beforeEach(async () => {
      await put("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
      await put(
        "apps/web/package.json",
        JSON.stringify({ name: "web", dependencies: { "@acme/shared": "*", "@acme/ui": "*" } }),
      );
    });

    it("follows exports, entry fields, and subpaths to source files", async () => {
      await put(
        "packages/shared/package.json",
        JSON.stringify({
          name: "@acme/shared",
          exports: { ".": { types: "./dist/index.d.ts", import: "./src/index.ts" } },
        }),
      );
      await put("packages/shared/src/index.ts", "export const shared = 1;\n");
      await put(
        "packages/ui/package.json",
        JSON.stringify({ name: "@acme/ui", main: "./lib/main.js" }),
      );
      await put("packages/ui/lib/main.ts", "export const ui = 1;\n");
      await put("packages/ui/lib/button.tsx", "export const Button = () => null;\n");
      await put(
        "apps/web/app.ts",
        [
          'import { shared } from "@acme/shared";',
          'import { ui } from "@acme/ui";',
          'import { Button } from "@acme/ui/lib/button";',
          "",
        ].join("\n"),
      );
      const graph = await analyze(dir);
      expect(importEdges(graph)).toEqual([
        "file:web/app.ts -> file:shared/src/index.ts (exact)",
        "file:web/app.ts -> file:ui/lib/button.tsx (exact)",
        "file:web/app.ts -> file:ui/lib/main.ts (exact)",
      ]);
    });

    it("uses subpath export keys", async () => {
      await put(
        "packages/shared/package.json",
        JSON.stringify({
          name: "@acme/shared",
          exports: { "./utils": "./src/utils/index.ts", "./*": "./src/*.ts" },
        }),
      );
      await put("packages/shared/src/utils/index.ts", "export const u = 1;\n");
      await put("apps/web/app.ts", 'import { u } from "@acme/shared/utils";\n');
      const graph = await analyze(dir);
      expect(importEdges(graph)).toEqual([
        "file:web/app.ts -> file:shared/src/utils/index.ts (exact)",
      ]);
    });

    it("falls back to src/index as heuristic when the entry points into dist", async () => {
      await put(
        "packages/shared/package.json",
        JSON.stringify({ name: "@acme/shared", main: "dist/index.js", types: "dist/index.d.ts" }),
      );
      await put("packages/shared/src/index.ts", "export const shared = 1;\n");
      await put("packages/shared/src/format.ts", "export const format = 1;\n");
      await put(
        "apps/web/app.ts",
        'import { shared } from "@acme/shared";\nimport { format } from "@acme/shared/format";\n',
      );
      const graph = await analyze(dir);
      expect(importEdges(graph)).toEqual([
        "file:web/app.ts -> file:shared/src/format.ts (heuristic)",
        "file:web/app.ts -> file:shared/src/index.ts (heuristic)",
      ]);
    });

    it("uses index as exact when the manifest names no entry", async () => {
      await put("packages/shared/package.json", JSON.stringify({ name: "@acme/shared" }));
      await put("packages/shared/index.js", "module.exports = {};\n");
      await put("apps/web/app.ts", 'import shared from "@acme/shared";\n');
      const graph = await analyze(dir);
      expect(importEdges(graph)).toEqual(["file:web/app.ts -> file:shared/index.js (exact)"]);
    });

    it("marks a workspace import with no resolvable entry as unresolved", async () => {
      await put(
        "packages/shared/package.json",
        JSON.stringify({ name: "@acme/shared", main: "../../outside.js" }),
      );
      await put("packages/shared/README.md", "no code\n");
      await put("apps/web/app.ts", 'import shared from "@acme/shared";\n');
      const graph = await analyze(dir);
      expect(importEdges(graph)).toEqual([
        "file:web/app.ts -> unresolved:web/app.ts:1:20 (unresolved)",
      ]);
    });

    it("survives an unparseable manifest in the imported package", async () => {
      await put("packages/shared/package.json", '{ "name": "@acme/shared", ');
      await put("packages/shared/src/index.ts", "export const shared = 1;\n");
      await put("apps/web/app.ts", 'import { shared } from "shared";\n');
      const graph = await analyze(dir);
      // With no readable name the package is named after its folder, and has no entry fields.
      expect(importEdges(graph)).toEqual([
        "file:web/app.ts -> file:shared/src/index.ts (heuristic)",
      ]);
    });
  });

  it("warns when an import resolves to a file outside every service", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    await put("apps/web/package.json", JSON.stringify({ name: "web" }));
    await put("apps/web/app.ts", 'import { s } from "../../scripts/seed";\n');
    await put("scripts/seed.ts", "export const s = 1;\n");
    const graph = await analyze(dir);
    expect(importEdges(graph)).toEqual([]);
    expect(graph.warnings).toContainEqual({
      code: "IMPORT_OUTSIDE_SERVICE",
      file: "apps/web/app.ts",
      message:
        '"../../scripts/seed" at 1:19 resolves to scripts/seed.ts, which belongs to no service',
    });
  });
});
