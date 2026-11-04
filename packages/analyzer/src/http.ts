/**
 * HTTP call-site collection (M2.1): every outbound `fetch`, axios, ofetch, and ky request in the repo,
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
 * - ofetch (M5C.3c, ADR-0205), from its documented API: `ofetch` or `$fetch` imported from
 *   `ofetch` (named, renamed, or as `of.ofetch` under `import * as of`), and instances from
 *   `<ofetch or instance>.create(options)`, which merge `options` over the defaults of what they
 *   are called on. Requests are `x(url, options?)` and `x.raw(url, options?)`, their method
 *   the call's `method`, else the instance's, else `GET`, and their `baseURL` the call's, else
 *   the instance's. The base joins the URL as ofetch's (ufo's `withBase`): as axios's, except
 *   that a URL already starting with a literal base is left alone. `x.native(url, init?)` is
 *   the platform's `fetch`, without base or default method.
 * - ky (M5C.3e, ADR-0207), from its documented API (ky 1 and ky 2): the default export of `ky`
 *   (also `k.default` under `import * as k`), and instances from `<ky or instance>.extend(options)`,
 *   which merges `options` over the defaults of what it is called on, and `.create(options)`,
 *   which starts from ky's own defaults. Requests are `x(url, options?)`, its method the call's
 *   `method`, else the instance's, else `GET`, and `x.get|post|put|patch|delete|head(url,
 *   options?)`, which set the method. The base is the call's `prefixUrl` (ky 1), `prefix`, or
 *   `baseUrl` (ky 2), else the instance's, each joined as ky does (`url.ts`): `prefixUrl` and
 *   `prefix` by plain string joining with one `/`, `prefixUrl` refusing a URL that starts with
 *   `/` (ky throws, so it's unresolved with that reason), and `baseUrl` by URL resolution.
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
 * - RTK Query endpoints (ADR-0196): `build.query|mutation|infiniteQuery({ query })` (or
 *   `query(…)` destructured from the builder, `({ query, mutation: send }) => …`) inside
 *   the `endpoints` function (arrow or method) of `createApi(options)` or of
 *   `api.injectEndpoints(options)` (`api` a `const` holding a `createApi` call, imported too),
 *   with `createApi` imported from `@reduxjs/toolkit/query` or `@reduxjs/toolkit/query/react`
 *   and a `baseQuery` that is `fetchBaseQuery(config)` from there (directly, through a
 *   `const`, or inside RTK's `retry`). fetchBaseQuery makes the `fetch`, so each value `query`
 *   returns (an arrow, function, or method; named or inline) is one request at the endpoint's
 *   `build.query(…)` call: a string is the URL, an object literal its `url` and `method`
 *   (absent: `GET`, the `Request` default). `baseUrl` joins like axios's `baseURL` (RTK's
 *   `joinUrls` drops the same slashes). The query function's parameters are holes, so one that
 *   leads the URL is `DYNAMIC_URL`. An unreadable definition or return value is a request with
 *   no URL, never a guess. A `baseQuery` that is a repo function passing its first parameter
 *   on unchanged to a `fetchBaseQuery` result's call (RTK's documented re-authorization
 *   wrapper, `(args, api, extraOptions) => rawBaseQuery(args, api, extraOptions)`, also inside
 *   a nested callback or `retry`) counts as that `fetchBaseQuery` (M5C.2): every other use of
 *   the parameter only reads it (`args.url`, `typeof args`, a comparison), and all its forwards
 *   go to one `fetchBaseQuery`. Under any other `baseQuery` (one that rewrites, reassigns, or
 *   hands on its arguments, picks between bases, or can't be read), each endpoint with a
 *   `query` is one request with no URL or method, `DYNAMIC_URL` saying the base query isn't
 *   followed (M5B.7b): shown, not dropped.
 * - A call of a `fetchBaseQuery` result in repo code (M5C.2; the re-auth wrapper's
 *   `rawBaseQuery("/auth/refresh", api, extraOptions)`) is a request read from its first
 *   argument like a `query` value, joined to that `fetchBaseQuery`'s `baseUrl`, in a service
 *   whose program imports RTK Query. A first argument that is a parameter of the enclosing
 *   function is the forwarding call above and makes no request of its own.
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
 * - Other HTTP clients (`got`, `superagent`), `XMLHttpRequest`, and
 *   `EventSource`/`WebSocket`. An SWR fetcher that wraps one of the above is inlined at the
 *   hook (`wrappers.ts`, ADR-0193).
 * - ofetch: Nuxt's global `$fetch` and `useFetch` (auto-imported, never imported from
 *   `ofetch`; Vue is outside v1), `require("ofetch")`, `createFetch`, the old `ohmyfetch`
 *   package, a declaration typed `$Fetch` without a traced value, `onRequest` interceptors
 *   that change the request, and a `query`/`params` option (paths only are matched). Options
 *   the collector can't see (a parameter, a spread hiding `baseURL`) are assumed not to set a
 *   `baseURL`, as for axios's shorthand calls.
 * - ky: `require("ky")` and `ky-universal`, `extend` given a function (both bases and the
 *   method unknown), `ky.query` (the `QUERY` method isn't an `HttpMethod`), a `Request` object
 *   as the input (ky ignores the bases then; read as a URL it's unreadable), `hooks.beforeRequest`
 *   that change the request, `searchParams` (paths only are matched), and more than one of
 *   `prefixUrl`, `prefix`, and `baseUrl` in effect at once (unresolved, saying so). Options the
 *   collector can't see are assumed not to set a base, as for ofetch.
 * - TanStack Query (ADR-0196): a `queryFn` is read like any other function, so
 *   `queryFn: () => fetch("/api/todos")` or a call to a wrapper there resolves, but a URL read
 *   from the key in its context (`({ queryKey }) => fetch(queryKey[0])`, also a `QueryClient`'s
 *   default `queryFn`) stays `DYNAMIC_URL`: which key reaches it isn't followed.
 * - RTK Query: what a custom `baseQuery` other than a forwarding wrapper does with an
 *   endpoint's `query` (the endpoint is unresolved, above; the base query's own `fetch` or
 *   axios calls are collected as usual), a wrapper that rewrites the arguments before
 *   forwarding them (`{ ...args, url: "/v2" + args.url }`: the rewritten call is an unreadable
 *   request of its own) or logs them (`log(args)` counts as handing them on), a destructured
 *   first parameter, `fetchBaseQuery` options other than `baseUrl` (a default `method` in its
 *   fetch options, `paramsSerializer`), `buildCreateApi`/`createApi` reached other than by a
 *   plain import, a builder destructured anywhere but in the `endpoints` function's parameter
 *   (`const { query } = build`) or passed on to a helper, a repo helper that takes a URL and
 *   passes it to a `fetchBaseQuery` result (`get(path) { return rawBaseQuery(path, …) }`: a
 *   parameter there reads as forwarding, so no request), a `fetchBaseQuery` result called in a
 *   service whose program has no RTK Query import (one imported from another package), a
 *   `queryFn` endpoint, `enhanceEndpoints`, and the generated hooks (`useGetPostsQuery`): the
 *   request is drawn from the API slice that defines the endpoint, not from the components
 *   that call its hook.
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
import { DYNAMIC_URL_DETAIL, type DynamicUrlDetail } from "./url.js";
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

/** Modules RTK Query's `createApi`, `fetchBaseQuery`, and `retry` are imported from. */
const RTK_QUERY_MODULES: ReadonlySet<string> = new Set([
  "@reduxjs/toolkit/query",
  "@reduxjs/toolkit/query/react",
]);

/** The endpoint builder's methods that define an endpoint from a `query` option. */
const RTK_ENDPOINT_KINDS: ReadonlySet<string> = new Set(["infiniteQuery", "mutation", "query"]);

/** What ofetch's `ofetch` module exports as its fetch function (M5C.3c). */
const OFETCH_EXPORTS: ReadonlySet<string> = new Set(["$fetch", "ofetch"]);

/** ky's shorthand methods (M5C.3e), each making a request with its own name as the method. */
const KY_METHODS: ReadonlySet<string> = new Set(["delete", "get", "head", "patch", "post", "put"]);

/** The library that makes a request. */
export type HttpClient = "fetch" | "axios" | "ofetch" | "ky";

/**
 * How a site's `baseURL` joins its URL, when not as axios's does (see `url.ts`): ofetch's
 * `withBase`, ky 1's `prefixUrl`, ky 2's `prefix`, or ky 2's `baseUrl`.
 */
export type BaseJoin = "withBase" | "kyPrefixUrl" | "kyPrefix" | "kyBaseUrl";

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
   * Why `url` is `null` when the collector knows more than "unreadable" (an RTK Query endpoint
   * under a base query it doesn't follow); the URL normalizer reports it as the `DYNAMIC_URL`
   * detail. Absent otherwise.
   */
  urlDetail?: DynamicUrlDetail;
  /**
   * The axios `baseURL` in effect: the call's own, else the instance's. `undefined` when none
   * is set (always for `fetch`), `null` when one may be set but can't be read.
   */
  baseURL: ProgramExpression | null | undefined;
  /**
   * `withBase` for ofetch, whose join (ufo's `withBase`) leaves a URL that already starts with
   * the base alone, and ky's three joins (M5C.3e); absent for axios's join (see `url.ts`).
   */
  baseJoin?: BaseJoin;
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

/** What an expression evaluates to when it is ofetch's fetch function or an instance (M5C.3c). */
interface OfetchValue {
  /** The default `baseURL` its `create` options set: `undefined` for none, `null` for unknown. */
  baseURL: ProgramExpression | null | undefined;
  /** The default `method` its `create` options set, likewise. */
  method: ConfigValue;
  confidence: Confidence;
}

/** ky's options that set a base for the input (M5C.3e): ky 1's, then ky 2's. */
const KY_BASES = ["prefixUrl", "prefix", "baseUrl"] as const;

/** What an expression evaluates to when it is ky or a ky instance (M5C.3e). */
interface KyValue {
  /**
   * The defaults its `create`/`extend` options set for `prefixUrl`, `prefix`, `baseUrl`, and
   * `method`: `undefined` for none, `null` for unknown.
   */
  defaults: Record<(typeof KY_BASES)[number] | "method", ConfigValue>;
  confidence: Confidence;
}

/** A `fetchBaseQuery(config)` call (RTK Query) a base query comes from. */
interface FetchBaseQuery {
  sp: ServiceProgram;
  call: ts.CallExpression;
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
 * Collect every `fetch`, axios, ofetch, and ky request in the service programs (see the file comment for
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

  // ---- client values (axios, ofetch, ky) ----

  /**
   * Where a client library's own values come from (M5C.3c): its imports and `require`s, type
   * annotations, and `x.create(options)` (or its other {@link ClientLibrary.creators}).
   * Everything else (variables, imports across the repo, factories, `??`, `await`) is traced
   * the same way for every library by {@link createTracer}.
   */
  interface ClientLibrary<V extends { confidence: Confidence }> {
    /** The methods that make an instance from one of its values (`create`, ky's `extend`). */
    creators: ReadonlySet<string>;
    /** What an import binding of a module is (`*` for a namespace, else the export's name). */
    imported(sp: ServiceProgram, binding: { module: string; name: string }): V | undefined;
    /** What `require(module)` (or its `.default`) is. */
    required(sp: ServiceProgram, module: string): V | undefined;
    /** What a declaration's type annotation says. */
    typed(
      sp: ServiceProgram,
      declaration: ts.Declaration,
      type: ts.TypeNode | undefined,
    ): V | undefined;
    /** What `creator(options)` (one of {@link creators}) called on one of its values makes. */
    created(sp: ServiceProgram, call: ts.CallExpression, parent: V, creator: string): V;
  }

  /** `create` only: axios's and ofetch's instance maker. */
  const CREATE: ReadonlySet<string> = new Set(["create"]);

  /**
   * A function telling what an expression is when it is one of `lib`'s values: traced with the
   * checker through variables, imports (workspace packages too, via the shared resolver),
   * `export default`, CommonJS exports, `??`/`||`/`&&`, ternaries, `await`, `create` calls, and
   * factory functions that return the value.
   */
  const createTracer = <V extends { confidence: Confidence }>(
    lib: ClientLibrary<V>,
  ): ((sp: ServiceProgram, expression: ts.Expression, hops: number) => V | undefined) => {
    const ofDeclaration = (
      sp: ServiceProgram,
      declaration: ts.Declaration,
      hops: number,
    ): V | undefined => {
      const binding = importBinding(declaration);
      if (binding) return lib.imported(sp, binding);
      if (
        ts.isVariableDeclaration(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isPropertySignature(declaration) ||
        ts.isParameter(declaration)
      ) {
        const typed = lib.typed(sp, declaration, declaration.type);
        if (typed) return typed;
        const init = ts.isPropertySignature(declaration) ? undefined : declaration.initializer;
        if (!init) return undefined;
        const module = requiredModule(init);
        const required = module === undefined ? undefined : lib.required(sp, module);
        return required ?? valueOf(sp, init, hops + 1);
      }
      if (ts.isPropertyAssignment(declaration)) {
        return valueOf(sp, declaration.initializer, hops + 1);
      }
      if (ts.isShorthandPropertyAssignment(declaration)) {
        const value = resolver.checkerOf(sp).getShorthandAssignmentValueSymbol(declaration);
        return value && ofSymbol(sp, value, hops + 1);
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

    /**
     * Results by symbol (each symbol belongs to one program's checker). A symbol being traced
     * maps to `null`, so cycles stop. Visiting order is fixed, so results stay deterministic.
     */
    const bySymbol = new Map<ts.Symbol, V | null>();

    const ofSymbol = (sp: ServiceProgram, start: ts.Symbol, hops: number): V | undefined => {
      if (hops > MAX_HOPS) return undefined;
      const known = bySymbol.get(start);
      if (known !== undefined) return known ?? undefined;
      bySymbol.set(start, null);
      const result = traceSymbol(sp, start, hops);
      bySymbol.set(start, result ?? null);
      return result;
    };

    /** A value reached through a workspace import, no surer than the import. */
    const through = (
      target: { sp: ServiceProgram; symbol: ts.Symbol; confidence: Confidence } | undefined,
      hops: number,
    ): V | undefined => {
      const found = target && ofSymbol(target.sp, target.symbol, hops + 1);
      return found && target
        ? { ...found, confidence: weaker(target.confidence, found.confidence) }
        : undefined;
    };

    const traceSymbol = (sp: ServiceProgram, start: ts.Symbol, hops: number): V | undefined => {
      let symbol = start;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        // Check the import (or, in JS files, the `require`) itself first: a library has no
        // declarations without `node_modules`.
        const own = symbol.declarations?.[0];
        const direct = own && ofDeclaration(sp, own, hops);
        if (direct) return direct;
        const aliased = resolver.checkerOf(sp).getAliasedSymbol(symbol);
        if ((aliased.declarations ?? []).length === 0) {
          return own ? through(resolver.importTarget(sp, own), hops) : undefined;
        }
        symbol = aliased;
      }
      for (const declaration of symbol.declarations ?? []) {
        const found = ofDeclaration(sp, declaration, hops);
        if (found) return found;
      }
      return undefined;
    };

    /**
     * Results by factory function, like {@link bySymbol}: without it, factories that each
     * return several calls of the next one are traced exponentially often.
     */
    const byFactory = new Map<FunctionWithBody, V | null>();

    /** The first value a factory function returns. */
    const ofFactory = (sp: ServiceProgram, fn: FunctionWithBody, hops: number): V | undefined => {
      const known = byFactory.get(fn);
      if (known !== undefined) return known ?? undefined;
      byFactory.set(fn, null);
      let result: V | undefined;
      for (const returned of returnedExpressions(fn)) {
        result = valueOf(sp, returned, hops + 1);
        if (result) break;
      }
      byFactory.set(fn, result ?? null);
      return result;
    };

    const valueOf = (
      sp: ServiceProgram,
      expression: ts.Expression,
      hops: number,
    ): V | undefined => {
      if (hops > MAX_HOPS) return undefined;
      const e = unwrap(expression);
      if (ts.isAwaitExpression(e)) return valueOf(sp, e.expression, hops + 1);
      const module = requiredModule(e);
      if (module !== undefined) return lib.required(sp, module);
      if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind;
        if (
          op === ts.SyntaxKind.QuestionQuestionToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.AmpersandAmpersandToken
        ) {
          return valueOf(sp, e.left, hops + 1) ?? valueOf(sp, e.right, hops + 1);
        }
        if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
          return valueOf(sp, e.right, hops + 1);
        }
        return undefined;
      }
      if (ts.isConditionalExpression(e)) {
        return valueOf(sp, e.whenTrue, hops + 1) ?? valueOf(sp, e.whenFalse, hops + 1);
      }
      if (ts.isCallExpression(e)) {
        const callee = unwrap(e.expression);
        // `axios.create(config)`, `ofetch.create(options)`, `ky.extend(options)`, or
        // `instance.create(…)`.
        if (ts.isPropertyAccessExpression(callee) && lib.creators.has(callee.name.text)) {
          const parent = valueOf(sp, callee.expression, hops + 1);
          return parent && lib.created(sp, e, parent, callee.name.text);
        }
        // A factory function that returns the library or an instance.
        const name = ts.isIdentifier(callee)
          ? callee
          : ts.isPropertyAccessExpression(callee)
            ? callee.name
            : undefined;
        const symbol = name && symbolAt(sp, name);
        const fn = symbol && functionOf(resolver.checkerOf(sp), symbol);
        return fn ? ofFactory(sp, fn, hops) : undefined;
      }
      if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
        const symbol = symbolAt(sp, ts.isIdentifier(e) ? e : e.name);
        if (symbol) return ofSymbol(sp, symbol, hops + 1);
        if (ts.isPropertyAccessExpression(e)) {
          const object = unwrap(e.expression);
          // `axios.default` under `import * as axios` or `require("axios")`.
          if (e.name.text === "default") {
            const inner = valueOf(sp, object, hops + 1);
            if (inner) return inner;
          }
          // `of.ofetch` under `import * as of from "ofetch"`, or `http.api` where `http` is a
          // namespace import of a workspace package.
          if (ts.isIdentifier(object)) {
            const declaration = symbolAt(sp, object)?.declarations?.[0];
            if (declaration && ts.isNamespaceImport(declaration)) {
              const binding = importBinding(declaration);
              const member = binding && lib.imported(sp, { ...binding, name: e.name.text });
              if (member) return member;
              return through(resolver.importTarget(sp, declaration, e.name.text), hops);
            }
          }
        }
      }
      return undefined;
    };

    return valueOf;
  };

  /** What an expression is when it is axios or an axios instance. */
  const axiosOf = createTracer<AxiosValue>({
    creators: CREATE,
    imported: (sp, binding) =>
      binding.module === "axios" && (binding.name === "default" || binding.name === "*")
        ? axiosRoot(sp)
        : undefined,
    required: (sp, module) => (module === "axios" ? axiosRoot(sp) : undefined),
    typed: axiosOfType,
    created: (sp, call, parent) => {
      const own = configProperty(sp, call.arguments[0], "baseURL");
      return {
        baseURL: own,
        origin: call,
        ...(own === undefined ? { parent } : {}),
        confidence: parent.confidence,
      };
    },
  });

  // ---- ofetch ----

  /** `ofetch` (or `$fetch`) imported from `ofetch`: no base and `GET` by default. */
  const OFETCH_ROOT: OfetchValue = { baseURL: undefined, method: undefined, confidence: "exact" };

  /**
   * What an expression is when it is ofetch's `ofetch` or `$fetch`, or an instance its `create`
   * made. `create(options)` merges `options` over the defaults of what it is called on (ofetch's
   * `$fetch.create`), so an instance's `baseURL` and `method` are its own, else its parent's.
   * A spread or an options value the collector can't see makes both unknown.
   */
  const ofetchOf = createTracer<OfetchValue>({
    creators: CREATE,
    imported: (_sp, binding) =>
      binding.module === "ofetch" && OFETCH_EXPORTS.has(binding.name) ? OFETCH_ROOT : undefined,
    required: () => undefined,
    typed: () => undefined,
    created: (sp, call, parent) => {
      const options = call.arguments[0];
      const read = (name: string): ConfigValue =>
        options && ts.isSpreadElement(options) ? null : configProperty(sp, options, name);
      const baseURL = read("baseURL");
      const method = read("method");
      return {
        baseURL: baseURL === undefined ? parent.baseURL : baseURL,
        method: method === undefined ? parent.method : method,
        confidence: parent.confidence,
      };
    },
  });

  // ---- ky ----

  /** ky's own defaults: no base, and `GET`. */
  const KY_DEFAULTS: KyValue["defaults"] = {
    prefixUrl: undefined,
    prefix: undefined,
    baseUrl: undefined,
    method: undefined,
  };

  /**
   * What an expression is when it is ky's default export or an instance (M5C.3e). `extend`
   * merges its options over the defaults of what it is called on, and `create` over ky's own
   * (ky's docs: "complete new defaults"), so an instance's bases and method are its own, else
   * the ones it started from. A spread, a function (`extend((parent) => …)`), or options the
   * collector can't see make them all unknown.
   */
  const kyOf = createTracer<KyValue>({
    creators: new Set(["create", "extend"]),
    imported: (_sp, binding) =>
      binding.module === "ky" && binding.name === "default"
        ? { defaults: KY_DEFAULTS, confidence: "exact" }
        : undefined,
    required: () => undefined,
    typed: () => undefined,
    created: (sp, call, parent, creator) => {
      const options = call.arguments[0];
      const start = creator === "extend" ? parent.defaults : KY_DEFAULTS;
      const defaults = { ...start };
      for (const key of [...KY_BASES, "method"] as const) {
        const own =
          options && (ts.isSpreadElement(options) || isFunctionWithBody(unwrap(options)))
            ? null
            : configProperty(sp, options, key);
        if (own !== undefined) defaults[key] = own;
      }
      return { defaults, confidence: parent.confidence };
    },
  });

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

  /**
   * The request `instance(url, options?)` (or `instance.raw(…)`) makes with ofetch (M5C.3c).
   * The call's own `baseURL` and `method` win over the instance's defaults, and the method is
   * `GET` when neither sets one. `options` is `null` after a spread. Options the collector can't
   * see are assumed not to set a `baseURL`, as for axios's shorthand calls; their `method` is
   * re-read by wrapper inlining (M2.3) from the caller's arguments, unless the instance has a
   * default `method` of its own.
   */
  const ofetchRequest = (
    sp: ServiceProgram,
    instance: OfetchValue,
    url: ProgramExpression | null,
    options: ts.Expression | null | undefined,
  ): RequestShape => {
    const own = (name: string): ConfigValue =>
      options === null ? null : configProperty(sp, options, name);
    const ownBase = own("baseURL");
    const ownMethod = own("method");
    let method: Pick<HttpCallSite, "method" | "methodSource">;
    if (instance.method === undefined || (ownMethod !== undefined && ownMethod !== null)) {
      method = configMethod(sp, options, "GET");
    } else if (ownMethod === undefined) {
      method = { method: methodOf(instance.method, "GET") };
    } else {
      method = { method: null };
    }
    return {
      client: "ofetch",
      ...method,
      url,
      baseURL: ownBase === undefined || ownBase === null ? instance.baseURL : ownBase,
      baseJoin: "withBase",
      confidence: instance.confidence,
    };
  };

  /** The join each of ky's base options uses (see `url.ts`). */
  const KY_JOINS: Record<(typeof KY_BASES)[number], BaseJoin> = {
    prefixUrl: "kyPrefixUrl",
    prefix: "kyPrefix",
    baseUrl: "kyBaseUrl",
  };

  /**
   * The request `instance(url, options?)` or `instance.get(url, options?)` (`shorthand` the
   * method its name sets, which wins over `options.method`, as ky merges it last) makes with ky
   * (M5C.3e). Otherwise the method is the call's, else the instance's, else `GET`, read like
   * ofetch's ({@link ofetchRequest}). Each base option is the call's, else the instance's;
   * options the collector can't see are assumed not to set one. One the instance has but that
   * can't be read makes the base unknown. With more than one base option in effect the request
   * has no URL, saying why: how ky 1 and ky 2 combine them isn't followed.
   */
  const kyRequest = (
    sp: ServiceProgram,
    instance: KyValue,
    url: ProgramExpression | null,
    options: ts.Expression | null | undefined,
    shorthand?: HttpMethod,
  ): RequestShape => {
    const own = (name: string): ConfigValue =>
      options === null ? null : configProperty(sp, options, name);
    let method: Pick<HttpCallSite, "method" | "methodSource">;
    const ownMethod = shorthand === undefined ? own("method") : undefined;
    if (shorthand !== undefined) {
      method = { method: shorthand };
    } else if (
      instance.defaults.method === undefined ||
      (ownMethod !== undefined && ownMethod !== null)
    ) {
      method = configMethod(sp, options, "GET");
    } else if (ownMethod === undefined) {
      method = { method: methodOf(instance.defaults.method, "GET") };
    } else {
      method = { method: null };
    }
    const bases = KY_BASES.flatMap((key) => {
      const value = own(key) ?? instance.defaults[key];
      return value === undefined ? [] : [{ key, value }];
    });
    const [only] = bases;
    if (bases.some((b) => b.value === null)) {
      return { client: "ky", ...method, url, baseURL: null, confidence: instance.confidence };
    }
    if (bases.length > 1) {
      return {
        client: "ky",
        ...method,
        url: null,
        urlDetail: DYNAMIC_URL_DETAIL.kyBases,
        baseURL: undefined,
        confidence: instance.confidence,
      };
    }
    return {
      client: "ky",
      ...method,
      url,
      baseURL: only?.value,
      ...(only ? { baseJoin: KY_JOINS[only.key] } : {}),
      confidence: instance.confidence,
    };
  };

  /** The request a call in `file` makes, if it is a `fetch`, axios, ofetch, or ky request. */
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
    const ofetch = ofetchOf(sp, callee, 0);
    if (ofetch) return ofetchRequest(sp, ofetch, urlArg(0), arg(1));
    if (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === "raw" || callee.name.text === "native")
    ) {
      const instance = ofetchOf(sp, callee.expression, 0);
      // `x.native(…)` is the platform's `fetch`, without the instance's defaults.
      if (instance && callee.name.text === "native") {
        return {
          client: "ofetch",
          ...configMethod(sp, arg(1), "GET"),
          url: urlArg(0),
          baseURL: undefined,
          confidence: instance.confidence,
        };
      }
      if (instance) return ofetchRequest(sp, instance, urlArg(0), arg(1));
    }

    const ky = kyOf(sp, callee, 0);
    if (ky) return kyRequest(sp, ky, urlArg(0), arg(1));
    if (ts.isPropertyAccessExpression(callee) && KY_METHODS.has(callee.name.text)) {
      const instance = kyOf(sp, callee.expression, 0);
      const method = toMethod(callee.name.text);
      if (instance && method) return kyRequest(sp, instance, urlArg(0), arg(1), method);
    }

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

  // ---- RTK Query ----

  /** The `module#export` a callee identifier is imported as, if it is a plain import. */
  const importedName = (sp: ServiceProgram, callee: ts.Expression): string | undefined => {
    const e = unwrap(callee);
    const declaration = ts.isIdentifier(e) ? symbolAt(sp, e)?.declarations?.[0] : undefined;
    const binding = declaration && importBinding(declaration);
    return binding && RTK_QUERY_MODULES.has(binding.module) ? binding.name : undefined;
  };

  /** The expression a `const` identifier holds (through imports), else the expression itself. */
  const constValue = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): ProgramExpression & { confidence: Confidence } => {
    const e = unwrap(expression);
    const symbol = ts.isIdentifier(e) && hops <= MAX_HOPS ? symbolAt(sp, e) : undefined;
    const found = symbol && resolveDeclaration(sp, symbol, hops + 1);
    const d = found?.declaration;
    if (!found || !d || !ts.isVariableDeclaration(d) || !d.initializer || !isConst(d)) {
      return { sp, expression: e, confidence: "exact" };
    }
    const inner = constValue(found.sp, d.initializer, hops + 1);
    return { ...inner, confidence: weaker(found.confidence, inner.confidence) };
  };

  /**
   * The `fetchBaseQuery(config)` call (imported from RTK Query) a base query expression is:
   * directly, through a `const`, or wrapped in RTK's `retry`. With `forwarding`, also a repo
   * function passing its first parameter on unchanged to one (see {@link forwardedBase}).
   */
  const fetchBaseQueryOf = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
    forwarding: boolean,
  ): FetchBaseQuery | undefined => {
    let query = constValue(sp, expression, hops);
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const e = query.expression;
      if (ts.isCallExpression(e)) {
        const name = importedName(query.sp, e.expression);
        const [first] = e.arguments;
        if (name === "retry" && first) {
          const inner = constValue(query.sp, first, hops);
          query = { ...inner, confidence: weaker(query.confidence, inner.confidence) };
          continue;
        }
        return name === "fetchBaseQuery"
          ? { sp: query.sp, call: e, confidence: query.confidence }
          : undefined;
      }
      if (!forwarding) return undefined;
      let fn: { sp: ServiceProgram; fn: FunctionWithBody; confidence: Confidence } | undefined;
      if (isFunctionWithBody(e)) fn = { sp: query.sp, fn: e, confidence: "exact" };
      else if (ts.isIdentifier(e)) {
        const symbol = symbolAt(query.sp, e);
        const found = symbol && resolveDeclaration(query.sp, symbol, hops + 1);
        if (found && isFunctionWithBody(found.declaration)) {
          fn = { sp: found.sp, fn: found.declaration, confidence: found.confidence };
        }
      }
      const base = fn && forwardedBase(fn.sp, fn.fn, hops + 1);
      return (
        fn &&
        base && {
          ...base,
          confidence: weaker(query.confidence, weaker(fn.confidence, base.confidence)),
        }
      );
    }
    return undefined;
  };

  /** The expression around `node` that only changes its type: parentheses, `as`, `!`. */
  const typeOnlyParent = (node: ts.Expression): ts.Expression => {
    let outer = node;
    while (
      ts.isParenthesizedExpression(outer.parent) ||
      ts.isAsExpression(outer.parent) ||
      ts.isSatisfiesExpression(outer.parent) ||
      ts.isNonNullExpression(outer.parent) ||
      ts.isTypeAssertionExpression(outer.parent)
    ) {
      outer = outer.parent;
    }
    return outer;
  };

  /**
   * True when a parameter reference only reads it: a property read (`args.url`, never written
   * or deleted), `typeof args`, or an equality or `instanceof` comparison.
   */
  const onlyReads = (reference: ts.Identifier): boolean => {
    const outer = typeOnlyParent(reference);
    const parent = outer.parent;
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === outer
    ) {
      const user = typeOnlyParent(parent).parent;
      const written =
        (ts.isBinaryExpression(user) &&
          user.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          user.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          typeOnlyParent(parent) === user.left) ||
        ts.isDeleteExpression(user) ||
        ts.isPrefixUnaryExpression(user) ||
        ts.isPostfixUnaryExpression(user);
      return !written;
    }
    if (ts.isTypeOfExpression(parent)) return true;
    if (!ts.isBinaryExpression(parent)) return false;
    const kind = parent.operatorToken.kind;
    return (
      kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      kind === ts.SyntaxKind.EqualsEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsToken ||
      kind === ts.SyntaxKind.InstanceOfKeyword
    );
  };

  /**
   * The `fetchBaseQuery` a base query function sends every endpoint's arguments through, as in
   * RTK's documented re-authorization example (`baseQueryWithReauth = async (args, api,
   * extraOptions) => { let result = await rawBaseQuery(args, api, extraOptions); … }`, M5C.2):
   * its first parameter, a plain identifier, is the first argument of at least one call of a
   * `fetchBaseQuery` result (nested functions included, so a mutex's callback too), and every
   * other use of it only reads it ({@link onlyReads}). `undefined` when it is assigned, passed
   * to anything else (another base query, a logger), built into another value that reaches a
   * `fetchBaseQuery` result (a rewritten URL), or forwarded to two different `fetchBaseQuery`
   * calls: the endpoints' URL or base would then depend on what isn't followed.
   */
  const forwardedBase = (
    sp: ServiceProgram,
    fn: FunctionWithBody,
    hops: number,
  ): FetchBaseQuery | undefined => {
    const [parameter] = fn.parameters;
    if (!parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name) || !fn.body) {
      return undefined;
    }
    const name = parameter.name;
    const symbol = symbolAt(sp, name);
    if (!symbol || hops > MAX_HOPS) return undefined;
    const references = (node: ts.Node): boolean =>
      (ts.isIdentifier(node) && node.text === name.text && symbolAt(sp, node) === symbol) ||
      (ts.forEachChild(node, references) ?? false);
    let base: FetchBaseQuery | undefined;
    let followed = true;
    const visit = (node: ts.Node): void => {
      if (!followed) return;
      if (ts.isCallExpression(node)) {
        const [first, ...rest] = node.arguments;
        const target = first && fetchBaseQueryOf(sp, node.expression, hops, false);
        if (first && target) {
          if (ts.isSpreadElement(first)) followed = !references(first);
          else if (ts.isIdentifier(unwrap(first)) && references(unwrap(first))) {
            if (base && base.call !== target.call) followed = false;
            base = target;
          } else if (references(first)) followed = false;
          visit(node.expression);
          for (const arg of rest) visit(arg);
          return;
        }
      }
      if (ts.isIdentifier(node) && node.text === name.text && symbolAt(sp, node) === symbol) {
        followed = onlyReads(node);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return followed ? base : undefined;
  };

  /** The `baseUrl` a `fetchBaseQuery` call sets: `undefined` without one, `null` if unreadable. */
  const baseUrlOf = (base: FetchBaseQuery): ProgramExpression | null | undefined => {
    const [config] = base.call.arguments;
    if (config && ts.isSpreadElement(config)) return null;
    return configProperty(base.sp, config, "baseUrl");
  };

  /**
   * The `baseUrl` a `createApi` call's `baseQuery` gives (ADR-0196): `fetchBaseQuery(config)`
   * from RTK Query, directly, through a `const`, or wrapped in RTK's `retry`, or a repo function
   * forwarding its arguments to one (M5C.2). `undefined` when the base query is anything else
   * or can't be read (its endpoints are then unresolved, M5B.7b); `baseURL` is `undefined`
   * without a `baseUrl` and `null` when one may be set but can't be read.
   */
  const rtkBase = (
    sp: ServiceProgram,
    api: ts.CallExpression,
    hops: number,
  ): { baseURL: ProgramExpression | null | undefined; confidence: Confidence } | undefined => {
    const options = api.arguments[0];
    const object = options && configObject(sp, options, 0);
    const value = object && objectProperty(object.sp, object.expression, "baseQuery");
    const base = value ? fetchBaseQueryOf(value.sp, value.expression, hops, true) : undefined;
    return base && { baseURL: baseUrlOf(base), confidence: base.confidence };
  };

  /**
   * The request `fetchBaseQuery` makes for an endpoint's arguments: a string is the URL, an
   * object literal its `url` and `method` (absent: `GET`, the `Request` default), anything else
   * a request with no URL or method.
   */
  const rtkArgsRequest = (
    sp: ServiceProgram,
    args: ts.Expression,
    baseURL: ProgramExpression | null | undefined,
    confidence: Confidence,
  ): RequestShape => {
    const shape = (
      url: ProgramExpression | null,
      method: Pick<HttpCallSite, "method" | "methodSource">,
    ): RequestShape => ({ client: "fetch", ...method, url, baseURL, confidence });
    if (configObject(sp, args, 0)) {
      const url = configProperty(sp, args, "url");
      return shape(url ?? null, configMethod(sp, args, "GET"));
    }
    return isStringValued(sp, args)
      ? shape({ sp, expression: args }, { method: "GET" })
      : shape(null, { method: null });
  };

  const usesRtk = new Map<ServiceProgram, boolean>();

  /** True when a file of `sp`'s program imports RTK Query (so a call may be a base query's). */
  const importsRtk = (sp: ServiceProgram): boolean => {
    let known = usesRtk.get(sp);
    if (known === undefined) {
      known = sp.program
        .getSourceFiles()
        .some(
          (f) =>
            !f.isDeclarationFile &&
            f.statements.some(
              (s) =>
                ts.isImportDeclaration(s) &&
                ts.isStringLiteral(s.moduleSpecifier) &&
                RTK_QUERY_MODULES.has(s.moduleSpecifier.text),
            ),
        );
      usesRtk.set(sp, known);
    }
    return known;
  };

  /**
   * A call of a `fetchBaseQuery` result in repo code (M5C.2), such as a re-auth wrapper's
   * `rawBaseQuery("/auth/refresh", api, extraOptions)`: fetchBaseQuery makes the `fetch`, so
   * its first argument is a request like an endpoint's `query` value, joined to its `baseUrl`.
   * A first argument that is a parameter of the function around the call (`rawBaseQuery(args,
   * api, extraOptions)`) carries some caller's arguments, for a base query RTK calls with an
   * endpoint's: those requests are at the endpoints (see {@link forwardedBase}), so it is none.
   */
  const rtkDirectCall = (sp: ServiceProgram, call: ts.CallExpression): RequestShape | undefined => {
    const [first] = call.arguments;
    if (!first || ts.isSpreadElement(first) || !importsRtk(sp)) return undefined;
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee) && !ts.isCallExpression(callee)) return undefined;
    const base = fetchBaseQueryOf(sp, callee, 0, false);
    if (!base) return undefined;
    const arg = unwrap(first);
    const declaration = ts.isIdentifier(arg) ? symbolAt(sp, arg)?.valueDeclaration : undefined;
    if (declaration && ts.isParameter(declaration)) return undefined;
    return rtkArgsRequest(sp, first, baseUrlOf(base), base.confidence);
  };

  /**
   * The `createApi` call an `endpoints` function belongs to: the one it is passed to, or for
   * `api.injectEndpoints({ endpoints })` the one `api` holds (a `const`, imported too).
   */
  const rtkApiOf = (
    sp: ServiceProgram,
    endpoints: FunctionWithBody,
  ): { sp: ServiceProgram; call: ts.CallExpression; confidence: Confidence } | undefined => {
    let holder: ts.Node = endpoints;
    if (!ts.isMethodDeclaration(endpoints)) {
      while (ts.isParenthesizedExpression(holder.parent)) holder = holder.parent;
      if (!ts.isPropertyAssignment(holder.parent) || holder.parent.initializer !== holder) {
        return undefined;
      }
      holder = holder.parent;
    }
    const key = (holder as ts.PropertyAssignment | ts.MethodDeclaration).name;
    if (!(ts.isIdentifier(key) || ts.isStringLiteralLike(key)) || key.text !== "endpoints") {
      return undefined;
    }
    const options: ts.Node = holder.parent;
    if (!ts.isObjectLiteralExpression(options)) return undefined;
    let call: ts.Node = options;
    while (ts.isParenthesizedExpression(call.parent)) call = call.parent;
    const parent = call.parent;
    if (!ts.isCallExpression(parent) || parent.arguments[0] !== call) return undefined;
    if (importedName(sp, parent.expression) === "createApi") {
      return { sp, call: parent, confidence: "exact" };
    }
    const callee = unwrap(parent.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "injectEndpoints") {
      return undefined;
    }
    const api = constValue(sp, callee.expression, 0);
    return ts.isCallExpression(api.expression) &&
      importedName(api.sp, api.expression.expression) === "createApi"
      ? { sp: api.sp, call: api.expression, confidence: api.confidence }
      : undefined;
  };

  /**
   * The value of an endpoint definition's `query` option: a property or a method (`query(id)
   * { … }`); `null` when a spread or computed key could supply it, `undefined` when absent.
   */
  const queryOption = (
    sp: ServiceProgram,
    definition: ts.ObjectLiteralExpression,
  ): FunctionWithBody | ConfigValue => {
    for (let i = definition.properties.length - 1; i >= 0; i--) {
      const property = definition.properties[i];
      if (
        property &&
        ts.isMethodDeclaration(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
        property.name.text === "query"
      ) {
        return isFunctionWithBody(property) ? property : null;
      }
      const value = property && ownProperty(sp, property, "query");
      if (value !== undefined) return value;
    }
    return undefined;
  };

  /**
   * The `endpoints` function an endpoint builder call's callee comes from: `build.query` (or
   * `mutation`, `infiniteQuery`) with `build` the function's first parameter, or `query` (also
   * renamed, `{ mutation: send }`) destructured in that parameter (M5B.7b). It is checked to
   * belong to a `createApi` by {@link rtkApiOf}.
   */
  const rtkEndpointsOf = (
    sp: ServiceProgram,
    calleeExpression: ts.Expression,
  ): FunctionWithBody | undefined => {
    const callee = unwrap(calleeExpression);
    let parameter: ts.Node | undefined;
    if (ts.isPropertyAccessExpression(callee) && RTK_ENDPOINT_KINDS.has(callee.name.text)) {
      const build = unwrap(callee.expression);
      parameter = ts.isIdentifier(build) ? symbolAt(sp, build)?.valueDeclaration : undefined;
    } else if (ts.isIdentifier(callee)) {
      const element = symbolAt(sp, callee)?.valueDeclaration;
      if (!element || !ts.isBindingElement(element) || element.dotDotDotToken) return undefined;
      const key = element.propertyName ?? element.name;
      if (!(ts.isIdentifier(key) || ts.isStringLiteralLike(key))) return undefined;
      if (!RTK_ENDPOINT_KINDS.has(key.text)) return undefined;
      const pattern = element.parent;
      if (!ts.isObjectBindingPattern(pattern)) return undefined;
      parameter = pattern.parent;
    }
    const endpoints = parameter && ts.isParameter(parameter) ? parameter.parent : undefined;
    return endpoints && isFunctionWithBody(endpoints) && endpoints.parameters[0] === parameter
      ? endpoints
      : undefined;
  };

  /**
   * The requests an RTK Query endpoint makes (ADR-0196): `call` is `build.query(definition)`,
   * `build.mutation(…)`, or `build.infiniteQuery(…)`, where `build` is the first parameter of
   * the `endpoints` function of a `createApi` (or `injectEndpoints`) call (see
   * {@link rtkEndpointsOf}). With `fetchBaseQuery` as the base query, what `query` returns
   * becomes a `fetch`: a string is the URL, an object its `url` and `method` (absent: `GET`),
   * joined to `baseUrl` like axios's `baseURL`, one request per value `query` returns. Under any
   * other base query, one request with no URL or method and the `rtkBaseQuery` detail (M5B.7b).
   * An endpoint with no `query` (a `queryFn`) makes none here.
   */
  const rtkEndpoint = (sp: ServiceProgram, call: ts.CallExpression): RequestShape[] => {
    const endpoints = rtkEndpointsOf(sp, call.expression);
    const api = endpoints && rtkApiOf(sp, endpoints);
    const [first] = call.arguments;
    if (!api || !first || ts.isSpreadElement(first)) return [];
    const definition = configObject(sp, first, 0);
    const query = definition && queryOption(definition.sp, definition.expression);
    if (definition && query === undefined) return [];
    const base = rtkBase(api.sp, api.call, 0);
    // Another base query decides the URL and method from what `query` returns, so the request
    // is shown, unresolved, rather than dropped or guessed (fail visibly).
    if (!base) {
      return [
        {
          client: "fetch",
          method: null,
          url: null,
          urlDetail: DYNAMIC_URL_DETAIL.rtkBaseQuery,
          baseURL: undefined,
          confidence: api.confidence,
        },
      ];
    }
    const confidence = weaker(api.confidence, base.confidence);
    const unknown: RequestShape[] = [
      { client: "fetch", method: null, url: null, baseURL: base.baseURL, confidence },
    ];
    if (!definition) return unknown;
    let fn: FunctionWithBody | undefined;
    if (query && "kind" in query) fn = query;
    else if (query) {
      const e = unwrap(query.expression);
      if (isFunctionWithBody(e)) fn = e;
      else if (ts.isIdentifier(e)) {
        const symbol = symbolAt(query.sp, e);
        fn = symbol && functionOf(resolver.checkerOf(query.sp), symbol);
      }
    }
    const returned = fn ? returnedExpressions(fn) : [];
    if (returned.length === 0) return unknown;
    return returned.map((r) => rtkArgsRequest(definition.sp, r, base.baseURL, confidence));
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
          const request = requestOf(sp, file, node) ?? rtkDirectCall(sp, node);
          for (const shape of request ? [request] : rtkEndpoint(sp, node)) {
            sites.push({
              ...shape,
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
