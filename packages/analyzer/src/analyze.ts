import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { SCHEMA_VERSION, SYSTEM_ID, parseGraph, type ArchitectureGraph } from "@gitinside/schema";

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
}

/**
 * Analyze the repository at `dir` and return its architecture graph.
 * The analyzer only reads files; it never executes or installs anything from the repo.
 * Throws if `dir` is not a directory. The result is validated against the schema.
 */
export async function analyze(
  dir: string,
  options: AnalyzeOptions = {},
): Promise<ArchitectureGraph> {
  const root = resolve(dir);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`not a directory: ${dir}`);

  const name = options.name ?? (basename(root) || "repo");
  return parseGraph({
    schemaVersion: SCHEMA_VERSION,
    repo: {
      owner: options.owner ?? "local",
      name,
      ...(options.sha ? { sha: options.sha } : {}),
    },
    analyzerVersion: ANALYZER_VERSION,
    nodes: [{ id: SYSTEM_ID, kind: "system", label: name, parentId: null }],
    edges: [],
    warnings: [],
  });
}
