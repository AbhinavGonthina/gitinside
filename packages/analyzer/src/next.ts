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
 *   (req.method)`, also through `const { method } = req` and `req.method ?? ""`), in which case
 *   one route per method. When other methods may still fall through to real code (no negative
 *   guard, `default`, or 405, and the checks don't end the handler), an `ALL` route is added as
 *   well, so a fall-through endpoint is never dropped (see `handledMethods`).
 * - Negated method tests in an `if` (ADR-0195): `!==`, `!(… === …)`, `!["A"].includes(…)`,
 *   through `&&`, `||`, and parentheses. A block that only answers (calls on the response
 *   object or `console`, `throw`, `return`) or names 405 / `Allow` refuses the other methods,
 *   as above. A block that does other work serves every method but the named ones, so an `ALL`
 *   route is added, and the named methods are routes only when code after the `if` or its
 *   `else` can serve them (`if (req.method !== "POST" && req.method !== "PUT") { … }` as the
 *   handler's last statement is one `ALL` route).
 * - next-connect routers in `pages/api` (ADR-0191): a default export that is a router from
 *   `next-connect`'s factory (v0's default export `nc(opts)`, v1's `createRouter()`), imported
 *   or required, directly, through a variable, or through repo functions returning one
 *   (`apiHandler = () => nc(opts)`), optionally as v1's `router.handler(opts)`. Each method
 *   registered on it (`.get/.post/.put/.patch/.delete/.head/.options`, chained or not, in the
 *   router's chain or on its variables in their own file) is one route, at its first
 *   registration; `.all(…)` is `ALL`, and `.use(…)` registers none. Each handler argument
 *   naming a symbol node gets a `handles` edge, and inline handlers own the calls inside them
 *   (`inlineHandlers`, as Express's). When more methods may be registered unseen (a route
 *   pattern argument `.get("/x", h)`, `.trace`/`.connect`, the router passed to other code,
 *   exported, or declared at module level in another file, or another router mounted with
 *   `.use(sub)`), the file's `ALL` route is kept as well (once, `.all` or not), with a
 *   `NEXT_CONNECT_UNSEEN_METHODS` warning per reason. `export { router as default }` is the
 *   default export, not an escape.
 * - Type-only exports (`export type GET = …`) in a `route.ts` are not routes.
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
 * - A negated method test's block is read by what it calls, not by what it answers: a
 *   refusal through a helper (`return reject(res)`, no 405 in sight) reads as serving and adds
 *   an `ALL` route (an extra route, never a dropped one). A negated test outside an `if`
 *   condition (`const other = req.method !== "GET"`, a ternary) stays a refusal, and an
 *   `else` or later code is not checked for which methods actually reach it.
 * - next-connect beyond the forms above: route patterns are not matched against the file's
 *   path (next-connect matches them against the request URL), routers mounted with `.use(sub)`
 *   don't add their methods, nor do registrations in another file on an exported or shared
 *   router variable (each keeps the `ALL` route, as above). A router returned from a repo
 *   function through a local variable (`const r = nc(); return r;`) reads as passed on. A wrapped
 *   default export (`export default withAuth(router)`), a function default export calling
 *   v1's `router.run(req, res)`, and a router with no method registered stay one `ALL` route;
 *   v1's `createEdgeRouter` in app router files is not read.
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
import { inlineFunctions, isFunctionWithBody, returnedExpressions } from "./express.js";
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
  return handledMethods(handler).methods;
}

/**
 * The methods a pages API handler checks (see {@link checkedMethods}) and whether other
 * methods may still reach real code (`open`). The set is closed when the remainder is
 * visibly rejected or empty: a negative guard whose block only answers (`req.method !==
 * "POST"`, `!["GET"].includes(method)`), a `switch` with a `default`, a `405` or `Allow` response,
 * or positive checks whose `if` has no final `else` and is the handler's last statement
 * (a trailing `switch` without `default` counts the same). Otherwise, as in
 * `if (req.method === "GET") return list(); return create();`, it's open, and the caller
 * adds an `ALL` route so the fall-through endpoint isn't dropped. A negated test whose block
 * does the work (B3) leaves it open too: that block is where the other methods go.
 */
export function handledMethods(handler: ts.SignatureDeclaration): {
  methods: HttpMethod[];
  open: boolean;
} {
  const request = handler.parameters[0];
  const body = (handler as ts.FunctionLikeDeclaration).body;
  if (!request || !body) return { methods: [], open: false };

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
    // `req.method ?? ""`, which strict types ask for in `.includes(…)`.
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return isMethod(e.left);
    }
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
  /** Positive checks (`===`, `includes`, `switch` without `default`), for the open/closed test. */
  const positive: ts.Node[] = [];
  let rejectsOthers = false;
  /** Set when a negated test's block serves the request: every other method reaches code. */
  let servesOthers = false;

  const responseName = handler.parameters[1]?.name;
  /** Whether a call only answers: on the response object (`res.status(400).json(…)`) or `console`. */
  const answers = (call: ts.CallExpression): boolean => {
    let e: ts.Expression = call.expression;
    while (
      ts.isPropertyAccessExpression(e) ||
      ts.isElementAccessExpression(e) ||
      ts.isCallExpression(e) ||
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e)
    ) {
      e = e.expression;
    }
    return (
      ts.isIdentifier(e) &&
      (e.text === "console" ||
        (responseName !== undefined &&
          ts.isIdentifier(responseName) &&
          e.text === responseName.text))
    );
  };
  /**
   * Whether the block a negated test enters serves the request rather than refusing it: it
   * names no 405 or `Allow`, and it calls something besides the response and `console`.
   */
  const serves = (block: ts.Statement): boolean => {
    let refuses = false;
    let works = false;
    const look = (node: ts.Node): void => {
      if (
        (ts.isNumericLiteral(node) && node.text === "405") ||
        (ts.isStringLiteralLike(node) && node.text.toLowerCase() === "allow")
      ) {
        refuses = true;
      }
      if (ts.isCallExpression(node) && !answers(node)) works = true;
      ts.forEachChild(node, look);
    };
    look(block);
    return works && !refuses;
  };
  /** Whether a statement inside the handler has anything after it, at any level up to the body. */
  const followed = (statement: ts.Node): boolean => {
    for (let node = statement; node !== body; node = node.parent) {
      const parent = node.parent;
      if (ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
        const list: readonly ts.Statement[] = parent.statements;
        if (list.indexOf(node as ts.Statement) < list.length - 1) return true;
      }
    }
    return false;
  };
  /**
   * Whether a method test holds for the methods it names or for all others (`!==`, `!(…)`,
   * an odd number of `!`), and the `if` whose condition it is, following `(…)`, `!`, `&&`, and
   * `||` up to it.
   */
  const polarity = (
    test: ts.Node,
    negated: boolean,
  ): { negated: boolean; guard?: ts.IfStatement } => {
    let node = test;
    for (;;) {
      const parent = node.parent;
      if (
        ts.isPrefixUnaryExpression(parent) &&
        parent.operator === ts.SyntaxKind.ExclamationToken
      ) {
        negated = !negated;
      } else if (ts.isIfStatement(parent) && parent.expression === node) {
        return { negated, guard: parent };
      } else if (
        !ts.isParenthesizedExpression(parent) &&
        !(
          ts.isBinaryExpression(parent) &&
          (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        )
      ) {
        return { negated };
      }
      node = parent;
    }
  };
  /**
   * Records a method test naming `names`: a positive one for the open/closed test; a negated
   * one as a rejection of the others, unless its block serves them (B3), in which case the
   * named methods are routes only when code after the block or its `else` can serve them.
   */
  const record = (test: ts.Node, negated: boolean, names: readonly ts.Expression[]): void => {
    const { negated: negative, guard } = polarity(test, negated);
    if (!negative) {
      names.forEach(literal);
      positive.push(test);
    } else if (guard && serves(guard.thenStatement)) {
      servesOthers = true;
      if (guard.elseStatement || followed(guard)) names.forEach(literal);
    } else {
      names.forEach(literal);
      rejectsOthers = true;
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isNumericLiteral(node) && node.text === "405") ||
      (ts.isStringLiteralLike(node) && node.text.toLowerCase() === "allow")
    ) {
      rejectsOthers = true;
    }
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
        const negative =
          kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          kind === ts.SyntaxKind.ExclamationEqualsToken;
        if (isMethod(node.left) || isMethod(node.right)) {
          record(node, negative, [isMethod(node.left) ? node.right : node.left]);
        }
      }
    } else if (ts.isSwitchStatement(node) && isMethod(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) literal(clause.expression);
        else rejectsOthers = true;
      }
      positive.push(node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      node.arguments[0] !== undefined &&
      isMethod(node.arguments[0])
    ) {
      const list = unwrap(node.expression.expression);
      record(node, false, ts.isArrayLiteralExpression(list) ? list.elements : []);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  const methods = [...found].filter((m) => METHODS.has(m)).sort(compareStrings) as HttpMethod[];
  if (servesOthers) return { methods, open: true };
  if (methods.length === 0 || rejectsOthers) return { methods, open: false };

  // Every positive check must sit in an `if` (or be a `switch`) with no final `else`, inside
  // the handler's last statement; anything else may let other methods reach real code.
  const statements = ts.isBlock(body) ? body.statements : undefined;
  const last = statements?.[statements.length - 1];
  const open = positive.some((check) => {
    let statement: ts.Node | undefined = check;
    if (!ts.isSwitchStatement(check)) {
      statement = check.parent;
      while (statement && !ts.isIfStatement(statement) && statement !== body) {
        statement = statement.parent;
      }
      if (!statement || !ts.isIfStatement(statement)) return true;
      if (check.getStart() >= statement.expression.getEnd()) return true; // not in the condition
      let tail: ts.IfStatement = statement;
      while (tail.elseStatement && ts.isIfStatement(tail.elseStatement)) tail = tail.elseStatement;
      if (tail.elseStatement) return true;
    }
    let top: ts.Node = statement;
    while (top.parent !== body && top.parent !== undefined) top = top.parent;
    return top !== last;
  });
  return { methods, open };
}

/** next-connect's router methods and the HTTP method each registers (`use` registers none). */
const CONNECT_METHODS: ReadonlyMap<string, HttpMethod | undefined> = new Map([
  ["all", "ALL"],
  ["delete", "DELETE"],
  ["get", "GET"],
  ["head", "HEAD"],
  ["options", "OPTIONS"],
  ["patch", "PATCH"],
  ["post", "POST"],
  ["put", "PUT"],
  ["use", undefined],
]);

/** Router methods that register a method the graph has no name for, so an `ALL` stays. */
const UNNAMED_METHODS: ReadonlySet<string> = new Set(["connect", "trace"]);

/** Calls on a router that neither register nor let it escape (v1's `handler()`, `run()`). */
const SERVING_METHODS: ReadonlySet<string> = new Set(["handler", "run"]);

/** How many variable, alias, or factory hops are followed to a router's creation. */
const MAX_ROUTER_HOPS = 8;

/** One method registration on a next-connect router: `router.get(…handlers)`. */
interface Registration {
  method: HttpMethod;
  call: ts.CallExpression;
  /** The method's name, where the route is placed. */
  name: ts.MemberName;
}

/** What the analyzer reads of a next-connect router (ADR-0191). */
export interface ConnectRouter {
  registrations: Registration[];
  /** Why other methods may be registered unseen, one warning message each. */
  unseen: string[];
}

function isNextConnectSpecifier(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isStringLiteralLike(node) && node.text === "next-connect";
}

function isRequireNextConnect(expression: ts.Expression): boolean {
  const e = unwrap(expression);
  return (
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "require" &&
    e.arguments.length === 1 &&
    isNextConnectSpecifier(e.arguments[0])
  );
}

/**
 * True when `callee` names next-connect's router factory, imported or required from
 * `next-connect`: its default export (v0's `nc()`) or `createRouter` (v1). Found through the
 * checker's declaration of the name, so a local `nc` that shadows it doesn't count.
 */
function isConnectFactory(checker: ts.TypeChecker, callee: ts.Expression): boolean {
  const e = unwrap(callee);
  if (!ts.isIdentifier(e)) return false;
  const declaration = checker.getSymbolAtLocation(e)?.declarations?.[0];
  if (!declaration) return false;
  if (ts.isImportClause(declaration))
    return isNextConnectSpecifier(declaration.parent.moduleSpecifier);
  if (ts.isImportSpecifier(declaration)) {
    const imported = (declaration.propertyName ?? declaration.name).text;
    const specifier = declaration.parent.parent.parent.moduleSpecifier;
    return (
      isNextConnectSpecifier(specifier) && (imported === "createRouter" || imported === "default")
    );
  }
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    return declaration.initializer !== undefined && isRequireNextConnect(declaration.initializer);
  }
  if (ts.isBindingElement(declaration)) {
    const imported = declaration.propertyName ?? declaration.name;
    const init = declaration.parent.parent;
    return (
      ts.isIdentifier(imported) &&
      imported.text === "createRouter" &&
      ts.isVariableDeclaration(init) &&
      init.initializer !== undefined &&
      isRequireNextConnect(init.initializer)
    );
  }
  return false;
}

/**
 * True when a registration's first argument is a route pattern rather than a handler: a
 * string, template, or regex literal, or anything the checker types as a string.
 */
function isPattern(checker: ts.TypeChecker, argument: ts.Expression | undefined): boolean {
  if (!argument) return false;
  const e = unwrap(argument);
  if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e) || ts.isRegularExpressionLiteral(e)) {
    return true;
  }
  return (checker.getTypeAtLocation(e).flags & ts.TypeFlags.StringLike) !== 0;
}

/**
 * The next-connect router a pages API file's default export is (ADR-0191), or undefined when
 * it isn't one. `expression` is the export's value: the router itself, a chain of method
 * calls on it (`nc().get(a).post(b)`), v1's `router.handler(options)`, or a variable holding
 * one of those. The router is created by next-connect's factory directly or by a repo function
 * returning one (`apiHandler = () => nc(options)`), within {@link MAX_ROUTER_HOPS}. Methods
 * are read from the chains and from calls on the router's variables in their own file; a
 * pattern argument (`.get("/x", h)`), a `trace`/`connect` registration, a router mounted with
 * `.use(sub)`, or the router passed on (`register(handler)`), exported, or declared at module
 * level in another file adds an `unseen` reason.
 */
export function connectRouter(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ConnectRouter | undefined {
  const registrations: Registration[] = [];
  const unseen: string[] = [];
  const variables = new Set<ts.Symbol>();

  const register = (call: ts.CallExpression, name: ts.MemberName): void => {
    const method = CONNECT_METHODS.get(name.text);
    if (name.text === "use") {
      // A mounted router's methods aren't read; inline or named middleware registers none.
      const sub = call.arguments.find((a) => visit(a, 0, false));
      if (sub) {
        const text = sub.getText();
        unseen.push(
          `the next-connect router mounts another router with .use(${text.length > 40 ? "…" : text}), whose methods aren't read; kept an ALL route for them`,
        );
      }
      return;
    }
    if (UNNAMED_METHODS.has(name.text)) {
      unseen.push(
        `the next-connect router registers .${name.text}(…), which the graph has no method for; kept an ALL route for it`,
      );
    } else if (method === undefined) {
      return;
    } else if (isPattern(checker, call.arguments[0])) {
      unseen.push(
        `the next-connect route pattern ${call.arguments[0]?.getText() ?? ""} in .${name.text}(…) isn't read; kept an ALL route for the methods it may add`,
      );
    } else {
      registrations.push({ method, call, name });
    }
  };

  /**
   * Whether `node` is a router, recording the registrations chained on it and its variables
   * (only checking, when `record` is false).
   */
  const visit = (node: ts.Expression, hops: number, record = true): boolean => {
    if (hops > MAX_ROUTER_HOPS) return false;
    let e = unwrap(node);
    const chain: { call: ts.CallExpression; name: ts.MemberName }[] = [];
    while (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression);
      if (!ts.isPropertyAccessExpression(callee)) break;
      const name = callee.name.text;
      if (!CONNECT_METHODS.has(name) && !UNNAMED_METHODS.has(name)) break;
      chain.push({ call: e, name: callee.name });
      e = unwrap(callee.expression);
    }
    let found = false;
    if (ts.isCallExpression(e)) {
      if (isConnectFactory(checker, e.expression)) found = true;
      else {
        // A repo factory: every value it returns must be a router.
        const fn = functionOf(checker, unwrap(e.expression));
        const returned = fn && isFunctionWithBody(fn) ? returnedExpressions(fn) : [];
        found = returned.length > 0 && returned.every((r) => visit(r, hops + 1, record));
      }
    } else if (ts.isIdentifier(e)) {
      let symbol = checker.getSymbolAtLocation(e);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.valueDeclaration;
      if (
        symbol &&
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        visit(declaration.initializer, hops + 1, record)
      ) {
        if (record) variables.add(symbol);
        found = true;
      }
    }
    if (found && record) for (const link of chain.reverse()) register(link.call, link.name);
    return found;
  };

  let top = unwrap(expression);
  if (ts.isCallExpression(top)) {
    const callee = unwrap(top.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "handler") {
      top = unwrap(callee.expression);
    }
  }
  if (!visit(top, 0)) return undefined;

  // Calls on the router's variables in their own files: chains of registrations, serving
  // calls, the default export, or else the router escapes and may get more methods. A
  // module-level router in another file, or an exported one, may get them in any file.
  const page = expression.getSourceFile();
  for (const symbol of variables) {
    const declaration = symbol.valueDeclaration as ts.VariableDeclaration;
    const statement = declaration.parent.parent;
    const exported = `the next-connect router ${symbol.name} is exported, so other files may register more methods; kept an ALL route for them`;
    if (declaration.getSourceFile() !== page) {
      if (ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent)) {
        unseen.push(
          `the next-connect router ${symbol.name} is declared in another file, where more methods may be registered; kept an ALL route for them`,
        );
      }
    } else if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      unseen.push(exported);
    }
    const use = (id: ts.Identifier): void => {
      let node: ts.Node = id;
      while (ts.isParenthesizedExpression(node.parent) || ts.isNonNullExpression(node.parent)) {
        node = node.parent;
      }
      let parent = node.parent;
      if (ts.isExportAssignment(parent) || parent === declaration) return;
      if (ts.isExportSpecifier(parent)) {
        // `export { router as default }` in the page file is its default export.
        const inPage = parent.getSourceFile() === page && parent.name.text === "default";
        if (!inPage && declaration.getSourceFile() === page) unseen.push(exported);
        return;
      }
      // Walk up `router.a(…).b(…)`, registering each link, until the chain ends.
      let chained = false;
      while (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      ) {
        const name = parent.name.text;
        if (SERVING_METHODS.has(name)) return;
        if (!CONNECT_METHODS.has(name) && !UNNAMED_METHODS.has(name)) break;
        register(parent.parent, parent.name);
        chained = true;
        node = parent.parent;
        parent = node.parent;
      }
      if (chained) return;
      const call = ts.isCallExpression(parent) ? parent.expression.getText() : parent.getText();
      unseen.push(
        `the next-connect router is passed to ${call.length > 40 ? "code" : call}(…), which may register more methods; kept an ALL route for them`,
      );
    };
    const walk = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        node !== declaration.name &&
        node.text === symbol.name &&
        checker.getSymbolAtLocation(node) === symbol
      ) {
        use(node);
      }
      ts.forEachChild(node, walk);
    };
    walk(declaration.getSourceFile());
  }
  registrations.sort(
    (a, b) =>
      compareStrings(a.call.getSourceFile().fileName, b.call.getSourceFile().fileName) ||
      a.call.getStart() - b.call.getStart(),
  );
  return { registrations, unseen: [...new Set(unseen)] };
}

/**
 * What one service's program says about Next.js, as plain data (ADR-0090): its routes and
 * pages, their `handles`/`renders` edges, and warnings, in the order its files were walked.
 * Every ID carries the service's key and duplicates are only possible within one router, so
 * no other service's facts change them; {@link composeNextRoutes} only merges and sorts.
 */
export interface NextFacts {
  /** Key of the service whose program found these. */
  service: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: AnalysisWarning[];
  /**
   * The inline handler functions of next-connect registrations (ADR-0191) by node key, with
   * the sorted IDs of the routes each serves, as Express's `inlineHandlers` (`owners.ts`).
   */
  inlineHandlers: { key: string; routes: string[] }[];
}

/**
 * Collect one service's {@link NextFacts} with its program (see the file comment for the
 * patterns): `route` nodes (`route:<service>/<METHOD> <path>`) and `page` nodes
 * (`page:<service>/<path>`), both parented to their file, with their edges. Empty unless the
 * service depends on `next`.
 */
export function collectNextFacts(sp: ServiceProgram, resolver: SymbolResolver): NextFacts {
  const service = sp.service;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const warnings: AnalysisWarning[] = [];
  /** Routes served by each inline handler function, by node key. */
  const inline = new Map<string, Set<string>>();
  const facts = (): NextFacts => ({
    service: service.key,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    warnings,
    inlineHandlers: [...inline]
      .map(([key, routes]) => ({ key, routes: [...routes].sort(compareStrings) }))
      .sort((a, b) => compareStrings(a.key, b.key)),
  });
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
    if (edges.has(id)) return; // a handler registered twice keeps its first site
    edges.set(id, { id, kind, from, to: target.id, confidence: target.confidence, sites: [site] });
  };

  if (!service.dependencies.includes("next")) return facts();
  const checker = resolver.checkerOf(sp);
  const local = sp.rootFiles.map((file) => ({ file, rel: withinService(service, file) }));
  const atRoot = local.some(({ rel }) => rel.startsWith("app/") || rel.startsWith("pages/"));
  const base = atRoot ? "" : "src/";

  /** The module's exports by name, or an empty map for files without a module symbol. */
  const exportsOf = (sourceFile: ts.SourceFile): Map<string, ts.Symbol> => {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    const result = new Map<string, ts.Symbol>();
    if (!moduleSymbol) return result;
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) result.set(symbol.name, symbol);
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

  /**
   * One route per method a next-connect router registers, at the method's first registration,
   * with a `handles` edge for each handler argument naming a symbol node and its inline
   * handlers recorded; plus the file's `ALL` route, with a warning, when methods may be unseen.
   */
  const connectRoutes = (
    router: ConnectRouter,
    path: string,
    file: string,
    exportSite: SourceLocation,
    exportTarget: CallTarget | undefined,
  ): void => {
    const byMethod = new Map<HttpMethod, Registration[]>();
    for (const registration of router.registrations) {
      const list = byMethod.get(registration.method) ?? [];
      list.push(registration);
      byMethod.set(registration.method, list);
    }
    for (const method of [...byMethod.keys()].sort(compareStrings)) {
      const registrations = byMethod.get(method) ?? [];
      const first = registrations[0];
      if (!first) continue;
      const at = (node: ts.Node): SourceLocation =>
        locationOf(node, sp.toRepoPath(node.getSourceFile().fileName) ?? file);
      const id = route(method, path, file, at(first.name));
      if (id === undefined) continue;
      for (const { call } of registrations) {
        for (const handler of call.arguments) {
          addEdge("handles", id, resolver.resolve(sp, handler), at(handler));
          const handlerFile = sp.toRepoPath(handler.getSourceFile().fileName);
          if (handlerFile === undefined) continue;
          for (const fn of inlineFunctions(handler)) {
            const key = nodeKey(handlerFile, fn);
            const routes = inline.get(key) ?? new Set<string>();
            routes.add(id);
            inline.set(key, routes);
          }
        }
      }
    }
    if (router.unseen.length === 0) return;
    for (const message of router.unseen) {
      warnings.push({ code: "NEXT_CONNECT_UNSEEN_METHODS", file, message });
    }
    if (byMethod.has("ALL")) return;
    const id = route("ALL", path, file, exportSite);
    if (id !== undefined) addEdge("handles", id, exportTarget, exportSite);
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
      // Only value exports handle requests; `export type GET = …` is not a route. An alias
      // TS can't resolve yields its "unknown" symbol, which is flagged as a value, so
      // unresolvable re-exports still count.
      const isValue = (symbol: ts.Symbol): boolean => {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        return (target.flags & ts.SymbolFlags.Value) !== 0;
      };
      const methods = [...exports]
        .filter(([name, symbol]) => METHODS.has(name) && isValue(symbol))
        .map(([name]) => name)
        .sort(compareStrings);
      if (methods.length === 0) {
        warnings.push({
          code: "NEXT_ROUTE_NO_METHODS",
          file,
          message: "route handler file exports no HTTP method (GET, POST, …); no route was created",
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
      const value =
        declaration && ts.isExportAssignment(declaration)
          ? declaration.expression
          : declaration && ts.isExportSpecifier(declaration)
            ? (declaration.propertyName ?? declaration.name)
            : undefined;
      const router = value && ts.isExpression(value) ? connectRouter(checker, value) : undefined;
      if (router && (router.registrations.length > 0 || router.unseen.length > 0)) {
        connectRoutes(router, path, file, site, found?.target);
        continue;
      }
      const handler = functionOf(checker, declaration);
      const { methods: checked, open } = handler
        ? handledMethods(handler)
        : { methods: [], open: false };
      const methods: HttpMethod[] = checked.length === 0 || open ? ["ALL", ...checked] : checked;
      for (const method of methods) {
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
  return facts();
}

/** Next.js routes of the whole repo, from {@link composeNextRoutes}. */
export interface NextRoutes {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: AnalysisWarning[];
  /** next-connect's inline handlers: route IDs by function node key (see `NextFacts`). */
  inlineHandlers: Map<string, string[]>;
}

/** Every service's Next.js routes, pages, edges, and warnings from their facts, sorted. */
export function composeNextRoutes(facts: readonly NextFacts[]): NextRoutes {
  return {
    inlineHandlers: new Map(
      facts.flatMap((f) => f.inlineHandlers.map(({ key, routes }) => [key, routes] as const)),
    ),
    nodes: facts.flatMap((f) => f.nodes).sort((a, b) => compareStrings(a.id, b.id)),
    edges: facts.flatMap((f) => f.edges).sort((a, b) => compareStrings(a.id, b.id)),
    warnings: facts
      .flatMap((f) => f.warnings)
      .sort(
        (a, b) =>
          compareStrings(a.file ?? "", b.file ?? "") || compareStrings(a.message, b.message),
      ),
  };
}

/**
 * Detect Next.js routes and pages in every service that depends on `next`:
 * {@link collectNextFacts} per program, then {@link composeNextRoutes}.
 */
export function buildNextRoutes(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
): NextRoutes {
  return composeNextRoutes(programs.map((sp) => collectNextFacts(sp, resolver)));
}
