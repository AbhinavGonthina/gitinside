import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInventory } from "./inventory.js";
import {
  detectWorkspace,
  compileGlob,
  findCycles,
  serviceForFile,
  serviceNodes,
  type Workspace,
} from "./workspace.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-ws-"));
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

async function detect(): Promise<Workspace> {
  const inventory = await buildInventory(dir);
  return detectWorkspace(dir, inventory.files);
}

const summary = (ws: Workspace) => ws.packages.map((p) => [p.key, p.dir, p.name]);

describe("compileGlob", () => {
  it.each([
    ["packages/*", "packages/a", true],
    ["packages/*", "packages/a/b", false],
    ["packages/**", "packages/a/b", true],
    ["packages/**", "packages", false],
    ["packages/**/x", "packages/x", true],
    ["packages/**/x", "packages/a/b/x", true],
    ["packages/**/x", "packages//x", false],
    ["**/x", "x", true],
    ["**/x", "a/x", true],
    ["**/x", "ax", false],
    ["./apps/*/", "apps/web", true],
    ["apps/*/package.json", "apps/web", true],
    ["apps/{web,api}", "apps/api", true],
    ["apps/{web,api}", "apps/docs", false],
    ["{apps,libs}/{a,b}", "libs/b", true],
    ["{apps,libs}/{a,b}", "libs/c", false],
    ["app?", "app1", true],
    ["app?", "app/", false],
    ["apps.v2/*", "appsxv2/a", false],
    ["a*b*c", "aXbYc", true],
    ["a*b*c", "aX/bYc", false],
    ["*", "web", true],
  ])("%s matches %s: %s", (pattern, path, expected) => {
    expect(compileGlob(pattern)?.(path)).toBe(expected);
  });

  it("matches pathological globs in linear time", () => {
    // A backtracking RegExp for these takes minutes against a deep, non-matching path.
    const deep = `${Array.from({ length: 60 }, () => "a").join("/")}/b`;
    const start = performance.now();
    expect(compileGlob(`${"**/".repeat(40)}z`)?.(deep)).toBe(false);
    expect(compileGlob(`${"**a".repeat(40)}z`)?.(deep)).toBe(false);
    expect(compileGlob(`${"*a".repeat(40)}z`)?.("a".repeat(500))).toBe(false);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("refuses patterns that are too long or expand to too many alternatives", () => {
    expect(compileGlob("{a,b}".repeat(30))).toBeUndefined();
    expect(compileGlob(`{${Array.from({ length: 300 }, (_, i) => i).join(",")}}`)).toBeUndefined();
    expect(compileGlob("a".repeat(1025))).toBeUndefined();
    expect(compileGlob("{a,b}".repeat(8))).toBeDefined();
  });
});

describe("findCycles", () => {
  it("reports multi-package cycles and self-loops, sorted", () => {
    const graph = new Map([
      ["c", ["a"]],
      ["a", ["b"]],
      ["b", ["c", "external"]],
      ["d", ["d"]],
      ["e", ["a"]],
    ]);
    expect(findCycles(graph)).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("returns nothing for an acyclic graph", () => {
    expect(
      findCycles(
        new Map([
          ["a", ["b"]],
          ["b", []],
        ]),
      ),
    ).toEqual([]);
  });
});

describe("detectWorkspace", () => {
  it("falls back to one root service for a single package", async () => {
    await tree({
      "package.json": { name: "@acme/shop", dependencies: { next: "15", react: "19" } },
    });
    const ws = await detect();
    expect(ws.tools).toEqual([]);
    expect(ws.packages).toEqual([
      {
        key: "shop",
        dir: "",
        name: "@acme/shop",
        packageName: "@acme/shop",
        framework: "next",
        dependencies: ["next", "react"],
      },
    ]);
    expect(ws.warnings).toEqual([]);
  });

  it("uses the key `app` when there is no package.json", async () => {
    await tree({ "index.js": "" });
    expect(summary(await detect())).toEqual([["app", "", "app"]]);
  });

  it("reads npm/yarn workspaces arrays and yarn's { packages } form", async () => {
    await tree({
      "package.json": { workspaces: { packages: ["apps/*", "packages/*"] } },
      "apps/web/package.json": { name: "web" },
      "packages/shared/package.json": { name: "@acme/shared" },
      "docs/package.json": { name: "docs" },
    });
    const ws = await detect();
    expect(ws.tools).toEqual(["npm-workspaces"]);
    expect(summary(ws)).toEqual([
      ["web", "apps/web", "web"],
      ["shared", "packages/shared", "@acme/shared"],
    ]);
  });

  it("reads pnpm-workspace.yaml with exclusions, alongside turbo.json", async () => {
    await tree({
      "package.json": { name: "root" },
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - '!apps/legacy'\n",
      "turbo.json": {},
      "apps/api/package.json": { name: "api" },
      "apps/legacy/package.json": { name: "legacy" },
    });
    const ws = await detect();
    expect(ws.tools).toEqual(["pnpm", "turborepo"]);
    expect(summary(ws)).toEqual([["api", "apps/api", "api"]]);
  });

  it("uses lerna.json packages, or Lerna's default when none are listed", async () => {
    await tree({
      "lerna.json": { packages: ["modules/*"] },
      "modules/core/package.json": { name: "core" },
    });
    expect(summary(await detect())).toEqual([["core", "modules/core", "core"]]);

    await tree({ "lerna.json": {}, "packages/util/package.json": { name: "util" } });
    expect(summary(await detect())).toEqual([["util", "packages/util", "util"]]);
  });

  it("treats every project.json folder as a service in an Nx repo", async () => {
    await tree({
      "nx.json": {},
      "apps/admin/project.json": { name: "admin-app" },
      "libs/ui/project.json": {},
      "libs/ui/package.json": { name: "@acme/ui" },
    });
    const ws = await detect();
    expect(ws.tools).toEqual(["nx"]);
    expect(summary(ws)).toEqual([
      ["admin", "apps/admin", "admin-app"],
      ["ui", "libs/ui", "@acme/ui"],
    ]);
    // Only a package.json name is importable; Nx project names are labels.
    expect(ws.packages.map((p) => p.packageName)).toEqual([undefined, "@acme/ui"]);
  });

  it("applies ! exclusions to Nx project folders too", async () => {
    await tree({
      "nx.json": {},
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - '!apps/legacy'\n",
      "apps/admin/project.json": {},
      "apps/legacy/project.json": {},
    });
    expect(summary(await detect())).toEqual([["admin", "apps/admin", "admin"]]);
  });

  it("gives nameless packages no importable name", async () => {
    await tree({
      "package.json": { workspaces: ["packages/*"] },
      "packages/config/package.json": { private: true },
    });
    const ws = await detect();
    expect(summary(ws)).toEqual([["config", "packages/config", "config"]]);
    expect(ws.packages[0]?.packageName).toBeUndefined();
  });

  it("skips hostile workspace patterns with a warning instead of hanging", async () => {
    await tree({
      "package.json": {
        workspaces: ["{a,b}".repeat(30), `${"**/".repeat(40)}z`, "packages/*"],
      },
      "packages/x/package.json": { name: "x" },
      [`${Array.from({ length: 40 }, () => "a").join("/")}/package.json`]: { name: "deep" },
    });
    const ws = await detect();
    expect(summary(ws)).toEqual([["x", "packages/x", "x"]]);
    expect(ws.warnings.map((w) => w.code)).toEqual([
      "WORKSPACE_NO_MATCH",
      "WORKSPACE_PATTERN_TOO_COMPLEX",
    ]);
  });

  it("disambiguates colliding and reserved folder names deterministically", async () => {
    await tree({
      "package.json": { workspaces: ["apps/*", "packages/*", "infra"] },
      "apps/web/package.json": { name: "a" },
      "packages/web/package.json": { name: "b" },
      "infra/package.json": { name: "c" },
    });
    expect(summary(await detect())).toEqual([
      ["apps-web", "apps/web", "a"],
      ["infra-2", "infra", "c"],
      ["packages-web", "packages/web", "b"],
    ]);
  });

  it("detects frameworks from runtime dependencies only", async () => {
    await tree({
      "package.json": { workspaces: ["*"] },
      "api/package.json": { dependencies: { express: "4" }, devDependencies: { react: "19" } },
      "ui/package.json": { peerDependencies: { react: "19" } },
      "tool/package.json": { devDependencies: { express: "4" } },
    });
    const ws = await detect();
    expect(ws.packages.map((p) => [p.key, p.framework])).toEqual([
      ["api", "express"],
      ["tool", undefined],
      ["ui", "react"],
    ]);
    expect(ws.packages[0]?.dependencies).toEqual(["express", "react"]);
  });

  it("warns about invalid config and keeps going", async () => {
    await tree({
      "package.json": { workspaces: "apps/*" },
      "pnpm-workspace.yaml": "packages: [unclosed",
      "lerna.json": "[]",
    });
    const ws = await detect();
    expect(ws.warnings.map((w) => [w.file, w.code])).toEqual([
      ["lerna.json", "INVALID_JSON"],
      ["lerna.json", "WORKSPACE_NO_MATCH"],
      ["package.json", "INVALID_WORKSPACES"],
      ["pnpm-workspace.yaml", "INVALID_YAML"],
    ]);
    expect(summary(ws)).toEqual([["app", "", "app"]]);
  });

  it("warns when a pattern matches nothing and when a package.json is invalid", async () => {
    await tree({
      "package.json": { workspaces: ["apps/*", "services/*"] },
      "apps/web/package.json": "not json",
    });
    const ws = await detect();
    expect(ws.warnings).toEqual([
      {
        code: "INVALID_JSON",
        file: "apps/web/package.json",
        message: "could not parse JSON; ignored",
      },
      {
        code: "WORKSPACE_NO_MATCH",
        file: "package.json",
        message: 'workspace pattern "services/*" matched no package folders',
      },
    ]);
    expect(summary(ws)).toEqual([["web", "apps/web", "web"]]);
  });

  it("warns about duplicate package names and circular dependencies", async () => {
    await tree({
      "package.json": { workspaces: ["*"] },
      "a/package.json": { name: "a", dependencies: { b: "*" } },
      "b/package.json": { name: "b", peerDependencies: { a: "*" } },
      "c/package.json": { name: "a" },
      "d/package.json": { name: "d", devDependencies: { a: "*" } },
    });
    const ws = await detect();
    expect(ws.warnings).toEqual([
      {
        code: "DUPLICATE_PACKAGE_NAME",
        message: 'package name "a" is used by a, c; workspace imports of it are ambiguous',
      },
      { code: "WORKSPACE_CYCLE", message: "circular workspace dependencies between a, b" },
    ]);
  });

  it("never reads files outside the inventory", async () => {
    await tree({
      "package.json": { workspaces: ["*"] },
      "real/package.json": { name: "real" },
      "node_modules/dep/package.json": { name: "dep" },
    });
    await mkdir(join(dir, "linked"));
    // Windows without symlink rights can't create this; the node_modules case still runs.
    await symlink(join(dir, "real", "package.json"), join(dir, "linked", "package.json")).catch(
      () => undefined,
    );
    expect(summary(await detect())).toEqual([["real", "real", "real"]]);
  });

  it("is independent of file order", async () => {
    await tree({
      "package.json": { workspaces: ["*"] },
      "b/package.json": { name: "b" },
      "a/package.json": { name: "a" },
    });
    const inventory = await buildInventory(dir);
    const forward = await detectWorkspace(dir, inventory.files);
    const reversed = await detectWorkspace(dir, [...inventory.files].reverse());
    expect(reversed).toEqual(forward);
  });
});

describe("serviceForFile and serviceNodes", () => {
  const ws: Workspace = {
    tools: [],
    warnings: [],
    packages: [
      { key: "web", dir: "apps/web", name: "@acme/web", framework: "next", dependencies: [] },
      { key: "docs", dir: "apps/web/docs", name: "docs", dependencies: [] },
    ],
  };

  it("picks the deepest containing package", () => {
    expect(serviceForFile(ws, "apps/web/src/a.ts")?.key).toBe("web");
    expect(serviceForFile(ws, "apps/web/docs/b.ts")?.key).toBe("docs");
    expect(serviceForFile(ws, "apps/webby/c.ts")).toBeUndefined();
    expect(serviceForFile(ws, "scripts/d.ts")).toBeUndefined();
  });

  it("puts every file in the root service of a single-package repo", () => {
    const single: Workspace = {
      ...ws,
      packages: [{ key: "app", dir: "", name: "app", dependencies: [] }],
    };
    expect(serviceForFile(single, "src/a.ts")?.key).toBe("app");
  });

  it("emits service nodes under the system root with framework and layer", () => {
    expect(serviceNodes(ws)).toEqual([
      {
        id: "service:web/",
        kind: "service",
        label: "@acme/web",
        parentId: "system:root",
        root: "apps/web",
        framework: "next",
        layer: "frontend",
      },
      {
        id: "service:docs/",
        kind: "service",
        label: "docs",
        parentId: "system:root",
        root: "apps/web/docs",
      },
    ]);
  });
});
