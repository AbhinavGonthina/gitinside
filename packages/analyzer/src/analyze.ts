import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { SYSTEM_ID, type AnalysisWarning, type ArchitectureGraph } from "@gitinside/schema";
import { assembleGraph } from "./assemble.js";
import type { FactCache } from "./cache.js";
import { collectCallFacts, composeCallEdges, createSymbolResolver } from "./calls.js";
import {
  collectExpressFacts,
  composeExpressRoutes,
  rootFileServices,
  routerCreations,
} from "./express.js";
import {
  CollectionFailed,
  stageFacts,
  type FactStage,
  type ServiceFacts,
  type StageFacts,
} from "./facts.js";
import { errorText } from "./failures.js";
import { buildFileNodes, outsideServiceWarnings } from "./files.js";
import { createFindings, type AnalysisFindings } from "./findings.js";
import { collectHttpCalls } from "./http.js";
import { collectImportFacts, composeImports, type ManifestCache } from "./imports.js";
import { cachedFacts, factKeys, storeFacts, type FactKeys } from "./incremental.js";
import { buildInfra, relinkStores } from "./infra.js";
import { serviceInputs } from "./inputs.js";
import { AnalysisError, buildInventory, type InventoryLimits } from "./inventory.js";
import { buildHttpEdges, createRouteMatcher } from "./match.js";
import { collectNextFacts, composeNextRoutes } from "./next.js";
import { buildPrismaSchemas, collectPrismaFacts, composePrisma } from "./prisma.js";
import { buildServicePrograms, type ServiceProgram } from "./program.js";
import { collectQueueFacts, composeQueueEdges, usesQueueLibrary } from "./queues.js";
import { collectSdkFacts, composeSdkEdges } from "./sdk.js";
import { collectSymbolNodes } from "./symbols.js";
import { createUrlNormalizer } from "./url.js";
import { ANALYZER_VERSION } from "./version.js";
import { detectWorkspace, serviceNodes, type Workspace } from "./workspace.js";
import { bindWrappers, collectHttpFacts } from "./wrappers.js";

export { ANALYZER_VERSION };
export { findingsOf, type AnalysisFindings } from "./findings.js";
export * from "./facts.js";

/** Pipeline stages reported to {@link AnalyzeOptions.onStage}, in the order they run. */
export const ANALYSIS_STAGES = [
  "inventory",
  "workspace",
  "programs",
  "imports",
  "express",
  "next",
  "prisma",
  "infra",
  "files",
  "symbols",
  "calls",
  "http",
  "sdk",
  "queues",
  "assemble",
] as const;

/** One pipeline stage of {@link analyze}. */
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

/** A stage starting, or learning how much work it has (see {@link AnalyzeOptions.onProgress}). */
export interface AnalysisProgress {
  stage: AnalysisStage;
  /** What the stage works through, when known: source files to parse, requests to link. */
  count?: number;
}
/** Options for {@link analyze}. */
export interface AnalyzeOptions {
  /** Repo owner recorded in the graph. Defaults to `local`. */
  owner?: string;
  /** Repo name recorded in the graph. Defaults to the root `package.json` name, else `repo`. */
  name?: string;
  /** Commit SHA recorded in the graph, if known. */
  sha?: string;
  /** Override inventory limits (mainly for tests). Defaults to `DEFAULT_LIMITS`. */
  limits?: Partial<InventoryLimits>;
  /**
   * Called once per stage, in order, with its wall-clock milliseconds. Timing never enters
   * the graph (it would break determinism); it feeds benchmarks and `analyses.stats`.
   */
  onStage?: (stage: AnalysisStage, ms: number) => void;
  /**
   * Called as each stage starts, in order. `programs` carries the source files it parses;
   * `http` reports a second time, with the requests it links to routes, once it has
   * collected them. Like timings, progress never enters the graph.
   */
  onProgress?: (event: AnalysisProgress) => void;
  /**
   * Called after each stage that finds services (`workspace`), routes and pages (`express`,
   * `next`), data stores (`infra`, `queues`), or external services (`http`, `sdk`), with
   * everything found so far. The last call equals {@link findingsOf} on the returned graph's
   * nodes. Like progress, findings never enter the graph.
   */
  onFound?: (found: AnalysisFindings) => void;
  /**
   * Reuse service facts from this cache (`openDiskCache`) when every service's recorded
   * inputs still hold, and store them after a cold run (ADR-0175). The graph is the same
   * bytes either way; only the time differs.
   */
  cache?: FactCache;
}

/**
 * The repo name used when none is given: the root `package.json` `name`, else `repo`. Never
 * the checkout's folder name, which differs between machines and would break "same commit ⇒
 * same bytes".
 */
async function defaultName(root: string, files: readonly string[]): Promise<string> {
  if (!files.includes("package.json")) return "repo";
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const name =
      typeof manifest === "object" && manifest !== null && "name" in manifest
        ? manifest.name
        : undefined;
    return typeof name === "string" && name.trim() !== "" ? name : "repo";
  } catch {
    return "repo"; // the workspace stage already warns about invalid JSON
  }
}

/** The `DETECTOR_FAILED` warning for a detector stage that threw (see {@link errorText}). */
export function detectorFailure(
  stage: AnalysisStage,
  error: unknown,
  root: string,
): AnalysisWarning {
  return {
    code: "DETECTOR_FAILED",
    message: `the ${stage} stage stopped on an internal error (${errorText(error, root)}); what it finds is missing from this graph`,
  };
}

/**
 * Analyze the repository at `dir` and return its architecture graph.
 * The analyzer only reads files; it never executes or installs anything from the repo.
 * Throws if `dir` is not a directory, and `AnalysisError` when a limit is exceeded.
 * Skipped files appear as graph warnings. The result is validated against the schema.
 * A detector stage (imports, Express, Next.js, Prisma, infra, calls, HTTP, SDKs, queues)
 * that throws becomes a `DETECTOR_FAILED` warning and contributes nothing, so one detector's
 * bug costs its own nodes and edges rather than the whole analysis.
 */
export function analyze(dir: string, options: AnalyzeOptions = {}): Promise<ArchitectureGraph> {
  return analyzeServices(dir, options);
}

/** Options for {@link analyzeServices}: {@link analyze}'s, plus the service facts. */
export interface ServiceFactsOptions extends AnalyzeOptions {
  /**
   * Compose the graph from these instead of collecting them: one bundle per service, in
   * workspace order (else it throws). No program is built; the global steps (inventory,
   * workspace, Prisma schemas, infra, file nodes, matching, assembly) still run.
   */
  facts?: readonly ServiceFacts[];
  /** Called with every service's facts once all stages have collected them, before assembly. */
  onFacts?: (facts: readonly ServiceFacts[]) => void;
}

/**
 * {@link analyze}, rebuilt as facts → compose (ADR-0174): each stage collects one
 * {@link ServiceFacts} entry per service, asked as that service (ADR-0173), then composes
 * the stage from every service's facts. A throw while collecting one service is recorded in
 * its bundle, and the stage contributes nothing, as when composition throws. Composing given
 * `facts` (a JSON copy, or M6.7e's cache) gives the same bytes as collecting them.
 */
export async function analyzeServices(
  dir: string,
  options: ServiceFactsOptions = {},
): Promise<ArchitectureGraph> {
  const root = resolve(dir);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`not a directory: ${dir}`);

  const { onStage, onProgress } = options;
  /** Run one stage, reporting its start (with `count`, if known) and duration to listeners. */
  async function stage<T>(
    name: AnalysisStage,
    run: () => T | Promise<T>,
    count?: number,
  ): Promise<T> {
    onProgress?.(count === undefined ? { stage: name } : { stage: name, count });
    const start = performance.now();
    const result = await run();
    onStage?.(name, performance.now() - start);
    return result;
  }

  const failures: AnalysisWarning[] = [];
  /**
   * Run a detector stage; if it throws (anything but a limit), record a `DETECTOR_FAILED`
   * warning (the one a service's failed collection recorded, if that's why) and use `empty`
   * instead. Files and symbols aren't detectors: edges point at their nodes, so they always
   * run unguarded.
   */
  function detector<T>(name: AnalysisStage, run: () => T | Promise<T>, empty: () => T): Promise<T> {
    return stage(name, async () => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof AnalysisError) throw error;
        failures.push(
          error instanceof CollectionFailed ? error.warning : detectorFailure(name, error, root),
        );
        return empty();
      }
    });
  }
  const none = () => ({ nodes: [], edges: [], warnings: [] });
  // Added in assembly's part order, so the first node with an ID is the one the graph keeps.
  const found = createFindings(options.onFound);

  const inventory = await stage("inventory", () => buildInventory(root, options.limits));
  const workspace = await stage("workspace", () => detectWorkspace(root, inventory.files));
  const services = serviceNodes(workspace);
  found.add(["services"], services);
  let given = options.facts && givenFacts(options.facts, workspace);
  const cache = given ? undefined : options.cache;
  let keys: FactKeys | undefined;
  const programs = await stage(
    "programs",
    async () => {
      // A warm run composes from the cache instead of building programs (ADR-0175).
      if (cache) {
        keys = await factKeys(root, workspace, inventory, options.limits);
        given = await cachedFacts(cache, root, workspace, inventory, keys);
      }
      return given ? [] : buildServicePrograms(root, workspace, inventory);
    },
    inventory.sourceFiles.length,
  );
  const resolver = createSymbolResolver(programs, workspace);
  const collected = programs.map((sp) => ({ sp, facts: newFacts(sp) }));
  const bundles: readonly ServiceFacts[] = given ?? collected.map((c) => c.facts);

  /**
   * Collect `stage`'s facts for each service, asked as that service (ADR-0173). A throw is
   * recorded as that service's failed collection, and the other services still collect, so a
   * bundle doesn't depend on how another service's went.
   */
  function collect<S extends FactStage>(stage: S, run: (sp: ServiceProgram) => StageFacts[S]) {
    for (const { sp, facts } of collected) {
      try {
        const stages: Partial<StageFacts> = facts;
        stages[stage] = resolver.asking(sp, () => run(sp));
      } catch (error) {
        if (error instanceof AnalysisError) throw error;
        facts.failed.push({ stage, warning: detectorFailure(stage, error, root) });
      }
    }
  }
  /**
   * Run a global step `stage`'s collection needs; if it throws, every service's collection of
   * the stage failed, so each bundle records it before the stage fails.
   */
  async function collectionInput<T>(stage: FactStage, run: () => T | Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof AnalysisError)) {
        const warning = detectorFailure(stage, error, root);
        for (const { facts } of collected) facts.failed.push({ stage, warning });
      }
      throw error;
    }
  }

  const imports = await detector(
    "imports",
    () => {
      // Per-service facts, then the global merge (ADR-0098).
      const manifests: ManifestCache = new Map();
      collect("imports", (sp) =>
        collectImportFacts(sp, workspace, inventory.sourceFiles, manifests),
      );
      return composeImports(stageFacts(bundles, "imports"));
    },
    none,
  );
  const express = await detector(
    "express",
    async () => {
      // Per-service facts, then the global composition (ADR-0093).
      if (!given) {
        const hasRouters = await collectionInput("express", () =>
          programs.some((sp) => routerCreations(sp).length > 0),
        );
        collect("express", (sp) => collectExpressFacts(sp, resolver, hasRouters));
      }
      return composeExpressRoutes(
        stageFacts(bundles, "express"),
        workspace.packages,
        rootFileServices(
          bundles.map((f) => ({ service: { key: f.service }, rootFiles: f.rootFiles })),
        ),
      );
    },
    () => ({ ...none(), inlineHandlers: new Map<string, string[]>(), listedRoutes: [] }),
  );
  found.add(["routes"], express.nodes);
  const next = await detector(
    "next",
    () => {
      collect("next", (sp) => collectNextFacts(sp, resolver));
      return composeNextRoutes(stageFacts(bundles, "next"));
    },
    none,
  );
  found.add(["routes", "pages"], next.nodes);
  const prisma = await detector(
    "prisma",
    async () => {
      // The schema is a global step; client calls are per-service facts (ADR-0099).
      const build = () => buildPrismaSchemas(root, workspace, inventory.sourceFiles);
      const schemas = await (given ? build() : collectionInput("prisma", build));
      collect("prisma", (sp) => collectPrismaFacts(sp, resolver, schemas.usesPrisma));
      return composePrisma(schemas, stageFacts(bundles, "prisma"), express.inlineHandlers);
    },
    () => ({ ...none(), datastores: [] }),
  );
  const infra = await detector(
    "infra",
    () => buildInfra(root, inventory.files, prisma.datastores),
    () => ({ nodes: [], warnings: [], links: new Map() }),
  );
  const stored = relinkStores(prisma, infra.links);
  found.add(["stores"], [...stored.nodes, ...infra.nodes]);
  const files = await stage("files", () => buildFileNodes(root, workspace, inventory.sourceFiles));
  const symbols = await stage("symbols", () => {
    for (const { sp, facts } of collected) facts.symbols = collectSymbolNodes(sp);
    return bundles.flatMap((f) => f.symbols);
  });
  const calls = await detector(
    "calls",
    () => {
      collect("calls", (sp) => collectCallFacts(sp, resolver));
      return composeCallEdges(stageFacts(bundles, "calls"));
    },
    () => [],
  );
  const http = await detector(
    "http",
    async () => {
      if (!given) {
        // Whole-repo passes that ask as each service they walk (ADR-0173), giving
        // per-service facts; then the global binding step (ADR-0092, ADR-0094).
        const facts = await collectionInput("http", () =>
          collectHttpFacts(
            collectHttpCalls(programs, resolver),
            programs,
            resolver,
            createUrlNormalizer(resolver),
          ),
        );
        // One per program, in program order (missing ones fail in `stageFacts`).
        for (const f of facts) {
          const bundle = collected.find((c) => c.sp.service.key === f.service)?.facts;
          if (bundle) bundle.http = f;
        }
      }
      const requests = bindWrappers(stageFacts(bundles, "http"), express.inlineHandlers);
      onProgress?.({ stage: "http", count: requests.length });
      const matcher = createRouteMatcher(
        [...express.nodes, ...next.nodes],
        workspace,
        new Set(express.listedRoutes),
      );
      return buildHttpEdges(requests, matcher, workspace);
    },
    () => ({ nodes: [], edges: [], matches: [] }),
  );
  found.add(["externals"], http.nodes);
  const sdk = await detector(
    "sdk",
    () => {
      // Per-service facts, then the global merge (ADR-0172).
      collect("sdk", (sp) => collectSdkFacts(sp, resolver, workspace));
      return composeSdkEdges(stageFacts(bundles, "sdk"), express.inlineHandlers);
    },
    () => ({ nodes: [], edges: [] }),
  );
  found.add(["externals"], sdk.nodes);
  const queues = await detector(
    "queues",
    async () => {
      // Per-service facts; worker factories and the merge are global (ADR-0172).
      if (!given) {
        const scanned = await collectionInput("queues", () => usesQueueLibrary(programs));
        collect("queues", (sp) => collectQueueFacts(sp, resolver, workspace, scanned));
      }
      return composeQueueEdges(stageFacts(bundles, "queues"), express.inlineHandlers);
    },
    () => ({ nodes: [], edges: [] }),
  );
  found.add(["stores"], queues.nodes);
  for (const { sp, facts } of collected) facts.analyzerWarnings = resolver.warnings(sp);
  options.onFacts?.(bundles);
  if (cache && keys && collected.length > 0) {
    await storeFacts(cache, keys, bundles, serviceInputs(programs, resolver));
  }
  const name = options.name ?? (await defaultName(root, inventory.files));
  // Part order is precedence: a custom Express server can register the same route as a
  // Next.js file, and Express's node wins (ADR-0027).
  return stage("assemble", () =>
    assembleGraph({
      repo: {
        owner: options.owner ?? "local",
        name,
        ...(options.sha ? { sha: options.sha } : {}),
      },
      analyzerVersion: ANALYZER_VERSION,
      parts: [
        { source: "inventory", warnings: inventory.warnings },
        {
          source: "workspace",
          nodes: [{ id: SYSTEM_ID, kind: "system", label: name, parentId: null }, ...services],
          warnings: workspace.warnings,
        },
        { source: "typescript", warnings: bundles.flatMap((f) => f.programWarnings) },
        {
          source: "files",
          nodes: files,
          warnings: outsideServiceWarnings(workspace, inventory.sourceFiles),
        },
        { source: "symbols", nodes: symbols },
        { source: "imports", ...imports },
        { source: "calls", edges: calls },
        { source: "express", ...express },
        { source: "next", ...next },
        { source: "prisma", ...stored, warnings: prisma.warnings },
        { source: "infra", nodes: infra.nodes, warnings: infra.warnings },
        { source: "http", nodes: http.nodes, edges: http.edges },
        { source: "sdk", ...sdk },
        { source: "queues", ...queues },
        {
          source: "analyzer",
          warnings: [...bundles.flatMap((f) => f.analyzerWarnings), ...failures],
        },
      ],
    }),
  );
}

/** A bundle for `sp` with its program's facts and no stage collected yet. */
function newFacts(sp: ServiceProgram): ServiceFacts {
  return {
    service: sp.service.key,
    rootFiles: sp.rootFiles,
    programWarnings: sp.warnings,
    symbols: [],
    failed: [],
    analyzerWarnings: [],
  };
}

/** `facts`, checked to hold one bundle per workspace service, in workspace order. */
function givenFacts(facts: readonly ServiceFacts[], workspace: Workspace): readonly ServiceFacts[] {
  const expected = workspace.packages.map((p) => p.key);
  const keys = facts.map((f) => f.service);
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    throw new Error(
      `service facts for ${keys.join(", ")} don't match the workspace's services (${expected.join(", ")})`,
    );
  }
  return facts;
}
