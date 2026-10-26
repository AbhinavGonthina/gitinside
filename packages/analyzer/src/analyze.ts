import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { SYSTEM_ID, type ArchitectureGraph } from "@gitinside/schema";
import { assembleGraph } from "./assemble.js";
import { buildCallEdges, createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { buildFileNodes } from "./files.js";
import { buildImportGraph } from "./imports.js";
import { buildInventory, type InventoryLimits } from "./inventory.js";
import { buildNextRoutes } from "./next.js";
import { buildPrisma } from "./prisma.js";
import { buildServicePrograms } from "./program.js";
import { buildSymbolNodes } from "./symbols.js";
import { detectWorkspace, serviceNodes } from "./workspace.js";

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
  "files",
  "symbols",
  "calls",
  "assemble",
] as const;

/** One pipeline stage of {@link analyze}. */
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

/** Options for {@link analyze}. */
export interface AnalyzeOptions {
  /** Repo owner recorded in the graph. Defaults to `local`. */
  owner?: string;
  /** Repo name recorded in the graph. Defaults to the directory name. */
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

  const onStage = options.onStage;
  /** Run one stage, reporting its duration when someone is listening. */
  async function stage<T>(name: AnalysisStage, run: () => T | Promise<T>): Promise<T> {
    const start = performance.now();
    const result = await run();
    onStage?.(name, performance.now() - start);
    return result;
  }

  const inventory = await stage("inventory", () => buildInventory(root, options.limits));
  const workspace = await stage("workspace", () => detectWorkspace(root, inventory.files));
  const programs = await stage("programs", () => buildServicePrograms(root, workspace, inventory));
  const imports = await stage("imports", () =>
    buildImportGraph(programs, workspace, inventory.sourceFiles),
  );
  const resolver = createSymbolResolver(programs, workspace);
  const express = await stage("express", () => buildExpressRoutes(programs, resolver));
  const next = await stage("next", () => buildNextRoutes(programs, resolver));
  const prisma = await stage("prisma", () =>
    buildPrisma(root, programs, workspace, resolver, inventory.sourceFiles, express.inlineHandlers),
  );
  const files = await stage("files", () => buildFileNodes(root, workspace, inventory.sourceFiles));
  const symbols = await stage("symbols", () => buildSymbolNodes(programs));
  const calls = await stage("calls", () => buildCallEdges(programs, resolver));
  const name = options.name ?? (basename(root) || "repo");
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
        { source: "files", nodes: files },
        { source: "symbols", nodes: symbols },
        { source: "imports", ...imports },
        { source: "calls", edges: calls },
        { source: "express", ...express },
        { source: "next", ...next },
        { source: "prisma", ...prisma },
      ],
    }),
  );
}
