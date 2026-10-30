import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { SYSTEM_ID, type AnalysisWarning, type ArchitectureGraph } from "@gitinside/schema";
import { assembleGraph } from "./assemble.js";
import { collectCallFacts, composeCallEdges, createSymbolResolver } from "./calls.js";
import {
  collectExpressFacts,
  composeExpressRoutes,
  rootFileServices,
  routerCreations,
} from "./express.js";
import { errorText } from "./failures.js";
import { buildFileNodes, outsideServiceWarnings } from "./files.js";
import { collectHttpCalls } from "./http.js";
import { collectImportFacts, composeImports, type ManifestCache } from "./imports.js";
import { buildInfra, relinkStores } from "./infra.js";
import { AnalysisError, buildInventory, type InventoryLimits } from "./inventory.js";
import { buildHttpEdges, createRouteMatcher } from "./match.js";
import { buildNextRoutes } from "./next.js";
import { buildPrisma } from "./prisma.js";
import { buildServicePrograms } from "./program.js";
import { buildQueueEdges } from "./queues.js";
import { buildSdkEdges } from "./sdk.js";
import { collectSymbolNodes } from "./symbols.js";
import { createUrlNormalizer } from "./url.js";
import { ANALYZER_VERSION } from "./version.js";
import { detectWorkspace, serviceNodes } from "./workspace.js";
import { bindWrappers, collectHttpFacts } from "./wrappers.js";

export { ANALYZER_VERSION };

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
export async function analyze(
  dir: string,
  options: AnalyzeOptions = {},
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
   * warning and use `empty` instead. Files and symbols aren't detectors: edges point at
   * their nodes, so they always run unguarded.
   */
  function detector<T>(name: AnalysisStage, run: () => T | Promise<T>, empty: () => T): Promise<T> {
    return stage(name, async () => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof AnalysisError) throw error;
        failures.push(detectorFailure(name, error, root));
        return empty();
      }
    });
  }
  const none = () => ({ nodes: [], edges: [], warnings: [] });

  const inventory = await stage("inventory", () => buildInventory(root, options.limits));
  const workspace = await stage("workspace", () => detectWorkspace(root, inventory.files));
  const programs = await stage(
    "programs",
    () => buildServicePrograms(root, workspace, inventory),
    inventory.sourceFiles.length,
  );
  const imports = await detector(
    "imports",
    () => {
      // Per-service facts, then the global merge (ADR-0098).
      const manifests: ManifestCache = new Map();
      return composeImports(
        programs.map((sp) => collectImportFacts(sp, workspace, inventory.sourceFiles, manifests)),
      );
    },
    none,
  );
  const resolver = createSymbolResolver(programs, workspace);
  const express = await detector(
    "express",
    () => {
      // Per-service facts, then the global composition (ADR-0093).
      const hasRouters = programs.some((sp) => routerCreations(sp).length > 0);
      const facts = programs.map((sp) => collectExpressFacts(sp, resolver, hasRouters));
      return composeExpressRoutes(facts, workspace.packages, rootFileServices(programs));
    },
    () => ({ ...none(), inlineHandlers: new Map<string, string[]>() }),
  );
  const next = await detector("next", () => buildNextRoutes(programs, resolver), none);
  const prisma = await detector(
    "prisma",
    () =>
      buildPrisma(
        root,
        programs,
        workspace,
        resolver,
        inventory.sourceFiles,
        express.inlineHandlers,
      ),
    () => ({ ...none(), datastores: [] }),
  );
  const infra = await detector(
    "infra",
    () => buildInfra(root, inventory.files, prisma.datastores),
    () => ({ nodes: [], warnings: [], links: new Map() }),
  );
  const stored = relinkStores(prisma, infra.links);
  const files = await stage("files", () => buildFileNodes(root, workspace, inventory.sourceFiles));
  const symbols = await stage("symbols", () => programs.flatMap((sp) => collectSymbolNodes(sp)));
  const calls = await detector(
    "calls",
    () => composeCallEdges(programs.map((sp) => collectCallFacts(sp, resolver))),
    () => [],
  );
  const http = await detector(
    "http",
    () => {
      const sites = collectHttpCalls(programs, resolver);
      // Per-service facts, then the global binding step (ADR-0092, ADR-0094).
      const facts = collectHttpFacts(sites, programs, resolver, createUrlNormalizer(resolver));
      const requests = bindWrappers(facts, express.inlineHandlers);
      onProgress?.({ stage: "http", count: requests.length });
      const matcher = createRouteMatcher([...express.nodes, ...next.nodes], workspace);
      return buildHttpEdges(requests, matcher, workspace);
    },
    () => ({ nodes: [], edges: [], matches: [] }),
  );
  const sdk = await detector(
    "sdk",
    () => buildSdkEdges(programs, resolver, workspace, express.inlineHandlers),
    () => ({ nodes: [], edges: [] }),
  );
  const queues = await detector(
    "queues",
    () => buildQueueEdges(programs, resolver, workspace, express.inlineHandlers),
    () => ({ nodes: [], edges: [] }),
  );
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
          nodes: [
            { id: SYSTEM_ID, kind: "system", label: name, parentId: null },
            ...serviceNodes(workspace),
          ],
          warnings: workspace.warnings,
        },
        { source: "typescript", warnings: programs.flatMap((p) => p.warnings) },
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
        { source: "analyzer", warnings: [...resolver.warnings(), ...failures] },
      ],
    }),
  );
}
