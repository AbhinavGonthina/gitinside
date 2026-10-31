import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringifyGraph } from "@gitinside/schema";
import {
  ANALYSIS_STAGES,
  ANALYZER_VERSION,
  analyze,
  detectorFailure,
  type AnalysisFindings,
  type AnalysisProgress,
} from "./analyze.js";
import { guardedChecker } from "./calls.js";
import { runCli } from "./cli.js";
import { AnalysisError } from "./inventory.js";

// Detectors that throw on demand, so a test can stand in for an analyzer bug, and a checker
// that throws on one expression's text, standing in for TypeScript's own crash (M5.8c). All
// pass through until a test sets `failing`.
const failing = vi.hoisted(() => ({
  express: undefined as unknown,
  sdk: undefined as unknown,
  symbolAt: undefined as string | undefined,
  typeAt: undefined as string | undefined,
}));
vi.mock("./program.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./program.js")>();
  return {
    ...actual,
    buildServicePrograms: (...args: Parameters<typeof actual.buildServicePrograms>) =>
      actual.buildServicePrograms(...args).map((sp) => {
        const checker = sp.program.getTypeChecker();
        const throwing: ts.TypeChecker = {
          ...checker,
          getSymbolAtLocation: (node) => {
            if (node.getText() === failing.symbolAt) {
              throw new TypeError("Cannot read properties of undefined (reading 'id')");
            }
            return checker.getSymbolAtLocation(node);
          },
          getTypeAtLocation: (node) => {
            if (node.getText() === failing.typeAt) {
              throw new TypeError("Cannot read properties of undefined (reading 'flags')");
            }
            return checker.getTypeAtLocation(node);
          },
        };
        return { ...sp, program: { ...sp.program, getTypeChecker: () => throwing } };
      }),
  };
});
vi.mock("./express.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./express.js")>();
  return {
    ...actual,
    composeExpressRoutes: (...args: Parameters<typeof actual.composeExpressRoutes>) => {
      if (failing.express !== undefined) throw failing.express;
      return actual.composeExpressRoutes(...args);
    },
  };
});
vi.mock("./sdk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sdk.js")>();
  return {
    ...actual,
    buildSdkEdges: (...args: Parameters<typeof actual.buildSdkEdges>) => {
      if (failing.sdk !== undefined) throw failing.sdk;
      return actual.buildSdkEdges(...args);
    },
  };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-test-"));
  failing.express = undefined;
  failing.sdk = undefined;
  failing.symbolAt = undefined;
  failing.typeAt = undefined;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capture() {
  const io = {
    out: "",
    err: "",
    stdout: (t: string) => (io.out += t),
    stderr: (t: string) => (io.err += t),
  };
  return io;
}

describe("analyze", () => {
  it("returns a valid graph with a system root and a fallback service", async () => {
    const graph = await analyze(dir, { owner: "acme", name: "shop", sha: "abc1234" });
    expect(graph.repo).toEqual({ owner: "acme", name: "shop", sha: "abc1234" });
    expect(graph.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(graph.nodes.map((n) => n.id)).toEqual(["system:root", "service:app/"]);
  });

  it("creates one service node per workspace package", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(
      join(dir, "apps", "api", "package.json"),
      JSON.stringify({ name: "@acme/api", dependencies: { express: "4" } }),
    );
    const graph = await analyze(dir);
    expect(graph.nodes[1]).toEqual({
      id: "service:api/",
      kind: "service",
      label: "@acme/api",
      parentId: "system:root",
      root: "apps/api",
      framework: "express",
      layer: "backend",
    });
  });

  it("merges inventory and workspace warnings in sorted order", async () => {
    await writeFile(join(dir, "package.json"), "{");
    await writeFile(join(dir, "app.min.js"), "!0;");
    const graph = await analyze(dir);
    expect(graph.warnings.map((w) => [w.file, w.code])).toEqual([
      ["app.min.js", "SKIPPED_GENERATED"],
      ["package.json", "INVALID_JSON"],
    ]);
  });

  it("includes tsconfig and syntax warnings from the per-service programs", async () => {
    await writeFile(join(dir, "bad.ts"), "const = ;");
    const graph = await analyze(dir);
    expect(graph.warnings.map((w) => [w.file, w.code])).toEqual([
      [undefined, "TSCONFIG_MISSING"],
      ["bad.ts", "SYNTAX_ERROR"],
    ]);
  });

  it("defaults owner and name without using the folder name", async () => {
    const graph = await analyze(dir);
    expect(graph.repo).toEqual({ owner: "local", name: "repo" });
    expect(graph.nodes[0]?.label).toBe("repo");

    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@acme/shop" }));
    expect((await analyze(dir)).repo.name).toBe("@acme/shop");

    await writeFile(join(dir, "package.json"), JSON.stringify({ name: 7 }));
    expect((await analyze(dir)).repo.name).toBe("repo");
  });

  it("is byte-identical across runs", async () => {
    const a = stringifyGraph(await analyze(dir, { name: "x" }));
    const b = stringifyGraph(await analyze(dir, { name: "x" }));
    expect(a).toBe(b);
  });

  it("reports every stage once, in order, without changing the graph", async () => {
    await writeFile(join(dir, "a.ts"), "export function f() { return 1; }");
    const seen: [string, number][] = [];
    const timed = await analyze(dir, { name: "x", onStage: (s, ms) => seen.push([s, ms]) });
    expect(seen.map(([s]) => s)).toEqual([...ANALYSIS_STAGES]);
    expect(seen.every(([, ms]) => Number.isFinite(ms) && ms >= 0)).toBe(true);
    expect(stringifyGraph(timed)).toBe(stringifyGraph(await analyze(dir, { name: "x" })));
  });

  it("reports each stage's start with file and request counts, without changing the graph", async () => {
    await writeFile(join(dir, "a.ts"), "export const get = () => fetch('/api/a');");
    await writeFile(
      join(dir, "b.ts"),
      "export const post = () => fetch('/api/b', { method: 'POST' });",
    );
    const seen: AnalysisProgress[] = [];
    const reported = await analyze(dir, { name: "x", onProgress: (event) => seen.push(event) });
    expect(seen).toEqual([
      { stage: "inventory" },
      { stage: "workspace" },
      { stage: "programs", count: 2 },
      ...ANALYSIS_STAGES.slice(3, ANALYSIS_STAGES.indexOf("http") + 1).map((stage) => ({ stage })),
      { stage: "http", count: 2 },
      { stage: "sdk" },
      { stage: "queues" },
      { stage: "assemble" },
    ]);
    expect(stringifyGraph(reported)).toBe(stringifyGraph(await analyze(dir, { name: "x" })));
  });

  it("reports what each stage found, adding to what earlier stages found", async () => {
    const shop = fileURLToPath(new URL("../../../fixtures/shop-demo", import.meta.url));
    const found: AnalysisFindings[] = [];
    const events: string[] = [];
    await analyze(shop, {
      onProgress: ({ stage }) => events.push(stage),
      onFound: (event) => {
        found.push(event);
        events.push(`found after ${events.at(-1) ?? ""}`);
      },
    });
    const services = ["@shop/api", "@shop/web"];
    expect(found).toEqual([
      { services },
      { services, routes: 2 },
      { services, routes: 2, pages: 3 },
      { services, routes: 2, pages: 3, stores: ["db"] },
      { services, routes: 2, pages: 3, stores: ["db"], externals: [] },
      { services, routes: 2, pages: 3, stores: ["db"], externals: ["api.stripe.com"] },
      { services, routes: 2, pages: 3, stores: ["db"], externals: ["api.stripe.com"] },
    ]);
    // Each report follows its stage, before the next stage starts.
    expect(events.filter((e) => e.startsWith("found"))).toEqual(
      ["workspace", "express", "next", "infra", "http", "sdk", "queues"].map(
        (stage) => `found after ${stage}`,
      ),
    );
  });

  it("reports a stage that looked and found nothing as 0 or [], without changing the graph", async () => {
    await writeFile(join(dir, "a.ts"), "export const get = () => fetch('/api/a');");
    const found: AnalysisFindings[] = [];
    const reported = await analyze(dir, { name: "x", onFound: (event) => found.push(event) });
    expect(found.at(-1)).toEqual({
      services: ["app"],
      routes: 0,
      pages: 0,
      stores: [],
      externals: [],
    });
    expect(stringifyGraph(reported)).toBe(stringifyGraph(await analyze(dir, { name: "x" })));
  });

  it("rejects a missing directory", async () => {
    await expect(analyze(join(dir, "nope"))).rejects.toThrow(/not a directory/);
  });

  it("records skipped files as graph warnings", async () => {
    await writeFile(join(dir, "app.min.js"), "!0;");
    const graph = await analyze(dir);
    expect(graph.warnings).toEqual([
      {
        code: "SKIPPED_GENERATED",
        file: "app.min.js",
        message: "generated file skipped (minified)",
      },
    ]);
  });

  it("fails with LIMIT_FILES over the source-file limit", async () => {
    await writeFile(join(dir, "a.ts"), "");
    await writeFile(join(dir, "b.ts"), "");
    await expect(analyze(dir, { limits: { maxSourceFiles: 1 } })).rejects.toMatchObject({
      code: "LIMIT_FILES",
    });
  });

  it("fails with LIMIT_SOURCE_SIZE over the source-size limit, before building programs", async () => {
    await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
    const stages: string[] = [];
    await expect(
      analyze(dir, {
        limits: { maxSourceBytes: 10 },
        onProgress: ({ stage }) => stages.push(stage),
      }),
    ).rejects.toMatchObject({ code: "LIMIT_SOURCE_SIZE" });
    expect(stages).toEqual(["inventory"]);
  });
});

describe("runCli", () => {
  it("prints the graph to stdout", async () => {
    const io = capture();
    expect(await runCli(["analyze", dir], io)).toBe(0);
    expect(JSON.parse(io.out).schemaVersion).toBe("1.0.0");
  });

  it("writes to --out", async () => {
    const io = capture();
    const file = join(dir, "out.json");
    expect(await runCli(["analyze", dir, "--out", file], io)).toBe(0);
    expect(io.out).toBe("");
    expect(JSON.parse(await readFile(file, "utf8")).nodes).toHaveLength(2);
  });

  it("replaces an existing --out file and leaves no temp file behind", async () => {
    const io = capture();
    const file = join(dir, "out.json");
    await writeFile(file, "old");
    expect(await runCli(["analyze", dir, "--out", file], io)).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8")).schemaVersion).toBe("1.0.0");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("reports a failed write with exit 1 and cleans up the temp file", async () => {
    const io = capture();
    // Renaming a file onto a directory fails after the temp file was written.
    const target = join(dir, "taken");
    await mkdir(join(target, "child"), { recursive: true });
    expect(await runCli(["analyze", dir, "--out", target], io)).toBe(1);
    expect(io.err).toMatch(/^error: /);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("reports a missing path with exit 1", async () => {
    const io = capture();
    expect(await runCli(["analyze", join(dir, "nope")], io)).toBe(1);
    expect(io.err).toMatch(/not a directory/);
  });

  it("records --owner, --name, and --sha in the graph", async () => {
    const io = capture();
    const argv = ["analyze", dir, "--owner", "acme", "--name", "shop", "--sha", "abc1234"];
    expect(await runCli(argv, io)).toBe(0);
    expect(JSON.parse(io.out).repo).toEqual({ owner: "acme", name: "shop", sha: "abc1234" });
  });

  it("gives the same bytes for the same tree in differently named folders", async () => {
    const files = { "package.json": JSON.stringify({ name: "shop" }), "src/a.ts": "export {};\n" };
    const outputs: string[] = [];
    for (const folder of ["checkout-one", "other name"]) {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, folder, "src"), { recursive: true });
        await writeFile(join(dir, folder, path), content);
      }
      const io = capture();
      expect(await runCli(["analyze", join(dir, folder)], io)).toBe(0);
      outputs.push(io.out);
    }
    expect(outputs[0]).toBe(outputs[1]);
  });

  it.each([
    [["analyze"]],
    [["analyze", "a", "b"]],
    [["analyze", "a", "--out"]],
    [["analyze", "a", "--name"]],
    [["analyze", "a", "--sha", ""]],
    [["analyze", "a", "--bogus"]],
    [["frobnicate"]],
  ])("rejects bad usage %j with exit 2", async (argv) => {
    const io = capture();
    expect(await runCli(argv, io)).toBe(2);
    expect(io.err).toMatch(/Usage/);
  });

  it("prints usage and exits 0 with no command", async () => {
    const io = capture();
    expect(await runCli([], io)).toBe(0);
    expect(io.err).toMatch(/Usage/);
  });
});

async function put(path: string, content: string[]): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content.join("\n") + "\n");
}

/** An Express server whose route calls Stripe, so both detectors have something to find. */
async function shop(): Promise<void> {
  await put("package.json", [
    JSON.stringify({ name: "shop", dependencies: { express: "4", stripe: "17" } }),
  ]);
  await put("src/server.ts", [
    'import express from "express";',
    'import Stripe from "stripe";',
    'const stripe = new Stripe("sk");',
    "export async function pay() {",
    "  await stripe.charges.create({});",
    "}",
    "const app = express();",
    'app.post("/pay", pay);',
  ]);
}

describe("internal failures (M5.8c)", () => {
  it("turns a detector's internal error into a warning and keeps every other detector's output", async () => {
    await shop();
    const healthy = await analyze(dir);
    failing.express = new TypeError("Cannot read properties of undefined (reading 'id')");
    const graph = await analyze(dir);

    expect(graph.warnings.filter((w) => w.code === "DETECTOR_FAILED")).toEqual([
      {
        code: "DETECTOR_FAILED",
        message:
          "the express stage stopped on an internal error (TypeError: Cannot read properties of undefined (reading 'id')); what it finds is missing from this graph",
      },
    ]);
    // Only Express's own nodes and edges are missing: the route and its handles edge.
    const removed = new Set(["route:shop/POST /pay"]);
    expect(graph.nodes).toEqual(healthy.nodes.filter((n) => !removed.has(n.id)));
    expect(graph.edges).toEqual(healthy.edges.filter((e) => !removed.has(e.from)));
    expect(graph.edges.some((e) => e.kind === "external_call")).toBe(true);
  });

  it("guards later stages too, and lists each failure", async () => {
    await shop();
    failing.express = new Error("first");
    failing.sdk = "not even an Error";
    const graph = await analyze(dir);
    expect(
      graph.warnings.filter((w) => w.code === "DETECTOR_FAILED").map((w) => w.message),
    ).toEqual([
      "the express stage stopped on an internal error (Error: first); what it finds is missing from this graph",
      "the sdk stage stopped on an internal error (not even an Error); what it finds is missing from this graph",
    ]);
    expect(graph.edges.filter((e) => e.kind === "external_call" || e.kind === "handles")).toEqual(
      [],
    );
  });

  it("treats an expression TypeScript throws on as unknown, with one warning (fixtures/checker-crash)", async () => {
    const fixture = fileURLToPath(new URL("../../../fixtures/checker-crash/", import.meta.url));
    const healthy = await analyze(fixture, { owner: "fixtures", name: "checker-crash" });
    failing.symbolAt = "bind";
    const graph = await analyze(fixture, { owner: "fixtures", name: "checker-crash" });

    expect(graph.warnings).toEqual([
      {
        code: "TYPESCRIPT_INTERNAL_ERROR",
        file: "src/schema.js",
        message:
          "TypeScript failed on the expression at 17:37 (TypeError: Cannot read properties of undefined (reading 'id')); what it names is treated as unknown",
      },
    ]);
    // `bind` names nothing the graph draws, so only the warning differs.
    expect({ ...graph, warnings: [] }).toEqual(healthy);
    expect(graph.nodes.map((n) => n.id)).toContain("route:checker-crash/POST /echo");
  });

  it("treats a type TypeScript throws on as unknown, keeping the stage's other edges (M5 review)", async () => {
    await put("package.json", [JSON.stringify({ name: "client", dependencies: { axios: "1" } })]);
    await put("src/client.ts", [
      'import axios from "axios";',
      "export async function load(target: string) {",
      "  await axios(target);",
      '  await fetch("https://api.example.com/items");',
      "}",
    ]);
    const healthy = await analyze(dir);
    failing.typeAt = "target";
    const graph = await analyze(dir);

    expect(graph.warnings.filter((w) => w.code !== "TSCONFIG_MISSING")).toEqual([
      {
        code: "TYPESCRIPT_INTERNAL_ERROR",
        file: "src/client.ts",
        message:
          "TypeScript failed on the expression at 3:15 (TypeError: Cannot read properties of undefined (reading 'flags')); what it names is treated as unknown",
      },
    ]);
    // Only `axios(target)` changes: with no type known, its argument reads as a config, not
    // a URL. The http stage itself keeps going, so the `fetch` call is linked as before.
    const call = "unresolved:client/src/client.ts:3:9";
    expect({ ...graph, warnings: [] }).toEqual({
      ...healthy,
      nodes: healthy.nodes.map((n) =>
        n.id === call
          ? { ...n, label: "? axios(target)", detail: "the URL can't be read statically" }
          : n,
      ),
      warnings: [],
    });
    expect(graph.edges.map((e) => e.to)).toContain("external:ext/api.example.com");
  });

  it("still fails the analysis on a limit", async () => {
    await shop();
    failing.express = new AnalysisError("LIMIT_FILES", "too many files");
    await expect(analyze(dir)).rejects.toBeInstanceOf(AnalysisError);
  });
});

describe("detectorFailure", () => {
  it("removes the checkout's path in either slash style", () => {
    const root = "C:\\work\\repo";
    const error = new Error(
      "ENOENT: C:\\work\\repo\\src\\a.ts and C:/work/repo/src/b.ts, root C:\\work\\repo",
    );
    expect(detectorFailure("prisma", error, root).message).toBe(
      "the prisma stage stopped on an internal error (Error: ENOENT: src\\a.ts and src/b.ts, root .); what it finds is missing from this graph",
    );
  });

  it("cuts long error text", () => {
    const message = detectorFailure("calls", new Error("x".repeat(500)), "/repo").message;
    expect(message).toContain(`(Error: ${"x".repeat(192)}…)`);
  });
});

describe("guardedChecker", () => {
  const sourceFile = ts.createSourceFile("/a.ts", "const a = b.c;", ts.ScriptTarget.ES2022, true);
  const program = ts.createProgram({
    rootNames: ["/a.ts"],
    options: { noLib: true, types: [] },
    host: {
      ...ts.createCompilerHost({}),
      getSourceFile: (name) => (name === "/a.ts" ? sourceFile : undefined),
      fileExists: (name) => name === "/a.ts",
    },
  });
  const checker = program.getTypeChecker();
  const declaration = (sourceFile.statements[0] as ts.VariableStatement).declarationList
    .declarations[0]!;

  it("passes answers through and keeps the rest of the checker", () => {
    const failed = vi.fn();
    const guarded = guardedChecker(checker, failed);
    expect(guarded.getSymbolAtLocation(declaration.name)?.name).toBe("a");
    expect(guarded.typeToString(guarded.getTypeAtLocation(declaration.name))).toBe("any");
    expect(failed).not.toHaveBeenCalled();
  });

  it("answers undefined and reports the node when TypeScript throws", () => {
    const failed = vi.fn();
    const error = new TypeError("Cannot read properties of undefined (reading 'id')");
    const broken: ts.TypeChecker = {
      ...checker,
      getSymbolAtLocation: () => {
        throw error;
      },
    };
    expect(guardedChecker(broken, failed).getSymbolAtLocation(declaration.name)).toBeUndefined();
    expect(failed).toHaveBeenCalledWith(declaration.name, error);
  });

  it("answers `any` for a type TypeScript throws on, and reports the node", () => {
    const failed = vi.fn();
    const error = new TypeError("Cannot read properties of undefined (reading 'flags')");
    const broken: ts.TypeChecker = {
      ...checker,
      getTypeAtLocation: () => {
        throw error;
      },
    };
    const type = guardedChecker(broken, failed).getTypeAtLocation(declaration.name);
    expect(type.flags).toBe(ts.TypeFlags.Any);
    expect(failed).toHaveBeenCalledWith(declaration.name, error);
  });
});
