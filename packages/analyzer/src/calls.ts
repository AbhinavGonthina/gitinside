import ts from "typescript";
import {
  compareStrings,
  edgeId,
  type AnalysisWarning,
  type CallSite,
  type Confidence,
  type GraphEdge,
} from "@gitinside/schema";
import { errorText } from "./failures.js";
import { createModuleResolver, type ManifestCache } from "./imports.js";
import type { ServiceProgram } from "./program.js";
import { extractSymbols, symbolNodeId, unwrap } from "./symbols.js";
import type { Workspace } from "./workspace.js";

/** How many alias, re-export, or property-value hops are followed before giving up. */
const MAX_HOPS = 8;

/** A callee resolved to a symbol node. */
export interface CallTarget {
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
export function calleeName(expression: ts.Expression): ts.Node | undefined {
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

/** A stable key for a node: repo path, kind, and span. Equal across programs loading the file. */
export function nodeKey(path: string, node: ts.Node): string {
  return `${path}:${node.kind}:${node.pos}:${node.end}`;
}

/**
 * A checker whose `getSymbolAtLocation` answers `undefined` (no symbol known) and whose
 * `getTypeAtLocation` answers `any` (no type known) instead of throwing, calling `failed`
 * with the node and error. TypeScript itself can crash on code it doesn't expect: 5.6 throws
 * inside it while printing the type of a getter-only property for an error message under
 * `exactOptionalPropertyTypes` (zod's bundled `safeParse` result, M5.8c). One such
 * expression in a repo should cost that expression, not the analysis or a whole stage.
 * Other checker methods take symbols or work on these answers and pass through unguarded.
 */
export function guardedChecker(
  checker: ts.TypeChecker,
  failed: (node: ts.Node, error: unknown) => void,
): ts.TypeChecker {
  return {
    ...checker,
    getSymbolAtLocation(node) {
      try {
        return checker.getSymbolAtLocation(node);
      } catch (error) {
        failed(node, error);
        return undefined;
      }
    },
    getTypeAtLocation(node) {
      try {
        return checker.getTypeAtLocation(node);
      } catch (error) {
        failed(node, error);
        return checker.getAnyType();
      }
    },
  };
}

/** Resolves expressions to symbol nodes across all service programs. */
export interface SymbolResolver {
  /**
   * The program whose root files include `path` (repo-relative), if any, for use by the
   * analysis of `from`'s service (recorded in {@link reached}).
   */
  programOf(path: string, from: ServiceProgram): ServiceProgram | undefined;
  /**
   * Programs other than `sp` that the analysis of `sp`'s service has reached so far, through
   * {@link importTarget} (also inside {@link resolve}) or {@link programOf}. Their inputs are
   * inputs of `sp`'s facts too (`serviceInputs` in `inputs.ts`), so detectors must reach
   * other services' programs only through those two methods.
   */
  reached(sp: ServiceProgram): ReadonlySet<ServiceProgram>;
  /**
   * The type checker of a program, created once. Its `getSymbolAtLocation` and
   * `getTypeAtLocation` never throw (see {@link guardedChecker}); expressions they failed on
   * are listed by {@link warnings}.
   */
  checkerOf(sp: ServiceProgram): ts.TypeChecker;
  /**
   * One `TYPESCRIPT_INTERNAL_ERROR` warning per expression TypeScript threw on so far, so
   * call this after the last stage that uses a checker.
   */
  warnings(): AnalysisWarning[];
  /** Symbol node IDs by declaration node, per root source file. */
  callers: ReadonlyMap<ts.SourceFile, ReadonlyMap<ts.Node, string>>;
  /**
   * The symbol node a callee or value expression (`f`, `a.b.m`, `a["m"]`) names, as seen
   * from `sp`. See {@link buildCallEdges} for what is followed.
   */
  resolve(sp: ServiceProgram, expression: ts.Expression): CallTarget | undefined;
  /**
   * For an import alias TypeScript couldn't resolve (a workspace package import), the
   * exported symbol it names in the target program, with the import's confidence. `member`
   * is the property read from a namespace import.
   */
  importTarget(
    sp: ServiceProgram,
    declaration: ts.Declaration,
    member?: string,
  ): ImportTarget | undefined;
}

/** An exported symbol reached through an import TypeScript couldn't resolve. */
export interface ImportTarget {
  sp: ServiceProgram;
  symbol: ts.Symbol;
  confidence: Confidence;
}

/**
 * Create a {@link SymbolResolver} over every service program. Each program's checker and
 * module resolver are created on first use.
 */
export function createSymbolResolver(
  programs: readonly ServiceProgram[],
  workspace: Workspace,
): SymbolResolver {
  // Symbol nodes by declaration key (shared across programs that load the same file),
  // and by declaration node within each root file (to find callers).
  const symbolByKey = new Map<string, string>();
  const callers = new Map<ts.SourceFile, Map<ts.Node, string>>();
  const programByFile = new Map<string, ServiceProgram>();
  for (const sp of programs) {
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      if (!sourceFile) continue;
      programByFile.set(file, sp);
      const byNode = new Map<ts.Node, string>();
      for (const symbol of extractSymbols(sourceFile)) {
        const id = symbolNodeId(sp.service, file, symbol.qualified);
        symbolByKey.set(nodeKey(file, symbol.node), id);
        byNode.set(symbol.node, id);
      }
      callers.set(sourceFile, byNode);
    }
  }

  const reached = new Map<ServiceProgram, Set<ServiceProgram>>();
  /** Record that `from`'s analysis used `to`'s program; returns `to`. */
  const reach = <T extends ServiceProgram | undefined>(from: ServiceProgram, to: T): T => {
    if (to && to !== from) {
      const set = reached.get(from);
      if (set) set.add(to);
      else reached.set(from, new Set([to]));
    }
    return to;
  };

  const manifests: ManifestCache = new Map();
  const failures = new Map<string, AnalysisWarning>();
  const contexts = new Map<ServiceProgram, Context>();
  const contextOf = (sp: ServiceProgram): Context => {
    let context = contexts.get(sp);
    if (!context) {
      const failed = (node: ts.Node, error: unknown): void => {
        const sourceFile = node.getSourceFile();
        const file = sp.toRepoPath(sourceFile.fileName);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const at = `${line + 1}:${character + 1}`;
        const key = `${file ?? ""}:${at}`;
        if (failures.has(key)) return;
        failures.set(key, {
          code: "TYPESCRIPT_INTERNAL_ERROR",
          message: `TypeScript failed on the expression at ${at} (${errorText(error, sp.toAbsolute(""))}); what it names is treated as unknown`,
          ...(file === undefined ? {} : { file }),
        });
      };
      context = {
        sp,
        checker: guardedChecker(sp.program.getTypeChecker(), failed),
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
      const id = symbolByKey.get(nodeKey(path, n));
      if (id !== undefined) return id;
      if (!(n.parent as ts.Node | undefined) || !WRAPPER_KINDS.has(n.parent.kind)) {
        return undefined;
      }
    }
    return undefined;
  };

  const weaker = (a: Confidence, b: Confidence): Confidence => (a === "exact" ? b : a);

  /** The named export of the target module an import TypeScript couldn't resolve points at. */
  const importTarget = (
    ctx: Context,
    declaration: ts.Declaration,
    member: string | undefined,
  ): ImportTarget | undefined => {
    const site = importOf(declaration, member);
    if (!site) return undefined;
    const resolved = ctx.resolveModule(
      site.literal.text,
      declaration.getSourceFile(),
      site.literal,
    );
    const targetSp = resolved && reach(ctx.sp, programByFile.get(resolved.path));
    if (!resolved || !targetSp) return undefined;
    const checker = contextOf(targetSp).checker;
    const sourceFile = targetSp.program.getSourceFile(targetSp.toAbsolute(resolved.path));
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return undefined;
    const exported = checker.getExportsOfModule(moduleSymbol).find((s) => s.name === site.name);
    return exported && { sp: targetSp, symbol: exported, confidence: resolved.confidence };
  };

  /** Follow an import TypeScript couldn't resolve to a named export of the target module. */
  const resolveImport = (
    ctx: Context,
    declaration: ts.Declaration,
    member: string | undefined,
    hops: number,
  ): CallTarget | undefined => {
    const target = importTarget(ctx, declaration, member);
    const result = target && resolveSymbol(contextOf(target.sp), target.symbol, hops + 1);
    return (
      result &&
      target && { id: result.id, confidence: weaker(target.confidence, result.confidence) }
    );
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

  /** Resolve a callee or value expression to a symbol node. */
  const resolve = (sp: ServiceProgram, expression: ts.Expression): CallTarget | undefined => {
    const ctx = contextOf(sp);
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

  return {
    programOf: (path, from) => reach(from, programByFile.get(path)),
    reached: (sp) => reached.get(sp) ?? new Set(),
    checkerOf: (sp) => contextOf(sp).checker,
    warnings: () => [...failures.values()],
    callers,
    resolve,
    importTarget: (sp, declaration, member) => importTarget(contextOf(sp), declaration, member),
  };
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
 * every call site (the callee name's position) listed. Each site records how many arguments
 * the call passes (`args`; `new C` without parentheses passes 0), except when an argument is
 * a spread (`f(...xs)`), whose length isn't known statically.
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
  resolver: SymbolResolver,
): GraphEdge[] {
  const edges = new Map<string, GraphEdge>();
  for (const sp of programs) {
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      const byNode = sourceFile && resolver.callers.get(sourceFile);
      if (!sourceFile || !byNode) continue;

      const visit = (node: ts.Node, caller: string | undefined): void => {
        const owner = byNode.get(node) ?? caller;
        if (owner !== undefined && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
          const target = resolver.resolve(sp, node.expression);
          if (target && target.id !== owner) {
            const name = calleeName(node.expression) ?? node;
            const position = sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile));
            const args = node.arguments ?? [];
            const site: CallSite = {
              file,
              line: position.line + 1,
              column: position.character + 1,
              ...(args.some(ts.isSpreadElement) ? {} : { args: args.length }),
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
