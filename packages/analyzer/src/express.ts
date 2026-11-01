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
 * - Class properties declared without a value and assigned once in the constructor
 *   (`app: Application;` + `this.app = express()`): the service's files must write the
 *   property exactly once, with a plain `=` on `this` as a statement of the constructor body.
 * - Routers passed to functions: `registerRoutes(app)` binds the parameter to `app`, so
 *   `function registerRoutes(app) { app.get(…) }` composes like a mount at `""`. A parameter
 *   typed `Express`, `Application`, or `Router` (from `express`) is an app or router even when
 *   no call site is found.
 * - Handlers: each handler argument (or array of them) that names a symbol node becomes a
 *   `handles` edge, with the call resolver's confidence (ADR-0025).
 * - Routers loaded from a folder listing (ADR-0162): `fs.readdirSync(dir)` or
 *   `glob.sync(pattern, { cwd: dir })` (`glob`, `fast-glob`), optionally through `.filter`,
 *   `.sort`, and `.map(require)` / `.map((f) => require(…))`, then mounted in
 *   `.forEach((f) => app.use(…))`, `.reduce((r, x) => r.use(x), Router())`, or
 *   `for (const f of list) app.use(…)`. The folder must be a repo path (`__dirname`,
 *   `path.join`/`resolve`, templates, `+`, consts; `a ? b : c` lists both). The listing is
 *   computed from the service's own root files and each listed file's export
 *   (`module.exports`, or `require(f).default`) is mounted; prefixes may use the file name
 *   (`path.basename`, string `replace`/`slice`). Filters aren't evaluated, so a route reached
 *   only this way is listed in `listedRoutes` and matched at `heuristic` at best.
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
 *   (`routers.forEach((r) => app.use(r))`), and a shadowed `express` name.
 * - Class properties without a value written more than once, outside the constructor's own
 *   statements (a branch, a method, a callback), from another service's files, or by
 *   destructuring (`({ app: this.app } = x)` isn't seen as a write); static properties.
 * - Listings whose folder isn't a repo path (`process.env.DIR`, `process.cwd()`, a glob with
 *   no `cwd`), `readdirSync` with `withFileTypes`, glob syntax beyond `*`, `**`, `?`, and
 *   `{a,b}`, async listings (`readdir`, `await glob(…)`), files in another service, and
 *   prefixes computed by other calls (those routes become `DYNAMIC_ROUTE`).
 * - `use` prefixes that are plain identifiers which don't resolve to a static string are read
 *   as middleware, not prefixes (only literals, templates, `+`, arrays, and `process.env.*`
 *   count as path syntax).
 * - Decorator frameworks (NestJS, v1.1+), `app.param`, and `express.static` file paths.
 * - Mount graphs whose composition exceeds 20,000 steps (routers shared under several
 *   prefixes at many levels, which multiplies paths): composition stops and an
 *   `EXPRESS_ROUTE_LIMIT` warning says routes are missing.
 */
import { posix } from "node:path";
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
import {
  REPO_ROOT,
  absoluteFolder,
  globEntries,
  readdirEntries,
  repoPathOf,
  resolveRequire,
} from "./listings.js";
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
  /** Set when the children were read from a folder listing (ADR-0162). */
  listed?: true;
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
  /**
   * The sorted IDs of routes reached only through a mount read from a folder listing
   * (ADR-0162): the route matcher links requests to them at `heuristic` at best.
   */
  listedRoutes: string[];
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
  /** True when the child was read from a folder listing. */
  listed: boolean;
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

/**
 * The initial value of `list.reduce(callback, initial)` when every value the callback returns
 * is its accumulator, or a `use`/route call chained on it (`(r, x) => r.use(x)`), so the
 * reduction evaluates to `initial`; else undefined.
 */
function reducedOnto(call: ts.CallExpression): ts.Expression | undefined {
  const callee = unwrap(call.expression);
  const [callback, initial] = call.arguments;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "reduce") return undefined;
  if (!callback || !initial) return undefined;
  const fn = unwrap(callback);
  const accumulator = isFunctionWithBody(fn) ? fn.parameters[0]?.name : undefined;
  if (!accumulator || !ts.isIdentifier(accumulator) || !isFunctionWithBody(fn)) return undefined;
  const returned = returnedExpressions(fn);
  const onAccumulator = (expression: ts.Expression): boolean => {
    let e = unwrap(expression);
    while (ts.isCallExpression(e)) {
      const inner = unwrap(e.expression);
      if (!ts.isPropertyAccessExpression(inner)) return false;
      if (inner.name.text !== "use" && !METHODS.has(inner.name.text)) return false;
      e = unwrap(inner.expression);
    }
    return ts.isIdentifier(e) && e.text === accumulator.text;
  };
  return returned.length > 0 && returned.every(onAccumulator) ? initial : undefined;
}

/** The folder of a repo file (`""` at the root). */
function folderOf(file: string): string {
  const folder = posix.dirname(file);
  return folder === "." ? "" : folder;
}

/** Modules whose `readdirSync` lists a folder, and whose `sync`/`globSync` expand a glob. */
const FS_MODULES: ReadonlySet<string> = new Set(["fs", "node:fs", "fs-extra"]);
const GLOB_MODULES: ReadonlySet<string> = new Set(["glob", "fast-glob"]);
const GLOB_FUNCTIONS: ReadonlySet<string> = new Set(["sync", "globSync"]);

/** At most this many alternative values are kept for one expression (`a ? "ts" : "js"`). */
const MAX_ALTERNATIVES = 8;

/** The module's own value (`require(f)` itself), as opposed to one of its named exports. */
const MODULE_VALUE = ts.InternalSymbolName.ExportEquals as string;

/**
 * A value while reading a folder-listing loop (ADR-0162): a string (a listed name or a path
 * built from it), a repo file's module (`require(path)`), or a router reference.
 */
type Listed = { text: string } | { module: string } | { ref: RouterRef };

function isText(value: Listed): value is { text: string } {
  return "text" in value;
}

/** Every way of joining one value from each list, or undefined past {@link MAX_ALTERNATIVES}. */
function combinations(lists: readonly string[][]): string[][] | undefined {
  let out: string[][] = [[]];
  for (const list of lists) {
    out = out.flatMap((prefix) => list.map((value) => [...prefix, value]));
    if (out.length > MAX_ALTERNATIVES) return undefined;
  }
  return out;
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

  /** Left sides of the assignments to a property name (`x.p = …`, `x["p"] ??= …`), by name. */
  let propertyWrites: Map<string, ts.Expression[]> | undefined;
  const writesTo = (name: string): readonly ts.Expression[] => {
    if (!propertyWrites) {
      const writes = new Map<string, ts.Expression[]>();
      forEachNode((_, node) => {
        if (
          !ts.isBinaryExpression(node) ||
          node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
          node.operatorToken.kind > ts.SyntaxKind.LastAssignment
        ) {
          return;
        }
        const left = unwrap(node.left);
        const written = ts.isPropertyAccessExpression(left)
          ? left.name.text
          : ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression)
            ? left.argumentExpression.text
            : undefined;
        if (written !== undefined) writes.set(written, [...(writes.get(written) ?? []), left]);
      });
      propertyWrites = writes;
    }
    return propertyWrites.get(name) ?? [];
  };

  /**
   * The value assigned to a class's instance property declared without one
   * (`app: Application;` + `this.app = express()`), when the service's files write it exactly
   * once: a plain `=` on `this`, as a statement of the class's constructor body. A write in a
   * branch, a method, a callback, or another file leaves it unknown.
   */
  const constructorValue = (
    sp: ServiceProgram,
    symbol: ts.Symbol,
    declaration: ts.PropertyDeclaration,
  ): ts.Expression | undefined => {
    const name = declaration.name;
    const owner = declaration.parent;
    const isStatic = ts
      .getModifiers(declaration)
      ?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    if (isStatic || (!ts.isIdentifier(name) && !ts.isPrivateIdentifier(name))) return undefined;
    if (!files.some((f) => f.sourceFile === declaration.getSourceFile())) return undefined;
    const checker = resolver.checkerOf(sp);
    // A string-keyed write (`x["app"] = …`) may be to any object, so it always counts.
    const writes = writesTo(name.text).filter(
      (left) =>
        !ts.isPropertyAccessExpression(left) || checker.getSymbolAtLocation(left.name) === symbol,
    );
    const [left] = writes;
    if (writes.length !== 1 || !left || !ts.isPropertyAccessExpression(left)) return undefined;
    const assignment = left.parent;
    const statement = assignment.parent as ts.Node | undefined;
    const body = statement?.parent;
    const isConstructorStatement =
      ts.isBinaryExpression(assignment) &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement !== undefined &&
      ts.isExpressionStatement(statement) &&
      body !== undefined &&
      ts.isBlock(body) &&
      ts.isConstructorDeclaration(body.parent) &&
      body.parent.parent === owner &&
      unwrap(left.expression).kind === ts.SyntaxKind.ThisKeyword;
    return isConstructorStatement ? assignment.right : undefined;
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
    if (ts.isPropertyDeclaration(declaration)) {
      const assigned = constructorValue(sp, symbol, declaration);
      return assigned && valueOf(sp, assigned, hops + 1);
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
    return value && refOfValue(value, hops);
  };

  /** What router a value (see `valueOf`) may be. */
  const refOfValue = (value: ts.Node, hops: number): RouterRef | undefined => {
    const key = mayBeRouter(value) ? routerSite(sp, value)?.key : undefined;
    const then: RouterRef[] = [];
    if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
      const callee = unwrap(value.expression);
      const reduced = ts.isCallExpression(value) ? reducedOnto(value) : undefined;
      if (
        ts.isPropertyAccessExpression(callee) &&
        (METHODS.has(callee.name.text) || callee.name.text === "use")
      ) {
        // `router.get(…)` and `router.use(…)` return the router, so chained calls keep it.
        const ref = refOf(callee.expression, hops + 1);
        if (ref) then.push(ref);
      } else if (reduced) {
        // `list.reduce((r, x) => r.use(x), Router())` returns the initial router.
        const ref = refOf(reduced, hops + 1);
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

  // Folder listings (ADR-0162): values read without running anything.
  const rootFileSet = new Set(sp.rootFiles);

  /** Where an identifier was imported or required from, and the export it names, if any. */
  const importedFrom = (id: ts.Identifier): { module: string; name?: string } | undefined => {
    const declaration = resolver.checkerOf(sp).getSymbolAtLocation(id)?.declarations?.[0];
    if (!declaration) return undefined;
    const text = (node: ts.Node | undefined) =>
      node && ts.isStringLiteralLike(node) ? node.text : undefined;
    const required = (init: ts.Expression | undefined) => {
      const e = init && unwrap(init);
      return e && isRequireCall(e) ? text(e.arguments[0]) : undefined;
    };
    let module: string | undefined;
    let name: string | undefined;
    if (ts.isImportSpecifier(declaration)) {
      module = text(declaration.parent.parent.parent.moduleSpecifier);
      name = (declaration.propertyName ?? declaration.name).text;
    } else if (ts.isImportClause(declaration)) {
      module = text(declaration.parent.moduleSpecifier);
    } else if (ts.isNamespaceImport(declaration)) {
      module = text(declaration.parent.parent.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(declaration)) {
      const reference = declaration.moduleReference;
      module = ts.isExternalModuleReference(reference) ? text(reference.expression) : undefined;
    } else if (ts.isVariableDeclaration(declaration)) {
      module = required(declaration.initializer);
    } else if (
      ts.isBindingElement(declaration) &&
      ts.isVariableDeclaration(declaration.parent.parent)
    ) {
      module = required(declaration.parent.parent.initializer);
      const imported = declaration.propertyName ?? declaration.name;
      name = ts.isIdentifier(imported) ? imported.text : undefined;
    }
    return module === undefined ? undefined : { module, ...(name ? { name } : {}) };
  };

  /** The module and function a call's callee names (`fs.readdirSync`, `{ join }` from `path`). */
  const calleeOf = (callee: ts.Expression): { module: string; name: string } | undefined => {
    const e = unwrap(callee);
    if (ts.isIdentifier(e)) {
      const from = importedFrom(e);
      return from?.name ? { module: from.module, name: from.name } : undefined;
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const from = importedFrom(e.expression);
      return from && !from.name ? { module: from.module, name: e.name.text } : undefined;
    }
    return undefined;
  };

  /** A `const` (or object property) a name stands for, followed through imports. */
  const constInitializer = (e: ts.Identifier | ts.PropertyAccessExpression) => {
    const checker = resolver.checkerOf(sp);
    let symbol = checker.getSymbolAtLocation(ts.isIdentifier(e) ? e : e.name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    if (!declaration) return undefined;
    if (ts.isPropertyAssignment(declaration)) return declaration.initializer;
    const isConst =
      ts.isVariableDeclaration(declaration) &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
    return isConst ? declaration.initializer : undefined;
  };

  /** The router a repo file exports under `name` (or as its module value), if any. */
  const exportRef = (file: string, name: string): RouterRef | undefined => {
    const checker = resolver.checkerOf(sp);
    const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
    // The checker gives no symbol for a CommonJS file (no ES `import`/`export`), but the
    // binder still put its `module.exports` on the file's own symbol, as `require` reads it.
    const moduleSymbol =
      sourceFile &&
      (checker.getSymbolAtLocation(sourceFile) ??
        (sourceFile as ts.SourceFile & { symbol?: ts.Symbol }).symbol);
    const symbol = moduleSymbol?.exports?.get(ts.escapeLeadingUnderscores(name));
    const value = symbol && valueOfSymbol(sp, symbol, 1);
    return value && refOfValue(value, 1);
  };

  /** The repo modules `require` loads for each specifier (never the requiring file itself). */
  const required = (specifiers: readonly string[], file: string): Listed[] =>
    specifiers.flatMap((specifier) => {
      const target = resolveRequire(specifier, file, rootFileSet);
      return target === undefined || target === file ? [] : [{ module: target }];
    });

  type Env = ReadonlyMap<ts.Symbol, Listed>;

  /**
   * The values an expression in `file` may have, with loop variables bound by `env`: strings
   * from literals, templates, `+`, `__dirname`, `path.join`/`resolve`/`basename`, string
   * `replace`/`slice`, consts, and `a ? b : c` (each alternative); modules from `require`; and
   * routers from a module's exports (`m.default`). Undefined when it can't be read.
   */
  const evaluate = (
    expression: ts.Expression,
    env: Env,
    file: string,
    hops: number,
  ): Listed[] | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const checker = resolver.checkerOf(sp);
    const e = unwrap(expression);
    const texts = (x: ts.Expression): string[] | undefined => {
      const values = evaluate(x, env, file, hops + 1);
      return values?.every(isText) ? values.map((v) => v.text) : undefined;
    };
    const joined = (parts: readonly (string[] | undefined)[], join: (p: string[]) => string) => {
      if (parts.some((p) => p === undefined)) return undefined;
      return combinations(parts as string[][])?.map((p) => ({ text: join(p) }));
    };
    if (ts.isStringLiteralLike(e)) return [{ text: e.text }];
    if (ts.isTemplateExpression(e)) {
      const parts = [[e.head.text]];
      for (const span of e.templateSpans) {
        const values = texts(span.expression);
        if (!values) return undefined;
        parts.push(values, [span.literal.text]);
      }
      return joined(parts, (p) => p.join(""));
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return joined([texts(e.left), texts(e.right)], (p) => p.join(""));
    }
    if (ts.isConditionalExpression(e)) {
      const a = evaluate(e.whenTrue, env, file, hops + 1);
      const b = evaluate(e.whenFalse, env, file, hops + 1);
      if (!a || !b || a.length + b.length > MAX_ALTERNATIVES) return undefined;
      return [...a, ...b];
    }
    if (ts.isIdentifier(e)) {
      const symbol = checker.getSymbolAtLocation(e);
      const bound = symbol && env.get(symbol);
      if (bound) return [bound];
      const declaredInRepo = symbol?.declarations?.some(
        (d) => sp.toRepoPath(d.getSourceFile().fileName) !== undefined,
      );
      if (e.text === "__dirname" && !declaredInRepo) {
        return [{ text: absoluteFolder(folderOf(file)) }];
      }
    }
    if (ts.isPropertyAccessExpression(e)) {
      const objects = evaluate(e.expression, env, file, hops + 1);
      if (objects && objects.length > 0 && objects.every((o) => "module" in o)) {
        // `require(f).default`: the router the module exports under that name, if any.
        return objects.flatMap((o) => {
          const ref = "module" in o ? exportRef(o.module, e.name.text) : undefined;
          return ref ? [{ ref }] : [];
        });
      }
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const initializer = constInitializer(e);
      return initializer && evaluate(initializer, env, file, hops + 1);
    }
    if (!ts.isCallExpression(e)) return undefined;
    const callee = unwrap(e.expression);
    const args = e.arguments;
    if (ts.isIdentifier(callee) && callee.text === "require" && args.length === 1 && args[0]) {
      const specifiers = texts(args[0]);
      return specifiers && required(specifiers, file);
    }
    const fn = calleeOf(callee);
    if (fn && (fn.module === "path" || fn.module === "node:path")) {
      if (fn.name === "join" || fn.name === "resolve") {
        const resolve = fn.name === "resolve";
        return joined(
          args.map((a) => texts(a)),
          // `resolve` restarts at an absolute part; only `__dirname` makes one here.
          (parts) =>
            posix.join(
              ...parts.reduce<string[]>(
                (acc, part) => (resolve && part.startsWith(REPO_ROOT) ? [part] : [...acc, part]),
                [],
              ),
            ),
        );
      }
      if (fn.name === "basename" && args[0]) {
        const ext = args[1] && unwrap(args[1]);
        if (ext && !ts.isStringLiteralLike(ext)) return undefined;
        return texts(args[0])?.map((t) => ({ text: posix.basename(t, ext?.text) }));
      }
      return undefined;
    }
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const method = callee.name.text;
    const literals = args.map((a) => {
      const x = unwrap(a);
      if (ts.isStringLiteralLike(x)) return x.text;
      if (ts.isNumericLiteral(x)) return Number(x.text);
      const negative =
        ts.isPrefixUnaryExpression(x) &&
        x.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(x.operand);
      return negative ? -Number((x.operand as ts.NumericLiteral).text) : undefined;
    });
    const receiver =
      method === "replace" || method === "slice" ? texts(callee.expression) : undefined;
    if (!receiver) return undefined;
    const [first, second] = literals;
    if (method === "replace" && typeof first === "string" && typeof second === "string") {
      // A string pattern replaces its first occurrence, with `second` taken literally.
      return receiver.map((t) => {
        const at = t.indexOf(first);
        return { text: at < 0 ? t : t.slice(0, at) + second + t.slice(at + first.length) };
      });
    }
    const numbers = literals.every((l) => typeof l === "number") && args.length <= 2;
    if (method === "slice" && numbers) {
      return receiver.map((t) => ({ text: t.slice(...(literals as number[])) }));
    }
    return undefined;
  };

  /**
   * The names or paths a `readdirSync(folder)` or `glob.sync(pattern, { cwd })` call lists
   * (see `listings.ts`), from the service's own root files; undefined for anything else, or
   * when the folder isn't a repo path (`process.env.DIR`, a glob without `cwd`).
   */
  const listing = (call: ts.CallExpression, file: string): Listed[] | undefined => {
    const fn = calleeOf(call.expression);
    if (!fn) return undefined;
    const texts = (x: ts.Expression | undefined) => {
      const values = x && evaluate(x, new Map(), file, 0);
      return values?.every(isText) ? values.map((v) => v.text) : undefined;
    };
    const names = new Set<string>();
    const [first, options] = call.arguments;
    if (FS_MODULES.has(fn.module) && fn.name === "readdirSync") {
      // Only the plain-names form: `withFileTypes` would list `Dirent` objects.
      if (options && !ts.isStringLiteralLike(unwrap(options))) return undefined;
      const folders = texts(first)?.map(repoPathOf);
      if (!folders || folders.some((f) => f === undefined)) return undefined;
      for (const folder of folders as string[]) {
        for (const name of readdirEntries(folder, sp.rootFiles)) names.add(name);
      }
    } else if (GLOB_MODULES.has(fn.module) && GLOB_FUNCTIONS.has(fn.name)) {
      const patterns = texts(first);
      let cwd: string[] | undefined;
      if (options) {
        const o = unwrap(options);
        if (!ts.isObjectLiteralExpression(o)) return undefined;
        for (const property of o.properties) {
          const key = property.name && ts.isIdentifier(property.name) ? property.name.text : "";
          if (key === "absolute") return undefined;
          if (key === "cwd" && ts.isPropertyAssignment(property)) cwd = texts(property.initializer);
          else if (key === "cwd") return undefined;
        }
      }
      if (!patterns) return undefined;
      for (const pattern of patterns) {
        if (pattern.startsWith(REPO_ROOT)) {
          // An absolute pattern lists absolute paths, whatever `cwd` is.
          const relative = repoPathOf(pattern);
          const found =
            relative === undefined ? undefined : globEntries(relative, "", sp.rootFiles);
          if (!found) return undefined;
          for (const path of found) names.add(`${absoluteFolder("")}${path}`);
          continue;
        }
        // Without `cwd`, a relative pattern lists from wherever the process starts.
        if (!cwd) return undefined;
        for (const folder of cwd.map(repoPathOf)) {
          const found =
            folder === undefined ? undefined : globEntries(pattern, folder, sp.rootFiles);
          if (!found) return undefined;
          for (const path of found) names.add(path);
        }
      }
    } else {
      return undefined;
    }
    return [...names].sort(compareStrings).map((text) => ({ text }));
  };

  /**
   * The values a listing chain yields (`listing.filter(…).map(require)`): the listing's names,
   * mapped through `map` callbacks with one returned value. `filter` and `sort` are passed
   * through unread, so the result may include files the code filters out (ADR-0162).
   */
  const elementsOf = (
    expression: ts.Expression,
    file: string,
    hops: number,
  ): Listed[] | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    if (ts.isIdentifier(e)) {
      const initializer = constInitializer(e);
      return initializer && elementsOf(initializer, file, hops + 1);
    }
    if (!ts.isCallExpression(e)) return undefined;
    const listed = listing(e, file);
    if (listed) return listed;
    const callee = unwrap(e.expression);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const op = callee.name.text;
    if (op === "filter" || op === "sort") return elementsOf(callee.expression, file, hops + 1);
    const callback = e.arguments[0] && unwrap(e.arguments[0]);
    if (op !== "map" || !callback) return undefined;
    const elements = elementsOf(callee.expression, file, hops + 1);
    if (!elements) return undefined;
    if (ts.isIdentifier(callback) && callback.text === "require") {
      return required(
        elements.flatMap((x) => (isText(x) ? [x.text] : [])),
        file,
      );
    }
    const parameter = isFunctionWithBody(callback) ? callback.parameters[0]?.name : undefined;
    const returned = isFunctionWithBody(callback) ? returnedExpressions(callback) : [];
    const symbol = parameter && resolver.checkerOf(sp).getSymbolAtLocation(parameter);
    const [value] = returned;
    if (!symbol || !value || returned.length !== 1) return undefined;
    return elements.flatMap((x) => evaluate(value, new Map([[symbol, x]]), file, hops + 1) ?? []);
  };

  /**
   * `use` calls in a loop body over a listing: one {@link UseFact} per call and prefix, with
   * the routers each listed value names as children. `accumulator` is a `reduce` callback's
   * first parameter and the router it starts from.
   */
  const listedUses = (
    file: string,
    body: ts.Node,
    element: ts.Symbol,
    elements: readonly Listed[],
    accumulator?: { symbol: ts.Symbol; ref: RouterRef | undefined },
  ): void => {
    const checker = resolver.checkerOf(sp);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "use") calls.push(node);
      }
      if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
    };
    visit(body);
    for (const call of calls) {
      const target = (unwrap(call.expression) as ts.PropertyAccessExpression).expression;
      const object = unwrap(target);
      const onAccumulator =
        accumulator !== undefined &&
        ts.isIdentifier(object) &&
        checker.getSymbolAtLocation(object) === accumulator.symbol;
      const router = onAccumulator ? accumulator.ref : refOf(target);
      const [first] = call.arguments;
      if (!router || !first) continue;
      const groups = new Map<string, UseFact>();
      for (const value of elements) {
        const env = new Map([[element, value]]);
        const firstValues = evaluate(first, env, file, 0);
        const textual =
          firstValues !== undefined && firstValues.length > 0 && firstValues.every(isText);
        const hasPrefix = textual || isPathSyntax(first);
        const prefixes = !hasPrefix ? [""] : textual ? firstValues.map((v) => v.text) : undefined;
        const children = call.arguments.slice(hasPrefix ? 1 : 0).flatMap((argument) =>
          (evaluate(argument, env, file, 0) ?? []).flatMap((v) => {
            const ref =
              "ref" in v ? v.ref : "module" in v ? exportRef(v.module, MODULE_VALUE) : undefined;
            return ref ? [ref] : [];
          }),
        );
        if (children.length === 0) continue;
        const key = prefixes === undefined ? "" : JSON.stringify(prefixes);
        const group = groups.get(key);
        if (group) {
          group.children.push(...children);
          continue;
        }
        groups.set(key, {
          type: "use",
          router,
          ...(prefixes === undefined ? {} : { prefixes }),
          prefixText: hasPrefix ? first.getText() : "",
          site: locationOf(call, file),
          children,
          listed: true,
        });
      }
      facts.registrations.push(...groups.values());
    }
  };

  /** Loops over a listing: `list.forEach(cb)`, `list.reduce(cb, router)`, `for (const x of list)`. */
  const listingLoop = (file: string, node: ts.Node): void => {
    const checker = resolver.checkerOf(sp);
    if (ts.isForOfStatement(node)) {
      const declarations = ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations
        : [];
      const name = declarations.length === 1 ? declarations[0]?.name : undefined;
      const symbol = name && ts.isIdentifier(name) ? checker.getSymbolAtLocation(name) : undefined;
      const elements = symbol && elementsOf(node.expression, file, 0);
      if (symbol && elements) listedUses(file, node.statement, symbol, elements);
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) return;
    const op = callee.name.text;
    const callback = node.arguments[0] && unwrap(node.arguments[0]);
    if ((op !== "forEach" && op !== "reduce") || !callback || !isFunctionWithBody(callback)) {
      return;
    }
    const [first, second] = callback.parameters.map((p) =>
      ts.isIdentifier(p.name) ? checker.getSymbolAtLocation(p.name) : undefined,
    );
    const element = op === "reduce" ? second : first;
    const initial = node.arguments[1];
    if (!element || (op === "reduce" && (!first || !initial))) return;
    const elements = elementsOf(callee.expression, file, 0);
    if (!elements || !callback.body) return;
    const accumulator =
      op === "reduce" && first && initial ? { symbol: first, ref: refOf(initial) } : undefined;
    listedUses(file, callback.body, element, elements, accumulator);
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
    listingLoop(file, node);
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
  if (routers.size === 0) {
    return { nodes: [], edges: [], warnings: [], inlineHandlers, listedRoutes: [] };
  }

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
          listed: false,
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
          listed: registration.listed === true,
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

  /** Route IDs emitted through a listed mount, and through mounts that are all read from code. */
  const viaListing = new Set<string>();
  const viaCode = new Set<string>();
  const emit = (
    { fact: route, service }: RouteRecord,
    base: Base,
    rootService: string,
    listed: boolean,
  ): void => {
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
      (listed ? viaListing : viaCode).add(id);
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
  const walk = (
    router: RouterObject,
    base: Base,
    root: string,
    stack: Set<RouterObject>,
    listed: boolean,
  ): void => {
    if (stack.has(router) || !spend()) return;
    stack.add(router);
    visited.add(router);
    for (const route of router.routes) emit(route, base, root, listed);
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
      for (const next of bases) walk(mount.child, next, root, stack, listed || mount.listed);
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
    walk(root, { path: "/" }, root.service, new Set(), false);
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
    listedRoutes: [...viaListing].filter((id) => !viaCode.has(id)).sort(compareStrings),
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
