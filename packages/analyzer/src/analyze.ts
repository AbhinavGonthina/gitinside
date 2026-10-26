import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  SCHEMA_VERSION,
  SYSTEM_ID,
  compareStrings,
  parseGraph,
  type ArchitectureGraph,
} from "@gitinside/schema";
import { buildInventory, type InventoryLimits } from "./inventory.js";
import { buildServicePrograms } from "./program.js";
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
  const name = options.name ?? (basename(root) || "repo");
  return parseGraph({
    schemaVersion: SCHEMA_VERSION,
    repo: {
      owner: options.owner ?? "local",
      name,
      ...(options.sha ? { sha: options.sha } : {}),
    },
    analyzerVersion: ANALYZER_VERSION,
    nodes: [
      { id: SYSTEM_ID, kind: "system", label: name, parentId: null },
      ...serviceNodes(workspace),
    ],
    edges: [],
    warnings: [
      ...inventory.warnings,
      ...workspace.warnings,
      ...programs.flatMap((p) => p.warnings),
    ].sort(
      (a, b) =>
        compareStrings(a.file ?? "", b.file ?? "") ||
        compareStrings(a.code, b.code) ||
        compareStrings(a.message, b.message),
    ),
  });
}
