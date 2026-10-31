import { compareStrings } from "@gitinside/schema";
import type { AnalysisWarning, ArchitectureGraph } from "@gitinside/schema";

/**
 * The analysis's warnings for the reader (M4b.12b, ADR-0128): what wasn't
 * analyzed and why (ADR-0070), grouped by code under a plain-English title.
 * The analyzer's own message and file stay as written, so nothing is
 * reworded into something the analysis didn't say.
 */

/**
 * A title per warning code the analyzer emits. A code missing here (a newer
 * analyzer's) is titled with the code itself, never dropped.
 */
export const WARNING_TITLES: Readonly<Record<string, string>> = {
  COMPOSE_DYNAMIC_IMAGE: "Compose images set at runtime",
  COMPOSE_INVALID: "Compose files that couldn't be read",
  DETECTOR_FAILED: "Detectors that stopped on an internal error",
  DUPLICATE_NODE: "Things found twice (the first was kept)",
  DUPLICATE_PACKAGE_NAME: "Packages sharing a name",
  EXPRESS_ROUTE_LIMIT: "Express routes past the route limit",
  EXPRESS_UNMOUNTED_ROUTER: "Express routers never mounted",
  FILES_OUTSIDE_SERVICE: "Files outside every service",
  IMPORT_OUTSIDE_SERVICE: "Imports reaching outside their service",
  INFRA_AMBIGUOUS_DATASTORE: "Data stores that could be more than one",
  INVALID_JSON: "JSON files that couldn't be read",
  INVALID_WORKSPACES: "Workspace lists that couldn't be read",
  INVALID_YAML: "YAML files that couldn't be read",
  NEXT_DUPLICATE_ROUTE: "Next.js routes defined twice",
  NEXT_ROUTE_NO_METHODS: "Next.js route files without handlers",
  PRISMA_DUPLICATE_MODEL: "Prisma models defined twice",
  PRISMA_DYNAMIC_PROVIDER: "Prisma providers set at runtime",
  PRISMA_NO_DATASOURCE: "Prisma schemas without a datasource",
  PRISMA_SYNTAX: "Prisma schemas that didn't parse",
  SKIPPED_DEPTH: "Folders nested too deep, skipped",
  SKIPPED_GENERATED: "Generated files, skipped",
  SKIPPED_LARGE: "Files over 2 MB, skipped",
  SKIPPED_SPECIAL: "Special files, skipped",
  SKIPPED_SYMLINK: "Symbolic links, not followed",
  SYNTAX_ERROR: "Files that didn't parse",
  TSCONFIG_INVALID: "tsconfig files that couldn't be read",
  TSCONFIG_MISSING: "Services without a tsconfig (defaults used)",
  TYPESCRIPT_INTERNAL_ERROR: "Expressions TypeScript failed on",
  WORKSPACE_CYCLE: "Packages that depend on each other in a cycle",
  WORKSPACE_NO_MATCH: "Workspace patterns that match no package",
  WORKSPACE_PATTERN_TOO_COMPLEX: "Workspace patterns too complex to follow",
};

/** The warnings with one code, under its title. */
export interface WarningGroup {
  code: string;
  title: string;
  warnings: readonly AnalysisWarning[];
}

/**
 * Warnings grouped by code, groups by title, each group's warnings by file
 * (none first) then message. Deterministic in any input order.
 */
export function groupWarnings(warnings: readonly AnalysisWarning[]): WarningGroup[] {
  const byCode = new Map<string, AnalysisWarning[]>();
  for (const w of warnings) {
    const list = byCode.get(w.code);
    if (list) list.push(w);
    else byCode.set(w.code, [w]);
  }
  return [...byCode]
    .map(([code, list]) => ({
      code,
      title: WARNING_TITLES[code] ?? code,
      warnings: list.sort(
        (a, b) =>
          compareStrings(a.file ?? "", b.file ?? "") || compareStrings(a.message, b.message),
      ),
    }))
    .sort((a, b) => compareStrings(a.title, b.title) || compareStrings(a.code, b.code));
}

/** "1 warning", "1,204 warnings". */
export function warningCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "warning" : "warnings"}`;
}

/**
 * Whether the analysis found a TypeScript or JavaScript app: any source file
 * in a service. A repo of only docs, config, or a Prisma schema has none, and
 * the explorer says so instead of drawing an empty service (UX.md "States").
 */
export function hasSourceFiles(graph: ArchitectureGraph): boolean {
  return graph.nodes.some((n) => n.kind === "file");
}
