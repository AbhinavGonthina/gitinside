import ts from "typescript";
import {
  compareStrings,
  edgeId,
  nodeId,
  type AnalysisWarning,
  type Confidence,
  type GraphEdge,
  type GraphNode,
  type SourceLocation,
} from "@gitinside/schema";
import { fileNodeId, withinService } from "./files.js";
import type { ServiceProgram } from "./program.js";
import { serviceForFile, type Workspace, type WorkspacePackage } from "./workspace.js";

/** One module specifier found in a source file. */
export interface ImportSite {
  /** The specifier text (`./db`, `@acme/shared`, `express`). */
  specifier: string;
  /** The string literal node, used for the resolution mode and the source location. */
  literal: ts.StringLiteralLike;
}

/**
 * Specifier extensions that name assets, not code. Bundlers load these (`import "./a.css"`),
 * TypeScript can't resolve them, and they have no file node, so they produce no edge.
 */
const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ".avif",
  ".css",
  ".eot",
  ".gif",
  ".graphql",
  ".gql",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".json",
  ".less",
  ".md",
  ".mdx",
  ".mp3",
  ".mp4",
  ".otf",
  ".png",
  ".sass",
  ".scss",
  ".styl",
  ".svg",
  ".ttf",
  ".txt",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".yaml",
  ".yml",
]);

/** `exports` conditions tried in order; any other conditions follow in sorted order. */
const CONDITIONS: readonly string[] = [
  "source",
  "types",
  "typings",
  "import",
  "module",
  "default",
  "require",
  "node",
  "browser",
];

/** `package.json` entry fields tried in order for a bare package import. */
const ENTRY_FIELDS: readonly string[] = ["source", "types", "typings", "module", "main"];

function isStringLiteralLike(node: ts.Node | undefined): node is ts.StringLiteralLike {
  return (
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  );
}

/**
 * Every module specifier in one source file, in source order.
 *
 * Handles: `import … from "x"` and `import "x"` (including `import type`), `export … from "x"`,
 * `import x = require("x")`, and anywhere in the file, `require("x")` and `import("x")` calls
 * whose argument is a plain string literal.
 *
 * Not handled: computed specifiers (`require(name)`, `` import(`./${x}`) ``), `require.resolve`,
 * `import("x")` type annotations, triple-slash references, and loader APIs such as
 * `jest.mock("x")` or `next/dynamic` options objects.
 */
export function extractImports(sourceFile: ts.SourceFile): ImportSite[] {
  const sites: ImportSite[] = [];
  const add = (literal: ts.Node | undefined): void => {
    if (isStringLiteralLike(literal)) sites.push({ specifier: literal.text, literal });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isRequire || callee.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** The extension of a specifier's last path segment, lowercased, or `""`. */
function extensionOf(specifier: string): string {
  const last = specifier.slice(specifier.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot <= 0 ? "" : last.slice(dot).toLowerCase();
}

/** True for `./x`, `../x`, `.`, `..`, and absolute `/x` specifiers. */
function isRelative(specifier: string): boolean {
  return /^\.\.?(\/|$)/.test(specifier) || specifier.startsWith("/");
}

/** True when a tsconfig `paths` key (`@app/*`, `config`) matches the specifier. A bare `*` never counts. */
function matchesPathsKey(key: string, specifier: string): boolean {
  const star = key.indexOf("*");
  if (star === -1) return key === specifier;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return (
    prefix !== "" &&
    specifier.length >= prefix.length + suffix.length &&
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix)
  );
}

/** The workspace package a bare specifier names (longest name wins), with the subpath after it. */
function workspaceTarget(
  workspace: Workspace,
  specifier: string,
): { pkg: WorkspacePackage; subpath: string } | undefined {
  let best: { pkg: WorkspacePackage; subpath: string } | undefined;
  let bestLength = -1;
  for (const pkg of workspace.packages) {
    const name = pkg.packageName;
    if (name === undefined) continue;
    const matches = specifier === name || specifier.startsWith(`${name}/`);
    if (matches && name.length > bestLength) {
      best = { pkg, subpath: specifier.slice(name.length + 1) };
      bestLength = name.length;
    }
  }
  return best;
}

/** Target strings of an `exports` value, in condition order (see {@link CONDITIONS}). */
function conditionTargets(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth > 8 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v) => conditionTargets(v, depth + 1));
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const ordered = [
    ...CONDITIONS.filter((c) => keys.includes(c)),
    ...keys.filter((k) => !CONDITIONS.includes(k)).sort(compareStrings),
  ];
  return ordered.flatMap((k) => conditionTargets(record[k], depth + 1));
}

/** Target strings of `exports` for a subpath (`""` = the package root). Wildcards aren't expanded. */
function exportTargets(exports: unknown, subpath: string): string[] {
  const key = subpath === "" ? "." : `./${subpath}`;
  if (typeof exports === "string" || Array.isArray(exports)) {
    return key === "." ? conditionTargets(exports) : [];
  }
  if (exports === null || typeof exports !== "object") return [];
  const record = exports as Record<string, unknown>;
  const isSubpathMap = Object.keys(record).some((k) => k.startsWith("."));
  if (isSubpathMap) return key in record ? conditionTargets(record[key]) : [];
  return key === "." ? conditionTargets(record) : [];
}

/** A resolved import target: a repo-relative file and how sure we are. */
export interface ResolvedImport {
  path: string;
  confidence: Confidence;
}

/** Parsed `package.json` files by package folder, shared between resolvers. */
export type ManifestCache = Map<string, Record<string, unknown> | undefined>;

/**
 * A module resolver for one service program: TypeScript's resolution first (`exact`), then
 * cross-workspace package imports from their manifests (see {@link buildImportGraph} for the
 * order and confidence rules). Returns undefined when neither finds a repo file.
 */
export function createModuleResolver(
  sp: ServiceProgram,
  workspace: Workspace,
  manifests: ManifestCache = new Map(),
): (
  specifier: string,
  sourceFile: ts.SourceFile,
  literal: ts.StringLiteralLike,
) => ResolvedImport | undefined {
  const options = sp.program.getCompilerOptions();
  const cache = ts.createModuleResolutionCache(sp.toAbsolute(""), (f) => f, options);

  /** Resolve `specifier` as TypeScript would from `containingFile`, to a repo file. */
  const resolveTs = (
    specifier: string,
    containingFile: string,
    mode?: ts.ResolutionMode,
  ): string | undefined => {
    const result = ts.resolveModuleName(
      specifier,
      containingFile,
      options,
      sp.host,
      cache,
      undefined,
      mode,
    );
    const fileName = result.resolvedModule?.resolvedFileName;
    return fileName === undefined ? undefined : sp.toRepoPath(fileName);
  };

  const manifestOf = (pkg: WorkspacePackage): Record<string, unknown> | undefined => {
    if (manifests.has(pkg.dir)) return manifests.get(pkg.dir);
    const path = pkg.dir === "" ? "package.json" : `${pkg.dir}/package.json`;
    let manifest: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(sp.host.readFile(sp.toAbsolute(path)) ?? "");
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        manifest = parsed as Record<string, unknown>;
      }
    } catch {
      manifest = undefined;
    }
    manifests.set(pkg.dir, manifest);
    return manifest;
  };

  const resolveWorkspace = (pkg: WorkspacePackage, subpath: string): ResolvedImport | undefined => {
    const manifest = manifestOf(pkg) ?? {};
    const from = sp.toAbsolute(pkg.dir === "" ? "package.json" : `${pkg.dir}/package.json`);
    const exact: string[] = exportTargets(manifest.exports, subpath);
    let namesEntry = manifest.exports !== undefined;
    if (subpath === "") {
      for (const field of ENTRY_FIELDS) {
        const value = manifest[field];
        if (typeof value === "string") {
          exact.push(value);
          namesEntry = true;
        }
      }
      if (!namesEntry) exact.push("index");
    } else {
      exact.push(subpath);
    }
    const fallback = subpath === "" ? ["src/index", "index"] : [`src/${subpath}`];
    const tries: ResolvedImport[] = [
      ...exact.map((path) => ({ path, confidence: "exact" as const })),
      ...fallback.map((path) => ({ path, confidence: "heuristic" as const })),
    ];
    for (const attempt of tries) {
      const relative = attempt.path.replace(/^\.\//, "");
      if (relative === "" || relative.startsWith("/") || relative.startsWith("../")) continue;
      const path = resolveTs(`./${relative}`, from);
      if (path !== undefined) return { path, confidence: attempt.confidence };
    }
    return undefined;
  };

  return (specifier, sourceFile, literal) => {
    const mode = ts.getModeForUsageLocation(sourceFile, literal, options);
    const tsPath = resolveTs(specifier, sourceFile.fileName, mode);
    if (tsPath !== undefined) return { path: tsPath, confidence: "exact" };
    const pkgTarget = workspaceTarget(workspace, specifier);
    return pkgTarget ? resolveWorkspace(pkgTarget.pkg, pkgTarget.subpath) : undefined;
  };
}

/**
 * Build `imports` edges (file → file) for every service program, plus an `unresolved` node
 * and edge for each local-looking import that doesn't resolve to a file in the repo.
 *
 * Resolution, in order:
 * 1. TypeScript's own module resolution with the service's compiler options, over the
 *    inventory-only host: relative paths, `paths`/`baseUrl` aliases, `index` files, `.js` →
 *    `.ts` mapping, and package.json `imports` (`#x`). A hit is `exact`.
 * 2. Cross-workspace package imports (`@acme/shared`, `@acme/shared/utils`), since there is
 *    no `node_modules`: the matching workspace package's `package.json` `exports` (string,
 *    condition object, or exact subpath key), then `source`/`types`/`typings`/`module`/`main`,
 *    then a direct subpath, each resolved like a relative import from the package folder
 *    (`exact`). If none exists (usually because they point into a skipped `dist/` folder),
 *    `src/index` / `src/<subpath>` and then `index` are tried as `heuristic`, except that
 *    `index` is `exact` when the manifest names no entry at all (Node's own default).
 * 3. Otherwise, a specifier that must be local (relative, absolute, `@/`, `~/`, `#`, a
 *    `paths` key other than a bare `*`, or a workspace package name) becomes an `unresolved`
 *    node (reason `UNKNOWN_SYMBOL`, expression = the specifier) parented to the importing
 *    service, with an `unresolved` edge. Anything else is a third-party package and gets no
 *    edge here (external SDKs are M2.6).
 *
 * Imports of assets (`.css`, `.svg`, `.json`, …, see {@link ASSET_EXTENSIONS}) produce nothing.
 * A target that resolves to a repo file outside every service gets an
 * `IMPORT_OUTSIDE_SERVICE` warning instead of an edge. Repeated imports of the same target
 * from one file share one edge, with every site listed. Type-only imports count: they are
 * real file dependencies.
 *
 * Not handled: `exports` wildcard patterns (`./*`), `typesVersions`, conditional
 * `paths` per environment, and resolution through real `node_modules` (never present).
 */
export function buildImportGraph(
  programs: readonly ServiceProgram[],
  workspace: Workspace,
  sourceFiles: readonly string[],
): { nodes: GraphNode[]; edges: GraphEdge[]; warnings: AnalysisWarning[] } {
  const sources = new Set(sourceFiles);
  const nodes: GraphNode[] = [];
  const edges = new Map<string, GraphEdge>();
  const warnings: AnalysisWarning[] = [];
  const manifests: ManifestCache = new Map();

  for (const sp of programs) {
    const options = sp.program.getCompilerOptions();
    const pathsKeys = Object.keys(options.paths ?? {});
    const resolveModule = createModuleResolver(sp, workspace, manifests);

    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      if (!sourceFile) continue;
      const fromId = fileNodeId(sp.service, file);

      for (const site of extractImports(sourceFile)) {
        const { specifier, literal } = site;
        if (specifier === "" || ASSET_EXTENSIONS.has(extensionOf(specifier))) continue;
        const position = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
        const location: SourceLocation = {
          file,
          line: position.line + 1,
          column: position.character + 1,
        };

        const resolved = resolveModule(specifier, sourceFile, literal);
        if (resolved) {
          const target = serviceForFile(workspace, resolved.path);
          if (!target || !sources.has(resolved.path)) {
            warnings.push({
              code: "IMPORT_OUTSIDE_SERVICE",
              file,
              message: `"${specifier}" at ${location.line}:${location.column} resolves to ${resolved.path}, which belongs to no service`,
            });
            continue;
          }
          const toId = fileNodeId(target, resolved.path);
          const id = edgeId("imports", fromId, toId);
          const existing = edges.get(id);
          if (existing) {
            existing.sites.push(location);
            if (resolved.confidence === "exact") existing.confidence = "exact";
          } else {
            edges.set(id, {
              id,
              kind: "imports",
              from: fromId,
              to: toId,
              confidence: resolved.confidence,
              sites: [location],
            });
          }
          continue;
        }

        const mustBeLocal =
          isRelative(specifier) ||
          /^(@\/|~\/|#)/.test(specifier) ||
          workspaceTarget(workspace, specifier) !== undefined ||
          pathsKeys.some((key) => matchesPathsKey(key, specifier));
        if (!mustBeLocal) continue;

        const unresolvedId = nodeId(
          "unresolved",
          sp.service.key,
          `${withinService(sp.service, file)}:${location.line}:${location.column}`,
        );
        nodes.push({
          id: unresolvedId,
          kind: "unresolved",
          label: specifier,
          parentId: nodeId("service", sp.service.key, ""),
          reason: "UNKNOWN_SYMBOL",
          expression: specifier,
          source: location,
        });
        const id = edgeId("imports", fromId, unresolvedId);
        edges.set(id, {
          id,
          kind: "imports",
          from: fromId,
          to: unresolvedId,
          confidence: "unresolved",
          reason: "UNKNOWN_SYMBOL",
          sites: [location],
        });
      }
    }
  }

  const sortedEdges = [...edges.values()].sort((a, b) => compareStrings(a.id, b.id));
  for (const edge of sortedEdges) {
    edge.sites.sort(
      (a, b) => compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column,
    );
  }
  return {
    nodes: nodes.sort((a, b) => compareStrings(a.id, b.id)),
    edges: sortedEdges,
    warnings,
  };
}
