import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { SYSTEM_ID, type ArchitectureGraph } from "@gitinside/schema";
import { assembleGraph } from "./assemble.js";
import { buildCallEdges, createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { buildFileNodes, outsideServiceWarnings } from "./files.js";
import { collectHttpCalls } from "./http.js";
import { buildImportGraph } from "./imports.js";
import { buildInfra, relinkStores } from "./infra.js";
import { buildInventory, type InventoryLimits } from "./inventory.js";
import { buildHttpEdges, createRouteMatcher } from "./match.js";
import { buildNextRoutes } from "./next.js";
import { buildPrisma } from "./prisma.js";
import { buildServicePrograms } from "./program.js";
import { buildQueueEdges } from "./queues.js";
import { buildSdkEdges } from "./sdk.js";
import { buildSymbolNodes } from "./symbols.js";
import { createUrlNormalizer } from "./url.js";
import { detectWorkspace, serviceNodes } from "./workspace.js";
import { inlineWrappers } from "./wrappers.js";

/** Version stamped into every graph. Part of the cache key, so bump it when output changes. */
export const ANALYZER_VERSION = "0.1.0";

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

/**
 * Analyze the repository at `dir` and return its architecture graph.
 * The analyzer only reads files; it never executes or installs anything from the repo.
 * Throws if `dir` is not a directory, and `AnalysisError` when a limit is exceeded.
 * Skipped files appear as graph warnings. The result is validated against the schema.
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

  const inventory = await stage("inventory", () => buildInventory(root, options.limits));
  const workspace = await stage("workspace", () => detectWorkspace(root, inventory.files));
  const programs = await stage(
    "programs",
    () => buildServicePrograms(root, workspace, inventory),
    inventory.sourceFiles.length,
  );
  const imports = await stage("imports", () =>
    buildImportGraph(programs, workspace, inventory.sourceFiles),
  );
  const resolver = createSymbolResolver(programs, workspace);
  const express = await stage("express", () => buildExpressRoutes(programs, resolver));
  const next = await stage("next", () => buildNextRoutes(programs, resolver));
  const prisma = await stage("prisma", () =>
    buildPrisma(root, programs, workspace, resolver, inventory.sourceFiles, express.inlineHandlers),
  );
  const infra = await stage("infra", () => buildInfra(root, inventory.files, prisma.datastores));
  const stored = relinkStores(prisma, infra.links);
  const files = await stage("files", () => buildFileNodes(root, workspace, inventory.sourceFiles));
  const symbols = await stage("symbols", () => buildSymbolNodes(programs));
  const calls = await stage("calls", () => buildCallEdges(programs, resolver));
  const http = await stage("http", () => {
    const sites = collectHttpCalls(programs, resolver, express.inlineHandlers);
    const requests = inlineWrappers(
      sites,
      programs,
      resolver,
      createUrlNormalizer(resolver),
      express.inlineHandlers,
    );
    onProgress?.({ stage: "http", count: requests.length });
    const matcher = createRouteMatcher([...express.nodes, ...next.nodes], workspace);
    return buildHttpEdges(requests, matcher, workspace);
  });
  const sdk = await stage("sdk", () =>
    buildSdkEdges(programs, resolver, workspace, express.inlineHandlers),
  );
  const queues = await stage("queues", () =>
    buildQueueEdges(programs, resolver, workspace, express.inlineHandlers),
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
      ],
    }),
  );
}
