import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
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

  const inventory = await buildInventory(root, options.limits);
  const workspace = await detectWorkspace(root, inventory.files);
  const programs = buildServicePrograms(root, workspace, inventory);
  const imports = buildImportGraph(programs, workspace, inventory.sourceFiles);
  const resolver = createSymbolResolver(programs, workspace);
  const express = buildExpressRoutes(programs, resolver);
  const next = buildNextRoutes(programs, resolver);
  const prisma = await buildPrisma(
    root,
    programs,
    workspace,
    resolver,
    inventory.sourceFiles,
    express.inlineHandlers,
  );
  const name = options.name ?? (basename(root) || "repo");
  // Part order is precedence: a custom Express server can register the same route as a
  // Next.js file, and Express's node wins (ADR-0027).
  return assembleGraph({
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
      { source: "files", nodes: await buildFileNodes(root, workspace, inventory.sourceFiles) },
      { source: "symbols", nodes: buildSymbolNodes(programs) },
      { source: "imports", ...imports },
      { source: "calls", edges: buildCallEdges(programs, resolver) },
      { source: "express", ...express },
      { source: "next", ...next },
      { source: "prisma", ...prisma },
    ],
  });
}
