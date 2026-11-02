import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchitectureGraph } from "@gitinside/schema";
import { analyze, analyzeServices, type ServiceFactsOptions } from "./analyze.js";
import { serializeGraph } from "./assemble.js";
import type { ServiceFacts } from "./facts.js";

// A checker that throws when asked for one file's module symbol (as `importTarget` does), a
// Next.js collector that throws for one service, and a queue-library check that throws: all
// pass through until a test sets them.
const failing = vi.hoisted(() => ({
  moduleOf: undefined as string | undefined,
  nextIn: undefined as string | undefined,
  queueCheck: false,
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
            if (
              failing.moduleOf !== undefined &&
              ts.isSourceFile(node) &&
              node.fileName.endsWith(failing.moduleOf)
            ) {
              throw new TypeError("Cannot read properties of undefined (reading 'id')");
            }
            return checker.getSymbolAtLocation(node);
          },
        };
        return { ...sp, program: { ...sp.program, getTypeChecker: () => throwing } };
      }),
  };
});
vi.mock("./next.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./next.js")>();
  return {
    ...actual,
    collectNextFacts: (...args: Parameters<typeof actual.collectNextFacts>) => {
      if (args[0].service.key === failing.nextIn) throw new Error("next broke");
      return actual.collectNextFacts(...args);
    },
  };
});
vi.mock("./queues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queues.js")>();
  return {
    ...actual,
    usesQueueLibrary: (...args: Parameters<typeof actual.usesQueueLibrary>) => {
      if (failing.queueCheck) throw new Error("queue check broke");
      return actual.usesQueueLibrary(...args);
    },
  };
});

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
/** Every fixture with a golden graph. */
const NAMES = readdirSync(FIXTURES).filter((name) =>
  existsSync(join(FIXTURES, name, "expected.json")),
);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-facts-"));
  failing.moduleOf = undefined;
  failing.nextIn = undefined;
  failing.queueCheck = false;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
}

/** The graph of `root` and every service's facts from the same run. */
async function collected(
  root: string,
  options: ServiceFactsOptions = {},
): Promise<{ graph: ArchitectureGraph; facts: readonly ServiceFacts[] }> {
  let facts: readonly ServiceFacts[] | undefined;
  const graph = await analyzeServices(root, { ...options, onFacts: (f) => (facts = f) });
  if (!facts) throw new Error("onFacts wasn't called");
  return { graph, facts };
}

/** `facts` after a JSON round trip, checked to be unchanged by it. */
function revived(facts: readonly ServiceFacts[]): ServiceFacts[] {
  const copy = JSON.parse(JSON.stringify(facts)) as ServiceFacts[];
  expect(copy).toEqual(facts);
  return copy;
}

/** A web app importing `@acme/shared`, and the shared package's entry file. */
const SHARED_ENTRY = "packages/shared/src/index.ts";
async function sharedRepo(): Promise<void> {
  await put("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
  await put("apps/web/package.json", JSON.stringify({ name: "web" }));
  await put(
    "packages/shared/package.json",
    JSON.stringify({ name: "@acme/shared", exports: "./src/index.ts" }),
  );
  await put(SHARED_ENTRY, "export function format(x: number) { return String(x); }\n");
  await put(
    "apps/web/app.ts",
    'import { format } from "@acme/shared";\nexport function render() { format(1); }\n',
  );
}

describe("service facts (M6.7d3d2)", () => {
  it.each(NAMES)("%s: composes JSON round-tripped facts into the same bytes", async (name) => {
    const root = join(FIXTURES, name);
    const options = { owner: "fixtures", name };
    const { graph, facts } = await collected(root, options);
    expect(serializeGraph(graph)).toBe(serializeGraph(await analyze(root, options)));
    const composed = await analyzeServices(root, { ...options, facts: revived(facts) });
    expect(serializeGraph(composed)).toBe(serializeGraph(graph));
  });

  it("holds one bundle per service, in workspace order, with every stage's facts", async () => {
    await sharedRepo();
    const { facts } = await collected(dir);
    expect(facts.map((f) => f.service)).toEqual(["web", "shared"]);
    for (const f of facts) {
      expect(f.failed).toEqual([]);
      for (const stage of [
        "imports",
        "express",
        "next",
        "prisma",
        "calls",
        "http",
        "sdk",
        "queues",
      ]) {
        expect(f).toHaveProperty(stage);
      }
    }
    const web = facts[0];
    expect(web?.rootFiles).toEqual(["apps/web/app.ts"]);
    expect(web?.symbols.map((n) => n.id)).toEqual(["symbol:web/app.ts#render"]);
    expect(web?.calls?.calls.map((c) => c.to)).toEqual(["symbol:shared/src/index.ts#format"]);
  });

  it("composes from the given facts without collecting them again", async () => {
    await sharedRepo();
    const { facts } = await collected(dir);
    await put(
      "apps/web/app.ts",
      'import { format } from "@acme/shared";\nexport function render() { format(1); }\nexport function added() {}\n',
    );
    const fresh = await analyze(dir);
    const composed = await analyzeServices(dir, { facts: revived(facts) });
    const added = "symbol:web/app.ts#added";
    expect(fresh.nodes.map((n) => n.id)).toContain(added);
    // The symbol comes from the stale facts, while file nodes (a global step) are re-read.
    expect(composed.nodes.map((n) => n.id)).not.toContain(added);
    expect(composed.nodes.find((n) => n.id === "file:web/app.ts")).toEqual(
      fresh.nodes.find((n) => n.id === "file:web/app.ts"),
    );
  });

  it("refuses facts that don't match the workspace's services", async () => {
    await sharedRepo();
    const { facts } = await collected(dir);
    await expect(analyzeServices(dir, { facts: [...facts].reverse() })).rejects.toThrow(
      "service facts for shared, web don't match the workspace's services (web, shared)",
    );
    await expect(analyzeServices(dir, { facts: facts.slice(1) })).rejects.toThrow(/don't match/);
  });

  it("puts a cross-program TypeScript failure in the asking service's bundle", async () => {
    await sharedRepo();
    const healthy = await analyze(dir);
    failing.moduleOf = SHARED_ENTRY;
    const { graph, facts } = await collected(dir);

    const [web, shared] = facts;
    expect(web?.analyzerWarnings.map((w) => [w.code, w.file])).toEqual([
      ["TYPESCRIPT_INTERNAL_ERROR", SHARED_ENTRY],
    ]);
    expect(shared?.analyzerWarnings).toEqual([]);
    // web's import of shared can't be followed, so its call edge is gone; the warning says why.
    expect(healthy.edges.some((e) => e.kind === "calls")).toBe(true);
    expect(graph.edges.some((e) => e.kind === "calls")).toBe(false);
    expect(graph.warnings).toContainEqual(web?.analyzerWarnings[0]);

    failing.moduleOf = undefined;
    const composed = await analyzeServices(dir, { facts: revived(facts) });
    expect(serializeGraph(composed)).toBe(serializeGraph(graph));
  });

  it("records a service's failed collection in its bundle, and the stage contributes nothing", async () => {
    const shop = join(FIXTURES, "shop-demo");
    const options = { owner: "fixtures", name: "shop-demo" };
    const healthy = await analyze(shop, options);
    failing.nextIn = "api";
    const { graph, facts } = await collected(shop, options);

    const warning = {
      code: "DETECTOR_FAILED",
      message:
        "the next stage stopped on an internal error (Error: next broke); what it finds is missing from this graph",
    };
    const api = facts.find((f) => f.service === "api");
    const web = facts.find((f) => f.service === "web");
    expect(api?.failed).toEqual([{ stage: "next", warning }]);
    expect(api).not.toHaveProperty("next");
    // The other service still collected, so its bundle doesn't depend on how api's went.
    expect(web?.failed).toEqual([]);
    expect(web?.next?.nodes.length).toBeGreaterThan(0);

    expect(graph.warnings.filter((w) => w.code === "DETECTOR_FAILED")).toEqual([warning]);
    expect(graph.nodes.filter((n) => n.kind === "page")).toEqual([]);
    expect(healthy.nodes.some((n) => n.kind === "page")).toBe(true);

    failing.nextIn = undefined;
    const composed = await analyzeServices(shop, { ...options, facts: revived(facts) });
    expect(serializeGraph(composed)).toBe(serializeGraph(graph));
  });

  it("records a failed global step of a stage's collection in every bundle", async () => {
    const root = join(FIXTURES, "queues-bullmq");
    const options = { owner: "fixtures", name: "queues-bullmq" };
    failing.queueCheck = true;
    const { graph, facts } = await collected(root, options);

    const warning = {
      code: "DETECTOR_FAILED",
      message:
        "the queues stage stopped on an internal error (Error: queue check broke); what it finds is missing from this graph",
    };
    for (const f of facts) {
      expect(f.failed).toEqual([{ stage: "queues", warning }]);
      expect(f).not.toHaveProperty("queues");
    }
    expect(graph.warnings.filter((w) => w.code === "DETECTOR_FAILED")).toEqual([warning]);
    expect(graph.edges.filter((e) => e.kind === "publishes" || e.kind === "consumes")).toEqual([]);

    failing.queueCheck = false;
    const composed = await analyzeServices(root, { ...options, facts: revived(facts) });
    expect(serializeGraph(composed)).toBe(serializeGraph(graph));
  });
});
