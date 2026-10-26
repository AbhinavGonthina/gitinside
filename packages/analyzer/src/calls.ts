import ts from "typescript";
import {
  compareStrings,
  edgeId,
  type Confidence,
  type GraphEdge,
  type SourceLocation,
} from "@gitinside/schema";
import { createModuleResolver, type ManifestCache } from "./imports.js";
import type { ServiceProgram } from "./program.js";
import { extractSymbols, symbolNodeId, unwrap } from "./symbols.js";
import type { Workspace } from "./workspace.js";

/** How many alias, re-export, or property-value hops are followed before giving up. */
const MAX_HOPS = 8;

/** A callee resolved to a symbol node. */
interface CallTarget {
  id: string;
  confidence: Confidence;
}

/** Context for resolving symbols in one program: its checker and its module resolver. */
interface Context {
  sp: ServiceProgram;
  checker: ts.TypeChecker;
  resolveModule: ReturnType<typeof createModuleResolver>;
}

/**
 * Node kinds a declaration may sit inside before reaching the node a symbol was extracted
 * from, e.g. `exports.x = function () {}` declares `x` on the property access, while the
 * symbol spans the whole statement.
 */
const WRAPPER_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
]);

/** The identifier a callee names: `f`, the `m` of `a.b.m`, or a string-literal element `a["m"]`. */
function calleeName(expression: ts.Expression): ts.Node | undefined {
  const e = unwrap(expression);
  if (ts.isIdentifier(e)) return e;
  if (ts.isPropertyAccessExpression(e)) return e.name;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return e.argumentExpression;
  }
  return undefined;
}

/** The module specifier and imported name behind an import or re-export alias declaration. */
function importOf(
  declaration: ts.Declaration,
  member: string | undefined,
): { literal: ts.StringLiteralLike; name: string } | undefined {
  let statement: ts.Node | undefined;
  let name: string | undefined;
  if (ts.isImportSpecifier(declaration) || ts.isExportSpecifier(declaration)) {
    statement = declaration.parent.parent.parent;
    name = (declaration.propertyName ?? declaration.name).text;
  } else if (ts.isImportClause(declaration)) {
    statement = declaration.parent;
    name = member === undefined ? "default" : undefined;
  } else if (ts.isNamespaceImport(declaration)) {
    statement = declaration.parent.parent;
    name = member;
  }
  if (statement === undefined || name === undefined) return undefined;
  const specifier =
    ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      ? statement.moduleSpecifier
      : undefined;
  return specifier !== undefined && ts.isStringLiteralLike(specifier)
    ? { literal: specifier, name }
    : undefined;
}

/**
 * Build `calls` edges (symbol → symbol) for calls whose callee resolves to a symbol node.
 *
 * The caller is the innermost symbol (see `extractSymbols`) whose declaration contains the
 * call, so calls inside nested functions and callbacks belong to the enclosing top-level
 * function, and calls inside a method belong to the method. The callee is resolved with the
 * service program's type checker:
 * - `f()`, `ns.f()`, `obj.method()`, `this.method()`, `super.method()`, `a["m"]()`, `new C()`
 *   (to the class), optional calls `a?.b()`, and calls through parentheses, `as`, and `!`.
 * - Through imports, re-exports, `import x = require()`, and CommonJS `require` in JS files,
 *   as far as TypeScript resolves them. Overloads resolve to the implementation.
 * - Through `{ list }` / `{ list: listImpl }` object properties and `const a = b` aliases,
 *   to the function they name.
 * - Imports TypeScript can't resolve because there is no `node_modules`, i.e. cross-workspace
 *   package imports (`import { f } from "@acme/shared"`, `import * as s` then `s.f()`), are
 *   resolved like import edges (M1.8), then looked up among the target module's exports with
 *   that service's checker. The edge takes the import's confidence (`exact` or `heuristic`).
 *
 * All other edges are `exact`. Calls from one symbol to the same callee share one edge, with
 * every call site (the callee name's position) listed.
 *
 * Not handled, and producing no edge: calls at file top level (there is no caller symbol);
 * recursion (self-edges); calls to nested functions, constructors, accessors, third-party
 * packages, and built-ins (no symbol node); JSX elements (`renders`, M1.11); tagged
 * templates and decorators; callees reached through untyped values, such as a method on an
 * instance of a class imported from another workspace package; workspace packages reached
 * through `require` or `import x = require()` rather than ES imports; computed element access
 * (`a[name]()`); and function values passed around and called later (`cb()` where `cb` is a
 * parameter).
 */
export function buildCallEdges(
  programs: readonly ServiceProgram[],
  workspace: Workspace,
): GraphEdge[] {
  const keyOf = (path: string, node: ts.Node): string =>
    `${path}:${node.kind}:${node.pos}:${node.end}`;

  // Symbol nodes by declaration position (shared across programs that load the same file),
  // and by declaration node within each root file (to find callers).
  const symbolByKey = new Map<string, string>();
  const callers = new Map<ts.SourceFile, Map<ts.Node, string>>();
  const programOf = new Map<string, ServiceProgram>();
  for (const sp of programs) {
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      if (!sourceFile) continue;
      programOf.set(file, sp);
      const byNode = new Map<ts.Node, string>();
      for (const symbol of extractSymbols(sourceFile)) {
        const id = symbolNodeId(sp.service, file, symbol.qualified);
        symbolByKey.set(keyOf(file, symbol.node), id);
        byNode.set(symbol.node, id);
      }
      callers.set(sourceFile, byNode);
    }
  }

  const manifests: ManifestCache = new Map();
  const contexts = new Map<ServiceProgram, Context>();
  const contextOf = (sp: ServiceProgram): Context => {
    let context = contexts.get(sp);
    if (!context) {
      context = {
        sp,
        checker: sp.program.getTypeChecker(),
        resolveModule: createModuleResolver(sp, workspace, manifests),
      };
      contexts.set(sp, context);
    }
    return context;
  };

  /** The symbol node a declaration belongs to, if any. */
  const symbolOfDeclaration = (ctx: Context, declaration: ts.Node): string | undefined => {
    const path = ctx.sp.toRepoPath(declaration.getSourceFile().fileName);
    if (path === undefined) return undefined;
    for (let n: ts.Node | undefined = declaration; n; n = n.parent) {
      const id = symbolByKey.get(keyOf(path, n));
      if (id !== undefined) return id;
      if (!(n.parent as ts.Node | undefined) || !WRAPPER_KINDS.has(n.parent.kind)) {
        return undefined;
      }
    }
    return undefined;
  };

  const weaker = (a: Confidence, b: Confidence): Confidence => (a === "exact" ? b : a);

  /** Follow an import TypeScript couldn't resolve to a named export of the target module. */
  const resolveImport = (
    ctx: Context,
    declaration: ts.Declaration,
    member: string | undefined,
    hops: number,
  ): CallTarget | undefined => {
    const site = importOf(declaration, member);
    if (!site) return undefined;
    const resolved = ctx.resolveModule(
      site.literal.text,
      declaration.getSourceFile(),
      site.literal,
    );
    const targetSp = resolved && programOf.get(resolved.path);
    if (!resolved || !targetSp) return undefined;
    const target = contextOf(targetSp);
    const sourceFile = targetSp.program.getSourceFile(targetSp.toAbsolute(resolved.path));
    const moduleSymbol = sourceFile && target.checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return undefined;
    const exported = target.checker
      .getExportsOfModule(moduleSymbol)
      .find((s) => s.name === site.name);
    const result = exported && resolveSymbol(target, exported, hops + 1);
    return result && { id: result.id, confidence: weaker(resolved.confidence, result.confidence) };
  };

  /** Resolve a checker symbol to a symbol node, following aliases and property values. */
  const resolveSymbol = (ctx: Context, start: ts.Symbol, hops: number): CallTarget | undefined => {
    let symbol = start;
    for (let hop = hops; hop < MAX_HOPS; hop++) {
      if (symbol.flags & ts.SymbolFlags.Alias) {
        const aliased = ctx.checker.getAliasedSymbol(symbol);
        if ((aliased.declarations ?? []).length > 0) {
          symbol = aliased;
          continue;
        }
        const declaration = symbol.declarations?.[0];
        return declaration && resolveImport(ctx, declaration, undefined, hop);
      }
      const declarations = symbol.declarations ?? [];
      for (const declaration of declarations) {
        const id = symbolOfDeclaration(ctx, declaration);
        if (id !== undefined) return { id, confidence: "exact" };
      }
      let next: ts.Symbol | undefined;
      const declaration = declarations[0];
      if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
        next = ctx.checker.getShorthandAssignmentValueSymbol(declaration);
      } else if (
        declaration &&
        (ts.isPropertyAssignment(declaration) || ts.isVariableDeclaration(declaration)) &&
        declaration.initializer !== undefined &&
        ts.isIdentifier(unwrap(declaration.initializer))
      ) {
        next = ctx.checker.getSymbolAtLocation(unwrap(declaration.initializer));
      }
      if (!next || next === symbol) return undefined;
      symbol = next;
    }
    return undefined;
  };

  /** Resolve the callee of a call or `new` expression. */
  const resolveCallee = (ctx: Context, expression: ts.Expression): CallTarget | undefined => {
    const name = calleeName(expression);
    if (!name) return undefined;
    const symbol = ctx.checker.getSymbolAtLocation(name);
    if (symbol) return resolveSymbol(ctx, symbol, 0);
    // `ns.f()` where `ns` is a namespace import of a module TypeScript couldn't resolve.
    const e = unwrap(expression);
    if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
    const object = ctx.checker.getSymbolAtLocation(e.expression);
    const declaration = object?.declarations?.[0];
    if (!declaration || !ts.isNamespaceImport(declaration)) return undefined;
    return resolveImport(ctx, declaration, e.name.text, 0);
  };

  const edges = new Map<string, GraphEdge>();
  for (const sp of programs) {
    const ctx = contextOf(sp);
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      const byNode = sourceFile && callers.get(sourceFile);
      if (!sourceFile || !byNode) continue;

      const visit = (node: ts.Node, caller: string | undefined): void => {
        const owner = byNode.get(node) ?? caller;
        if (owner !== undefined && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
          const target = resolveCallee(ctx, node.expression);
          if (target && target.id !== owner) {
            const name = calleeName(node.expression) ?? node;
            const position = sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile));
            const site: SourceLocation = {
              file,
              line: position.line + 1,
              column: position.character + 1,
            };
            const id = edgeId("calls", owner, target.id);
            const existing = edges.get(id);
            if (existing) {
              existing.sites.push(site);
              if (target.confidence === "exact") existing.confidence = "exact";
            } else {
              edges.set(id, {
                id,
                kind: "calls",
                from: owner,
                to: target.id,
                confidence: target.confidence,
                sites: [site],
              });
            }
          }
        }
        ts.forEachChild(node, (child) => {
          visit(child, owner);
        });
      };
      visit(sourceFile, undefined);
    }
  }

  const sorted = [...edges.values()].sort((a, b) => compareStrings(a.id, b.id));
  for (const edge of sorted) {
    edge.sites.sort(
      (a, b) => compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column,
    );
  }
  return sorted;
}
