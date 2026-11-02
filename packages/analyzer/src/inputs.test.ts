import { readFileSync as realReadFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCallEdges, createSymbolResolver, type SymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { collectHttpCalls } from "./http.js";
import { buildImportGraph } from "./imports.js";
import {
  ABSENT,
  PRESENT,
  contentHash,
  createInputLog,
  createInputVerifier,
  createRepoFiles,
  inputsDigest,
  mergeInputs,
  serviceInputs,
  type ObservedInputs,
} from "./inputs.js";
import { buildInventory } from "./inventory.js";
import { buildNextRoutes } from "./next.js";
import { buildPrisma } from "./prisma.js";
import { buildServicePrograms, type ServiceProgram } from "./program.js";
import { buildQueueEdges } from "./queues.js";
import { buildSdkEdges } from "./sdk.js";
import { buildSymbolNodes } from "./symbols.js";
import { createUrlNormalizer } from "./url.js";
import { detectWorkspace } from "./workspace.js";
import { inlineWrappers } from "./wrappers.js";

/** Every path `readFileSync` was called with: the program host's only way to read the repo. */
const reads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    reads.push(String(args[0]));
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

/** Run every stage that uses service programs, as `analyze` does, and collect their inputs. */
async function observe(root: string) {
  const inventory = await buildInventory(root);
  const workspace = await detectWorkspace(root, inventory.files);
  const programs = buildServicePrograms(root, workspace, inventory);
  buildImportGraph(programs, workspace, inventory.sourceFiles);
  const resolver = createSymbolResolver(programs, workspace);
  const express = buildExpressRoutes(programs, resolver);
  buildNextRoutes(programs, resolver);
  await buildPrisma(
    root,
    programs,
    workspace,
    resolver,
    inventory.sourceFiles,
    express.inlineHandlers,
  );
  buildSymbolNodes(programs);
  buildCallEdges(programs, resolver);
  const sites = collectHttpCalls(programs, resolver);
  inlineWrappers(sites, programs, resolver, createUrlNormalizer(resolver), express.inlineHandlers);
  buildSdkEdges(programs, resolver, workspace, express.inlineHandlers);
  buildQueueEdges(programs, resolver, workspace, express.inlineHandlers);
  return { programs, resolver, inputs: serviceInputs(programs, resolver) };
}

/** Services whose inputs no longer hold for the checkout at `root`, sorted. */
async function invalidated(root: string, inputs: Map<string, ObservedInputs>): Promise<string[]> {
  const inventory = await buildInventory(root);
  const workspace = await detectWorkspace(root, inventory.files);
  const verify = createInputVerifier(root, workspace, inventory);
  const stale: string[] = [];
  for (const [service, observed] of inputs) {
    if ((await verify(observed)) !== undefined) stale.push(service);
  }
  return stale.sort();
}

function answer(inputs: ObservedInputs, path: string): string | undefined {
  return inputs.files.find(([p]) => p === path)?.[1];
}

describe("createInputLog", () => {
  it("records reads, probes, and the listing, sorted, with a hash beating `present`", () => {
    const log = createInputLog("api", ["src/b.ts", "src/a.ts"]);
    log.probeFile("src/z.ts", true);
    log.read("src/z.ts", "h1");
    log.probeFile("src/z.ts", true);
    log.probeFile("src/m.ts", true);
    log.probeFile("src/a.tsx", false);
    log.probeDir("src/lib", false);
    log.probeDir("", true);
    expect(log.snapshot()).toEqual({
      listings: [["api", ["src/a.ts", "src/b.ts"]]],
      files: [
        ["src/a.tsx", ABSENT],
        ["src/m.ts", PRESENT],
        ["src/z.ts", "h1"],
      ],
      dirs: [
        ["", true],
        ["src/lib", false],
      ],
    });
  });

  it("merges observations with the hash winning over `present`", () => {
    const a = createInputLog("a", ["a.ts"]);
    a.probeFile("x.ts", true);
    a.probeDir("d", true);
    const b = createInputLog("b", []);
    b.read("x.ts", "h");
    b.probeFile("y.ts", false);
    expect(mergeInputs([a.snapshot(), b.snapshot()])).toEqual({
      listings: [
        ["a", ["a.ts"]],
        ["b", []],
      ],
      files: [
        ["x.ts", "h"],
        ["y.ts", ABSENT],
      ],
      dirs: [["d", true]],
    });
  });
});

describe("serviceInputs", () => {
  /** A program stand-in for service `key` that reads `file`, counting its snapshots. */
  function fake(key: string, file: string) {
    const log = createInputLog(key, [file]);
    log.read(file, `hash-${key}`);
    const snapshot = vi.fn(() => log.snapshot());
    return { service: { key }, inputs: { ...log, snapshot } };
  }

  it("snapshots each program once and shares one object between equal reaches", () => {
    // web and admin each reach the other and lib; lib and cli reach nothing.
    const web = fake("web", "web.ts");
    const admin = fake("admin", "admin.ts");
    const lib = fake("lib", "lib.ts");
    const cli = fake("cli", "cli.ts");
    const reaches = new Map<unknown, unknown[]>([
      [web, [lib, admin]],
      [admin, [web]],
    ]);
    const programs = [web, admin, lib, cli] as unknown as ServiceProgram[];
    const resolver = {
      reached: (sp: unknown) => reaches.get(sp) ?? [],
    } as unknown as SymbolResolver;

    const inputs = serviceInputs(programs, resolver);
    for (const sp of [web, admin, lib, cli]) expect(sp.inputs.snapshot).toHaveBeenCalledTimes(1);
    const shared = mergeInputs([web, admin, lib].map((sp) => createSnapshot(sp)));
    expect(inputs.get("web")).toEqual(shared);
    expect(inputs.get("admin")).toBe(inputs.get("web"));
    expect(inputs.get("lib")).toEqual(createSnapshot(lib));
    expect(inputs.get("cli")).toEqual(createSnapshot(cli));
    expect(inputsDigest(inputs.get("web")!)).toBe(inputsDigest(structuredClone(shared)));
    expect(inputsDigest(inputs.get("lib")!)).not.toBe(inputsDigest(inputs.get("cli")!));
  });

  /** What `fake`'s log holds, without counting a snapshot. */
  function createSnapshot(sp: ReturnType<typeof fake>): ObservedInputs {
    const key = sp.service.key;
    return {
      listings: [[key, [`${key}.ts`]]],
      files: [[`${key}.ts`, `hash-${key}`]],
      dirs: [],
    };
  }
});

const NAMES = [
  "express-basic",
  "express-nested-routers",
  "next-app-router",
  "next-pages-api",
  "prisma-relations",
  "pnpm-monorepo",
  "syntax-error",
  "no-tsconfig",
  "wrapper-fetch",
  "external-sdk",
  "queues-bullmq",
  "shop-demo",
  "checker-crash",
];

describe.each(NAMES)("observed inputs of fixture %s", (name) => {
  it("cover every repo file read, with its hash, and still hold for the same checkout", async () => {
    const root = join(FIXTURES, name);
    const prefix = `${resolve(root).replaceAll("\\", "/")}/`;
    reads.length = 0;
    const { programs, inputs } = await observe(root);

    const read = new Set(
      reads.map((p) => p.replaceAll("\\", "/")).filter((p) => p.startsWith(prefix)),
    );
    expect(read.size).toBeGreaterThan(0);
    for (const absolute of read) {
      const path = absolute.slice(prefix.length);
      const hash = contentHash(realReadFileSync(absolute));
      const own = programs.filter((sp) => answer(sp.inputs.snapshot(), path) === hash);
      expect(own.length, path).toBeGreaterThan(0);
    }

    // Each program's repo source files are in its own service's log, with their hashes.
    for (const sp of programs) {
      const own = sp.inputs.snapshot();
      expect(own.listings).toEqual([[sp.service.key, sp.rootFiles]]);
      for (const sourceFile of sp.program.getSourceFiles()) {
        const path = sp.toRepoPath(sourceFile.fileName);
        if (path === undefined) continue;
        const hash = contentHash(realReadFileSync(sp.toAbsolute(path)));
        expect(answer(own, path), path).toBe(hash);
      }
    }

    expect(await invalidated(root, inputs)).toEqual([]);
  });
});

describe("createRepoFiles (M6.8c2)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gitinside-files-"));
    await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "b.ts"), "export const b = 2;\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const diskReads = (path: string) =>
    reads.filter((p) => p.replaceAll("\\", "/").endsWith(`/${path}`)).length;

  it("reads a file from disk once, then answers its text and hash from memory", () => {
    reads.length = 0;
    const files = createRepoFiles(dir);
    const first = files.read("a.ts");
    expect(first).toEqual({
      text: "export const a = 1;\n",
      hash: contentHash(Buffer.from("export const a = 1;\n")),
    });
    expect(files.read("a.ts")).toEqual(first);
    expect(diskReads("a.ts")).toBe(1);
  });

  it("answers preloaded files without the disk, in order, and unreadable ones as such", async () => {
    const files = createRepoFiles(dir);
    await files.preload(["b.ts", "a.ts"]);
    await rm(join(dir, "b.ts"));
    reads.length = 0;
    expect(files.read("b.ts").text).toBe("export const b = 2;\n");
    expect(diskReads("b.ts")).toBe(0);
    expect(await files.hashAll(["b.ts", "missing.ts", "a.ts"])).toEqual([
      contentHash(Buffer.from("export const b = 2;\n")),
      "",
      contentHash(Buffer.from("export const a = 1;\n")),
    ]);
    expect(() => files.read("missing.ts")).toThrow();
  });

  it("keeps no bytes of a file it only hashed", async () => {
    const files = createRepoFiles(dir);
    expect(await files.hash("a.ts")).toBe(contentHash(Buffer.from("export const a = 1;\n")));
    await rm(join(dir, "a.ts"));
    expect(() => files.read("a.ts")).toThrow();
  });
});

describe("verifying observed inputs after an edit", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gitinside-inputs-"));
    await tree({
      "package.json": { name: "mono", private: true },
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
      "README.md": "# mono\n",
      "apps/api/package.json": {
        name: "@acme/api",
        version: "1.0.0",
        dependencies: { "@acme/shared": "workspace:*" },
      },
      "apps/api/tsconfig.json": { compilerOptions: { strict: true } },
      "apps/api/src/index.ts": [
        'import { greet } from "@acme/shared";',
        'import { helper } from "./lib";',
        "export function handler(): string {",
        '  return greet(helper("x"));',
        "}",
        "",
      ].join("\n"),
      "apps/api/src/lib/index.ts": "export const helper = (s: string): string => s;\n",
      "apps/web/package.json": { name: "@acme/web", version: "1.0.0" },
      "apps/web/src/page.ts": "export function page(): number {\n  return 1;\n}\n",
      "packages/shared/package.json": {
        name: "@acme/shared",
        version: "1.0.0",
        main: "src/index.ts",
      },
      "packages/shared/src/index.ts":
        "export function greet(s: string): string {\n  return s;\n}\n",
    });
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

  /** The services invalidated by `edit`, from inputs observed before it. */
  async function after(edit: () => Promise<void>): Promise<string[]> {
    const { inputs } = await observe(dir);
    expect([...inputs.keys()].sort()).toEqual(["api", "shared", "web"]);
    await edit();
    return invalidated(dir, inputs);
  }

  it("reads each file once per run however many programs load it (M6.8c2)", async () => {
    // A relative import across services, so api's program loads shared's file too.
    await tree({
      "apps/api/src/rel.ts": 'export { greet } from "../../../packages/shared/src/index";\n',
    });
    const prefix = `${resolve(dir).replaceAll("\\", "/")}/`;
    reads.length = 0;
    const { programs } = await observe(dir);
    const paths = reads.map((p) => p.replaceAll("\\", "/")).filter((p) => p.startsWith(prefix));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBe(new Set(paths).size);
    // Some file is in two programs' logs, so it was loaded twice and read once.
    const logged = programs.flatMap((sp) =>
      sp.inputs
        .snapshot()
        .files.filter(([, answer]) => answer !== PRESENT && answer !== ABSENT)
        .map(([path]) => path),
    );
    expect(logged.length).toBeGreaterThan(new Set(logged).size);
  });

  it("invalidates nothing when nothing changed, or an unread file did", async () => {
    expect(await after(async () => undefined)).toEqual([]);
    expect(await after(() => tree({ "README.md": "# changed\n" }))).toEqual([]);
  });

  it("invalidates only the service whose own source changed", async () => {
    expect(await after(() => tree({ "apps/web/src/page.ts": "export const page = 2;\n" }))).toEqual(
      ["web"],
    );
  });

  it("invalidates a service whose analysis reached the changed service's program", async () => {
    const changed = "export function greet(s: string, t = ''): string {\n  return s + t;\n}\n";
    expect(await after(() => tree({ "packages/shared/src/index.ts": changed }))).toEqual([
      "api",
      "shared",
    ]);
  });

  it("invalidates the importer when a workspace manifest it resolved through changes", async () => {
    const manifest = { name: "@acme/shared", version: "1.0.1", main: "src/index.ts" };
    const stale = await after(() => tree({ "packages/shared/package.json": manifest }));
    expect(stale).toContain("api");
    expect(stale).not.toContain("web");
  });

  it("invalidates a service when a file appears where module resolution looked", async () => {
    const shadow = "export const helper = (s: string): string => s + s;\n";
    expect(await after(() => tree({ "apps/api/src/lib.ts": shadow }))).toEqual(["api"]);
  });

  it("invalidates a service when a file is added to its folder", async () => {
    expect(await after(() => tree({ "apps/web/src/new.ts": "export const n = 1;\n" }))).toEqual([
      "web",
    ]);
  });

  it("invalidates a service when a config appears where it had none", async () => {
    const config = { compilerOptions: { strict: true } };
    expect(await after(() => tree({ "apps/web/tsconfig.json": config }))).toEqual(["web"]);
  });

  it("invalidates a service when a file it read is deleted", async () => {
    expect(await after(() => rm(join(dir, "apps/api/src/lib/index.ts")))).toEqual(["api"]);
  });

  it("records what each service's analysis reached and probed", async () => {
    const { programs, resolver, inputs } = await observe(dir);
    const reachedKeys = programs.map((sp) => [
      sp.service.key,
      [...resolver.reached(sp)].map((other) => other.service.key),
    ]);
    expect(reachedKeys).toEqual([
      ["api", ["shared"]],
      ["web", []],
      ["shared", []],
    ]);
    const api = inputs.get("api") as ObservedInputs;
    expect(api.listings.map(([service]) => service)).toEqual(["api", "shared"]);
    expect(answer(api, "apps/api/src/lib.ts")).toBe(ABSENT);
    expect(answer(inputs.get("web") as ObservedInputs, "apps/web/tsconfig.json")).toBe(ABSENT);
  });

  it("reports a file it can no longer read as changed", async () => {
    const { inputs } = await observe(dir);
    const inventory = await buildInventory(dir);
    const workspace = await detectWorkspace(dir, inventory.files);
    const verify = createInputVerifier(dir, workspace, inventory);
    await rm(join(dir, "apps/web/src/page.ts"));
    expect(await verify(inputs.get("web") as ObservedInputs)).toBe("apps/web/src/page.ts");
  });
});
