/**
 * HTTP call-site collection (M2.1): every outbound `fetch` and axios request in the repo,
 * with its method, URL expression, and base URL expression, ready for the URL normalizer
 * (M2.2) and the route matcher (M2.4). Nothing here becomes graph output yet; every
 * collected site later yields an edge, resolved or unresolved (ROADMAP M2 "no call site
 * silently dropped").
 *
 * Patterns handled:
 * - `fetch(url, init?)` where `fetch` is the global (also `window.fetch`, `globalThis.fetch`,
 *   `self.fetch`) or is imported or required from `node-fetch`, `cross-fetch`,
 *   `isomorphic-fetch`, `isomorphic-unfetch`, `unfetch`, or `undici`. `fetch(new
 *   Request(url, init))` reads the request's arguments. The method is `init.method` when it
 *   is a string the collector can read (see below), `GET` when `init` or its `method` is
 *   absent, and `null` (unknown) otherwise.
 * - The `axios` default export (`import axios from "axios"`, `import * as axios`,
 *   `import axios = require("axios")`, `require("axios")` and `require("axios").default`),
 *   and instances from `<axios or instance>.create(config)`, whose `baseURL` comes from the
 *   config, else from the instance it was created from. Requests are `x(url, config?)` when
 *   the first argument is string syntax or string-typed, else `x(config)`; `x.request(config)`,
 *`x.get|delete|head|options(url, config?)`, and
 *   `x.post|put|patch|postForm|putForm|patchForm(url, data?, config?)`. A per-call
 *   `baseURL`, `url`, or `method` in the config wins over the instance and the default
 *   (`GET`).
 * - Values are traced with the checker the same way the Prisma client is: through
 *   variables, imports (workspace packages too, via the shared resolver), `export default`,
 *   CommonJS exports, `??`/`||`/`&&`, ternaries, `await`, and factory functions that return
 *   the value. A declaration typed `AxiosStatic` is axios; one typed `AxiosInstance` is an
 *   instance whose `baseURL` is unknown.
 * - Config objects are object literals, directly or through a variable. A property after
 *   the last spread is read; a property that could come from a spread (or a config the
 *   collector can't see) is unknown (`null`), never guessed.
 * - Method strings: literals, no-substitution templates, consts holding them (imported
 *   too), properties of const object literals (`METHODS.post`), and string enum members.
 *   Lowercase is accepted; methods outside `HttpMethod` are unknown.
 * - The owner of a call is the innermost symbol containing it, or the Express routes an
 *   inline handler serves. Top-level calls have no owner but are still collected.
 *
 * Patterns not handled:
 * - Locally declared functions named `fetch` and other wrappers (`get(path)` calling
 *   `fetch(BASE + path)`) are not requests themselves; one-level inlining is M2.3.
 * - Instances stored in collections, destructured (`const { get } = api`), assigned later
 *   (`this.api = axios.create()` in a TS constructor, unless the property is typed), or
 *   changed after creation (`api.defaults.baseURL = …`, interceptors rewriting URLs).
 * - Other HTTP clients (`ky`, `got`, `superagent`, `ofetch`, SWR/React Query fetchers that
 *   aren't one of the above), `XMLHttpRequest`, and `EventSource`/`WebSocket`.
 * - `axios.all`/`axios.spread` add nothing: the requests inside are collected on their own.
 */
import ts from "typescript";
import {
  compareStrings,
  HttpMethod,
  type Confidence,
  type SourceLocation,
} from "@gitinside/schema";
import type { SymbolResolver } from "./calls.js";
import { isFunctionWithBody, returnedExpressions, type FunctionWithBody } from "./express.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";

/** How many alias, variable, or return hops are followed before giving up. */
const MAX_HOPS = 16;

/** Modules whose export (default or `fetch`) is a `fetch` function. */
const FETCH_MODULES: ReadonlySet<string> = new Set([
  "cross-fetch",
  "isomorphic-fetch",
  "isomorphic-unfetch",
  "node-fetch",
  "undici",
  "unfetch",
]);

/** Globals `fetch` can be read from. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "self", "window"]);

/** Axios shorthand methods taking `(url, config?)`. */
const AXIOS_NO_DATA: ReadonlySet<string> = new Set(["delete", "get", "head", "options"]);

/** Axios shorthand methods taking `(url, data?, config?)`. */
const AXIOS_WITH_DATA: ReadonlySet<string> = new Set([
  "patch",
  "patchForm",
  "post",
  "postForm",
  "put",
  "putForm",
]);

/** An expression and the program whose checker understands it. */
export interface ProgramExpression {
  sp: ServiceProgram;
  expression: ts.Expression;
}

/** The library that makes a request. */
export type HttpClient = "fetch" | "axios";

/**
 * One outbound HTTP request in the source. `null` means "set, but not statically readable"
 * and always leads to an unresolved edge later, never a guess.
 */
export interface HttpCallSite {
  client: HttpClient;
  /** The program the call is in. */
  sp: ServiceProgram;
  /** Repo-relative file of the call. */
  file: string;
  /** The call expression. */
  call: ts.CallExpression;
  /** Position of the callee name (`fetch`, `get`, or the instance for `api(config)`). */
  site: SourceLocation;
  /** Symbol or route node IDs the call belongs to, sorted. Empty for top-level code. */
  owners: string[];
  /** The request method, or `null` when it can't be read. */
  method: HttpMethod | null;
  /** The URL argument or `url` config property, or `null` when it can't be read. */
  url: ProgramExpression | null;
  /**
   * The axios `baseURL` in effect: the call's own, else the instance's. `undefined` when none
   * is set (always for `fetch`), `null` when one may be set but can't be read.
   */
  baseURL: ProgramExpression | null | undefined;
  /**
   * `exact`, or the weaker confidence of a workspace-package import the axios instance was
   * reached through (M1.8).
   */
  confidence: Confidence;
}

/** What an expression evaluates to when it is axios or an axios instance. */
interface AxiosValue {
  /** The instance's `baseURL`: `undefined` for none, `null` for unknown. */
  baseURL: ProgramExpression | null | undefined;
  confidence: Confidence;
}

/** A property read from a config object: absent, unknown (`null`), or its value. */
type ConfigValue = ProgramExpression | null | undefined;

/** What a call site says about its request, before location and owners are added. */
type RequestShape = Omit<HttpCallSite, "sp" | "file" | "call" | "site" | "owners">;

const weaker = (a: Confidence, b: Confidence): Confidence => (a === "exact" ? b : a);

/** The module name of `require("x")` or `require("x").default`. */
function requiredModule(expression: ts.Expression): string | undefined {
  let e = unwrap(expression);
  if (ts.isPropertyAccessExpression(e) && e.name.text === "default") e = unwrap(e.expression);
  if (
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "require" &&
    e.arguments.length === 1
  ) {
    const arg = e.arguments[0];
    if (arg && ts.isStringLiteralLike(arg)) return arg.text;
  }
  return undefined;
}

/**
 * The module and imported name an import declaration binds: `default` for default imports,
 * `*` for namespace imports and `import x = require()`.
 */
function importBinding(declaration: ts.Declaration): { module: string; name: string } | undefined {
  let statement: ts.Node | undefined;
  let name: string | undefined;
  if (ts.isImportClause(declaration)) {
    statement = declaration.parent;
    name = "default";
  } else if (ts.isNamespaceImport(declaration)) {
    statement = declaration.parent.parent;
    name = "*";
  } else if (ts.isImportSpecifier(declaration)) {
    statement = declaration.parent.parent.parent;
    name = (declaration.propertyName ?? declaration.name).text;
  } else if (ts.isImportEqualsDeclaration(declaration)) {
    const reference = declaration.moduleReference;
    if (ts.isExternalModuleReference(reference) && ts.isStringLiteralLike(reference.expression)) {
      return { module: reference.expression.text, name: "*" };
    }
    return undefined;
  }
  if (!statement || name === undefined || !ts.isImportDeclaration(statement)) return undefined;
  const specifier = statement.moduleSpecifier;
  return ts.isStringLiteralLike(specifier) ? { module: specifier.text, name } : undefined;
}

/** True when a declaration is part of the repo's own code, not a lib or `.d.ts` file. */
function isRepoCode(sp: ServiceProgram, declaration: ts.Declaration): boolean {
  const sourceFile = declaration.getSourceFile();
  return !sourceFile.isDeclarationFile && sp.toRepoPath(sourceFile.fileName) !== undefined;
}

/** The location of a node's first token. */
function locationOf(node: ts.Node, file: string): SourceLocation {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1, column: position.character + 1 };
}

/** Normalize a method string to an {@link HttpMethod} other than `ALL`, or `null`. */
function toMethod(text: string): HttpMethod | null {
  const parsed = HttpMethod.safeParse(text.toUpperCase());
  return parsed.success && parsed.data !== "ALL" ? parsed.data : null;
}

/**
 * Collect every `fetch` and axios request in the service programs (see the file comment for
 * what is recognized). `inlineHandlers` comes from the Express detector, so calls inside an
 * inline route handler belong to the route. Sorted by file, line, and column.
 */
export function collectHttpCalls(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
  inlineHandlers: ReadonlyMap<ts.Node, readonly string[]> = new Map(),
): HttpCallSite[] {
  /**
   * The checker symbol an identifier or property name refers to, before alias resolution.
   * For the name of a shorthand property (`{ method }`), the value it reads.
   */
  const symbolAt = (sp: ServiceProgram, node: ts.Node): ts.Symbol | undefined => {
    const checker = resolver.checkerOf(sp);
    const parent = node.parent as ts.Node | undefined;
    return parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(node);
  };

  // ---- constant strings (methods) ----

  /** The string an expression always holds, if the collector can tell. */
  const constString = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): string | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isIdentifier(e)) {
      const symbol = symbolAt(sp, e);
      return symbol && constStringOfSymbol(sp, symbol, hops + 1);
    }
    if (ts.isPropertyAccessExpression(e)) {
      // A string enum member, `Verb.Patch`.
      const member = symbolAt(sp, e.name)?.valueDeclaration;
      if (member && ts.isEnumMember(member)) {
        const value = resolver.checkerOf(sp).getConstantValue(member);
        return typeof value === "string" ? value : undefined;
      }
      const object = constObject(sp, e.expression, hops + 1);
      const value = object && objectProperty(object.sp, object.expression, e.name.text);
      return value ? constString(value.sp, value.expression, hops + 1) : undefined;
    }
    return undefined;
  };

  const constStringOfSymbol = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): string | undefined => {
    const declaration = resolveDeclaration(sp, start, hops);
    if (!declaration) return undefined;
    const d = declaration.declaration;
    if (ts.isVariableDeclaration(d) && d.initializer && isConst(d)) {
      return constString(declaration.sp, d.initializer, hops + 1);
    }
    return undefined;
  };

  /** True when a variable is declared with `const`. */
  const isConst = (declaration: ts.VariableDeclaration): boolean =>
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0;

  /** A const object literal an expression names (`METHODS` in `METHODS.post`). */
  const constObject = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): { sp: ServiceProgram; expression: ts.ObjectLiteralExpression } | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    if (ts.isObjectLiteralExpression(e)) return { sp, expression: e };
    if (!ts.isIdentifier(e)) return undefined;
    const symbol = symbolAt(sp, e);
    const found = symbol && resolveDeclaration(sp, symbol, hops + 1);
    const d = found?.declaration;
    if (!found || !d || !ts.isVariableDeclaration(d) || !d.initializer || !isConst(d)) {
      return undefined;
    }
    return constObject(found.sp, d.initializer, hops + 1);
  };

  /**
   * Follow an alias (including a workspace-package import TypeScript couldn't resolve) to the
   * first declaration of the symbol it names, with the program that understands it.
   */
  const resolveDeclaration = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): { sp: ServiceProgram; declaration: ts.Declaration; confidence: Confidence } | undefined => {
    if (hops > MAX_HOPS) return undefined;
    if (start.flags & ts.SymbolFlags.Alias) {
      const aliased = resolver.checkerOf(sp).getAliasedSymbol(start);
      const declaration = aliased.declarations?.[0];
      if (declaration) return { sp, declaration, confidence: "exact" };
      const alias = start.declarations?.[0];
      const target = alias && resolver.importTarget(sp, alias);
      if (!target) return undefined;
      const found = resolveDeclaration(target.sp, target.symbol, hops + 1);
      return found && { ...found, confidence: weaker(target.confidence, found.confidence) };
    }
    const declaration = start.declarations?.[0];
    return declaration && { sp, declaration, confidence: "exact" };
  };

  // ---- config objects ----

  /** The object literal a config expression is, directly or through a variable. */
  const configObject = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): { sp: ServiceProgram; expression: ts.ObjectLiteralExpression } | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    if (ts.isObjectLiteralExpression(e)) return { sp, expression: e };
    if (!ts.isIdentifier(e)) return undefined;
    const symbol = symbolAt(sp, e);
    const found = symbol && resolveDeclaration(sp, symbol, hops + 1);
    const d = found?.declaration;
    if (!found || !d || !ts.isVariableDeclaration(d) || !d.initializer) return undefined;
    return configObject(found.sp, d.initializer, hops + 1);
  };

  /**
   * A property of an object literal: its value, `undefined` when it is certainly absent, or
   * `null` when a spread or a computed key could supply it.
   */
  const objectProperty = (
    sp: ServiceProgram,
    object: ts.ObjectLiteralExpression,
    name: string,
  ): ConfigValue => {
    for (let i = object.properties.length - 1; i >= 0; i--) {
      const property = object.properties[i];
      if (!property) continue;
      if (ts.isSpreadAssignment(property)) return null;
      const key = property.name;
      if (key && ts.isComputedPropertyName(key)) {
        if (!ts.isStringLiteralLike(key.expression)) return null;
        if (key.expression.text !== name) continue;
      } else if (
        !key ||
        !(ts.isIdentifier(key) || ts.isStringLiteralLike(key)) ||
        key.text !== name
      ) {
        continue;
      }
      if (ts.isPropertyAssignment(property)) return { sp, expression: property.initializer };
      if (ts.isShorthandPropertyAssignment(property)) return { sp, expression: property.name };
      return null; // a method or accessor
    }
    return undefined;
  };

  /** A property of a config expression; `null` when the config itself can't be read. */
  const configProperty = (
    sp: ServiceProgram,
    config: ts.Expression | undefined,
    name: string,
  ): ConfigValue => {
    if (!config) return undefined;
    const object = configObject(sp, config, 0);
    return object ? objectProperty(object.sp, object.expression, name) : null;
  };

  /**
   * True when an expression is a string: string syntax (literals, templates, `+`) or a
   * string-typed value. Untyped (`any`) values are not, so `axios(x)` reads `x` as a config.
   */
  const isStringValued = (sp: ServiceProgram, expression: ts.Expression): boolean => {
    const e = unwrap(expression);
    if (
      ts.isStringLiteralLike(e) ||
      ts.isTemplateExpression(e) ||
      (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      return true;
    }
    const type = resolver.checkerOf(sp).getTypeAtLocation(e);
    const parts = type.isUnion() ? type.types : [type];
    const nullish = ts.TypeFlags.Undefined | ts.TypeFlags.Null;
    return (
      parts.some((t) => t.flags & ts.TypeFlags.StringLike) &&
      parts.every((t) => t.flags & (ts.TypeFlags.StringLike | nullish))
    );
  };

  /** The method a config property names: absent ⇒ `fallback`, unreadable ⇒ `null`. */
  const methodOf = (value: ConfigValue, fallback: HttpMethod): HttpMethod | null => {
    if (value === undefined) return fallback;
    if (value === null) return null;
    const text = constString(value.sp, value.expression, 0);
    return text === undefined ? null : toMethod(text);
  };

  // ---- fetch ----

  /** True when a callee is a `fetch` function rather than a local function of that name. */
  const isFetch = (sp: ServiceProgram, callee: ts.Expression): boolean => {
    const e = unwrap(callee);
    if (ts.isPropertyAccessExpression(e)) {
      if (e.name.text !== "fetch") return false;
      const object = unwrap(e.expression);
      if (!ts.isIdentifier(object) || !GLOBAL_OBJECTS.has(object.text)) return false;
      const symbol = symbolAt(sp, object);
      return !(symbol?.declarations ?? []).some((d) => isRepoCode(sp, d));
    }
    if (!ts.isIdentifier(e)) return false;
    const symbol = symbolAt(sp, e);
    if (!symbol) return e.text === "fetch";
    return fetchSymbol(sp, symbol, e.text === "fetch");
  };

  /**
   * True when a symbol is `fetch`: imported from a fetch module, required from one, or (when
   * `global` says the callee is spelled `fetch`) declared only outside the repo's own code.
   */
  const fetchSymbol = (sp: ServiceProgram, symbol: ts.Symbol, global: boolean): boolean => {
    const declarations = symbol.declarations ?? [];
    for (const declaration of declarations) {
      const binding = importBinding(declaration);
      if (binding) {
        return (
          FETCH_MODULES.has(binding.module) &&
          (binding.name === "default" || binding.name === "fetch" || binding.name === "*")
        );
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const init = unwrap(declaration.initializer);
        const module =
          requiredModule(init) ??
          (ts.isPropertyAccessExpression(init) && init.name.text === "fetch"
            ? requiredModule(init.expression)
            : undefined);
        if (module !== undefined) return FETCH_MODULES.has(module);
      }
    }
    return global && !declarations.some((d) => isRepoCode(sp, d));
  };

  // ---- axios ----

  const AXIOS_ROOT: AxiosValue = { baseURL: undefined, confidence: "exact" };

  /** What a type annotation says about axios: `AxiosStatic`, `AxiosInstance`, or neither. */
  const axiosOfType = (type: ts.TypeNode | undefined): AxiosValue | undefined => {
    if (!type || !ts.isTypeReferenceNode(type)) return undefined;
    const name = ts.isIdentifier(type.typeName) ? type.typeName : type.typeName.right;
    if (name.text === "AxiosStatic") return AXIOS_ROOT;
    if (name.text === "AxiosInstance") return { baseURL: null, confidence: "exact" };
    return undefined;
  };

  const axiosOfDeclaration = (
    sp: ServiceProgram,
    declaration: ts.Declaration,
    hops: number,
  ): AxiosValue | undefined => {
    const binding = importBinding(declaration);
    if (binding) {
      return binding.module === "axios" && (binding.name === "default" || binding.name === "*")
        ? AXIOS_ROOT
        : undefined;
    }
    if (
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration) ||
      ts.isParameter(declaration)
    ) {
      const typed = axiosOfType(declaration.type);
      if (typed) return typed;
      const init = ts.isPropertySignature(declaration) ? undefined : declaration.initializer;
      if (!init) return undefined;
      if (requiredModule(init) === "axios") return AXIOS_ROOT;
      return axiosOf(sp, init, hops + 1);
    }
    if (ts.isPropertyAssignment(declaration)) return axiosOf(sp, declaration.initializer, hops + 1);
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = resolver.checkerOf(sp).getShorthandAssignmentValueSymbol(declaration);
      return value && axiosOfSymbol(sp, value, hops + 1);
    }
    if (ts.isExportAssignment(declaration)) return axiosOf(sp, declaration.expression, hops + 1);
    // CommonJS: `module.exports = x` and `exports.x = y` declare on the assignment.
    if (ts.isBinaryExpression(declaration)) return axiosOf(sp, declaration.right, hops + 1);
    const parent = declaration.parent as ts.Node | undefined;
    if (
      ts.isPropertyAccessExpression(declaration) &&
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === declaration
    ) {
      return axiosOf(sp, parent.right, hops + 1);
    }
    return undefined;
  };

  /**
   * Results by symbol (each symbol belongs to one program's checker). A symbol being traced
   * maps to `null`, so cycles stop. Visiting order is fixed, so results stay deterministic.
   */
  const axiosBySymbol = new Map<ts.Symbol, AxiosValue | null>();

  const axiosOfSymbol = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): AxiosValue | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const known = axiosBySymbol.get(start);
    if (known !== undefined) return known ?? undefined;
    axiosBySymbol.set(start, null);
    const result = traceAxiosSymbol(sp, start, hops);
    axiosBySymbol.set(start, result ?? null);
    return result;
  };

  const traceAxiosSymbol = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): AxiosValue | undefined => {
    let symbol = start;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      // Check the import (or, in JS files, the `require`) itself first: `axios` has no
      // declarations without `node_modules`.
      const own = symbol.declarations?.[0];
      const direct = own && axiosOfDeclaration(sp, own, hops);
      if (direct) return direct;
      const aliased = resolver.checkerOf(sp).getAliasedSymbol(symbol);
      if ((aliased.declarations ?? []).length === 0) {
        const target = own && resolver.importTarget(sp, own);
        const found = target && axiosOfSymbol(target.sp, target.symbol, hops + 1);
        return found && target
          ? { ...found, confidence: weaker(target.confidence, found.confidence) }
          : undefined;
      }
      symbol = aliased;
    }
    for (const declaration of symbol.declarations ?? []) {
      const found = axiosOfDeclaration(sp, declaration, hops);
      if (found) return found;
    }
    return undefined;
  };

  /**
   * The function a callee symbol names: a declaration, or a function value held by a
   * variable or object property (`{ make }`, `{ make: () => … }`), through aliases.
   */
  const functionOf = (sp: ServiceProgram, start: ts.Symbol): FunctionWithBody | undefined => {
    const checker = resolver.checkerOf(sp);
    let symbol: ts.Symbol | undefined = start;
    for (let hop = 0; symbol && hop < MAX_HOPS; hop++) {
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration: ts.Declaration | undefined = symbol.valueDeclaration;
      if (!declaration) return undefined;
      if (isFunctionWithBody(declaration)) return declaration;
      if (ts.isShorthandPropertyAssignment(declaration)) {
        symbol = checker.getShorthandAssignmentValueSymbol(declaration);
        continue;
      }
      const init =
        (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) &&
        declaration.initializer
          ? unwrap(declaration.initializer)
          : undefined;
      if (!init) return undefined;
      if (isFunctionWithBody(init)) return init;
      symbol = ts.isIdentifier(init) ? checker.getSymbolAtLocation(init) : undefined;
    }
    return undefined;
  };

  /** What an expression is when it is axios or an axios instance. */
  const axiosOf = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): AxiosValue | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    if (ts.isAwaitExpression(e)) return axiosOf(sp, e.expression, hops + 1);
    if (requiredModule(e) === "axios") return AXIOS_ROOT;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return axiosOf(sp, e.left, hops + 1) ?? axiosOf(sp, e.right, hops + 1);
      }
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        return axiosOf(sp, e.right, hops + 1);
      }
      return undefined;
    }
    if (ts.isConditionalExpression(e)) {
      return axiosOf(sp, e.whenTrue, hops + 1) ?? axiosOf(sp, e.whenFalse, hops + 1);
    }
    if (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression);
      // `axios.create(config)` or `instance.create(config)`.
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "create") {
        const parent = axiosOf(sp, callee.expression, hops + 1);
        if (!parent) return undefined;
        const own = configProperty(sp, e.arguments[0], "baseURL");
        return { baseURL: own === undefined ? parent.baseURL : own, confidence: parent.confidence };
      }
      // A factory function that returns axios or an instance.
      const name = ts.isIdentifier(callee)
        ? callee
        : ts.isPropertyAccessExpression(callee)
          ? callee.name
          : undefined;
      const symbol = name && symbolAt(sp, name);
      const fn = symbol && functionOf(sp, symbol);
      if (!fn) return undefined;
      for (const returned of returnedExpressions(fn)) {
        const found = axiosOf(sp, returned, hops + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const symbol = symbolAt(sp, ts.isIdentifier(e) ? e : e.name);
      if (symbol) return axiosOfSymbol(sp, symbol, hops + 1);
      if (ts.isPropertyAccessExpression(e)) {
        const object = unwrap(e.expression);
        // `axios.default` under `import * as axios` or `require("axios")`.
        if (e.name.text === "default") {
          const inner = axiosOf(sp, object, hops + 1);
          if (inner) return inner;
        }
        // `http.api` where `http` is a namespace import of a workspace package.
        if (ts.isIdentifier(object)) {
          const declaration = symbolAt(sp, object)?.declarations?.[0];
          if (declaration && ts.isNamespaceImport(declaration)) {
            const target = resolver.importTarget(sp, declaration, e.name.text);
            const found = target && axiosOfSymbol(target.sp, target.symbol, hops + 1);
            return found && target
              ? { ...found, confidence: weaker(target.confidence, found.confidence) }
              : undefined;
          }
        }
      }
    }
    return undefined;
  };

  // ---- call sites ----

  const sites: HttpCallSite[] = [];

  /**
   * The request an axios config describes. `url` is the URL argument, when the call has one
   * (otherwise the config's `url` is used). `method` is fixed by shorthand calls (`get`,
   * `post`, …), whose config, when unreadable, is assumed not to override the `baseURL`
   * (documented under "not handled"); otherwise it comes from the config, defaulting to `GET`.
   * `config` is `null` when it is passed but can't be located (after a spread).
   */
  const fromConfig = (
    sp: ServiceProgram,
    instance: AxiosValue,
    config: ts.Expression | null | undefined,
    url: ProgramExpression | undefined,
    method?: HttpMethod,
  ): RequestShape => {
    const shorthand = method !== undefined;
    const read = (name: string): ConfigValue => {
      const value = config === null ? null : configProperty(sp, config, name);
      return value === null && shorthand ? undefined : value;
    };
    const ownBase = read("baseURL");
    const ownUrl = url ?? read("url");
    return {
      client: "axios",
      method: method ?? methodOf(read("method"), "GET"),
      url: ownUrl ?? null,
      baseURL: ownBase === undefined ? instance.baseURL : ownBase,
      confidence: instance.confidence,
    };
  };

  /** The request a call makes, if it is a `fetch` or axios request. */
  const requestOf = (sp: ServiceProgram, call: ts.CallExpression): RequestShape | undefined => {
    const args = call.arguments;
    /** Argument `i`, `null` when a spread comes at or before it, `undefined` when absent. */
    const arg = (i: number): ts.Expression | null | undefined => {
      if (args.slice(0, i + 1).some((a) => ts.isSpreadElement(a))) return null;
      return args[i];
    };
    const urlArg = (i: number): ProgramExpression | null => {
      const e = arg(i);
      return e ? { sp, expression: e } : null;
    };

    if (isFetch(sp, call.expression)) {
      let url = urlArg(0);
      let init = arg(1);
      const first = url && unwrap(url.expression);
      // `fetch(new Request(url, init))`; an init passed to `fetch` itself wins.
      if (
        first &&
        ts.isNewExpression(first) &&
        ts.isIdentifier(first.expression) &&
        first.expression.text === "Request"
      ) {
        const inner = first.arguments ?? [];
        const spread = inner.findIndex((a) => ts.isSpreadElement(a));
        const innerUrl = spread === 0 ? undefined : inner[0];
        url = innerUrl ? { sp, expression: innerUrl } : null;
        if (init === undefined) init = spread !== -1 && spread <= 1 ? null : inner[1];
      }
      const method = init === null ? null : methodOf(configProperty(sp, init, "method"), "GET");
      return { client: "fetch", method, url, baseURL: undefined, confidence: "exact" };
    }

    const callee = unwrap(call.expression);
    const direct = axiosOf(sp, callee, 0);
    if (direct) {
      const first = arg(0);
      if (!first) return fromConfig(sp, direct, null, undefined);
      // `axios(url, config?)` when the first argument is a string, else `axios(config)`.
      if (isStringValued(sp, first))
        return fromConfig(sp, direct, arg(1), { sp, expression: first });
      return fromConfig(sp, direct, first, undefined);
    }

    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const name = callee.name.text;
    const shorthand = AXIOS_NO_DATA.has(name) || AXIOS_WITH_DATA.has(name);
    if (name !== "request" && !shorthand) return undefined;
    const instance = axiosOf(sp, callee.expression, 0);
    if (!instance) return undefined;
    if (!shorthand) {
      const config = arg(0);
      return fromConfig(sp, instance, config ?? null, undefined);
    }
    const method = toMethod(name.replace(/Form$/, "")) ?? "GET";
    const url = urlArg(0);
    const config = arg(AXIOS_NO_DATA.has(name) ? 1 : 2);
    if (!url) return { ...fromConfig(sp, instance, config, undefined, method), url: null };
    return fromConfig(sp, instance, config, url, method);
  };

  for (const sp of programs) {
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      const byNode = sourceFile && resolver.callers.get(sourceFile);
      if (!sourceFile || !byNode) continue;

      const visit = (node: ts.Node, owners: readonly string[]): void => {
        const symbol = byNode.get(node);
        const current = inlineHandlers.get(node) ?? (symbol !== undefined ? [symbol] : owners);
        if (ts.isCallExpression(node)) {
          const request = requestOf(sp, node);
          if (request) {
            const callee = unwrap(node.expression);
            const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
            sites.push({
              ...request,
              sp,
              file,
              call: node,
              site: locationOf(name, file),
              owners: [...current].sort(compareStrings),
            });
          }
        }
        ts.forEachChild(node, (child) => {
          visit(child, current);
        });
      };
      visit(sourceFile, []);
    }
  }

  return sites.sort(
    (a, b) =>
      compareStrings(a.file, b.file) || a.site.line - b.site.line || a.site.column - b.site.column,
  );
}
