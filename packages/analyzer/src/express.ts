/**
 * Express route detector (M1.10): `route` nodes, `handles` edges, and `DYNAMIC_ROUTE`
 * unresolved nodes, from Express apps and routers found with the type checker.
 *
 * Two steps (ADR-0093): `collectExpressFacts` reads one service's program into plain data,
 * with every router a registration uses left as a reference; `composeExpressRoutes` decides
 * which nodes are routers and composes full paths over all services' facts, without
 * TypeScript, since a router's prefixes come from whichever files mount it.
 *
 * Patterns handled:
 * - Apps and routers: `express()`, `express.Router()`, `Router()` (named import), and the same
 *   through `require("express")`, `import * as express`, and `import express = require()`.
 * - Routes: `x.get|post|put|patch|delete|head|options|all(path, ...handlers)` (at least one
 *   handler, so `app.get("env")` is not a route) and `x.route(path).get(h).post(h)` chains.
 *   Paths are string literals, arrays of them, consts, `${CONST}` templates, and `+`
 *   concatenations of those.
 * - Mounts: `x.use(prefix?, ...routers)`, composed into full paths
 *   (`app.use("/api", r)` + `r.get("/users/:id")` ⇒ `/api/users/:id`), including nested
 *   routers, sub-apps, chained calls (`router.get(…).post(…)`), and a router mounted twice.
 * - Routers across files: ES imports and exports (named, default, re-exports), CommonJS
 *   `module.exports = router` / `exports.r = router` / inline `require("./r")`, class
 *   properties (`router = Router()`), and factory functions that return a router.
 * - Routers passed to functions: `registerRoutes(app)` binds the parameter to `app`, so
 *   `function registerRoutes(app) { app.get(…) }` composes like a mount at `""`. A parameter
 *   typed `Express`, `Application`, or `Router` (from `express`) is an app or router even when
 *   no call site is found.
 * - Handlers: each handler argument (or array of them) that names a symbol node becomes a
 *   `handles` edge, with the call resolver's confidence (ADR-0025).
 *
 * Patterns not handled:
 * - Paths that aren't static (computed strings, `RegExp`s, runtime data, loops): the route
 *   becomes an `unresolved` node with reason `DYNAMIC_ROUTE` and the path expression. The same
 *   applies to every route under a mount whose prefix isn't static.
 * - Routers never mounted on an app we can see (or mounted only inside a mount cycle): their
 *   routes keep router-relative paths and an `EXPRESS_UNMOUNTED_ROUTER` warning says so.
 * - Inline handlers (`(req, res) => …`) and wrapped handlers (`asyncHandler(fn)`) get no
 *   `handles` edge, because there is no symbol node to point at. They are returned as
 *   `inlineHandlers` instead, so the Prisma, HTTP, SDK, and queue detectors can draw their
 *   edges from the route (`owners.ts`).
 * - Routers imported from other workspace packages, routers stored in collections
 *   (`routers.forEach((r) => app.use(r))`), routers assigned in constructors without an
 *   initializer, and a shadowed `express` name.
 * - `use` prefixes that are plain identifiers which don't resolve to a static string are read
 *   as middleware, not prefixes (only literals, templates, `+`, arrays, and `process.env.*`
 *   count as path syntax).
 * - Decorator frameworks (NestJS, v1.1+), `app.param`, and `express.static` file paths.
 * - Mount graphs whose composition exceeds 20,000 steps (routers shared under several
 *   prefixes at many levels, which multiplies paths): composition stops and an
 *   `EXPRESS_ROUTE_LIMIT` warning says routes are missing.
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
import { nodeKey, type CallTarget, type SymbolResolver } from "./calls.js";
import { fileNodeId, withinService } from "./files.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";
import type { WorkspacePackage } from "./workspace.js";

/** Express route methods and the HTTP method each registers. */
const METHODS: ReadonlyMap<string, HttpMethod> = new Map([
  ["all", "ALL"],
  ["delete", "DELETE"],
  ["get", "GET"],
  ["head", "HEAD"],
  ["options", "OPTIONS"],
  ["patch", "PATCH"],
  ["post", "POST"],
  ["put", "PUT"],
]);

/** How many alias, variable, or return hops are followed before giving up. */
const MAX_HOPS = 16;

/** How many rounds of parameter binding run; each round can expose routers passed further. */
const MAX_ROUNDS = 8;

/**
 * Work budget for mount composition (router visits + route paths emitted). Composition
 * enumerates every path through the mount graph, which is exponential when routers are
 * shared under several prefixes at every level; past the budget it stops with an
 * `EXPRESS_ROUTE_LIMIT` warning. Real apps use a few thousand at most.
 */
const MAX_COMPOSITION_STEPS = 20_000;

/** What a local name is bound to: the `express` module itself, or one of its named exports. */
type ExpressRole = "module" | "Router" | "Express" | "Application";

const NAMED_ROLES: ReadonlySet<string> = new Set(["Router", "Express", "Application"]);

/** Where a router is: its node key (see `nodeKey`), file, and position. */
export interface RouterSite {
  key: string;
  file: string;
  location: SourceLocation;
}

/** An app or router created with `express` (or a parameter typed as one) in a service's files. */
export interface RouterCreation extends RouterSite {
  kind: "app" | "router";
}

/**
 * The router an expression stands for, decided once every router is known: the node `key`
 * if it is a router, else the first of `then` that is one (a chained call's receiver, or the
 * values a factory function returns). Only nodes that can become routers (creation calls and
 * parameters) keep a `key`, and references that can never reach one are left out.
 */
export interface RouterRef {
  key?: string;
  then?: RouterRef[];
}

/** An argument passed to a function parameter, which becomes a router if the argument is one. */
export interface ParameterBinding {
  argument: RouterRef;
  parameter: RouterSite;
  /** Where the argument is (part of the mount's key). */
  site: SourceLocation;
}

/** One handler argument of a route. */
export interface HandlerFact {
  site: SourceLocation;
  /** Node keys of the inline functions the handler is (see `inlineFunctions`). */
  inline: string[];
  /** The symbol node it names, if any. */
  target?: CallTarget;
}

/** One route registration: a method, its router-relative path(s), and its handlers. */
export interface RouteFact {
  type: "route";
  /** The router it registers on. */
  router: RouterRef;
  method: HttpMethod;
  /** Static paths, absent when the path expression isn't static. */
  paths?: string[];
  /** Source text of the path expression. */
  pathText: string;
  /** Where the method name is (the route's `source`). */
  site: SourceLocation;
  /** Where the path expression is (the unresolved node's ID and `source`). */
  pathSite: SourceLocation;
  file: string;
  /** Its handlers; empty when the paths aren't static (a dynamic route has no edges). */
  handlers: HandlerFact[];
}

/** One `x.use(prefix?, ...children)` call. */
export interface UseFact {
  type: "use";
  /** The router it mounts on. */
  router: RouterRef;
  /** Static prefixes (`[""]` without a prefix), absent when the prefix isn't static. */
  prefixes?: string[];
  prefixText: string;
  /** Where the call is (part of the mount's key). */
  site: SourceLocation;
  children: RouterRef[];
}

/**
 * What one service's program says about Express, as plain data (ADR-0090): routers created
 * in its files, and its route registrations, mounts, and parameter bindings with the routers
 * they use left as {@link RouterRef}s. Which nodes are routers, and so every full path, is
 * decided by {@link composeExpressRoutes} over all services' facts, since a router can be
 * mounted, or passed to a function, from another service's files.
 */
export interface ExpressFacts {
  /** Key of the service whose program found these. */
  service: string;
  creations: RouterCreation[];
  /**
   * False when the repo had no routers, so only `creations` were collected (the rest would be
   * wasted checker work). Facts collected that way are stale once any service creates one.
   */
  scanned: boolean;
  bindings: ParameterBinding[];
  /** Routes and `use` calls, in source order. */
  registrations: (RouteFact | UseFact)[];
}

/** Express routes of the whole repo, from {@link composeExpressRoutes}. */
export interface ExpressRoutes {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: AnalysisWarning[];
  /**
   * The sorted IDs of the routes each inline handler function serves, by the function's node
   * key; other detectors' owners are bound to them with `bindOwners` (`owners.ts`).
   */
  inlineHandlers: Map<string, string[]>;
}

/** An app (`express()`) or a router (`Router()`, or a parameter bound to one). */
interface RouterObject {
  key: string;
  kind: "app" | "router";
  /** The service whose program has the router's file as a root (its routes' ID prefix). */
  service: string;
  file: string;
  location: SourceLocation;
  routes: RouteRecord[];
  mounts: Mount[];
  mounted: boolean;
}

/** A route registration and the service whose program found it. */
interface RouteRecord {
  fact: RouteFact;
  service: WorkspacePackage;
}

/** A child router reachable from a parent under some prefix(es). */
interface Mount {
  child: RouterObject;
  /** Static prefixes, or undefined when the prefix expression isn't static. */
  prefixes: string[] | undefined;
  prefixText: string;
  key: string;
}

/** Where routes under a router end up: a static path, or the source text of a dynamic one. */
type Base = { path: string } | { dynamic: string };

function isExpressSpecifier(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isStringLiteralLike(node) && node.text === "express";
}

function isRequireCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    node.arguments[0] !== undefined &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

function isRequireExpress(expression: ts.Expression): boolean {
  const e = unwrap(expression);
  return isRequireCall(e) && isExpressSpecifier(e.arguments[0]);
}

/** Local names bound to `express` by a file's top-level imports and requires. */
function expressBindings(sourceFile: ts.SourceFile): Map<string, ExpressRole> {
  const bindings = new Map<string, ExpressRole>();
  const named = (imported: string, local: string): void => {
    if (NAMED_ROLES.has(imported)) bindings.set(local, imported as ExpressRole);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && isExpressSpecifier(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.name) bindings.set(clause.name.text, "module");
      const bound = clause?.namedBindings;
      if (bound && ts.isNamespaceImport(bound)) bindings.set(bound.name.text, "module");
      else if (bound) {
        for (const element of bound.elements) {
          named((element.propertyName ?? element.name).text, element.name.text);
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      isExpressSpecifier(statement.moduleReference.expression)
    ) {
      bindings.set(statement.name.text, "module");
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer && unwrap(declaration.initializer);
        if (!init) continue;
        const name = declaration.name;
        if (isRequireExpress(init)) {
          if (ts.isIdentifier(name)) bindings.set(name.text, "module");
          else if (ts.isObjectBindingPattern(name)) {
            for (const element of name.elements) {
              const imported = element.propertyName ?? element.name;
              if (ts.isIdentifier(imported) && ts.isIdentifier(element.name)) {
                named(imported.text, element.name.text);
              }
            }
          }
        } else if (
          ts.isPropertyAccessExpression(init) &&
          isRequireExpress(init.expression) &&
          ts.isIdentifier(name)
        ) {
          named(init.name.text, name.text);
        }
      }
    }
  }
  return bindings;
}

/** `app` or `router` when a call creates one with the file's `express` bindings. */
function creationKind(
  node: ts.CallExpression | ts.NewExpression,
  bindings: ReadonlyMap<string, ExpressRole>,
): "app" | "router" | undefined {
  const callee = unwrap(node.expression);
  if (ts.isIdentifier(callee)) {
    const role = bindings.get(callee.text);
    if (role === "module") return "app";
    return role === "Router" ? "router" : undefined;
  }
  if (isRequireExpress(callee)) return "app";
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "Router") {
    const object = unwrap(callee.expression);
    const isModule =
      (ts.isIdentifier(object) && bindings.get(object.text) === "module") ||
      isRequireExpress(object);
    return isModule ? "router" : undefined;
  }
  return undefined;
}

/** `app` or `router` for a parameter typed `Express`/`Application`/`Router` from `express`. */
function typeKind(
  type: ts.TypeNode | undefined,
  bindings: ReadonlyMap<string, ExpressRole>,
): "app" | "router" | undefined {
  if (!type || !ts.isTypeReferenceNode(type)) return undefined;
  const typeName = type.typeName;
  let name: string | undefined;
  if (ts.isIdentifier(typeName)) {
    const role = bindings.get(typeName.text);
    name = role === "module" ? undefined : role;
  } else if (ts.isIdentifier(typeName.left) && bindings.get(typeName.left.text) === "module") {
    name = typeName.right.text;
  }
  if (name === "Router") return "router";
  return name === "Express" || name === "Application" ? "app" : undefined;
}

/** A function-like node with a body, whose returns can be followed. */
export type FunctionWithBody =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

/** True for function declarations, expressions, arrows, and methods that have a body. */
export function isFunctionWithBody(node: ts.Node): node is FunctionWithBody {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)) &&
    node.body !== undefined
  );
}

/** The expressions a function returns, not counting nested functions. */
export function returnedExpressions(fn: FunctionWithBody): ts.Expression[] {
  const body = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const results: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return results;
}

/** True for expressions that can only be a `use` prefix, never a router or middleware. */
function isPathSyntax(expression: ts.Expression): boolean {
  const e = unwrap(expression);
  if (
    ts.isStringLiteralLike(e) ||
    ts.isTemplateExpression(e) ||
    ts.isArrayLiteralExpression(e) ||
    ts.isRegularExpressionLiteral(e) ||
    (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken)
  ) {
    return true;
  }
  // `process.env.PREFIX`
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    ts.isIdentifier(e.expression.expression) &&
    e.expression.expression.text === "process" &&
    e.expression.name.text === "env"
  );
}

/** Join a mount prefix and a path into one normalized path: one `/` between, none trailing. */
export function joinPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

/**
 * The inline functions a handler argument is: `(req, res) => …` itself, or the function
 * arguments of a one-level wrapper call (`asyncHandler(async (req, res) => …)`).
 */
function inlineFunctions(handler: ts.Expression): ts.Node[] {
  const e = unwrap(handler);
  const isInline = (x: ts.Expression): boolean => {
    const u = unwrap(x);
    return ts.isArrowFunction(u) || ts.isFunctionExpression(u);
  };
  if (isInline(e)) return [e];
  return ts.isCallExpression(e) ? e.arguments.filter(isInline).map(unwrap) : [];
}

function locationOf(node: ts.Node, file: string): SourceLocation {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1, column: position.character + 1 };
}

function compareLocations(a: SourceLocation, b: SourceLocation): number {
  return compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;
}

/** A service program's root source files that it has parsed. */
function rootSources(sp: ServiceProgram): { file: string; sourceFile: ts.SourceFile }[] {
  const files: { file: string; sourceFile: ts.SourceFile }[] = [];
  for (const file of sp.rootFiles) {
    const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
    if (sourceFile) files.push({ file, sourceFile });
  }
  return files;
}

/** Where a node is, with its node key, when its file is in the repo. */
function routerSite(sp: ServiceProgram, node: ts.Node): RouterSite | undefined {
  const file = sp.toRepoPath(node.getSourceFile().fileName);
  if (file === undefined) return undefined;
  return { key: nodeKey(file, node), file, location: locationOf(node, file) };
}

/**
 * The apps and routers created with `express` in a service's root files, and parameters typed
 * as one, in source order. Syntax only, so it's cheap: a repo where no service has any needs
 * no other Express facts.
 */
export function routerCreations(sp: ServiceProgram): RouterCreation[] {
  const creations: RouterCreation[] = [];
  for (const { sourceFile } of rootSources(sp)) {
    const bindings = expressBindings(sourceFile);
    if (bindings.size === 0) continue;
    const add = (node: ts.Node, kind: "app" | "router" | undefined): void => {
      const site = kind && routerSite(sp, node);
      if (kind && site) creations.push({ ...site, kind });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        add(node, creationKind(node, bindings));
      } else if (ts.isParameter(node)) {
        add(node, typeKind(node.type, bindings));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return creations;
}

/**
 * Collect one service's {@link ExpressFacts} with its program (see the file comment for the
 * patterns). `repoHasRouters` is whether any service has {@link routerCreations}; without
 * one, nothing else can be a route, so only the creations are collected.
 */
export function collectExpressFacts(
  sp: ServiceProgram,
  resolver: SymbolResolver,
  repoHasRouters: boolean,
): ExpressFacts {
  const facts: ExpressFacts = {
    service: sp.service.key,
    creations: routerCreations(sp),
    scanned: repoHasRouters,
    bindings: [],
    registrations: [],
  };
  if (!repoHasRouters) return facts;
  const files = rootSources(sp);
  const forEachNode = (callback: (file: string, node: ts.Node) => void) => {
    for (const { file, sourceFile } of files) {
      const visit = (node: ts.Node): void => {
        callback(file, node);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  };
  const bindingsByFile = new Map<ts.SourceFile, Map<string, ExpressRole>>();
  /** True for nodes that may be routers: creation calls and parameters (typed or bound). */
  const mayBeRouter = (node: ts.Node): boolean => {
    if (ts.isParameter(node)) return true;
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
    const sourceFile = node.getSourceFile();
    let bindings = bindingsByFile.get(sourceFile);
    if (!bindings) {
      bindings = expressBindings(sourceFile);
      bindingsByFile.set(sourceFile, bindings);
    }
    return bindings.size > 0 && creationKind(node, bindings) !== undefined;
  };

  /** The value an expression evaluates to: the initializer, function, or parameter it names. */
  const valueOf = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): ts.Node | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const checker = resolver.checkerOf(sp);
    const e = unwrap(expression);
    if (isRequireCall(e)) {
      const specifier = e.arguments[0];
      const moduleSymbol = specifier && checker.getSymbolAtLocation(specifier);
      // What `require` returns: the module's `module.exports = …` / `export = …` value.
      const target = moduleSymbol?.exports?.get(ts.InternalSymbolName.ExportEquals);
      return target && valueOfSymbol(sp, target, hops + 1);
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const symbol = checker.getSymbolAtLocation(ts.isIdentifier(e) ? e : e.name);
      return symbol && valueOfSymbol(sp, symbol, hops + 1);
    }
    return e;
  };

  const valueOfSymbol = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): ts.Node | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const checker = resolver.checkerOf(sp);
    const symbol = start.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(start) : start;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return undefined;
    if (ts.isParameter(declaration) || isFunctionWithBody(declaration)) return declaration;
    if (
      (ts.isVariableDeclaration(declaration) ||
        ts.isPropertyAssignment(declaration) ||
        ts.isPropertyDeclaration(declaration)) &&
      declaration.initializer
    ) {
      return valueOf(sp, declaration.initializer, hops + 1);
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = checker.getShorthandAssignmentValueSymbol(declaration);
      return value && valueOfSymbol(sp, value, hops + 1);
    }
    if (ts.isExportAssignment(declaration)) return valueOf(sp, declaration.expression, hops + 1);
    // CommonJS: `module.exports = x` and `exports.x = y` declare on the assignment.
    if (ts.isBinaryExpression(declaration)) return valueOf(sp, declaration.right, hops + 1);
    const parent = declaration.parent as ts.Node | undefined;
    if (
      ts.isPropertyAccessExpression(declaration) &&
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === declaration
    ) {
      return valueOf(sp, parent.right, hops + 1);
    }
    return undefined;
  };

  /** What router an expression may refer to (see {@link RouterRef}). */
  const refOf = (expression: ts.Expression, hops = 0): RouterRef | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const value = valueOf(sp, expression, hops);
    if (!value) return undefined;
    const key = mayBeRouter(value) ? routerSite(sp, value)?.key : undefined;
    const then: RouterRef[] = [];
    if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
      const callee = unwrap(value.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        (METHODS.has(callee.name.text) || callee.name.text === "use")
      ) {
        // `router.get(…)` and `router.use(…)` return the router, so chained calls keep it.
        const ref = refOf(callee.expression, hops + 1);
        if (ref) then.push(ref);
      } else {
        // A factory function that returns a router.
        const fn = valueOf(sp, value.expression, hops + 1);
        if (fn && isFunctionWithBody(fn)) {
          for (const returned of returnedExpressions(fn)) {
            const ref = refOf(returned, hops + 2);
            if (ref) then.push(ref);
          }
        }
      }
    }
    if (key === undefined && then.length === 0) return undefined;
    return { ...(key === undefined ? {} : { key }), ...(then.length > 0 ? { then } : {}) };
  };

  /** Static path strings for a path expression, or undefined when it isn't static. */
  const staticPaths = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops = 0,
  ): string[] | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    const single = (x: ts.Expression): string | undefined => {
      const paths = staticPaths(sp, x, hops + 1);
      return paths?.length === 1 ? paths[0] : undefined;
    };
    if (ts.isStringLiteralLike(e)) return [e.text];
    if (ts.isArrayLiteralExpression(e)) {
      const all: string[] = [];
      for (const element of e.elements) {
        const paths = staticPaths(sp, element, hops + 1);
        if (!paths) return undefined;
        all.push(...paths);
      }
      return all;
    }
    if (ts.isTemplateExpression(e)) {
      let text = e.head.text;
      for (const span of e.templateSpans) {
        const value = single(span.expression);
        if (value === undefined) return undefined;
        text += value + span.literal.text;
      }
      return [text];
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = single(e.left);
      const right = single(e.right);
      return left === undefined || right === undefined ? undefined : [left + right];
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const checker = resolver.checkerOf(sp);
      let symbol = checker.getSymbolAtLocation(ts.isIdentifier(e) ? e : e.name);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.valueDeclaration;
      const isConst =
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
      const initializer =
        declaration && (isConst || ts.isPropertyAssignment(declaration))
          ? (declaration as ts.VariableDeclaration | ts.PropertyAssignment).initializer
          : undefined;
      return initializer ? staticPaths(sp, initializer, hops + 1) : undefined;
    }
    return undefined;
  };

  // Arguments that may bind function parameters to routers.
  forEachNode((file, node) => {
    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
    const fn = valueOf(sp, node.expression, 0);
    if (!fn || !isFunctionWithBody(fn)) return;
    node.arguments.forEach((argument, index) => {
      const parameter = fn.parameters[index];
      if (!parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return;
      if (node.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return;
      const ref = refOf(argument);
      const site = ref && routerSite(sp, parameter);
      if (ref && site) {
        facts.bindings.push({ argument: ref, parameter: site, site: locationOf(argument, file) });
      }
    });
  });

  // Routes and mounts.
  forEachNode((file, node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) return;
    const name = callee.name.text;
    const method = METHODS.get(name);
    if (method) {
      let base = unwrap(callee.expression);
      while (ts.isCallExpression(base)) {
        const inner = unwrap(base.expression);
        if (!ts.isPropertyAccessExpression(inner) || !METHODS.has(inner.name.text)) break;
        base = unwrap(inner.expression);
      }
      const baseCallee = ts.isCallExpression(base) ? unwrap(base.expression) : undefined;
      let router: RouterRef | undefined;
      let pathArg: ts.Expression | undefined;
      let handlers: readonly ts.Expression[];
      if (
        ts.isCallExpression(base) &&
        baseCallee &&
        ts.isPropertyAccessExpression(baseCallee) &&
        baseCallee.name.text === "route" &&
        base.arguments[0] !== undefined
      ) {
        // `router.route(path).get(h).post(h)`
        router = refOf(baseCallee.expression);
        pathArg = base.arguments[0];
        handlers = node.arguments;
        if (handlers.length === 0) return;
      } else {
        if (node.arguments.length < 2) return;
        router = refOf(callee.expression);
        pathArg = node.arguments[0];
        handlers = node.arguments.slice(1);
      }
      if (!router || !pathArg) return;
      const paths = staticPaths(sp, pathArg);
      facts.registrations.push({
        type: "route",
        router,
        method,
        ...(paths === undefined ? {} : { paths }),
        pathText: pathArg.getText(),
        site: locationOf(callee.name, file),
        pathSite: locationOf(pathArg, file),
        file,
        // A dynamic path is drawn without edges, so its handlers aren't resolved.
        handlers:
          paths === undefined
            ? []
            : handlers
                .flatMap((h) => {
                  const e = unwrap(h);
                  return ts.isArrayLiteralExpression(e) ? [...e.elements] : [h];
                })
                .map((handler) => {
                  const target = resolver.resolve(sp, handler);
                  return {
                    site: locationOf(handler, file),
                    inline: inlineFunctions(handler).map((fn) => nodeKey(file, fn)),
                    ...(target ? { target } : {}),
                  };
                }),
      });
    } else if (name === "use") {
      const first = node.arguments[0];
      const router = first && refOf(callee.expression);
      if (!first || !router) return;
      const prefixes = staticPaths(sp, first);
      const hasPrefix = prefixes !== undefined || isPathSyntax(first);
      const resolved = hasPrefix ? prefixes : [""];
      facts.registrations.push({
        type: "use",
        router,
        ...(resolved === undefined ? {} : { prefixes: resolved }),
        prefixText: hasPrefix ? first.getText() : "",
        site: locationOf(node, file),
        children: node.arguments
          .slice(hasPrefix ? 1 : 0)
          .flatMap((argument) => refOf(argument) ?? []),
      });
    }
  });
  return facts;
}

/**
 * The service key of the program each root file belongs to, from `ServiceProgram.rootFiles`
 * (or `programRootFiles` without programs). Input to {@link composeExpressRoutes}.
 */
export function rootFileServices(programs: readonly ServiceProgram[]): Map<string, string> {
  const services = new Map<string, string>();
  for (const sp of programs) for (const file of sp.rootFiles) services.set(file, sp.service.key);
  return services;
}

/**
 * Express routes from every service's {@link ExpressFacts}, in program order: decide which
 * nodes are routers (creations, then parameters bound to one, until nothing new appears),
 * attach registrations to them, and walk the mounts from every router nothing mounts.
 * Returns `route` nodes (parented to the declaring file, ID `route:<service>/<METHOD> <path>`
 * where the service is the root app's), `handles` edges (route → handler symbol),
 * `DYNAMIC_ROUTE` unresolved nodes, and warnings. Everything is sorted.
 *
 * `services` must include every service named in the facts, and `rootFiles` is
 * {@link rootFileServices}.
 */
export function composeExpressRoutes(
  facts: readonly ExpressFacts[],
  services: readonly WorkspacePackage[],
  rootFiles: ReadonlyMap<string, string>,
): ExpressRoutes {
  const byKey = new Map(services.map((s) => [s.key, s]));
  const serviceOf = (key: string): WorkspacePackage => {
    const service = byKey.get(key);
    if (!service) throw new Error(`Express facts name an unknown service: ${key}`);
    return service;
  };
  const inlineHandlers = new Map<string, string[]>();
  const routers = new Map<string, RouterObject>();

  const addRouter = (
    site: RouterSite,
    kind: "app" | "router",
    from: ExpressFacts,
  ): RouterObject => {
    const existing = routers.get(site.key);
    if (existing) return existing;
    const router: RouterObject = {
      key: site.key,
      kind,
      service: rootFiles.get(site.file) ?? from.service,
      file: site.file,
      location: site.location,
      routes: [],
      mounts: [],
      mounted: false,
    };
    routers.set(site.key, router);
    return router;
  };
  const routerOf = (ref: RouterRef): RouterObject | undefined => {
    const known = ref.key === undefined ? undefined : routers.get(ref.key);
    if (known) return known;
    for (const next of ref.then ?? []) {
      const router = routerOf(next);
      if (router) return router;
    }
    return undefined;
  };

  // Pass 1: apps and routers created with `express`, and parameters typed as one.
  for (const f of facts) for (const creation of f.creations) addRouter(creation, creation.kind, f);
  if (routers.size === 0) return { nodes: [], edges: [], warnings: [], inlineHandlers };

  // Pass 2: bind function parameters to the routers passed in, until nothing new appears.
  const mountKeys = new Set<string>();
  const addMount = (parent: RouterObject, mount: Mount): void => {
    if (mountKeys.has(mount.key)) return;
    mountKeys.add(mount.key);
    parent.mounts.push(mount);
    mount.child.mounted = true;
  };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const before = routers.size;
    for (const f of facts) {
      for (const binding of f.bindings) {
        const router = routerOf(binding.argument);
        if (!router) continue;
        const bound = addRouter(binding.parameter, "router", f);
        if (bound === router) continue;
        const site = binding.site;
        addMount(router, {
          child: bound,
          prefixes: [""],
          prefixText: "",
          key: `${router.key}->${bound.key}@${site.file}:${site.line}:${site.column}`,
        });
      }
    }
    if (routers.size === before) break;
  }

  // Pass 3: routes and mounts.
  for (const f of facts) {
    const service = serviceOf(f.service);
    for (const registration of f.registrations) {
      const router = routerOf(registration.router);
      if (!router) continue;
      if (registration.type === "route") {
        router.routes.push({ fact: registration, service });
        continue;
      }
      const site = registration.site;
      for (const ref of registration.children) {
        const child = routerOf(ref);
        if (!child || child === router) continue;
        addMount(router, {
          child,
          prefixes: registration.prefixes,
          prefixText: registration.prefixText,
          key: `${router.key}->${child.key}@${site.file}:${site.line}:${site.column}`,
        });
      }
    }
  }

  // Compose: walk from every router nothing mounts, emitting routes under each base path.
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const warnings: AnalysisWarning[] = [];
  const keep = (node: GraphNode): void => {
    const existing = nodes.get(node.id);
    if (
      !existing ||
      (node.source && existing.source && compareLocations(node.source, existing.source) < 0)
    ) {
      nodes.set(node.id, node);
    }
  };

  let steps = 0;
  /** Count one unit of composition work; false (after one warning) once the budget is spent. */
  const spend = (): boolean => {
    steps++;
    if (steps <= MAX_COMPOSITION_STEPS) return true;
    if (steps === MAX_COMPOSITION_STEPS + 1) {
      warnings.push({
        code: "EXPRESS_ROUTE_LIMIT",
        message: `mount composition stopped after ${MAX_COMPOSITION_STEPS} steps (routers shared under many prefixes); some Express routes are missing`,
      });
    }
    return false;
  };

  const emit = ({ fact: route, service }: RouteRecord, base: Base, rootService: string): void => {
    if (route.paths === undefined || "dynamic" in base) {
      const parts = [
        "dynamic" in base ? base.dynamic : base.path,
        route.paths?.length === 1 ? route.paths[0] : route.pathText,
      ].filter((p) => p !== "" && p !== "/");
      const expression = `${route.method} ${parts.join(" + ")}`;
      const id = nodeId(
        "unresolved",
        service.key,
        `${withinService(service, route.file)}:${route.pathSite.line}:${route.pathSite.column}`,
      );
      const existing = nodes.get(id);
      if (existing?.kind === "unresolved" && compareStrings(existing.expression, expression) <= 0) {
        return;
      }
      nodes.set(id, {
        id,
        kind: "unresolved",
        label: expression,
        parentId: nodeId("service", service.key, ""),
        reason: "DYNAMIC_ROUTE",
        expression,
        source: { ...route.pathSite },
      });
      return;
    }
    for (const local of route.paths) {
      if (!spend()) return;
      const path = joinPath(base.path, local);
      const label = `${route.method} ${path}`;
      const id = nodeId("route", rootService, label);
      keep({
        id,
        kind: "route",
        label,
        parentId: fileNodeId(service, route.file),
        layer: "backend",
        method: route.method,
        path,
        source: { ...route.site },
      });
      for (const handler of route.handlers) {
        for (const fn of handler.inline) {
          const ids = inlineHandlers.get(fn) ?? [];
          if (!ids.includes(id)) ids.push(id);
          inlineHandlers.set(fn, ids);
        }
        const target = handler.target;
        if (!target) continue;
        const site = { ...handler.site };
        const edge = edgeId("handles", id, target.id);
        const existing = edges.get(edge);
        if (!existing) {
          edges.set(edge, {
            id: edge,
            kind: "handles",
            from: id,
            to: target.id,
            confidence: target.confidence,
            sites: [site],
          });
          continue;
        }
        if (target.confidence === "exact") existing.confidence = "exact";
        if (!existing.sites.some((s) => compareLocations(s, site) === 0)) existing.sites.push(site);
      }
    }
  };

  const visited = new Set<RouterObject>();
  const walk = (router: RouterObject, base: Base, root: string, stack: Set<RouterObject>): void => {
    if (stack.has(router) || !spend()) return;
    stack.add(router);
    visited.add(router);
    for (const route of router.routes) emit(route, base, root);
    for (const mount of router.mounts) {
      const bases: Base[] =
        mount.prefixes === undefined
          ? [
              {
                dynamic: ["dynamic" in base ? base.dynamic : base.path, mount.prefixText]
                  .filter((p) => p !== "" && p !== "/")
                  .join(" + "),
              },
            ]
          : mount.prefixes.map((prefix) =>
              "dynamic" in base
                ? { dynamic: `${base.dynamic} + ${prefix}` }
                : { path: joinPath(base.path, prefix) },
            );
      for (const next of bases) walk(mount.child, next, root, stack);
    }
    stack.delete(router);
  };

  const start = (root: RouterObject): void => {
    const reachable = root.routes.length + root.mounts.length;
    if (root.kind === "router" && reachable > 0) {
      warnings.push({
        code: "EXPRESS_UNMOUNTED_ROUTER",
        file: root.file,
        message: `router at ${root.location.line}:${root.location.column} is never mounted on an app; its routes use paths relative to the router`,
      });
    }
    walk(root, { path: "/" }, root.service, new Set());
  };
  const ordered = [...routers.values()].sort((a, b) => compareLocations(a.location, b.location));
  for (const router of ordered) if (!router.mounted) start(router);
  // Routers mounted only inside a mount cycle have no root; start from the first one seen.
  for (const router of ordered) if (!visited.has(router)) start(router);

  const sortedEdges = [...edges.values()].sort((a, b) => compareStrings(a.id, b.id));
  for (const edge of sortedEdges) edge.sites.sort(compareLocations);
  for (const ids of inlineHandlers.values()) ids.sort(compareStrings);
  return {
    inlineHandlers,
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
    edges: sortedEdges,
    warnings: warnings.sort(
      (a, b) => compareStrings(a.file ?? "", b.file ?? "") || compareStrings(a.message, b.message),
    ),
  };
}

/**
 * Detect Express routes in every service program: {@link collectExpressFacts} per program,
 * then {@link composeExpressRoutes}.
 */
export function buildExpressRoutes(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
): ExpressRoutes {
  const hasRouters = programs.some((sp) => routerCreations(sp).length > 0);
  return composeExpressRoutes(
    programs.map((sp) => collectExpressFacts(sp, resolver, hasRouters)),
    programs.map((sp) => sp.service),
    rootFileServices(programs),
  );
}
