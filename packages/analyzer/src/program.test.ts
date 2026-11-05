import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInventory } from "./inventory.js";
import { DEFAULT_COMPILER_OPTIONS, buildServicePrograms, type ServiceProgram } from "./program.js";
import { detectWorkspace } from "./workspace.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-prog-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a tree of files; object values are serialized as JSON. */
async function tree(files: Record<string, string | object>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(
      join(dir, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
}

async function build(): Promise<ServiceProgram[]> {
  const inventory = await buildInventory(dir);
  const workspace = await detectWorkspace(dir, inventory.files);
  return buildServicePrograms(dir, workspace, inventory);
}

async function only(): Promise<ServiceProgram> {
  const programs = await build();
  expect(programs).toHaveLength(1);
  return programs[0] as ServiceProgram;
}

/** Repo-relative path that `specifier` in `from` resolves to, or undefined. */
function resolved(sp: ServiceProgram, from: string, specifier: string): string | undefined {
  const result = ts.resolveModuleName(
    specifier,
    sp.toAbsolute(from),
    sp.program.getCompilerOptions(),
    sp.host,
  );
  const file = result.resolvedModule?.resolvedFileName;
  return file === undefined ? undefined : sp.toRepoPath(file);
}

describe("buildServicePrograms", () => {
  it("synthesizes defaults and warns when no tsconfig exists", async () => {
    await tree({ "src/a.ts": "export const a = 1;", "src/b.jsx": "export const B = () => <b/>;" });
    const sp = await only();
    expect(sp.configFile).toBeUndefined();
    expect(sp.rootFiles).toEqual(["src/a.ts", "src/b.jsx"]);
    const options = sp.program.getCompilerOptions();
    expect(options.allowJs).toBe(true);
    expect(options.jsx).toBe(ts.JsxEmit.Preserve);
    expect(options.noEmit).toBe(true);
    expect(options.skipLibCheck).toBe(true);
    expect(options.types).toEqual([]);
    expect(sp.warnings).toEqual([
      {
        code: "TSCONFIG_MISSING",
        message: "no tsconfig.json or jsconfig.json; using default compiler options",
      },
    ]);
  });

  it("names the service folder in the missing-config warning", async () => {
    await tree({
      "package.json": { workspaces: ["apps/*"] },
      "apps/web/package.json": { name: "web" },
      "apps/web/index.ts": "",
    });
    const sp = await only();
    expect(sp.warnings[0]).toMatchObject({ code: "TSCONFIG_MISSING", file: "apps/web" });
  });

  it("does not warn about config for a service with no source files", async () => {
    await tree({ "README.md": "hi" });
    const sp = await only();
    expect(sp.rootFiles).toEqual([]);
    expect(sp.warnings).toEqual([]);
  });

  it("loads tsconfig.json and honors paths and baseUrl", async () => {
    await tree({
      "tsconfig.json": {
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] }, strict: true },
      },
      "src/app.ts": 'import { x } from "@/lib/x"; import { y } from "src/lib/y";',
      "src/lib/x.ts": "export const x = 1;",
      "src/lib/y.ts": "export const y = 1;",
    });
    const sp = await only();
    expect(sp.configFile).toBe("tsconfig.json");
    expect(sp.warnings).toEqual([]);
    expect(sp.program.getCompilerOptions().strict).toBe(true);
    expect(resolved(sp, "src/app.ts", "@/lib/x")).toBe("src/lib/x.ts");
    expect(resolved(sp, "src/app.ts", "src/lib/y")).toBe("src/lib/y.ts");
  });

  it("resolves extensionless, index, and .js-suffixed relative imports by default", async () => {
    await tree({
      "src/a.ts": "",
      "src/lib/index.ts": "",
      "src/c.ts": "",
    });
    const sp = await only();
    expect(resolved(sp, "src/a.ts", "./lib")).toBe("src/lib/index.ts");
    expect(resolved(sp, "src/a.ts", "./c.js")).toBe("src/c.ts");
  });

  it("follows a relative extends chain to a shared base config", async () => {
    await tree({
      "package.json": { workspaces: ["apps/*"] },
      "tsconfig.base.json": { compilerOptions: { paths: { "~/*": ["./apps/web/src/*"] } } },
      "apps/web/package.json": { name: "web" },
      "apps/web/tsconfig.json": { extends: "../../tsconfig.base.json" },
      "apps/web/src/a.ts": 'import "~/b";',
      "apps/web/src/b.ts": "",
    });
    const sp = await only();
    expect(sp.configFile).toBe("apps/web/tsconfig.json");
    expect(sp.warnings).toEqual([]);
    expect(resolved(sp, "apps/web/src/a.ts", "~/b")).toBe("apps/web/src/b.ts");
  });

  it("falls back to jsconfig.json", async () => {
    await tree({
      "jsconfig.json": { compilerOptions: { baseUrl: "src" } },
      "src/a.js": "",
      "src/b.js": "",
    });
    const sp = await only();
    expect(sp.configFile).toBe("jsconfig.json");
    expect(resolved(sp, "src/a.js", "b")).toBe("src/b.js");
  });

  it("warns and keeps going when extends points into node_modules", async () => {
    await tree({
      "tsconfig.json": { extends: "@tsconfig/node20/tsconfig.json", compilerOptions: {} },
      "a.ts": "",
    });
    const sp = await only();
    expect(sp.rootFiles).toEqual(["a.ts"]);
    expect(sp.warnings.map((w) => [w.code, w.file])).toEqual([
      ["TSCONFIG_INVALID", "tsconfig.json"],
    ]);
    expect(sp.warnings[0]?.message).toMatch(/@tsconfig\/node20/);
  });

  it("warns on unparseable tsconfig and uses defaults", async () => {
    await tree({ "tsconfig.json": "{ nope", "a.ts": "" });
    const sp = await only();
    expect(sp.configFile).toBeUndefined();
    expect(sp.program.getCompilerOptions().allowJs).toBe(true);
    expect(sp.warnings.map((w) => [w.code, w.file])).toEqual([
      ["TSCONFIG_INVALID", "tsconfig.json"],
    ]);
  });

  it("forces safe options over the repo's config", async () => {
    await tree({
      "tsconfig.json": {
        compilerOptions: { noEmit: false, outDir: "out", types: ["node"], composite: true },
      },
      "a.ts": "",
    });
    const options = (await only()).program.getCompilerOptions();
    expect(options.noEmit).toBe(true);
    expect(options.types).toEqual([]);
    expect(options.composite).toBe(false);
  });

  it.each([
    ["es2015", ts.ModuleResolutionKind.Bundler],
    ["commonjs", ts.ModuleResolutionKind.Node10],
    ["nodenext", undefined],
  ])("fills moduleResolution for module %s", async (module, expected) => {
    await tree({ "tsconfig.json": { compilerOptions: { module } }, "a.ts": "" });
    expect((await only()).program.getCompilerOptions().moduleResolution).toBe(expected);
  });

  it("keeps an explicit moduleResolution", async () => {
    await tree({
      "tsconfig.json": { compilerOptions: { module: "es2020", moduleResolution: "node" } },
      "a.ts": "",
    });
    expect((await only()).program.getCompilerOptions().moduleResolution).toBe(
      ts.ModuleResolutionKind.Node10,
    );
  });

  it("never reads node_modules: package imports stay unresolved", async () => {
    await tree({ "a.ts": 'import express from "express";' });
    await mkdir(join(dir, "node_modules", "express"), { recursive: true });
    await writeFile(join(dir, "node_modules", "express", "index.js"), "module.exports = 1;");
    await writeFile(
      join(dir, "node_modules", "express", "package.json"),
      JSON.stringify({ name: "express", main: "index.js" }),
    );
    const sp = await only();
    expect(resolved(sp, "a.ts", "express")).toBeUndefined();
    const repoFiles = sp.program
      .getSourceFiles()
      .map((f) => sp.toRepoPath(f.fileName))
      .filter((f) => f !== undefined);
    expect(repoFiles).toEqual(["a.ts"]);
  });

  it("only reads inventory files (skipped files stay invisible)", async () => {
    await tree({ "a.ts": 'import "./gen";', "gen.ts": "// @generated\nexport {};" });
    const sp = await only();
    expect(resolved(sp, "a.ts", "./gen")).toBeUndefined();
    expect(sp.rootFiles).toEqual(["a.ts"]);
  });

  it("reports syntax errors as warnings with a location, and still parses the file", async () => {
    await tree({ "src/bad.ts": "export function f( {\n  return 1;\n", "src/ok.ts": "" });
    const sp = await only();
    const syntax = sp.warnings.filter((w) => w.code === "SYNTAX_ERROR");
    expect(syntax).toHaveLength(1);
    expect(syntax[0]?.file).toBe("src/bad.ts");
    expect(syntax[0]?.message).toMatch(/^syntax error at \d+:\d+: /);
    expect(sp.program.getSourceFile(sp.toAbsolute("src/bad.ts"))).toBeDefined();
  });

  it("splits root files between nested services", async () => {
    await tree({
      "package.json": { workspaces: ["apps/*", "apps/web/plugins/*"] },
      "apps/web/package.json": { name: "web" },
      "apps/web/tsconfig.json": {},
      "apps/web/a.ts": "",
      "apps/web/plugins/p/package.json": { name: "p" },
      "apps/web/plugins/p/tsconfig.json": {},
      "apps/web/plugins/p/b.ts": "",
      "schema.prisma": "",
    });
    const programs = await build();
    // The root schema makes the root a service too (ADR-0021 amendment), with no program files.
    expect(programs.map((p) => [p.service.key, p.rootFiles])).toEqual([
      ["app", []],
      ["web", ["apps/web/a.ts"]],
      ["p", ["apps/web/plugins/p/b.ts"]],
    ]);
  });

  describe("a file loaded by several services", () => {
    const shared = "packages/shared/x.ts";
    const workspace = {
      "package.json": { workspaces: ["apps/*", "packages/*"] },
      "apps/web/package.json": { name: "web" },
      "apps/web/a.ts": 'import { x } from "../../packages/shared/x";',
      "apps/api/package.json": { name: "api" },
      "apps/api/b.ts": 'import { x } from "../../packages/shared/x";',
      "packages/shared/package.json": { name: "shared" },
      [shared]: "export const x = 1;",
    };
    const sourceOf = (sp: ServiceProgram | undefined): ts.SourceFile | undefined =>
      sp?.program.getSourceFile(sp.toAbsolute(shared));
    const byKey = (programs: ServiceProgram[], key: string): ServiceProgram | undefined =>
      programs.find((p) => p.service.key === key);

    it("is parsed once when their options parse it alike, each service recording its read", async () => {
      await tree(workspace);
      const programs = await build();
      const [web, api, owner] = ["web", "api", "shared"].map((key) => byKey(programs, key));
      const file = sourceOf(owner);
      expect(file).toBeDefined();
      expect(sourceOf(web)).toBe(file);
      expect(sourceOf(api)).toBe(file);
      for (const sp of [web, api, owner]) {
        const read = sp?.inputs.snapshot().files.find(([path]) => path === shared);
        expect(read?.[1]).toMatch(/^[0-9a-f]{64}$/);
        const checker = sp?.program.getTypeChecker();
        const module = file && checker?.getSymbolAtLocation(file);
        expect(module && checker?.getExportsOfModule(module).map((s) => s.name)).toEqual(["x"]);
      }
    });

    it("is parsed once when each service's config has its own `paths`", async () => {
      await tree({
        ...workspace,
        "apps/web/tsconfig.json": { compilerOptions: { paths: { "~/*": ["./*"] } } },
        "apps/api/tsconfig.json": { compilerOptions: { paths: { "~/*": ["./*"] } } },
      });
      const programs = await build();
      const [web, api, owner] = ["web", "api", "shared"].map((key) => byKey(programs, key));
      expect(sourceOf(web)).toBeDefined();
      expect(sourceOf(web)).toBe(sourceOf(owner));
      expect(sourceOf(api)).toBe(sourceOf(owner));
    });

    it("is parsed again for a service whose options parse or bind it differently", async () => {
      await tree({
        ...workspace,
        "apps/web/tsconfig.json": { compilerOptions: { jsx: "react-jsx" } },
        "apps/api/tsconfig.json": { compilerOptions: { target: "es5" } },
      });
      const programs = await build();
      const [web, api, owner] = ["web", "api", "shared"].map((key) => byKey(programs, key));
      const files = new Set([sourceOf(web), sourceOf(api), sourceOf(owner)]);
      expect(files.size).toBe(3);
      expect(sourceOf(api)?.languageVersion).toBe(ts.ScriptTarget.ES5);
    });

    it("resolves its imports with each service's own `paths` though its parse is shared", async () => {
      await tree({
        ...workspace,
        [shared]: 'import { z } from "~/z"; export const x = z;',
        "apps/web/tsconfig.json": { compilerOptions: { paths: { "~/*": ["./*"] } } },
        "apps/web/z.ts": "export const z = 1;",
        "apps/api/tsconfig.json": { compilerOptions: { paths: { "~/*": ["./*"] } } },
        "apps/api/z.ts": "export const z = 2;",
      });
      const programs = await build();
      const [web, api] = ["web", "api"].map((key) => byKey(programs, key));
      expect(sourceOf(web)).toBe(sourceOf(api));
      for (const [sp, own, other] of [
        [web, "apps/web/z.ts", "apps/api/z.ts"],
        [api, "apps/api/z.ts", "apps/web/z.ts"],
      ] as const) {
        expect(sp && resolved(sp, shared, "~/z")).toBe(own);
        expect(sp?.program.getSourceFile(sp.toAbsolute(own))).toBeDefined();
        expect(sp?.program.getSourceFile(sp.toAbsolute(other))).toBeUndefined();
      }
    });
  });

  it("keeps machine paths out of warning messages", async () => {
    await tree({ "tsconfig.json": { extends: "./missing.json" }, "a.ts": "" });
    const sp = await only();
    const text = JSON.stringify(sp.warnings);
    expect(text).not.toContain(dir.replaceAll("\\", "/"));
    expect(text).not.toContain(dir);
    expect(text).toContain("missing.json");
  });

  it("produces identical warnings across runs", async () => {
    await tree({ "tsconfig.json": "{", "a.ts": "let = ;" });
    expect((await only()).warnings).toEqual((await only()).warnings);
  });

  it("exports the documented defaults", () => {
    expect(DEFAULT_COMPILER_OPTIONS.moduleResolution).toBe(ts.ModuleResolutionKind.Bundler);
  });
});
