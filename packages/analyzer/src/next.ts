/**
 * Next.js route detector (M1.11): `route` and `page` nodes from the file system, with
 * `handles` edges (route → handler symbol) and `renders` edges (page → component symbol).
 *
 * Applies to services that declare `next` as a dependency. The router folders are `app/` and
 * `pages/` in the service folder, or `src/app/` and `src/pages/` when neither of the first
 * two holds a source file (Next's own rule). Only Next's default page extensions count
 * (`.tsx .ts .jsx .js`, not `.d.ts`).
 *
 * Patterns handled:
 * - App router route handlers: `app/**\/route.(ts|js|tsx|jsx)` exporting `GET`, `POST`,
 *   `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS`, in any form the checker sees as an export
 *   of the module: `export function GET`, `export const GET = …`, `export const { GET, POST } =
 *   handlers`, `export { handler as GET }`, and re-exports from local files. One route per
 *   exported method. A route file that exports no method gets a `NEXT_ROUTE_NO_METHODS`
 *   warning.
 * - App router pages: `app/**\/page.(tsx|ts|jsx|js)` ⇒ a `page` node.
 * - Pages router: `pages/**` files are pages (`index` maps to its folder), except `_app`,
 *   `_document`, and `_error` at the folder root. Files under `pages/api/` are API routes:
 *   method `ALL`, unless the default-export handler compares its request's method with
 *   string literals (`req.method === "POST"`, `!==`, `switch (req.method)`, `["GET"].includes
 *   (req.method)`, also through `const { method } = req`), in which case one route per method.
 * - Path segments: `[id]` ⇒ `:id`, `[...slug]` and `[[...slug]]` ⇒ `*slug`, route groups
 *   `(group)` and parallel-route slots `@slot` are dropped. App router folders starting with
 *   `_` are private and produce nothing.
 * - Edges: the exported method (or the pages router's default export) gets a `handles` edge
 *   and the page's default export a `renders` edge, when it resolves to a symbol node with the
 *   shared call resolver (ADR-0025).
 * - Two files mapping to the same route or page (which Next rejects at build time) keep the
 *   first by path, with a `NEXT_DUPLICATE_ROUTE` warning.
 *
 * Patterns not handled:
 * - `next.config` settings: `basePath`, `pageExtensions`, `i18n`, rewrites, and redirects (v1.1).
 *   The config is never read, let alone executed.
 * - Intercepting routes (`(.)photo`, `(..)photo`, `(...)photo`): they re-render another
 *   route, so they produce no node of their own.
 * - `layout`, `template`, `loading`, `error`, `not-found`, `default`, and `middleware` files.
 * - HEAD and OPTIONS handlers that Next adds implicitly, `export *` from modules that don't
 *   resolve, and method checks in a wrapped default export (`export default withAuth(h)`),
 *   which stays `ALL`.
 * - An optional catch-all `[[...slug]]` also matches its parent path; the `*slug` pattern
 *   doesn't record that.
 */
import ts from "typescript";
import {
  compareStrings,
  edgeId,
  nodeId,
  type AnalysisWarning,
  type GraphEdge,
  type GraphNode,
  type HttpMethod,
  type SourceLocation,
} from "@gitinside/schema";
import type { CallTarget, SymbolResolver } from "./calls.js";
import { fileNodeId, withinService } from "./files.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";

/** Methods an app router `route.ts` may export, and the methods a pages API check may name. */
const METHODS: ReadonlySet<string> = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

/** Next's default `pageExtensions`. */
const PAGE_EXTENSION = /\.(tsx|ts|jsx|js)$/;

/** Pages router files at the folder root that aren't routes. */
const SPECIAL_PAGES: ReadonlySet<string> = new Set(["_app", "_document", "_error"]);

/** Which router a path is computed for; only the app router has private `_folders`. */
type RouterKind = "app" | "pages";

/**
 * The URL path for a list of folder (or file) segments, or undefined when a segment opts the
 * file out of routing (private `_folder` in the app router, intercepting route).
 */
export function segmentsToPath(
  segments: readonly string[],
  router: RouterKind,
): string | undefined {
  const parts: string[] = [];
  for (const segment of segments) {
    if (/^\((\.{1,3}|\.\.\)\(\.\.)\)/.test(segment)) return undefined;
    if (router === "app" && segment.startsWith("_")) return undefined;
    if (/^\(.*\)$/.test(segment) || segment.startsWith("@")) continue;
    const catchAll = /^\[\[?\.\.\.([^\]]+)\]\]?$/.exec(segment);
    const dynamic = /^\[([^\]]+)\]$/.exec(segment);
    if (catchAll) parts.push(`*${catchAll[1] ?? ""}`);
    else if (dynamic) parts.push(`:${dynamic[1] ?? ""}`);
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** The location of a node's first token (after any JSDoc). */
function locationOf(node: ts.Node, file: string): SourceLocation {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1, column: position.character + 1 };
}

/** The function a value expression or declaration is, following identifiers in the checker. */
function functionOf(
  checker: ts.TypeChecker,
  node: ts.Node | undefined,
  hops = 0,
): ts.SignatureDeclaration | undefined {
  if (!node || hops > 8) return undefined;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return node;
  }
  if (ts.isExportAssignment(node)) return functionOf(checker, unwrap(node.expression), hops + 1);
  if (ts.isVariableDeclaration(node)) {
    return node.initializer && functionOf(checker, unwrap(node.initializer), hops + 1);
  }
  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return functionOf(checker, symbol?.valueDeclaration, hops + 1);
  }
  return undefined;
}

/**
 * HTTP methods a pages API handler compares its request's method with, sorted; empty when
 * none are statically visible.
 */
export function checkedMethods(handler: ts.SignatureDeclaration): HttpMethod[] {
  const request = handler.parameters[0];
  const body = (handler as ts.FunctionLikeDeclaration).body;
  if (!request || !body) return [];

  // Names the request object is bound to, and names bound to its `method`.
  const requestNames = new Set<string>();
  const methodNames = new Set<string>();
  const bindPattern = (pattern: ts.ObjectBindingPattern): void => {
    for (const element of pattern.elements) {
      const property = element.propertyName ?? element.name;
      if (
        ts.isIdentifier(property) &&
        property.text === "method" &&
        ts.isIdentifier(element.name)
      ) {
        methodNames.add(element.name.text);
      }
    }
  };
  if (ts.isIdentifier(request.name)) requestNames.add(request.name.text);
  else if (ts.isObjectBindingPattern(request.name)) bindPattern(request.name);

  const isMethod = (expression: ts.Expression): boolean => {
    const e = unwrap(expression);
    if (ts.isIdentifier(e)) return methodNames.has(e.text);
    return (
      ts.isPropertyAccessExpression(e) &&
      e.name.text === "method" &&
      ts.isIdentifier(e.expression) &&
      requestNames.has(e.expression.text)
    );
  };

  const found = new Set<string>();
  const literal = (expression: ts.Expression): void => {
    const e = unwrap(expression);
    if (ts.isStringLiteralLike(e)) found.add(e.text.toUpperCase());
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      if (
        ts.isObjectBindingPattern(node.name) &&
        ts.isIdentifier(init) &&
        requestNames.has(init.text)
      ) {
        bindPattern(node.name);
      } else if (ts.isIdentifier(node.name) && isMethod(init)) {
        methodNames.add(node.name.text);
      }
    } else if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        kind === ts.SyntaxKind.EqualsEqualsToken ||
        kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        kind === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        if (isMethod(node.left)) literal(node.right);
        else if (isMethod(node.right)) literal(node.left);
      }
    } else if (ts.isSwitchStatement(node) && isMethod(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) literal(clause.expression);
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      node.arguments[0] !== undefined &&
      isMethod(node.arguments[0])
    ) {
      const list = unwrap(node.expression.expression);
      if (ts.isArrayLiteralExpression(list)) list.elements.forEach(literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return [...found].filter((m) => METHODS.has(m)).sort(compareStrings) as HttpMethod[];
}

/**
 * Detect Next.js routes and pages in every service that depends on `next` (see the file
 * comment for the patterns). Returns `route` nodes (`route:<service>/<METHOD> <path>`) and
 * `page` nodes (`page:<service>/<path>`), both parented to their file, `handles` and
 * `renders` edges, and warnings. Everything is sorted.
 */
export function buildNextRoutes(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
): { nodes: GraphNode[]; edges: GraphEdge[]; warnings: AnalysisWarning[] } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const warnings: AnalysisWarning[] = [];
  /** The file that produced each node, for duplicate warnings. */
  const owners = new Map<string, string>();

  const addNode = (node: GraphNode, file: string): boolean => {
    const owner = owners.get(node.id);
    if (owner !== undefined) {
      warnings.push({
        code: "NEXT_DUPLICATE_ROUTE",
        file,
        message: `${node.label} is also defined by ${owner}; keeping ${owner}`,
      });
      return false;
    }
    owners.set(node.id, file);
    nodes.set(node.id, node);
    return true;
  };

  const addEdge = (
    kind: "handles" | "renders",
    from: string,
    target: CallTarget | undefined,
    site: SourceLocation,
  ): void => {
    if (!target) return;
    const id = edgeId(kind, from, target.id);
    edges.set(id, { id, kind, from, to: target.id, confidence: target.confidence, sites: [site] });
  };

  for (const sp of programs) {
    const service = sp.service;
    if (!service.dependencies.includes("next")) continue;
    const checker = resolver.checkerOf(sp);
    const local = sp.rootFiles.map((file) => ({ file, rel: withinService(service, file) }));
    const atRoot = local.some(({ rel }) => rel.startsWith("app/") || rel.startsWith("pages/"));
    const base = atRoot ? "" : "src/";

    /** The module's exports by name, or an empty map for files without a module symbol. */
    const exportsOf = (sourceFile: ts.SourceFile): Map<string, ts.Symbol> => {
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      const result = new Map<string, ts.Symbol>();
      if (!moduleSymbol) return result;
      for (const symbol of checker.getExportsOfModule(moduleSymbol))
        result.set(symbol.name, symbol);
      return result;
    };

    /**
     * The symbol node an export names, and where it is declared in `file` (the file's start
     * when the declaration is elsewhere, as with `export *`).
     */
    const exportTarget = (
      symbol: ts.Symbol,
      file: string,
      sourceFile: ts.SourceFile,
    ): { target: CallTarget | undefined; site: SourceLocation } | undefined => {
      const declaration = symbol.declarations?.[0];
      if (!declaration) return undefined;
      const name = ts.getNameOfDeclaration(declaration);
      const site =
        declaration.getSourceFile() === sourceFile
          ? locationOf(name ?? declaration, file)
          : { file, line: 1, column: 1 };
      const own = resolver.callers.get(declaration.getSourceFile())?.get(declaration);
      if (own !== undefined) return { target: { id: own, confidence: "exact" }, site };
      if (ts.isExportAssignment(declaration)) {
        return { target: resolver.resolve(sp, declaration.expression), site };
      }
      return {
        target: name && ts.isIdentifier(name) ? resolver.resolve(sp, name) : undefined,
        site,
      };
    };

    const route = (
      method: HttpMethod,
      path: string,
      file: string,
      site: SourceLocation,
    ): string | undefined => {
      const label = `${method} ${path}`;
      const id = nodeId("route", service.key, label);
      const added = addNode(
        {
          id,
          kind: "route",
          label,
          parentId: fileNodeId(service, file),
          layer: "backend",
          method,
          path,
          source: site,
        },
        file,
      );
      return added ? id : undefined;
    };

    for (const { file, rel } of local) {
      if (!rel.startsWith(base) || !PAGE_EXTENSION.test(rel) || rel.endsWith(".d.ts")) continue;
      const inner = rel.slice(base.length);
      const segments = inner.replace(PAGE_EXTENSION, "").split("/");
      const router: RouterKind | undefined =
        segments[0] === "app" ? "app" : segments[0] === "pages" ? "pages" : undefined;
      if (!router || segments.length < 2) continue;
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      if (!sourceFile) continue;
      const start: SourceLocation = { file, line: 1, column: 1 };

      if (router === "app") {
        const leaf = segments[segments.length - 1];
        if (leaf !== "route" && leaf !== "page") continue;
        const path = segmentsToPath(segments.slice(1, -1), "app");
        if (path === undefined) continue;
        const exports = exportsOf(sourceFile);
        if (leaf === "page") {
          const component = exports.get("default");
          const found = component && exportTarget(component, file, sourceFile);
          const id = nodeId("page", service.key, path);
          const site = found?.site ?? start;
          const page: GraphNode = {
            id,
            kind: "page",
            label: path,
            parentId: fileNodeId(service, file),
            layer: "frontend",
            path,
            source: site,
          };
          if (addNode(page, file)) addEdge("renders", id, found?.target, site);
          continue;
        }
        const methods = [...exports.keys()]
          .filter((name) => METHODS.has(name))
          .sort(compareStrings);
        if (methods.length === 0) {
          warnings.push({
            code: "NEXT_ROUTE_NO_METHODS",
            file,
            message:
              "route handler file exports no HTTP method (GET, POST, …); no route was created",
          });
        }
        for (const method of methods) {
          const found = exportTarget(exports.get(method) as ts.Symbol, file, sourceFile);
          const site = found?.site ?? start;
          const id = route(method as HttpMethod, path, file, site);
          if (id !== undefined) addEdge("handles", id, found?.target, site);
        }
        continue;
      }

      // Pages router.
      const fileSegments = segments.slice(1);
      if (fileSegments.length === 1 && SPECIAL_PAGES.has(fileSegments[0] ?? "")) continue;
      if (fileSegments[fileSegments.length - 1] === "index") fileSegments.pop();
      const path = segmentsToPath(fileSegments, "pages");
      if (path === undefined) continue;
      const exported = exportsOf(sourceFile).get("default");
      const found = exported && exportTarget(exported, file, sourceFile);
      const site = found?.site ?? start;
      if (fileSegments[0] === "api" && segments.length > 2) {
        const declaration = exported?.declarations?.[0];
        const handler = functionOf(checker, declaration);
        const checked = handler ? checkedMethods(handler) : [];
        for (const method of checked.length > 0 ? checked : (["ALL"] as const)) {
          const id = route(method, path, file, site);
          if (id !== undefined) addEdge("handles", id, found?.target, site);
        }
        continue;
      }
      const id = nodeId("page", service.key, path);
      const page: GraphNode = {
        id,
        kind: "page",
        label: path,
        parentId: fileNodeId(service, file),
        layer: "frontend",
        path,
        source: site,
      };
      if (addNode(page, file)) addEdge("renders", id, found?.target, site);
    }
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
    edges: [...edges.values()].sort((a, b) => compareStrings(a.id, b.id)),
    warnings: warnings.sort(
      (a, b) => compareStrings(a.file ?? "", b.file ?? "") || compareStrings(a.message, b.message),
    ),
  };
}
