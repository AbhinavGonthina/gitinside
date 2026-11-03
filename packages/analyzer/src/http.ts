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
 * - `x.defaults.baseURL = …` (or `x.defaults["baseURL"]`) on the default export or an
 *   instance (M5A.3d), for requests in files that reach the assigning module through imports
 *   (M5A.5d; so a test setup file's write rebases only the tests that import it), when it is
 *   the only write to that object's `defaults` they reach, a plain `=` statement at a module's
 *   top level, and the instance is created outside any function. It replaces the `create`
 *   config's `baseURL`. The default export's assignment applies to requests in the same
 *   service only (each service is its own runtime). Module load order isn't modeled, so a
 *   top-level request in a module that runs before the assignment still gets it. Any other
 *   reached write leaves the base unknown (`null`): a second assignment, one inside a
 *   function, `+=`, replacing `x.defaults` whole, or an instance a factory makes per call. So
 *   does `create()` without a `baseURL` on axios or an instance whose reached defaults are
 *   assigned: `create` copies them when it runs, and that may be before or after the
 *   assignment.
 * - Values are traced with the checker the same way the Prisma client is: through
 *   variables, imports (workspace packages too, via the shared resolver), `export default`,
 *   CommonJS exports, `??`/`||`/`&&`, ternaries, `await`, and factory functions that return
 *   the value. A declaration typed `AxiosStatic` is axios; one typed `AxiosInstance` is an
 *   instance whose `baseURL` is unknown.
 * - Config objects are object literals, directly or through a variable. A property after
 *   the last spread is read; a property that could come from a spread (or a config the
 *   collector can't see) is unknown (`null`), never guessed. A whole config it can't see
 *   (`axios(req)`) is kept on the site, so a wrapper's caller can supply it (M5A.3c).
 * - Method strings: literals, no-substitution templates, consts holding them (imported
 *   too), properties of const object literals (`METHODS.post`), and string enum members.
 *   Lowercase is accepted; methods outside `HttpMethod` are unknown.
 * - The owner of a call is the innermost symbol containing it, or the Express routes an
 *   inline handler serves. Top-level calls have no owner but are still collected.
 *
 * Patterns not handled:
 * - Locally declared functions named `fetch` and other wrappers (`get(path)` calling
 *   `fetch(BASE + path)`) are not requests themselves; `wrappers.ts` (M2.3) inlines calls
 *   to them one level deep.
 * - Instances stored in collections, destructured (`const { get } = api`), assigned later
 *   (`this.api = axios.create()` in a TS constructor, unless the property is typed), or
 *   changed after creation other than by a `defaults.baseURL` assignment (above): interceptors
 *   rewriting URLs, `Object.assign(api.defaults, …)`, a `defaults` object held in a variable.
 * - A `defaults.baseURL` write in a module the request's file doesn't import, even when an
 *   entry point loads both (`main.ts` importing `./setup` and `./App`): the request keeps the
 *   `create` config's base, since what an entry point loads isn't modeled.
 * - Other HTTP clients (`ky`, `got`, `superagent`, `ofetch`, React Query fetchers that aren't
 *   one of the above), `XMLHttpRequest`, and `EventSource`/`WebSocket`. An SWR fetcher that
 *   wraps one of the above is inlined at the hook (`wrappers.ts`, ADR-0193).
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
import { NO_OWNERS, ownersAt, type Owners } from "./owners.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";
import {
  createValueReader,
  isConst,
  MAX_HOPS,
  objectProperty,
  ownProperty,
  weaker,
  type ConfigValue,
  type ProgramExpression,
} from "./values.js";

export type { ProgramExpression } from "./values.js";

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
  /**
   * Start of the call expression (`axios` in `axios⏎ .get(…)`), where EVALUATION.md §1 puts
   * a call site (ADR-0167).
   */
  site: SourceLocation;
  /** The code the call belongs to, before Express composition (see `owners.ts`). */
  owners: Owners;
  /** The request method, or `null` when it can't be read. */
  method: HttpMethod | null;
  /**
   * Where an unreadable method (`null`) comes from: a `method` value, a config the collector
   * can't locate, or spreads in a config literal. Wrapper inlining (M2.3) re-reads it with the
   * caller's arguments. Absent when the method is known or hidden some other way.
   */
  methodSource?: MethodSource;
  /** The URL argument or `url` config property, or `null` when it can't be read. */
  url: ProgramExpression | null;
  /**
   * The axios `baseURL` in effect: the call's own, else the instance's. `undefined` when none
   * is set (always for `fetch`), `null` when one may be set but can't be read.
   */
  baseURL: ProgramExpression | null | undefined;
  /**
   * A whole axios config the collector can't locate (`axios(req)`, `api.request(req)` with
   * `req` a parameter), and the `baseURL` of the instance it is passed to, which applies when
   * the config sets none. Wrapper inlining (M5A.3c) reads `url`, `baseURL`, and `method` from
   * the caller's argument. Absent for `fetch`, shorthand calls, and configs that are found.
   */
  config?: { value: ProgramExpression; baseURL: ProgramExpression | null | undefined };
  /**
   * For `fetch(...args)`, the one argument a spread: the array spread, whose first element is
   * the URL and second the init (so `url` and `method` are `null`). Wrapper inlining (M5B.2b)
   * reads them from the caller's arguments when it is the wrapper's rest parameter.
   */
  spread?: ProgramExpression;
  /**
   * `exact`, or the weaker confidence of a workspace-package import the axios instance was
   * reached through (M1.8).
   */
  confidence: Confidence;
}

/**
 * The expression an unreadable method comes from: the `method` value itself, the request
 * config (`fetch` init or axios config) whose `method` property couldn't be looked up, or the
 * spreads in a config literal that could override it (`{ method: "GET", ...init }`, last
 * spread first, with the `method` property before them, if any).
 */
export type MethodSource =
  | { kind: "value"; value: ProgramExpression }
  | { kind: "config"; config: ProgramExpression }
  | { kind: "spreads"; spreads: ProgramExpression[]; fallback: ProgramExpression | undefined };

/**
 * What `x.defaults.baseURL = …` assignments write to: the default export as one service's
 * program sees it, a `create` call, or a declaration typed `AxiosInstance`.
 */
type AxiosOrigin = ServiceProgram | ts.Node;

/** What an expression evaluates to when it is axios or an axios instance. */
interface AxiosValue {
  /**
   * The `baseURL` it was given (its `create` config's), before `defaults` assignments:
   * `undefined` for none, `null` for unknown. See {@link AxiosValue.parent}.
   */
  baseURL: ProgramExpression | null | undefined;
  origin: AxiosOrigin;
  /** The value `create` was called on, when its config sets no `baseURL` of its own. */
  parent?: AxiosValue;
  confidence: Confidence;
}

/** What a call site says about its request, before location and owners are added. */
type RequestShape = Omit<HttpCallSite, "sp" | "file" | "call" | "site" | "owners">;

/** The module name of `require("x")` or `require("x").default`. */
export function requiredModule(expression: ts.Expression): string | undefined {
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
export function importBinding(
  declaration: ts.Declaration,
): { module: string; name: string } | undefined {
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

/**
 * The function a callee symbol names: a declaration, or a function value held by a variable
 * or object property (`{ make }`, `{ make: () => … }`), through aliases.
 */
export function functionOf(
  checker: ts.TypeChecker,
  start: ts.Symbol,
): FunctionWithBody | undefined {
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
}

/** The location of a node's first token. */
export function locationOf(node: ts.Node, file: string): SourceLocation {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1, column: position.character + 1 };
}

/** Normalize a method string to an {@link HttpMethod} other than `ALL`, or `null`. */
export function toMethod(text: string): HttpMethod | null {
  const parsed = HttpMethod.safeParse(text.toUpperCase());
  return parsed.success && parsed.data !== "ALL" ? parsed.data : null;
}

/**
 * Collect every `fetch` and axios request in the service programs (see the file comment for
 * what is recognized). A site's owners name the inline handlers it may be in by node key, so
 * nothing here depends on the Express composition (ADR-0094). Sorted by file, line, and column.
 */
export function collectHttpCalls(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
): HttpCallSite[] {
  const sitesOf = createHttpSiteCollector(resolver);
  return programs.flatMap((sp) => sitesOf(sp)).sort(compareSites);
}

/** Sites by file, line, and column. */
const compareSites = (a: HttpCallSite, b: HttpCallSite): number =>
  compareStrings(a.file, b.file) || a.site.line - b.site.line || a.site.column - b.site.column;

/**
 * {@link collectHttpCalls} one program at a time (ADR-0177): the sites in a program's root
 * files, sorted, collected on its first call (asked as its service) and remembered. Programs
 * share one collector, so the axios values and `defaults` writes they see are the same objects.
 */
export function createHttpSiteCollector(
  resolver: SymbolResolver,
): (sp: ServiceProgram) => readonly HttpCallSite[] {
  const { symbolAt, resolveDeclaration, constString } = createValueReader(resolver);

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
    if (!isConst(d) || isMutated(found.sp, d)) return undefined;
    return configObject(found.sp, d.initializer, hops + 1);
  };

  const mutated = new Map<ts.VariableDeclaration, boolean>();

  /**
   * True when a `const` object's members are written after it is declared: `x.a = …`,
   * `x["a"] += …`, `delete x.a`, or `Object.assign(x, …)` anywhere in its file. Then a
   * property read from its literal could be stale.
   */
  const isMutated = (sp: ServiceProgram, d: ts.VariableDeclaration): boolean => {
    const known = mutated.get(d);
    if (known !== undefined) return known;
    const symbol = ts.isIdentifier(d.name) ? symbolAt(sp, d.name) : undefined;
    const names = (e: ts.Expression): boolean => {
      const target = unwrap(e);
      return ts.isIdentifier(target) && symbol !== undefined && symbolAt(sp, target) === symbol;
    };
    const member = (e: ts.Expression): boolean => {
      const target = unwrap(e);
      return (
        (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
        names(target.expression)
      );
    };
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (
        (ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          member(n.left)) ||
        (ts.isDeleteExpression(n) && member(n.expression))
      ) {
        found = true;
        return;
      }
      if (ts.isCallExpression(n)) {
        const callee = unwrap(n.expression);
        const first = n.arguments[0];
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "assign" &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "Object" &&
          first &&
          names(first)
        ) {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    if (symbol) visit(d.getSourceFile());
    mutated.set(d, found);
    return found;
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

  /**
   * The spreads that could supply an object literal's `method` (`{ method: "GET", ...init }`),
   * last first, and the `method` property before them. `undefined` when something other than
   * a spread (a computed key, a `method()` member) hides it.
   */
  const spreadMethod = (
    sp: ServiceProgram,
    object: ts.ObjectLiteralExpression,
  ): MethodSource | undefined => {
    const spreads: ProgramExpression[] = [];
    let fallback: ProgramExpression | undefined;
    for (let i = object.properties.length - 1; i >= 0; i--) {
      const property = object.properties[i];
      if (!property) continue;
      if (ts.isSpreadAssignment(property)) {
        spreads.push({ sp, expression: property.expression });
        continue;
      }
      const value = ownProperty(sp, property, "method");
      if (value === null) return undefined;
      if (value) {
        fallback = value;
        break;
      }
    }
    return { kind: "spreads", spreads, fallback };
  };

  /**
   * The `method` a config passes (absent ⇒ `fallback`), with the {@link MethodSource} of an
   * unreadable one. `config` is `null` when a spread hides it.
   */
  const configMethod = (
    sp: ServiceProgram,
    config: ts.Expression | null | undefined,
    fallback: HttpMethod,
  ): Pick<HttpCallSite, "method" | "methodSource"> => {
    if (config === null) return { method: null };
    const value = configProperty(sp, config, "method");
    const method = methodOf(value, fallback);
    if (method !== null || !config) return { method };
    if (value === null) {
      // `null` here means the config itself couldn't be located, unless it is an object
      // literal whose `method` a spread could supply.
      const object = configObject(sp, config, 0);
      if (!object) {
        return { method, methodSource: { kind: "config", config: { sp, expression: config } } };
      }
      const spreads = spreadMethod(object.sp, object.expression);
      return spreads ? { method, methodSource: spreads } : { method };
    }
    return value && constString(value.sp, value.expression, 0) === undefined
      ? { method, methodSource: { kind: "value", value } }
      : { method };
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

  const roots = new Map<AxiosOrigin, AxiosValue>();

  /** The axios default export as a program sees it: one per service, each its own runtime. */
  const axiosRoot = (sp: ServiceProgram): AxiosValue => {
    let root = roots.get(sp);
    if (!root) {
      root = { baseURL: undefined, origin: sp, confidence: "exact" };
      roots.set(sp, root);
    }
    return root;
  };

  /** What a declaration's type annotation says about axios: `AxiosStatic`, `AxiosInstance`, or neither. */
  const axiosOfType = (
    sp: ServiceProgram,
    declaration: ts.Declaration,
    type: ts.TypeNode | undefined,
  ): AxiosValue | undefined => {
    if (!type || !ts.isTypeReferenceNode(type)) return undefined;
    const name = ts.isIdentifier(type.typeName) ? type.typeName : type.typeName.right;
    if (name.text === "AxiosStatic") return axiosRoot(sp);
    if (name.text === "AxiosInstance") {
      return { baseURL: null, origin: declaration, confidence: "exact" };
    }
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
        ? axiosRoot(sp)
        : undefined;
    }
    if (
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration) ||
      ts.isParameter(declaration)
    ) {
      const typed = axiosOfType(sp, declaration, declaration.type);
      if (typed) return typed;
      const init = ts.isPropertySignature(declaration) ? undefined : declaration.initializer;
      if (!init) return undefined;
      if (requiredModule(init) === "axios") return axiosRoot(sp);
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
   * Results by factory function, like {@link axiosBySymbol}: without it, factories that each
   * return several calls of the next one are traced exponentially often.
   */
  const axiosByFactory = new Map<FunctionWithBody, AxiosValue | null>();

  /** The first axios value a factory function returns. */
  const axiosOfFactory = (
    sp: ServiceProgram,
    fn: FunctionWithBody,
    hops: number,
  ): AxiosValue | undefined => {
    const known = axiosByFactory.get(fn);
    if (known !== undefined) return known ?? undefined;
    axiosByFactory.set(fn, null);
    let result: AxiosValue | undefined;
    for (const returned of returnedExpressions(fn)) {
      result = axiosOf(sp, returned, hops + 1);
      if (result) break;
    }
    axiosByFactory.set(fn, result ?? null);
    return result;
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
    if (requiredModule(e) === "axios") return axiosRoot(sp);
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
        return {
          baseURL: own,
          origin: e,
          ...(own === undefined ? { parent } : {}),
          confidence: parent.confidence,
        };
      }
      // A factory function that returns axios or an instance.
      const name = ts.isIdentifier(callee)
        ? callee
        : ts.isPropertyAccessExpression(callee)
          ? callee.name
          : undefined;
      const symbol = name && symbolAt(sp, name);
      const fn = symbol && functionOf(resolver.checkerOf(sp), symbol);
      return fn ? axiosOfFactory(sp, fn, hops) : undefined;
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

  // ---- defaults assignments ----

  /**
   * One write to an origin's `defaults`: the repo file it is in, and its value when it can be
   * trusted (see {@link defaultsWritesIn}), else `null`.
   */
  interface DefaultsWrite {
    origin: AxiosOrigin;
    file: string;
    value: ProgramExpression | null;
  }

  /** The `defaults` writes in each root file scanned so far, in source order. */
  const writesByFile = new Map<string, DefaultsWrite[]>();

  /**
   * True when an origin is one object: the default export, or a `create` call that runs once
   * per module load (outside every function and class).
   */
  const isSingle = (origin: AxiosOrigin): boolean => {
    if (roots.has(origin)) return true;
    if (!("kind" in origin) || !ts.isCallExpression(origin)) return false;
    for (let n = origin.parent as ts.Node | undefined; n; n = n.parent as ts.Node | undefined) {
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return false;
    }
    return true;
  };

  /** The axios value whose `defaults` a write target is, and whether it is the `baseURL`. */
  const targetOf = (
    sp: ServiceProgram,
    left: ts.Expression,
  ): { value: AxiosValue; whole: boolean } | undefined => {
    const target = unwrap(left);
    let defaults: ts.Expression = target;
    let whole = true;
    if (ts.isPropertyAccessExpression(target) && target.name.text === "baseURL") {
      defaults = unwrap(target.expression);
      whole = false;
    } else if (
      ts.isElementAccessExpression(target) &&
      ts.isStringLiteralLike(target.argumentExpression) &&
      target.argumentExpression.text === "baseURL"
    ) {
      defaults = unwrap(target.expression);
      whole = false;
    }
    if (!ts.isPropertyAccessExpression(defaults) || defaults.name.text !== "defaults") {
      return undefined;
    }
    const value = axiosOf(sp, defaults.expression, 0);
    return value && { value, whole };
  };

  /**
   * Every `x.defaults.baseURL = …` (also `x.defaults["baseURL"]`) and `x.defaults = …` on
   * axios or an instance in `file`, a root file of `sp`. A plain `=` assignment that is a
   * statement of its module's top level, on the default export or on an instance created
   * outside any function (so the instance is one object), is trusted. Any other write (one
   * inside a function, `+=`, the whole `defaults` replaced, an instance a factory makes per
   * call) is not. Each file is scanned once, when a request first reaches it (ADR-0177);
   * {@link writtenBase} decides which writes a request sees.
   */
  const defaultsWritesIn = (sp: ServiceProgram, file: string): readonly DefaultsWrite[] => {
    const known = writesByFile.get(file);
    if (known) return known;
    const found: DefaultsWrite[] = [];
    writesByFile.set(file, found);
    const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
    if (!sourceFile) return found;
    // The walk asks as the service whose request started it (no `asking` here): its facts are
    // what the scan feeds, so a failure meanwhile is one of theirs (ADR-0173).
    const visit = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const target = targetOf(sp, n.left);
        if (target) {
          const { origin } = target.value;
          const trusted =
            !target.whole &&
            n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isExpressionStatement(n.parent) &&
            ts.isSourceFile(n.parent.parent) &&
            isSingle(origin);
          found.push({ origin, file, value: trusted ? { sp, expression: n.right } : null });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sourceFile);
    return found;
  };

  /** The `defaults` writes in the root files each request file reaches, built on demand. */
  const reachable = new Map<string, readonly DefaultsWrite[]>();

  /**
   * The `defaults` writes in the root files a file of `sp` reaches through imports,
   * transitively, across programs (each file's imports are resolved, and its writes scanned,
   * in the program whose root files hold it), itself included.
   */
  const writesReachedFrom = (sp: ServiceProgram, file: string): readonly DefaultsWrite[] => {
    const known = reachable.get(file);
    if (known) return known;
    const seen = new Set([file]);
    const writes: DefaultsWrite[] = [];
    const queue: { sp: ServiceProgram; file: string }[] = [{ sp, file }];
    for (let next = queue.shift(); next; next = queue.shift()) {
      writes.push(...defaultsWritesIn(next.sp, next.file));
      for (const path of resolver.importedFiles(next.sp, next.file)) {
        if (seen.has(path)) continue;
        seen.add(path);
        const owner = resolver.programOf(path, sp);
        if (owner) queue.push({ sp: owner, file: path });
      }
    }
    reachable.set(file, writes);
    return writes;
  };

  /**
   * The `defaults.baseURL` a request in `from` sees on an origin: only writes in files `from`
   * reaches through imports count (so a test or e2e setup file's write rebases only what
   * imports it, M5A.5d). `undefined` when it reaches none, the value when it reaches exactly
   * one and that one is trusted, `null` (unknown) otherwise.
   */
  const writtenBase = (
    origin: AxiosOrigin,
    from: { sp: ServiceProgram; file: string },
  ): ProgramExpression | null | undefined => {
    const seen = writesReachedFrom(from.sp, from.file).filter((w) => w.origin === origin);
    if (seen.length === 0) return undefined;
    return seen.length === 1 && seen[0] ? seen[0].value : null;
  };

  /**
   * The `baseURL` requests in `from` on an axios value start from: a trusted
   * `defaults.baseURL` assignment it sees, else what the value was created with, else (for
   * `create()` without one) its parent's, unless it sees writes to the parent's defaults
   * too: `create` copies them when it runs, and whether that is before or after the
   * assignment isn't known, so it's unknown.
   */
  const baseOf = (
    value: AxiosValue,
    from: { sp: ServiceProgram; file: string },
  ): ProgramExpression | null | undefined => {
    const assigned = writtenBase(value.origin, from);
    if (assigned !== undefined) return assigned;
    if (!value.parent) return value.baseURL;
    return writtenBase(value.parent.origin, from) !== undefined ? null : baseOf(value.parent, from);
  };

  // ---- call sites ----

  /**
   * The request an axios config describes. `url` is the URL argument, when the call has one
   * (otherwise the config's `url` is used). `method` is fixed by shorthand calls (`get`,
   * `post`, …), whose config, when unreadable, is assumed not to override the `baseURL`
   * (documented under "not handled"); otherwise it comes from the config, defaulting to `GET`.
   * `config` is `null` when it is passed but can't be located (after a spread). `from` is the
   * call's program and file.
   */
  const fromConfig = (
    from: { sp: ServiceProgram; file: string },
    instance: AxiosValue,
    config: ts.Expression | null | undefined,
    url: ProgramExpression | undefined,
    method?: HttpMethod,
  ): RequestShape => {
    const { sp } = from;
    const shorthand = method !== undefined;
    const read = (name: string): ConfigValue => {
      const value = config === null ? null : configProperty(sp, config, name);
      return value === null && shorthand ? undefined : value;
    };
    const ownBase = read("baseURL");
    const ownUrl = url ?? read("url");
    const hidden = !shorthand && url === undefined && config && !configObject(sp, config, 0);
    const instanceBase = baseOf(instance, from);
    return {
      client: "axios",
      ...(shorthand ? { method } : configMethod(sp, config, "GET")),
      url: ownUrl ?? null,
      baseURL: ownBase === undefined ? instanceBase : ownBase,
      ...(hidden ? { config: { value: { sp, expression: config }, baseURL: instanceBase } } : {}),
      confidence: instance.confidence,
    };
  };

  /** The request a call in `file` makes, if it is a `fetch` or axios request. */
  const requestOf = (
    sp: ServiceProgram,
    file: string,
    call: ts.CallExpression,
  ): RequestShape | undefined => {
    const from = { sp, file };
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
      const [only] = args;
      return {
        client: "fetch",
        ...configMethod(sp, init, "GET"),
        url,
        baseURL: undefined,
        ...(args.length === 1 && only && ts.isSpreadElement(only)
          ? { spread: { sp, expression: only.expression } }
          : {}),
        confidence: "exact",
      };
    }

    const callee = unwrap(call.expression);
    const direct = axiosOf(sp, callee, 0);
    if (direct) {
      const first = arg(0);
      if (!first) return fromConfig(from, direct, null, undefined);
      // `axios(url, config?)` when the first argument is a string, else `axios(config)`.
      if (isStringValued(sp, first))
        return fromConfig(from, direct, arg(1), { sp, expression: first });
      return fromConfig(from, direct, first, undefined);
    }

    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const name = callee.name.text;
    const shorthand = AXIOS_NO_DATA.has(name) || AXIOS_WITH_DATA.has(name);
    if (name !== "request" && !shorthand) return undefined;
    const instance = axiosOf(sp, callee.expression, 0);
    if (!instance) return undefined;
    if (!shorthand) {
      const config = arg(0);
      return fromConfig(from, instance, config ?? null, undefined);
    }
    const method = toMethod(name.replace(/Form$/, "")) ?? "GET";
    const url = urlArg(0);
    const config = arg(AXIOS_NO_DATA.has(name) ? 1 : 2);
    if (!url) return { ...fromConfig(from, instance, config, undefined, method), url: null };
    return fromConfig(from, instance, config, url, method);
  };

  /** Collect the sites in `sp`'s root files. */
  const collectIn = (sp: ServiceProgram): HttpCallSite[] => {
    const sites: HttpCallSite[] = [];
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      const byNode = sourceFile && resolver.callers.get(sourceFile);
      if (!sourceFile || !byNode) continue;

      const visit = (node: ts.Node, owners: Owners): void => {
        const current = ownersAt(file, node, byNode.get(node), owners);
        if (ts.isCallExpression(node)) {
          const request = requestOf(sp, file, node);
          if (request) {
            sites.push({
              ...request,
              sp,
              file,
              call: node,
              site: locationOf(node, file),
              owners: current,
            });
          }
        }
        ts.forEachChild(node, (child) => {
          visit(child, current);
        });
      };
      visit(sourceFile, NO_OWNERS);
    }
    return sites.sort(compareSites);
  };
  const collected = new Map<ServiceProgram, readonly HttpCallSite[]>();
  return (sp) => {
    let sites = collected.get(sp);
    if (!sites) {
      sites = resolver.asking(sp, () => collectIn(sp));
      collected.set(sp, sites);
    }
    return sites;
  };
}
