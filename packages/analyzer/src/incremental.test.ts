import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, analyzeServices, type AnalyzeOptions } from "./analyze.js";
import { serializeGraph } from "./assemble.js";
import { openDiskCache, type DiskCache, type FactCache } from "./cache.js";
import { runCli } from "./cli.js";
import type { ServiceFacts } from "./facts.js";
import { globalFactsKey, storeFacts, type FactKeys } from "./incremental.js";
import { detectWorkspace } from "./workspace.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
/** Every fixture with a golden graph. */
const NAMES = readdirSync(FIXTURES).filter((name) =>
  existsSync(join(FIXTURES, name, "expected.json")),
);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-incremental-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, "repo", path)), { recursive: true });
  await writeFile(join(dir, "repo", path), content);
}

/** The graph of `root` without a cache: what a warm run must reproduce. */
async function cold(root: string, options: AnalyzeOptions = {}): Promise<string> {
  return serializeGraph(await analyze(root, options));
}

/** The graph of `root` with `cache`, and what the cache did during the run. */
async function warm(
  root: string,
  cache: DiskCache,
  options: AnalyzeOptions = {},
): Promise<{ bytes: string; hits: number; writes: number; services: number }> {
  const before = cache.stats();
  let services = 0;
  const bytes = serializeGraph(
    await analyzeServices(root, { ...options, cache, onFacts: (f) => (services = f.length) }),
  );
  const after = cache.stats();
  return {
    bytes,
    hits: after.hits - before.hits,
    writes: after.writes - before.writes,
    services,
  };
}

/**
 * A three-service workspace: `web` imports `@acme/shared` and calls `api` over HTTP, `api`
 * is an Express app, and `shared` has its own tsconfig.
 */
async function monorepo(): Promise<string> {
  await put("package.json", JSON.stringify({ name: "acme", workspaces: ["apps/*", "packages/*"] }));
  await put(
    "apps/web/package.json",
    JSON.stringify({ name: "web", dependencies: { "@acme/shared": "*" } }),
  );
  await put(
    "apps/web/src/app.ts",
    [
      'import { format } from "@acme/shared";',
      "export async function load() {",
      '  const res = await fetch("/api/users");',
      "  return format(await res.json());",
      "}",
      "",
    ].join("\n"),
  );
  await put(
    "apps/api/package.json",
    JSON.stringify({ name: "api", dependencies: { express: "4.0.0" } }),
  );
  await put(
    "apps/api/src/server.ts",
    [
      'import express from "express";',
      "const app = express();",
      'app.get("/api/users", (req, res) => res.json([]));',
      "app.listen(3000);",
      "",
    ].join("\n"),
  );
  await put(
    "packages/shared/package.json",
    JSON.stringify({ name: "@acme/shared", exports: "./src/index.ts" }),
  );
  await put("tsconfig.base.json", JSON.stringify({ compilerOptions: { strict: true } }));
  await put(
    "packages/shared/tsconfig.json",
    JSON.stringify({ extends: "../../tsconfig.base.json", compilerOptions: {} }),
  );
  await put(
    "packages/shared/src/index.ts",
    "export function format(x: unknown) { return String(x); }\n",
  );
  return join(dir, "repo");
}

describe("analyze({ cache }) (M6.7e1)", () => {
  it.each(NAMES)("%s: a warm run from a moved checkout gives the cold bytes", async (name) => {
    const options = { owner: "fixtures", name };
    const first = join(dir, "first");
    const moved = join(dir, "moved");
    await cp(join(FIXTURES, name), first, { recursive: true });
    await cp(join(FIXTURES, name), moved, { recursive: true });
    const expected = await cold(first, options);
    const cache = await openDiskCache(join(dir, "cache"));

    const filled = await warm(first, cache, options);
    expect(filled.bytes).toBe(expected);
    const reused = await warm(moved, cache, options);
    expect(reused.bytes).toBe(expected);
    // Every service came from the cache, so nothing was collected or stored again.
    expect(filled.writes).toBe(filled.services);
    expect(reused).toMatchObject({ hits: filled.services, writes: 0 });
  });

  const edits: [string, () => Promise<void>][] = [
    [
      "edit a file",
      () =>
        put(
          "apps/api/src/server.ts",
          [
            'import express from "express";',
            "const app = express();",
            'app.get("/api/users", (req, res) => res.json([]));',
            'app.post("/api/users", (req, res) => res.json({}));',
            "app.listen(3000);",
            "",
          ].join("\n"),
        ),
    ],
    ["add a file", () => put("packages/shared/src/extra.ts", "export const extra = 1;\n")],
    [
      "delete a file",
      async () => {
        await rm(join(dir, "repo", "packages/shared/src/index.ts"));
      },
    ],
    [
      "change a file another service imports",
      () =>
        put(
          "packages/shared/src/index.ts",
          "export function format(x: unknown, y = 0) { return String(x) + y; }\nexport function more() {}\n",
        ),
    ],
    [
      "add a cross-service import",
      () =>
        put(
          "apps/api/src/server.ts",
          [
            'import express from "express";',
            'import { format } from "../../../packages/shared/src/index";',
            "const app = express();",
            'app.get("/api/users", (req, res) => res.json(format([])));',
            "app.listen(3000);",
            "",
          ].join("\n"),
        ),
    ],
    [
      "add a tsconfig",
      () =>
        put(
          "apps/web/tsconfig.json",
          JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false } }),
        ),
    ],
    ["break a tsconfig", () => put("packages/shared/tsconfig.json", '{ "compilerOptions": ')],
    // No service's own files change: only the recorded inputs show it.
    ["break an extended tsconfig outside every service", () => put("tsconfig.base.json", "{ ")],
    [
      "add a dependency",
      () =>
        put(
          "apps/web/package.json",
          JSON.stringify({ name: "web", dependencies: { "@acme/shared": "*", next: "15.0.0" } }),
        ),
    ],
    [
      "add a Prisma schema",
      () =>
        put(
          "apps/api/prisma/schema.prisma",
          'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\nmodel User {\n  id Int @id\n}\n',
        ),
    ],
  ];

  it.each(edits)("%s: the warm run gives the cold bytes", async (_, edit) => {
    const root = await monorepo();
    const cache = await openDiskCache(join(dir, "cache"));
    const before = await warm(root, cache);
    expect(before.bytes).toBe(await cold(root));
    expect(before.writes).toBe(3);

    await edit();
    const expected = await cold(root);
    expect(expected).not.toBe(before.bytes);
    const after = await warm(root, cache);
    expect(after.bytes).toBe(expected);
    // Something changed, so the run was cold and stored its facts again.
    expect(after.writes).toBe(3);
    // And the next run reuses them.
    const again = await warm(root, cache);
    expect(again).toEqual({ bytes: expected, hits: 3, writes: 0, services: 3 });
  });

  it("reuses one entry per side when switching between two versions", async () => {
    const root = await monorepo();
    const cache = await openDiskCache(join(dir, "cache"));
    const server = join(root, "apps/api/src/server.ts");
    const base = await readFile(server, "utf8");
    const head = base.replace(
      "app.listen",
      'app.delete("/api/users", (req, res) => res.end());\napp.listen',
    );
    await warm(root, cache);
    await writeFile(server, head);
    await warm(root, cache);

    // api's own files differ, so each version has its own api entry; web's and shared's
    // inputs are the same in both, so their entries serve both. Both versions are warm.
    await writeFile(server, base);
    const back = await warm(root, cache);
    expect(back).toMatchObject({ bytes: await cold(root), hits: 3, writes: 0 });
    await writeFile(server, head);
    const forth = await warm(root, cache);
    expect(forth).toMatchObject({ bytes: await cold(root), hits: 3, writes: 0 });
  });

  it("treats an entry of the wrong shape as a miss", async () => {
    const root = await monorepo();
    const expected = await cold(root);
    const puts: string[] = [];
    const junk: FactCache = {
      get: async () => ({ facts: { service: "someone-else" }, inputs: {} }),
      put: async (key) => {
        puts.push(key);
      },
    };
    expect(serializeGraph(await analyze(root, { cache: junk }))).toBe(expected);
    expect(puts).toHaveLength(3);
  });

  it("composes from the cache when the cache answers stored entries", async () => {
    const root = await monorepo();
    const expected = await cold(root);
    const stored = new Map<string, unknown>();
    const memory: FactCache = {
      get: async (key) => structuredClone(stored.get(key)),
      put: async (key, value) => {
        stored.set(key, JSON.parse(JSON.stringify(value)));
      },
    };
    await analyze(root, { cache: memory });
    expect(stored.size).toBe(3);
    // Mark the facts: a warm run that reuses them shows it.
    for (const value of stored.values()) {
      const entry = value as { facts: ServiceFacts };
      entry.facts.programWarnings.push({ code: "TSCONFIG_MISSING", message: "from the cache" });
    }
    const reused = await analyze(root, { cache: memory });
    expect(serializeGraph(reused)).not.toBe(expected);
    expect(reused.warnings.filter((w) => w.message === "from the cache")).toHaveLength(1);
  });

  it("never stores a bundle whose collection failed", async () => {
    const puts: string[] = [];
    const cache: FactCache = {
      get: async () => undefined,
      put: async (key) => {
        puts.push(key);
      },
    };
    const bundle = (service: string, failed: ServiceFacts["failed"]): ServiceFacts => ({
      service,
      rootFiles: [],
      programWarnings: [],
      symbols: [],
      failed,
      analyzerWarnings: [],
    });
    const inputs = { listings: [], files: [], dirs: [] };
    const keys: FactKeys = {
      keys: new Map([
        ["a", "key-a"],
        ["b", "key-b"],
      ]),
      hashOf: async () => "",
    };
    await storeFacts(
      cache,
      keys,
      [
        bundle("a", []),
        bundle("b", [{ stage: "next", warning: { code: "DETECTOR_FAILED", message: "x" } }]),
      ],
      new Map([
        ["a", inputs],
        ["b", inputs],
      ]),
    );
    expect(puts).toEqual(["key-a"]);
  });

  it("keys the global inputs no service records", async () => {
    const root = await monorepo();
    const workspace = await detectWorkspace(root, [
      "package.json",
      "apps/web/package.json",
      "apps/api/package.json",
      "packages/shared/package.json",
    ]);
    const sources = ["apps/api/src/server.ts"];
    const key = globalFactsKey(workspace, sources);
    expect(globalFactsKey(workspace, sources, {})).toBe(key);
    expect(globalFactsKey(workspace, sources, { maxSourceFiles: 10 })).not.toBe(key);
    expect(globalFactsKey(workspace, [...sources, "apps/api/schema.prisma"])).not.toBe(key);
    const renamed = {
      ...workspace,
      packages: workspace.packages.map((p) => ({ ...p, dependencies: [...p.dependencies, "x"] })),
    };
    expect(globalFactsKey(renamed, sources)).not.toBe(key);
  });
});

describe("--cache (M6.7e1)", () => {
  function capture() {
    const io = {
      out: "",
      err: "",
      stdout: (t: string) => (io.out += t),
      stderr: (t: string) => (io.err += t),
    };
    return io;
  }

  it("analyze: fills the cache, then gives the same output from it", async () => {
    const root = await monorepo();
    const cacheDir = join(dir, "cache");
    const first = capture();
    expect(await runCli(["analyze", root, "--cache", cacheDir], first)).toBe(0);
    expect(first.out).toBe(await cold(root));
    expect((await openDiskCache(cacheDir)).stats().entries).toBe(3);
    const second = capture();
    expect(await runCli(["analyze", root, "--cache", cacheDir], second)).toBe(0);
    expect(second.out).toBe(first.out);
  });

  it("diff: both sides share the cache, and the diff is unchanged", async () => {
    const repo = await monorepo();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    const commit = (message: string) => {
      git("add", "--all");
      git(
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        message,
      );
    };
    git("init", "--quiet", "--initial-branch=main");
    git("config", "core.autocrlf", "false");
    commit("base");
    await put("packages/shared/src/extra.ts", "export const extra = 1;\n");
    commit("head");

    const plain = capture();
    expect(await runCli(["diff", "HEAD~1", "HEAD", "--repo", repo], plain)).toBe(0);
    const cacheDir = join(dir, "cache");
    for (let run = 0; run < 2; run++) {
      const io = capture();
      const argv = ["diff", "HEAD~1", "HEAD", "--repo", repo, "--cache", cacheDir];
      expect(await runCli(argv, io)).toBe(0);
      expect(io.err).toBe("");
      expect(io.out).toBe(plain.out);
    }
    // web and api have the same own files on both sides, so they share keys; shared differs.
    expect((await openDiskCache(cacheDir)).stats().entries).toBe(4);
  }, 60_000);
});
