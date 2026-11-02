import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareStrings } from "@gitinside/schema";
import {
  ANALYSIS_STAGES,
  analyze,
  analyzeServices,
  type AnalysisProgress,
  type AnalyzeOptions,
} from "./analyze.js";
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

/**
 * The graph of `root` with `cache`, what the cache did during the run, and which services'
 * facts it stored (sorted).
 */
async function warm(
  root: string,
  cache: DiskCache,
  options: AnalyzeOptions = {},
): Promise<{ bytes: string; hits: number; writes: number; services: number; stored: string[] }> {
  const before = cache.stats();
  let services = 0;
  const stored: string[] = [];
  const recording: FactCache = {
    get: (key) => cache.get(key),
    put: (key, value) => {
      stored.push((value as { facts: ServiceFacts }).facts.service);
      return cache.put(key, value);
    },
  };
  const bytes = serializeGraph(
    await analyzeServices(root, {
      ...options,
      cache: recording,
      onFacts: (f) => (services = f.length),
    }),
  );
  const after = cache.stats();
  return {
    bytes,
    hits: after.hits - before.hits,
    writes: after.writes - before.writes,
    services,
    stored: stored.sort(compareStrings),
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

describe("analyze({ cache }) (M6.7e1, M6.7e2)", () => {
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

  /**
   * The services each edit leaves dirty (M6.7e2): those whose recorded inputs it changes,
   * including through a program they reached (`web` reaches `shared`'s through its import of
   * `@acme/shared`), or every service when it changes the key's global inputs.
   */
  const recollected: Record<string, string[]> = {
    "edit a file": ["api"],
    "add a file": ["shared", "web"],
    "delete a file": ["shared", "web"],
    "change a file another service imports": ["shared", "web"],
    // api's program now loads shared's file itself; shared's facts don't change.
    "add a cross-service import": ["api"],
    "add a tsconfig": ["web"],
    "break a tsconfig": ["shared", "web"],
    "break an extended tsconfig outside every service": ["shared", "web"],
    "add a dependency": ["api", "shared", "web"],
    "add a Prisma schema": ["api", "shared", "web"],
  };

  it.each(edits)("%s: the warm run gives the cold bytes", async (name, edit) => {
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
    // Only the dirty services were collected and stored again; the rest were reused.
    expect(after.stored).toEqual(recollected[name]);
    // And the next run reuses them.
    const again = await warm(root, cache);
    expect(again).toEqual({ bytes: expected, hits: 3, writes: 0, services: 3, stored: [] });
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

  it("never stores a bundle whose collection failed or met a TypeScript internal error", async () => {
    const puts: string[] = [];
    const cache: FactCache = {
      get: async () => undefined,
      put: async (key) => {
        puts.push(key);
      },
    };
    const bundle = (service: string, broken: Partial<ServiceFacts> = {}): ServiceFacts => ({
      service,
      rootFiles: [],
      programWarnings: [],
      symbols: [],
      failed: [],
      analyzerWarnings: [],
      ...broken,
    });
    const service = { inputs: { listings: [], files: [], dirs: [] }, queueLibrary: () => false };
    const keys: FactKeys = {
      keys: new Map([
        ["a", "key-a"],
        ["b", "key-b"],
        ["c", "key-c"],
      ]),
      hashOf: async () => "",
    };
    const warning = { code: "DETECTOR_FAILED", message: "x" } as const;
    await storeFacts(
      cache,
      keys,
      [
        bundle("a"),
        bundle("b", { failed: [{ stage: "next", warning }] }),
        bundle("c", {
          analyzerWarnings: [{ code: "TYPESCRIPT_INTERNAL_ERROR", message: "y" }],
        }),
      ],
      new Map([
        ["a", service],
        ["b", service],
        ["c", service],
      ]),
      { routers: false, queues: false, wrappers: [] },
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

describe("partial reuse: repo-wide facts (M6.7e2)", () => {
  /** A workspace of `apps/*` and `packages/*` with the given package names, and no files. */
  async function workspaceOf(packages: Record<string, object>): Promise<string> {
    await put(
      "package.json",
      JSON.stringify({ name: "acme", workspaces: ["apps/*", "packages/*"] }),
    );
    for (const [folder, manifest] of Object.entries(packages)) {
      await put(`${folder}/package.json`, JSON.stringify(manifest));
    }
    return join(dir, "repo");
  }

  /** A run of `root` with `cache`: what `onStage` and `onProgress` reported, and what it stored. */
  async function observed(root: string, cache: DiskCache) {
    const stored: string[] = [];
    const stages: string[] = [];
    const progress: AnalysisProgress[] = [];
    await analyze(root, {
      cache: {
        get: (key) => cache.get(key),
        put: (key, value) => {
          stored.push((value as { facts: ServiceFacts }).facts.service);
          return cache.put(key, value);
        },
      },
      onStage: (stage) => stages.push(stage),
      onProgress: (event) => progress.push(event),
    });
    return { stored: stored.sort(compareStrings), stages, progress };
  }

  it("recollects a clean service when another adds a wrapper named like one of its calls", async () => {
    const root = await workspaceOf({
      "apps/web": { name: "web" },
      "apps/api": { name: "api" },
    });
    // `g` is `get`, but the call is only resolved when some wrapper is named `g` (ADR-0092).
    await put(
      "apps/web/src/client.ts",
      [
        "export function get(path: string) { return fetch(path); }",
        "const g = get;",
        'export function users() { return g("/users"); }',
        "",
      ].join("\n"),
    );
    await put("apps/api/src/index.ts", "export const port = 3000;\n");
    const cache = await openDiskCache(join(dir, "cache"));
    expect((await warm(root, cache)).stored).toEqual(["api", "web"]);

    await put("apps/api/src/g.ts", "export function g(url: string) { return fetch(url); }\n");
    const expected = await cold(root);
    const after = await warm(root, cache);
    expect(after.bytes).toBe(expected);
    // web's files and inputs are unchanged, but its call to `g` now inlines `get`.
    expect(after.stored).toEqual(["api", "web"]);
    expect(await warm(root, cache)).toMatchObject({ bytes: expected, writes: 0 });
  });

  it("recollects a clean service when the repo's first router appears", async () => {
    const root = await workspaceOf({
      "apps/api": { name: "api", dependencies: { express: "4.0.0" } },
      "packages/lib": { name: "@acme/lib" },
    });
    // lib registers a route on whatever router it's given; without any router in the repo,
    // its registrations aren't collected. (A relative import: routers aren't followed through
    // workspace package imports.)
    await put(
      "packages/lib/src/index.ts",
      'export function routes(r: any) { r.get("/health", (req: any, res: any) => res.end()); }\n',
    );
    await put("apps/api/src/server.ts", "export const port = 3000;\n");
    const cache = await openDiskCache(join(dir, "cache"));
    const without = await warm(root, cache);
    expect(without.stored).toEqual(["api", "lib"]);

    const server = [
      'import express from "express";',
      'import { routes } from "../../../packages/lib/src/index";',
      "const app = express();",
      "routes(app);",
      "app.listen(3000);",
      "",
    ].join("\n");
    await put("apps/api/src/server.ts", server);
    const expected = await cold(root);
    expect(expected).toContain("/health");
    const after = await warm(root, cache);
    expect(after.bytes).toBe(expected);
    expect(after.stored).toEqual(["api", "lib"]);

    // Back to the first version: every entry's inputs hold, but lib's (now collected with a
    // router in the repo) doesn't match the repo-wide facts the entries give together.
    await put("apps/api/src/server.ts", "export const port = 3000;\n");
    const back = await warm(root, cache);
    expect(back.bytes).toBe(without.bytes);
    expect(back.stored).toEqual(["lib"]);
    // And forth again: both versions' entries are now there.
    await put("apps/api/src/server.ts", server);
    expect(await warm(root, cache)).toMatchObject({ bytes: expected, stored: ["lib"] });
  });

  it("recollects a clean service when the repo's first queue library appears", async () => {
    const root = await workspaceOf({
      "apps/web": { name: "web" },
      "apps/jobs": { name: "jobs", dependencies: { bullmq: "5.0.0" } },
    });
    await put("apps/web/src/app.ts", "export const title = 1;\n");
    await put("apps/jobs/src/index.ts", "export const port = 3000;\n");
    const cache = await openDiskCache(join(dir, "cache"));
    await warm(root, cache);

    await put(
      "apps/jobs/src/index.ts",
      'import { Queue } from "bullmq";\nexport const emails = new Queue("emails");\n',
    );
    const expected = await cold(root);
    const after = await warm(root, cache);
    expect(after.bytes).toBe(expected);
    // web's queue facts were collected with nothing to look for; now there is.
    expect(after.stored).toEqual(["jobs", "web"]);
  });

  it("reports every stage once, in order, when a run collects a stale service again", async () => {
    const root = await workspaceOf({
      "apps/web": { name: "web" },
      "apps/api": { name: "api" },
    });
    await put("apps/web/src/client.ts", 'const g = (u: string) => u;\nexport const x = g("/x");\n');
    await put("apps/api/src/index.ts", "export const port = 3000;\n");
    const cache = await openDiskCache(join(dir, "cache"));
    const first = await observed(root, cache);
    expect(first.stages).toEqual([...ANALYSIS_STAGES]);

    await put("apps/api/src/g.ts", "export function g(url: string) { return fetch(url); }\n");
    const second = await observed(root, cache);
    // web was reused, then collected again (the wrappers changed), yet listeners saw one run.
    expect(second.stored).toEqual(["api", "web"]);
    expect(second.stages).toEqual([...ANALYSIS_STAGES]);
    // Every stage starts once, and `http` reports its requests once.
    const started = (events: AnalysisProgress[]) => events.map((e) => e.stage);
    expect(started(second.progress)).toEqual(started(first.progress));
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
