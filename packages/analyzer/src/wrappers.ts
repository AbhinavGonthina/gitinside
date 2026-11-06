/**
 * Wrapper inlining (M2.3, DESIGN.md §7.1; wrappers over wrappers since M5C.7f): turns
 * collected HTTP call sites into {@link HttpRequest}s. A call site whose URL or axios `baseURL` reads a parameter of the
 * function it sits in in its leading part (the start, the host, glued to the path, or the
 * first segment: `leadingHoles` in `url.ts`, M5A.3j), whose axios config is a parameter, or
 * whose method reads one is a wrapper body (`function get(path) { return fetch(BASE + path) }`);
 * a parameter that only fills a later hole or the query (`fetch(\`/api/posts/${id}\`)`)
 * leaves the request at its own call, as EVALUATION.md §1 labels it;
 * each call to that function (`get("/users")`) becomes its own request, with the parameters
 * bound to the caller's arguments and the URL normalized again. A request whose URL still
 * starts with a parameter of a caller that isn't followed is `WRAPPER_DEPTH`.
 *
 * Wrappers over wrappers (M5C.7f, ADR-0032's amendment): a symbol function whose call to a
 * wrapper passes its own parameter as the leading part of an argument that wrapper's URL
 * reads (`get(path) { return request(path, { method: "GET" }) }`, also `` `${path}?${q}` ``;
 * not `request("/users/" + id)`, which fixes the route) is a wrapper too, up to
 * {@link MAX_WRAPPER_DEPTH} wrappers deep. Its callers are inlined through the chain: each
 * level's arguments are read with the next level's bindings (`ParameterBindings.outer`), the
 * method too, and the request is placed at the outermost call, as EVALUATION.md §1 labels
 * it. The calls inside the chain make no request of their own then, and a wrapper another
 * wrapper calls keeps none either (its sites are represented through the outer one). A
 * function passing its parameter into a chain already at the limit gets `WRAPPER_DEPTH` at
 * that call; a call that would loop isn't followed; past {@link MAX_CHAIN_REQUESTS}
 * requests, one call's are collapsed to one `DYNAMIC_URL` per site.
 *
 * Per-service facts (M6.7c, ADR-0092): {@link collectHttpFacts} gives each service its
 * {@link HttpFacts}, plain data with no TypeScript nodes: the requests of its sites that aren't
 * wrapper bodies, its wrappers with the requests they make when nothing calls them, and its
 * calls to wrappers anywhere in the repo, already inlined in the caller's analysis (which
 * records the wrapper's program as reached). {@link bindWrappers} is the global step: a
 * wrapper's own requests are kept only when no service calls it, then everything is sorted.
 *
 * Patterns handled:
 * - Wrappers that are symbols (M1.7): function declarations, `const` arrow and function
 *   expressions, class methods and function-valued class properties, `export default`
 *   functions, CommonJS `exports.x = function` / `module.exports = { x() {} }`, and methods
 *   and function-valued properties of an exported `const` object literal
 *   (`export const api = { get(path) {…} }`, called as `api.get("/x")`, M5A.3b).
 * - Callers anywhere in the repo whose callee resolves to the wrapper's symbol node with the
 *   shared resolver (M1.9): direct calls, imports (renamed, default, namespace, and workspace
 *   packages at their import's confidence), and methods called on instances the checker types.
 * - Identifier parameters bound positionally. A missing argument takes the parameter's
 *   default; without one the value is unknown (a hole, or `GET` for a method, matching
 *   `fetch` and axios). Arguments at or after a spread, and rest parameters, are unknown.
 * - Methods read from a parameter: `fetch(url, init)` / `api.request(config)` where the config
 *   is a parameter (its `method` is read from the caller's object literal or const object),
 *   `{ method }` where the value is a parameter (read as a const string), and spreads of a
 *   parameter over a default (`{ method: "GET", ...init }`: the last spread that sets
 *   `method` wins; a missing argument spreads nothing). A spread of a rest element copies
 *   what it was destructured from (M5C.7a): `const { json, headers, ...rest } = init` then
 *   `fetch(url, { ...rest })` reads the caller's `init`, as does a parameter written
 *   `{ json, ...rest }`; a pattern that takes `method` out by name leaves `rest` without one,
 *   and a computed key that isn't a const string makes the method unknown.
 * - A whole axios config that is a parameter (`axios(req)`, `api.request(req)`, M5A.3c): the
 *   caller's object literal or const object gives `url`, `baseURL` (else the instance's), and
 *   `method`, so `httpRequest({ method: "POST", url: "/login" })` is `POST /login`. A caller
 *   passing its own parameter on is `WRAPPER_DEPTH`; a config read through a spread, or with
 *   no `url`, has no URL (`DYNAMIC_URL`).
 * - Sites inside callbacks the wrapper declares (`new Promise(async (resolve) => { await
 *   axios(req) })`): the wrapper is the innermost symbol around the site whose value is a
 *   function containing it, and only that function's parameters are bound (M5A.3c). A
 *   function the wrapper returns counts too: its requests are placed at the factory's call.
 *   When an inner function's own parameter reaches the URL's leading part
 *   (`createClient(base)` ⇒ `{ get: (path) => fetch(base + "/" + path) }`), the request is
 *   `WRAPPER_DEPTH`, since only a later call supplies it (M5A.5c); one that only fills a later
 *   hole (`(id) => fetch(base + "/users/" + id)`) leaves the route fixed.
 * - A URL with alternatives (ternary branches, a `let` set in a branch) gives one request per
 *   alternative, at the same site (`UrlNormalizer.alternatives`, M5A.3h). Whether it is a
 *   wrapper is read on each branch (M5C.10a): `slug ? \`/api/x/${slug}\` : "/api/y"` fixes its
 *   routes, so it stays at its own call with both. At a wrapper's call, a ternary on one of its
 *   parameters takes only the branch the argument settles (`version ? \`/api/${version}${path}\`
 *   : \`/api${path}\`` called with no `version` sends only `/api${path}`).
 * - SWR calling a wrapper as a fetcher (ADR-0193), from SWR's own contract: `useSWR`,
 *   `useSWRImmutable`, `useSWRInfinite`, `useSWRMutation`, and `preload`, found through their
 *   imports from `swr`, `swr/immutable`, `swr/infinite`, and `swr/mutation`, call
 *   `fetcher(key)` (the mutation adds `{ arg }`, unknown here). A hook whose fetcher argument
 *   names a wrapper (or a `{ fetcher }` config in its place) is a call to it at the hook, the
 *   key bound to the first parameter. Keys: `null`, `undefined`, `false`, and the falsy side
 *   of a ternary or `&&` make no request; a function key (`() => url`, `useSWRInfinite`'s
 *   `getKey`, inline or named) gives each value it returns; an array key is `DYNAMIC_URL`
 *   (SWR 1 spreads it into the fetcher's arguments, SWR 2 passes it whole); any other key is
 *   read as the URL, so one that isn't readable is unresolved at the hook. A hook with no
 *   fetcher uses `<SWRConfig value={{ fetcher }}>`'s when every `SWRConfig` in the service
 *   sets the same wrapper, at `heuristic` (which hooks render under which config isn't known).
 * - SWR fetchers written in place (M5B.2b, ADR-0194): a function that is a call's second argument or an
 *   object literal's `fetcher` property (`useSWR(key, (url) => fetch(url))`, `{ fetcher: … }`
 *   in a hook's config or in `SWRConfig`'s `value`) and reads its own parameters is inlined at
 *   each hook that calls it, like a wrapper; with no such hook its sites keep their own requests.
 * - `fetch(...args)` spreading the wrapper's rest parameter (SWR's documented
 *   `(...args) => fetch(...args)`, M5B.2b): the caller's argument at the rest parameter's
 *   position is the URL and the next one the init (absent: `GET`; after a spread, or SWR
 *   mutation's `{ arg }`: unknown).
 * - TanStack Query's key in a `queryFn`'s context (M5C.3f, ADR-0196's amendment), from its
 *   contract: `useQuery`, `useSuspenseQuery`, `useInfiniteQuery`, `useSuspenseInfiniteQuery`,
 *   `usePrefetchQuery`, `usePrefetchInfiniteQuery`, `queryOptions`, and `infiniteQueryOptions`,
 *   imported from `@tanstack/react-query` or `react-query`, call the options' `queryFn` with a
 *   context whose `queryKey` is the options' `queryKey`. A call whose options (an object
 *   literal or a `const` object) name a wrapper or a function written there as `queryFn` is a
 *   call to it at the hook, its first parameter bound to the options; options with no
 *   `queryFn` (and no spread) use the default every `new QueryClient({ defaultOptions: {
 *   queries: { queryFn } } })` in the service sets, at `heuristic`. The URL reads the key
 *   (`queryKey[0]`, `({ queryKey: [url] })`, `ctx.queryKey[1]`: `url.ts`); a key that is the
 *   caller's own parameter is `WRAPPER_DEPTH`.
 *
 * Patterns not handled:
 * - Functions nested inside other functions as wrappers themselves (their parameters aren't
 *   bound), object literals that aren't exported `const`s (or `module.exports`), and wrappers
 *   only ever passed around as values (no visible call): their sites stay as they are, so a
 *   parameter at the start of the URL is `DYNAMIC_URL`.
 * - A wrapper with visible callers that is also called invisibly (as a callback): only the
 *   visible calls become requests.
 * - Calls spelled with neither a wrapper's name nor an import alias (`const g = get; g()`),
 *   unless some wrapper in the repo has that name: they aren't resolved.
 * - Destructured parameters (`({ path }) => fetch(path)`), `arguments`, and parameters
 *   reassigned in the body (the caller's value is assumed to reach the call).
 * - A rest element declared with `let` or `var`, nested in another pattern, or destructured
 *   from anything but a plain value (`const { ...rest } = init ?? {}`): the method it may
 *   carry is unknown.
 * - A config parameter read through properties (`axios({ url: config.path })`), a `baseURL`
 *   in a shorthand call's config parameter (`api.get(path, config)`: the instance's applies),
 *   and axios instances passed as parameters: those sites are not collected or have no URL.
 * - Wrappers over wrappers past {@link MAX_WRAPPER_DEPTH} (`WRAPPER_DEPTH`), and a function
 *   that passes its parameter on only after a literal segment (`get(p) { return request("v1/"
 *   + p) }`: read like an id, `leadingHoles`), only as a method or a whole axios config, or
 *   through a hook (SWR or TanStack calling a function that calls a wrapper): its call is
 *   inlined there, one level, as before.
 * - A function whose route is fixed but whose method is a parameter is still a wrapper (the
 *   method is only known at its callers); see `leadingHoles` for the URL shapes misread.
 * - A ternary condition at a wrapper's call other than a parameter or its negation (`a ===
 *   "x"`, `a && b`, `opts.admin`), or a parameter bound to a value whose truthiness isn't
 *   static (a variable, a call), or an `if` choosing a `let`'s value: both branches are kept.
 * - SWR fetchers written as a method (`{ fetcher(url) {…} }`) or as a named function nested
 *   in a component (`function load(url) {…}` inside it: see the first item), a spread rest parameter
 *   reaching axios (`axios.get(...args)`) or `fetch` with other arguments around it;
 *   `SWRConfig` values that are functions or spread
 *   props, a `fetcher` passed in the third (options) argument, `useSWRSubscription`, `mutate`,
 *   RTK Query's generated hooks (`http.ts`, ADR-0196), and SWR required with
 *   `require()` or reached through a namespace import or a re-export.
 * - TanStack Query: v3/v4's positional `useQuery(key, fn)`, `useQueries`, `QueryClient`
 *   methods (`fetchQuery`, `prefetchQuery`, `ensureQueryData`, `setQueryDefaults`,
 *   `setDefaultOptions`), options built by a call or spread (`useQuery({ ...opts })`), a key
 *   read with `.join()` or at a computed index, and the other frameworks' adapters. Their
 *   `queryFn` sites keep their own requests (`DYNAMIC_URL` when the URL reads the key).
 */
import ts from "typescript";
import {
  compareStrings,
  type Confidence,
  type HttpMethod,
  type SourceLocation,
} from "@gitinside/schema";
import { calleeName, type SymbolResolver } from "./calls.js";
import { isFunctionWithBody, returnedExpressions, type FunctionWithBody } from "./express.js";
import {
  functionOf,
  importBinding,
  locationOf,
  toMethod,
  type HttpCallSite,
  type HttpClient,
  type MethodSource,
} from "./http.js";
import { bindOwners, NO_OWNERS, ownersAt, type Owners } from "./owners.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";
import {
  DYNAMIC_URL_DETAIL,
  WRAPPER_DEPTH_DETAIL,
  type NormalizedUrl,
  type ParameterBindings,
  type UrlNormalizer,
} from "./url.js";
import {
  clip,
  createValueReader,
  MAX_HOPS,
  objectProperty,
  redactedText,
  weaker,
  type ConfigValue,
  type ProgramExpression,
} from "./values.js";

/**
 * One HTTP request as the route matcher (M2.4) sees it. Plain data (JSON round-trips), so it
 * can be cached as a service's fact (ADR-0090).
 */
export interface HttpRequest {
  /** The `fetch` or axios call that makes the request: the wrapper body's when inlined. */
  call: { client: HttpClient; file: string; site: SourceLocation };
  /** The symbol node ID of the wrapper this request was inlined through, if any. */
  via?: string;
  /** Repo-relative file the request is made from: the wrapper call's when inlined. */
  file: string;
  /** Start of the wrapper call expression when inlined, else of the call (ADR-0167). */
  site: SourceLocation;
  /** Symbol or route node IDs the request belongs to, sorted. Empty for top-level code. */
  owners: string[];
  /** The request method, or `null` when it can't be read. */
  method: HttpMethod | null;
  /** The normalized URL, or why it is unresolved. */
  url: NormalizedUrl;
  /**
   * The weakest of the call site's, the URL's, and (when inlined) the wrapper call's
   * resolution confidence.
   */
  confidence: Confidence;
  /**
   * What an unresolved node for this request shows: the method and the URL as read, else its
   * source text (masked like {@link expression}).
   */
  label: string;
  /**
   * The source text an unresolved node shows: the wrapper call when inlined, else the
   * `fetch`/axios call, with secrets masked by {@link redactedText} (only the URL's text
   * before any `?` is kept; for a wrapper call, the arguments its URL reads).
   */
  expression: string;
}

/**
 * An {@link HttpRequest} as a service's fact: its owners still name the inline handlers it
 * may be in by node key, bound to route IDs by {@link bindWrappers} (ADR-0094).
 */
export type HttpRequestFact = Omit<HttpRequest, "owners"> & { owners: Owners };

/** A wrapper function whose body is in a service, as a fact. */
export interface WrapperFact {
  /** The symbol node ID of the wrapper. */
  id: string;
  /** The name a call to it is spelled with (the last part of its qualified name). */
  name: string;
  /**
   * The wrappers its body calls with its parameters in their URL's leading part (M5C.7f),
   * sorted; absent when none. Those calls are its requests, not call facts, and the wrappers
   * they reach count as called.
   */
  inner?: string[];
  /** The requests its sites (then its calls to `inner` wrappers) make when no service calls it. */
  requests: HttpRequestFact[];
}

/** A service's calls to one wrapper (in any service), inlined. */
export interface WrapperCallFact {
  /** The symbol node ID of the wrapper called. */
  wrapper: string;
  /** One request per call and wrapper site, in call order, then site order. */
  requests: HttpRequestFact[];
}

/**
 * What the HTTP stage found in one service before the global binding step. Plain data
 * (ADR-0092): every TypeScript question is answered by the time it exists.
 */
export interface HttpFacts {
  /** The service's key. */
  service: string;
  /** Requests of the service's sites that aren't wrapper bodies, in site order. */
  requests: HttpRequestFact[];
  /** Wrappers whose body is in the service, sorted by ID. */
  wrappers: WrapperFact[];
  /** The service's calls to wrappers, sorted by wrapper ID. */
  calls: WrapperCallFact[];
}

/** Which programs {@link collectHttpFacts} gives facts for, and what it knows of the rest. */
export interface HttpFactsScope {
  /** Give facts only for these programs (in program order). Default: every program. */
  only?: ReadonlySet<ServiceProgram>;
  /**
   * For programs outside `only`, the IDs of the wrappers whose bodies they hold, known from
   * their cached facts (ADR-0177). Such a program's sites are collected, and its wrappers
   * found, only when a call resolves to one of these; every other program is looked into.
   */
  known?: ReadonlyMap<ServiceProgram, readonly string[]>;
}

/**
 * How many path-taking wrappers deep a request is followed (M5C.7f): a wrapper calling a
 * wrapper calling a wrapper is inlined at the outermost one's callers; a function passing its
 * parameter into a fourth level's URL is `WRAPPER_DEPTH` there.
 */
export const MAX_WRAPPER_DEPTH = 3;

/**
 * The most requests one call makes through wrappers over wrappers (M5C.7f, a budget like
 * ADR-0039's): past it, each innermost site it reaches keeps one request, `DYNAMIC_URL`, so
 * calls fanning out at every level can't multiply the work.
 */
export const MAX_CHAIN_REQUESTS = 100;

/** A wrapper function and the call sites in its body that read its parameters. */
interface Wrapper {
  sp: ServiceProgram;
  fn: FunctionWithBody;
  /** Repo-relative file of the function. */
  file: string;
  sites: HttpCallSite[];
  /** The parameters that reach each site's leading part (`leadingParameters`), any function's. */
  leading: Map<HttpCallSite, ReadonlySet<ts.ParameterDeclaration>>;
  /** Calls in its body to wrappers that put its parameters in their URL's leading part. */
  inner: InnerCall[];
  /** How many wrappers deep its deepest request goes: 1 with only sites of its own. */
  depth: number;
}

/** A wrapper's call to another wrapper that its own callers are inlined through (M5C.7f). */
interface InnerCall {
  /** The symbol node ID of the wrapper called. */
  id: string;
  caller: Caller;
  /** The calling wrapper's parameters the request's URL reads through this call. */
  reads: ReadonlySet<ts.ParameterDeclaration>;
}

/**
 * One wrapper call being inlined, seen from the wrapper calls in its body (M5C.7f): the
 * wrapper's bindings, and `resolve`, which gives a value with them (and the scopes further
 * out) applied, as `inlineWith`'s `bound` does.
 */
interface Scope {
  bindings: ParameterBindings;
  resolve: (value: ProgramExpression) => ProgramExpression | "missing" | null;
}

/**
 * A key a data-fetching hook may pass its fetcher (ADR-0193): an expression the URL is read
 * from, or `array` for an array key, which the fetcher may take whole or spread.
 */
type HookKey = ts.Expression | "array";

/** A resolved call to a wrapper. */
interface Caller {
  sp: ServiceProgram;
  file: string;
  /** The call to the wrapper, or the hook call that hands it to SWR. */
  call: ts.CallExpression;
  site: SourceLocation;
  owners: Owners;
  confidence: Confidence;
  /**
   * When SWR calls the wrapper as a hook's fetcher (ADR-0193): the keys the hook may pass it
   * as its first argument, and whether it gets nothing more (`missing`) or values the
   * analyzer can't read (`unknown`). Absent for a direct call.
   */
  hook?: { keys: HookKey[]; rest: "missing" | "unknown" };
}

/** What a hook's fetcher is: a wrapper by ID, or a fetcher written in place (M5B.2b). */
type FetcherTarget = { confidence: Confidence } & ({ id: string } | { fn: FunctionWithBody });

/** The outermost node around `node` that only wraps it (parentheses, `as`, `satisfies`, …). */
function wrapped(node: ts.Node): ts.Node {
  let e = node;
  while (
    ts.isParenthesizedExpression(e.parent) ||
    ts.isAsExpression(e.parent) ||
    ts.isSatisfiesExpression(e.parent) ||
    ts.isNonNullExpression(e.parent) ||
    ts.isTypeAssertionExpression(e.parent)
  ) {
    e = e.parent;
  }
  return e;
}

/**
 * True when a function sits where SWR takes a fetcher (M5B.2b): a call's second argument, or
 * the `fetcher` property of an object literal (a hook's config or `SWRConfig`'s `value`); or
 * where TanStack Query takes a `queryFn` (M5C.3f): an object literal's `queryFn` property.
 * Only the syntax is checked; `callersIn` finds the hook that calls it.
 */
function inFetcherPosition(fn: FunctionWithBody): boolean {
  const e = wrapped(fn);
  const p = e.parent;
  if (ts.isCallExpression(p)) return p.arguments[1] === e;
  return (
    ts.isPropertyAssignment(p) &&
    p.initializer === e &&
    (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) &&
    (p.name.text === "fetcher" || p.name.text === "queryFn")
  );
}

/** What an SWR export does with the fetcher it is given (ADR-0193). */
interface HookContract {
  /**
   * The fetcher may come from a config object in its place (`useSWR(key, { fetcher })`) or,
   * when none is given, from `SWRConfig`'s `value`.
   */
  configured: boolean;
  /** What the fetcher gets after the key: nothing, or values the analyzer can't read. */
  rest: "missing" | "unknown";
}

/**
 * SWR's exports that call a fetcher with a key, by `module#export` (ADR-0193): `useSWR`,
 * `useSWRImmutable`, and `useSWRInfinite` call `fetcher(key)`; `useSWRMutation` calls
 * `fetcher(key, { arg })` and takes no default fetcher; `preload(key, fetcher)` calls it once.
 */
const SWR_HOOKS: ReadonlyMap<string, HookContract> = new Map([
  ["swr#default", { configured: true, rest: "missing" }],
  ["swr#preload", { configured: false, rest: "missing" }],
  ["swr/immutable#default", { configured: true, rest: "missing" }],
  ["swr/infinite#default", { configured: true, rest: "missing" }],
  ["swr/mutation#default", { configured: false, rest: "unknown" }],
]);

/** Modules a file must import from for its calls to be checked against {@link SWR_HOOKS}. */
const SWR_MODULES: ReadonlySet<string> = new Set(
  [...SWR_HOOKS.keys()].map((key) => key.slice(0, key.indexOf("#"))),
);

/** True when a file imports from one of `modules`. */
function importsFrom(sourceFile: ts.SourceFile, modules: ReadonlySet<string>): boolean {
  return sourceFile.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteralLike(s.moduleSpecifier) &&
      modules.has(s.moduleSpecifier.text),
  );
}

/**
 * TanStack Query's exports that run an options object's `queryFn` with a context holding the
 * object's `queryKey` (M5C.3f, ADR-0196's amendment), by `module#export`, for React
 * (`@tanstack/react-query`, v4 and v5) and v3 (`react-query`). `queryOptions` and
 * `infiniteQueryOptions` only return the options; their call is where the key is written.
 */
const QUERY_HOOKS: ReadonlySet<string> = new Set(
  ["@tanstack/react-query", "react-query"].flatMap((module) =>
    [
      "useQuery",
      "useSuspenseQuery",
      "useInfiniteQuery",
      "useSuspenseInfiniteQuery",
      "usePrefetchQuery",
      "usePrefetchInfiniteQuery",
      "queryOptions",
      "infiniteQueryOptions",
    ].map((name) => `${module}#${name}`),
  ),
);

/** TanStack Query's `QueryClient`, whose `defaultOptions.queries.queryFn` is the default. */
const QUERY_CLIENTS: ReadonlySet<string> = new Set(
  ["@tanstack/react-query", "@tanstack/query-core", "react-query"].map(
    (module) => `${module}#QueryClient`,
  ),
);

/** Modules a file must import from for its calls to be checked against TanStack's. */
const QUERY_MODULES: ReadonlySet<string> = new Set(
  [...QUERY_HOOKS, ...QUERY_CLIENTS].map((key) => key.slice(0, key.indexOf("#"))),
);

/** The `module#export` an identifier is imported as, if it is a plain import. */
function importedAs(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
  const binding = declaration && importBinding(declaration);
  return binding && `${binding.module}#${binding.name}`;
}

/** The innermost function with a body that contains a node. */
function enclosingFunction(node: ts.Node): FunctionWithBody | undefined {
  for (let n = node.parent as ts.Node | undefined; n; n = n.parent) {
    if (isFunctionWithBody(n)) return n;
  }
  return undefined;
}

/** The function a symbol's declaration node holds as its value, if any. */
function valueFunction(node: ts.Node): ts.Node | undefined {
  if (isFunctionWithBody(node)) return node;
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertyAssignment(node)) &&
    node.initializer
  ) {
    return unwrap(node.initializer);
  }
  if (ts.isExportAssignment(node)) return unwrap(node.expression);
  if (
    ts.isExpressionStatement(node) &&
    ts.isBinaryExpression(node.expression) &&
    node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return unwrap(node.expression.right);
  }
  return undefined;
}

/** The name a call to a symbol node ID is spelled with: the last part of its qualified name. */
function symbolName(id: string): string {
  const qualified = id.slice(id.lastIndexOf("#") + 1);
  return qualified.slice(qualified.lastIndexOf(".") + 1);
}

const compareLocations = (a: SourceLocation, b: SourceLocation): number =>
  compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;

/** The text an unresolved node shows for a site's own request (see {@link HttpRequest}). */
function ownText(
  site: HttpCallSite,
  url: NormalizedUrl,
): Pick<HttpRequest, "label" | "expression"> {
  const method = site.method ?? "?";
  const urlNode = site.url?.expression;
  const base = site.baseURL?.expression;
  const expression = redactedText(
    site.call,
    [urlNode, base].filter((e) => e !== undefined),
  );
  if (url.resolved) return { label: clip(`${method} ${url.text}`), expression };
  const shown = urlNode ? redactedText(urlNode, [urlNode]) : expression;
  return { label: `${method} ${shown}`, expression };
}

/**
 * Find wrappers and inline the calls to them, one {@link HttpFacts} per program, in program
 * order (see the file comment). `sites` are {@link collectHttpCalls}'s. A service's facts
 * depend only on its own analysis and the programs it reached (the wrappers it calls are
 * recorded with `programOf`), not on Express's routes (owners name inline handlers by node
 * key, ADR-0094), except for the candidate filter: a call is resolved only when it is spelled
 * like some wrapper in the repo or through an import alias (ADR-0092).
 *
 * `sites` may also be a function giving one program's sites (`createHttpSiteCollector`), so a
 * program whose wrappers are `known` is only looked into when needed. `scope` limits the facts
 * returned for a run that reuses the others' (ADR-0176, ADR-0177).
 */
export function collectHttpFacts(
  sites: readonly HttpCallSite[] | ((sp: ServiceProgram) => readonly HttpCallSite[]),
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
  normalizer: UrlNormalizer,
  scope: HttpFactsScope = {},
): HttpFacts[] {
  const { only, known = new Map() } = scope;
  const reader = createValueReader(resolver);

  /** The parameter an identifier names, if it is one of `fn`'s. */
  const parameterOf = (
    sp: ServiceProgram,
    expression: ts.Expression,
    fn: FunctionWithBody,
  ): ts.ParameterDeclaration | undefined => {
    const e = unwrap(expression);
    if (!ts.isIdentifier(e)) return undefined;
    const d = reader.symbolAt(sp, e)?.valueDeclaration;
    return d && ts.isParameter(d) && d.parent === fn ? d : undefined;
  };

  /**
   * What spreading `rest` copies when it is the rest element of an object pattern
   * (M5C.7a): `const { json, ...rest } = init` copies `init` (a `const` declaration only), and a
   * parameter `{ json, ...rest }` copies its argument. `method` says whether `rest` can hold a
   * `method`: `false` when the pattern takes it out by name, `null` when a computed key might.
   * `undefined` when the value isn't such a rest element.
   */
  const restElement = (
    value: ProgramExpression,
  ):
    | ({ method: boolean | null } & (
        | { value: ProgramExpression }
        | { parameter: ts.ParameterDeclaration }
      ))
    | undefined => {
    const e = unwrap(value.expression);
    if (!ts.isIdentifier(e)) return undefined;
    const d = reader.symbolAt(value.sp, e)?.valueDeclaration;
    if (!d || !ts.isBindingElement(d) || !d.dotDotDotToken) return undefined;
    const pattern = d.parent;
    if (!ts.isObjectBindingPattern(pattern)) return undefined;
    let named = false;
    let unknown = false;
    for (const element of pattern.elements) {
      if (element === d) continue;
      const key = element.propertyName ?? element.name;
      const text =
        ts.isIdentifier(key) || ts.isStringLiteralLike(key)
          ? key.text
          : ts.isComputedPropertyName(key)
            ? reader.constString(value.sp, key.expression, 0)
            : "";
      if (text === "method") named = true;
      else if (text === undefined) unknown = true;
    }
    const method = named ? false : unknown ? null : true;
    const holder = pattern.parent;
    if (ts.isParameter(holder)) return { method, parameter: holder };
    if (
      ts.isVariableDeclaration(holder) &&
      holder.initializer &&
      ts.isVariableDeclarationList(holder.parent) &&
      holder.parent.flags & ts.NodeFlags.Const
    ) {
      return { method, value: { sp: value.sp, expression: holder.initializer } };
    }
    return undefined;
  };

  /** True when a method source expression reads `fn`'s parameter, directly or as a rest. */
  const readsParameter = (value: ProgramExpression, fn: FunctionWithBody): boolean => {
    const rest = restElement(value);
    if (!rest) return parameterOf(value.sp, value.expression, fn) !== undefined;
    return "parameter" in rest
      ? rest.parameter.parent === fn
      : parameterOf(rest.value.sp, rest.value.expression, fn) !== undefined;
  };

  /** The expressions an unreadable method could come from. */
  const sourceExpressions = (source: MethodSource): ProgramExpression[] => {
    if (source.kind === "value") return [source.value];
    if (source.kind === "config") return [source.config];
    return source.fallback ? [...source.spreads, source.fallback] : source.spreads;
  };

  /**
   * The symbol node ID of the wrapper function a site sits in, if any: the innermost symbol
   * around the site whose value is a function containing it, directly or inside callbacks it
   * declares (`new Promise(async (resolve) => { await axios(req) })`, M5A.3c).
   */
  const wrapperOf = (site: HttpCallSite): { id: string; fn: FunctionWithBody } | undefined =>
    functionAround(site.call);

  /** Like {@link wrapperOf}, for any call: the symbol function it sits in, if any. */
  const functionAround = (
    call: ts.CallExpression,
  ): { id: string; fn: FunctionWithBody } | undefined => {
    const byNode = resolver.callers.get(call.getSourceFile());
    if (!byNode) return undefined;
    let n: ts.Node | undefined = call.parent;
    while (n && !byNode.has(n)) n = n.parent;
    const id = n && byNode.get(n);
    const fn = n && valueFunction(n);
    if (id === undefined || !fn || !isFunctionWithBody(fn)) return undefined;
    for (let f = enclosingFunction(call); f; f = enclosingFunction(f)) {
      if (f === fn) return { id, fn };
    }
    return undefined;
  };

  /** A site's own requests, as when nothing inlines it: one per URL alternative (M5A.3h). */
  const own = (site: HttpCallSite): HttpRequestFact[] =>
    normalizer.alternatives(site).map((url) => ({
      call: { client: site.client, file: site.file, site: site.site },
      file: site.file,
      site: site.site,
      owners: site.owners,
      method: site.method,
      url,
      confidence: url.resolved ? weaker(site.confidence, url.confidence) : site.confidence,
      ...ownText(site, url),
    }));

  // ---- per service: find wrappers ----

  let sitesOf: (sp: ServiceProgram) => readonly HttpCallSite[];
  if (typeof sites === "function") {
    sitesOf = sites;
  } else {
    const bySp = new Map<ServiceProgram, HttpCallSite[]>(programs.map((sp) => [sp, []]));
    for (const site of sites) bySp.get(site.sp)?.push(site);
    sitesOf = (sp) => bySp.get(sp) ?? [];
  }

  /** The index of `fn`'s rest parameter a `fetch(...args)` site spreads, if it does (M5B.2b). */
  const restIndex = (site: HttpCallSite, fn: FunctionWithBody): number | undefined => {
    const d = site.spread && parameterOf(site.spread.sp, site.spread.expression, fn);
    return d?.dotDotDotToken ? fn.parameters.indexOf(d) : undefined;
  };

  /**
   * True when a site reads `fn`'s parameters where a caller's arguments matter: `read` (its
   * leading parameters, any function's), its config or method, or a spread rest parameter.
   */
  const readsParameters = (
    site: HttpCallSite,
    fn: FunctionWithBody,
    read: ReadonlySet<ts.ParameterDeclaration>,
  ): boolean =>
    [...read].some((d) => d.parent === fn) ||
    (site.config !== undefined &&
      parameterOf(site.config.value.sp, site.config.value.expression, fn) !== undefined) ||
    (site.methodSource !== undefined &&
      sourceExpressions(site.methodSource).some((value) => readsParameter(value, fn))) ||
    restIndex(site, fn) !== undefined;

  const direct = new Map<ServiceProgram, HttpCallSite[]>();
  const owned = new Map<ServiceProgram, Map<string, Wrapper>>();
  /** Every wrapper in the repo by symbol node ID: the index callers are matched against. */
  const wrappers = new Map<string, Wrapper>();
  /** Fetchers written in place (M5B.2b) by function node, and each program's in site order. */
  const inlineFetchers = new Map<ts.Node, Wrapper>();
  const inlineIn = new Map<ServiceProgram, Wrapper[]>();
  /** Split `sp`'s sites into wrapper bodies', fetchers written in place, and the rest. */
  const findWrappers = (sp: ServiceProgram): void => {
    const plain: HttpCallSite[] = [];
    const mine = new Map<string, Wrapper>();
    const fetchers: Wrapper[] = [];
    for (const site of sitesOf(sp)) {
      const found = wrapperOf(site);
      // A parameter that only fills a later hole or the query leaves the route fixed here.
      let read: ReadonlySet<ts.ParameterDeclaration> | undefined;
      const leading = (): ReadonlySet<ts.ParameterDeclaration> =>
        (read ??= normalizer.leadingParameters(site));
      if (!found || !readsParameters(site, found.fn, leading())) {
        // A fetcher written where SWR takes one, reading its own parameters (M5B.2b).
        let fetcher: FunctionWithBody | undefined;
        for (let f = enclosingFunction(site.call); f && !fetcher; f = enclosingFunction(f)) {
          if (inFetcherPosition(f) && readsParameters(site, f, leading())) fetcher = f;
        }
        if (!fetcher) {
          plain.push(site);
          continue;
        }
        let inline = inlineFetchers.get(fetcher);
        if (!inline) {
          inline = {
            sp: site.sp,
            fn: fetcher,
            file: site.file,
            sites: [],
            leading: new Map(),
            inner: [],
            depth: 1,
          };
          inlineFetchers.set(fetcher, inline);
          fetchers.push(inline);
        }
        inline.sites.push(site);
        inline.leading.set(site, leading());
        continue;
      }
      const wrapper: Wrapper = mine.get(found.id) ?? {
        sp: site.sp,
        fn: found.fn,
        file: site.file,
        sites: [],
        leading: new Map(),
        inner: [],
        depth: 1,
      };
      wrapper.sites.push(site);
      wrapper.leading.set(site, leading());
      mine.set(found.id, wrapper);
      wrappers.set(found.id, wrapper);
    }
    direct.set(sp, plain);
    owned.set(sp, mine);
    inlineIn.set(sp, fetchers);
  };
  /** Wrappers known only by ID so far (`scope.known`), with the program holding each. */
  const pending = new Map<string, ServiceProgram>();
  for (const sp of programs) {
    const ids = only && !only.has(sp) ? known.get(sp) : undefined;
    if (ids) {
      for (const id of ids) pending.set(id, sp);
      continue;
    }
    resolver.asking(sp, () => {
      findWrappers(sp);
    });
  }
  /** The programs whose wrappers were looked for up front, in program order. */
  const scanned = programs.filter((sp) => owned.has(sp));
  /** Names calls to wrappers are spelled with; grows as wrappers over wrappers are found. */
  const names = new Set([...wrappers.keys(), ...pending.keys()].map(symbolName));
  /** The wrapper with this ID, finding its program's wrappers first when only known by ID. */
  const wrapperById = (id: string): Wrapper | undefined => {
    const sp = pending.get(id);
    if (sp) {
      for (const [other, owner] of pending) if (owner === sp) pending.delete(other);
      resolver.asking(sp, () => {
        findWrappers(sp);
        // Its wrappers over wrappers, whose names are known already (M5C.7f).
        let fresh: ReadonlySet<string> | undefined;
        for (let round = 0; round <= MAX_WRAPPER_DEPTH; round++) {
          const added = discoverIn(sp, callersIn(sp, fresh).callers);
          if (added.length === 0) break;
          fresh = new Set(added);
        }
      });
    }
    return wrappers.get(id);
  };

  // ---- per service: find and inline calls to wrappers ----

  /**
   * The wrapper a callee or value expression names, if any. Only expressions spelled like a
   * wrapper, or through a (possibly renamed) import, are resolved.
   */
  const wrapperAt = (
    sp: ServiceProgram,
    expression: ts.Expression,
  ): { id: string; confidence: Confidence } | undefined => {
    const name = calleeName(expression);
    const candidate =
      name !== undefined &&
      ((ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? names.has(name.text) : false) ||
        (ts.isIdentifier(name) &&
          ((resolver.checkerOf(sp).getSymbolAtLocation(name)?.flags ?? 0) &
            ts.SymbolFlags.Alias) !==
            0));
    const target = candidate ? resolver.resolve(sp, expression) : undefined;
    return target && (wrappers.has(target.id) || pending.has(target.id)) ? target : undefined;
  };

  /** The fetcher an expression handed to SWR is: one written in place, or a wrapper. */
  const fetcherTarget = (
    sp: ServiceProgram,
    expression: ts.Expression,
  ): FetcherTarget | undefined => {
    const e = unwrap(expression);
    if (isFunctionWithBody(e) && inlineFetchers.has(e)) return { fn: e, confidence: "exact" };
    return wrapperAt(sp, expression);
  };

  /**
   * The keys an SWR key argument may be (ADR-0193): `null`, `undefined`, and `false` (also a
   * ternary's or `&&`'s falsy side) make no request; a function key (`() => url`, and
   * `useSWRInfinite`'s `getKey(index, previous)`) gives what it returns; an array literal is
   * `array`; anything else is read as the URL.
   */
  const keysOf = (sp: ServiceProgram, expression: ts.Expression, hops: number): HookKey[] => {
    const e = unwrap(expression);
    if (hops > MAX_HOPS) return [e];
    if (
      e.kind === ts.SyntaxKind.NullKeyword ||
      e.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isIdentifier(e) && e.text === "undefined")
    ) {
      return [];
    }
    if (ts.isConditionalExpression(e)) {
      return [...keysOf(sp, e.whenTrue, hops + 1), ...keysOf(sp, e.whenFalse, hops + 1)];
    }
    if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return keysOf(sp, e.right, hops + 1);
    }
    if (ts.isArrayLiteralExpression(e)) return ["array"];
    let fn: FunctionWithBody | undefined;
    if (isFunctionWithBody(e)) fn = e;
    else if (ts.isIdentifier(e)) {
      const symbol = reader.symbolAt(sp, e);
      fn = symbol && functionOf(resolver.checkerOf(sp), symbol);
    }
    if (fn) return returnedExpressions(fn).flatMap((r) => keysOf(sp, r, hops + 1));
    return [e];
  };

  /**
   * The fetcher an SWR call is given: its second argument, or a config object's `fetcher`
   * there (when the contract allows one); `default` when none is given and `SWRConfig`'s
   * applies; `undefined` when there is none or it can't be read.
   */
  const fetcherOf = (
    sp: ServiceProgram,
    call: ts.CallExpression,
    contract: HookContract,
  ): ts.Expression | "default" | undefined => {
    const arg = call.arguments[1];
    if (!arg) return contract.configured ? "default" : undefined;
    const e = unwrap(arg);
    if (e.kind === ts.SyntaxKind.NullKeyword) return undefined;
    if (!contract.configured || !ts.isObjectLiteralExpression(e)) return arg;
    const fetcher = objectProperty(sp, e, "fetcher");
    return fetcher === undefined ? "default" : (fetcher?.expression ?? undefined);
  };

  /**
   * The fetcher `SWRConfig`'s `value` sets as the default in `sp` (a wrapper, or one written
   * there, M5B.2b), when every `<SWRConfig value={{ fetcher }}>` rendered in it sets the same
   * one (ADR-0193): which hooks render under which config isn't modeled, so the default is
   * `heuristic`. Any config whose fetcher is neither, or two different ones, give no default.
   */
  const defaultFetcherIn = (
    sp: ServiceProgram,
    files: readonly ts.SourceFile[],
  ): FetcherTarget | undefined => {
    const checker = resolver.checkerOf(sp);
    const found = new Map<string | FunctionWithBody, Confidence>();
    let unknown = false;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        importedAs(checker, node.tagName) === "swr#SWRConfig"
      ) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) {
            unknown = true; // a spread may set `value`
            continue;
          }
          if (!ts.isIdentifier(attribute.name) || attribute.name.text !== "value") continue;
          const init = attribute.initializer;
          const value = init && ts.isJsxExpression(init) ? init.expression : undefined;
          const e = value && unwrap(value);
          const object = !e
            ? undefined
            : ts.isObjectLiteralExpression(e)
              ? { sp, expression: e }
              : reader.constObject(sp, e, 0);
          const fetcher = object && objectProperty(object.sp, object.expression, "fetcher");
          if (fetcher === undefined && object) continue; // a config that sets no fetcher
          const target = fetcher ? fetcherTarget(fetcher.sp, fetcher.expression) : undefined;
          const key = target && ("id" in target ? target.id : target.fn);
          if (target && key) found.set(key, weaker(found.get(key) ?? "exact", target.confidence));
          else unknown = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const sourceFile of files) visit(sourceFile);
    return unknown ? undefined : onlyDefault(found);
  };

  /** The one default fetcher found, at `heuristic`; none when zero or several were. */
  const onlyDefault = (
    found: ReadonlyMap<string | FunctionWithBody, Confidence>,
  ): FetcherTarget | undefined => {
    const [only, ...others] = [...found];
    if (!only || others.length > 0) return undefined;
    const [key, confidence] = only;
    const heuristic = weaker(confidence, "heuristic");
    return typeof key === "string"
      ? { id: key, confidence: heuristic }
      : { fn: key, confidence: heuristic };
  };

  /** An object literal, or the `const` object an expression names. */
  const objectAt = (value: ProgramExpression): ProgramExpression | undefined => {
    const e = unwrap(value.expression);
    if (ts.isObjectLiteralExpression(e)) return { sp: value.sp, expression: e };
    return reader.constObject(value.sp, e, 0);
  };

  /**
   * The default `queryFn` of TanStack Query's `QueryClient`s in `sp` (M5C.3f), like
   * `SWRConfig`'s fetcher: when every `new QueryClient({ defaultOptions: { queries: { queryFn
   * } } })` that sets one sets the same (a wrapper, or one written there), at `heuristic`,
   * since which client a hook runs under isn't modeled. A client whose options can't be read,
   * or two different defaults, give none.
   */
  const defaultQueryFnIn = (
    sp: ServiceProgram,
    files: readonly ts.SourceFile[],
  ): FetcherTarget | undefined => {
    const checker = resolver.checkerOf(sp);
    const found = new Map<string | FunctionWithBody, Confidence>();
    let unknown = false;
    /** A property of an options object: `null` when it can't be read. */
    const property = (value: ProgramExpression | undefined, name: string): ConfigValue => {
      const object = value && objectAt(value);
      return object && ts.isObjectLiteralExpression(object.expression)
        ? objectProperty(object.sp, object.expression, name)
        : null;
    };
    const visit = (node: ts.Node): void => {
      const callee = ts.isNewExpression(node) ? unwrap(node.expression) : undefined;
      if (
        ts.isNewExpression(node) &&
        callee &&
        ts.isIdentifier(callee) &&
        QUERY_CLIENTS.has(importedAs(checker, callee) ?? "")
      ) {
        const [options] = node.arguments ?? [];
        const defaults = options && property({ sp, expression: options }, "defaultOptions");
        const queries = defaults && property(defaults, "queries");
        const queryFn = queries && property(queries, "queryFn");
        // A client that sets no default `queryFn` (`new QueryClient()`, in tests) is left out.
        if (options && defaults !== undefined && queries !== undefined && queryFn !== undefined) {
          const target = queryFn ? fetcherTarget(queryFn.sp, queryFn.expression) : undefined;
          const key = target && ("id" in target ? target.id : target.fn);
          if (target && key) found.set(key, weaker(found.get(key) ?? "exact", target.confidence));
          else unknown = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const sourceFile of files) visit(sourceFile);
    return unknown ? undefined : onlyDefault(found);
  };

  /**
   * The service's calls to wrappers, by wrapper ID, and the hooks that call its fetchers
   * written in place (M5B.2b), by function node, in file and visit order. With `only`, just
   * the calls to those wrappers (found in a later round, M5C.7f), and no fetchers in place.
   */
  const callersIn = (
    sp: ServiceProgram,
    only?: ReadonlySet<string>,
  ): { callers: Map<string, Caller[]>; hooks: Map<ts.Node, Caller[]> } => {
    const callers = new Map<string, Caller[]>();
    const hooks = new Map<ts.Node, Caller[]>();
    if (names.size === 0 && (inlineIn.get(sp) ?? []).length === 0) return { callers, hooks };
    const checker = resolver.checkerOf(sp);
    const files = sp.rootFiles.flatMap((file) => {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      const byNode = sourceFile && resolver.callers.get(sourceFile);
      return sourceFile && byNode
        ? [
            {
              file,
              sourceFile,
              byNode,
              swr: importsFrom(sourceFile, SWR_MODULES),
              query: importsFrom(sourceFile, QUERY_MODULES),
            },
          ]
        : [];
    });
    let defaultFetcher: ReturnType<typeof defaultFetcherIn> | null = null;
    /** `SWRConfig`'s default fetcher, found on the first hook call that needs it. */
    const configured = (): ReturnType<typeof defaultFetcherIn> =>
      (defaultFetcher ??= defaultFetcherIn(
        sp,
        files.filter((f) => f.swr).map((f) => f.sourceFile),
      ));
    let defaultQueryFn: ReturnType<typeof defaultQueryFnIn> | null = null;
    /** The `QueryClient`s' default `queryFn`, found on the first query that needs it. */
    const queryDefault = (): ReturnType<typeof defaultQueryFnIn> =>
      (defaultQueryFn ??= defaultQueryFnIn(
        sp,
        files.filter((f) => f.query).map((f) => f.sourceFile),
      ));
    const add = (id: string, caller: Caller): void => {
      if (only && !only.has(id)) return;
      const list = callers.get(id) ?? [];
      list.push(caller);
      callers.set(id, list);
    };
    /**
     * The `queryFn` a TanStack Query call runs with its options in the context (M5C.3f): the
     * options' own `queryFn`, else the `QueryClient`s' default. None when the options can't
     * be read or a spread may set `queryFn`.
     */
    const queryFnOf = (options: ts.Expression): FetcherTarget | undefined => {
      const object = objectAt({ sp, expression: options });
      if (!object || !ts.isObjectLiteralExpression(object.expression)) return undefined;
      const queryFn = objectProperty(object.sp, object.expression, "queryFn");
      if (queryFn === undefined) return queryDefault();
      return queryFn ? fetcherTarget(queryFn.sp, queryFn.expression) : undefined;
    };
    for (const { file, sourceFile, byNode, swr, query } of files) {
      const visit = (node: ts.Node, owners: Owners): void => {
        const current = ownersAt(file, node, byNode.get(node), owners);
        if (ts.isCallExpression(node)) {
          const caller = {
            sp,
            file,
            call: node,
            site: locationOf(node, file),
            owners: current,
          };
          const target = wrapperAt(sp, node.expression);
          if (target) add(target.id, { ...caller, confidence: target.confidence });
          const callee = unwrap(node.expression);
          const contract =
            swr && ts.isIdentifier(callee)
              ? SWR_HOOKS.get(importedAs(checker, callee) ?? "")
              : undefined;
          const [key, second] = node.arguments;
          if (contract && key && ![key, second].some((a) => a && ts.isSpreadElement(a))) {
            const fetcher = fetcherOf(sp, node, contract);
            const used =
              fetcher === "default" ? configured() : fetcher && fetcherTarget(sp, fetcher);
            if (used) {
              const hooked = {
                ...caller,
                confidence: used.confidence,
                hook: { keys: keysOf(sp, key, 0), rest: contract.rest },
              };
              if ("id" in used) add(used.id, hooked);
              else if (!only) hooks.set(used.fn, [...(hooks.get(used.fn) ?? []), hooked]);
            }
          }
          // TanStack Query calls `queryFn({ queryKey, … })`: its context parameter is bound to
          // the options object, whose `queryKey` the URL reads (`url.ts`).
          const [options] = node.arguments;
          if (
            query &&
            options &&
            !ts.isSpreadElement(options) &&
            ts.isIdentifier(callee) &&
            QUERY_HOOKS.has(importedAs(checker, callee) ?? "")
          ) {
            const used = queryFnOf(options);
            if (used) {
              const hooked = {
                ...caller,
                confidence: used.confidence,
                hook: { keys: [options], rest: "missing" as const },
              };
              if ("id" in used) add(used.id, hooked);
              else if (!only) hooks.set(used.fn, [...(hooks.get(used.fn) ?? []), hooked]);
            }
          }
        }
        ts.forEachChild(node, (child) => {
          visit(child, current);
        });
      };
      visit(sourceFile, NO_OWNERS);
    }
    return { callers, hooks };
  };

  /** A property of an object literal or const object (`null`: not readable). */
  const literalProperty = (value: ProgramExpression, name: string): ConfigValue => {
    const e = unwrap(value.expression);
    const object = ts.isObjectLiteralExpression(e)
      ? { sp: value.sp, expression: e }
      : reader.constObject(value.sp, e, 0);
    return object ? objectProperty(object.sp, object.expression, name) : null;
  };

  /** The `method` property of an object literal or const object (`null`: not readable). */
  const methodProperty = (value: ProgramExpression): ConfigValue =>
    literalProperty(value, "method");

  /** True when an expression names a parameter (of any function: the caller's, here). */
  const isParameterName = (value: ProgramExpression): boolean => {
    const e = unwrap(value.expression);
    const d = ts.isIdentifier(e) ? reader.symbolAt(value.sp, e)?.valueDeclaration : undefined;
    return d !== undefined && ts.isParameter(d);
  };

  /**
   * The requests one call to a wrapper makes: one per site in the wrapper's body. For a hook
   * call (ADR-0193), one per key the hook may pass, the same request kept once. `id` is
   * `undefined` for a fetcher written in place (M5B.2b), which is no symbol.
   */
  const inline = (id: string | undefined, wrapper: Wrapper, caller: Caller): HttpRequestFact[] => {
    const { hook } = caller;
    if (!hook) return inlineWith(id, wrapper, caller, caller.call.arguments, "missing");
    const seen = new Set<string>();
    return hook.keys
      .flatMap((key) =>
        inlineWith(id, wrapper, caller, key === "array" ? undefined : [key], hook.rest),
      )
      .filter((request) => {
        const key = JSON.stringify([request.call.site, request.method, request.url]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };

  /**
   * A wrapper's parameters bound to a call's arguments (see `inlineWith`), the arguments read
   * with `outer` when the call sits in a wrapper being inlined too (M5C.7f).
   */
  const bindArguments = (
    wrapper: Wrapper,
    callerSp: ServiceProgram,
    given: readonly ts.Expression[] | undefined,
    rest: "missing" | "unknown",
    outer: ParameterBindings | undefined,
  ): { bindings: ParameterBindings; missing: Set<ts.ParameterDeclaration> } => {
    const args = given ?? [];
    const spread = args.findIndex((a) => ts.isSpreadElement(a));
    const map = new Map<ts.ParameterDeclaration, ProgramExpression | undefined>();
    /** Parameters with no argument and no default: `undefined` at runtime. */
    const missing = new Set<ts.ParameterDeclaration>();
    // A destructured parameter is bound too: the URL reads only its `queryKey` (`url.ts`).
    wrapper.fn.parameters.forEach((d, i) => {
      const arg = args[i];
      if (d.dotDotDotToken || (spread !== -1 && spread <= i)) {
        map.set(d, undefined);
      } else if (arg) {
        map.set(d, { sp: callerSp, expression: arg });
      } else if ((given === undefined && i === 0) || rest === "unknown") {
        map.set(d, undefined);
      } else if (d.initializer) {
        map.set(d, { sp: wrapper.sp, expression: d.initializer });
      } else {
        map.set(d, undefined);
        missing.add(d);
      }
    });
    return { bindings: Object.assign(map, { missing }, outer ? { outer } : {}), missing };
  };

  /**
   * The requests a call to a wrapper makes with these arguments: `undefined` when the first
   * one can't be read as a URL (an SWR array key), and arguments past the end either absent
   * (`missing`, so defaults apply) or `unknown`. `outer` is the wrapper call the caller sits
   * in when the caller is a wrapper over this one, and `chain` the wrappers being inlined
   * around it, outermost first (M5C.7f).
   */
  const inlineWith = (
    id: string | undefined,
    wrapper: Wrapper,
    caller: Caller,
    given: readonly ts.Expression[] | undefined,
    rest: "missing" | "unknown",
    outer?: Scope,
    chain: readonly string[] = [],
  ): HttpRequestFact[] => {
    const args = given ?? [];
    const spread = args.findIndex((a) => ts.isSpreadElement(a));
    const { bindings, missing } = bindArguments(wrapper, caller.sp, given, rest, outer?.bindings);

    /** Argument `i`: `null` when unknown (a spread at or before it), `undefined` when absent. */
    const argAt = (i: number): ts.Expression | null | undefined => {
      if (spread !== -1 && spread <= i) return null;
      return args[i] ?? (rest === "unknown" ? null : undefined);
    };

    /**
     * A value with this call's bindings, and the outer calls' (M5C.7f): `missing` for an
     * absent argument, `null` if unknown.
     */
    const bound = (value: ProgramExpression): ProgramExpression | "missing" | null => {
      const d = parameterOf(value.sp, value.expression, wrapper.fn);
      if (d) return boundParameter(d);
      return outer ? outer.resolve(value) : value;
    };
    const boundParameter = (d: ts.ParameterDeclaration): ProgramExpression | "missing" | null => {
      if (missing.has(d)) return "missing";
      const v = bindings.get(d) ?? null;
      return v && outer ? outer.resolve(v) : v;
    };

    /** The method a `method` value names; absent (or `undefined`) is the default, `GET`. */
    const methodValue = (value: ConfigValue): HttpMethod | null => {
      if (value === null) return null;
      const v = value && bound(value);
      if (v === undefined || v === "missing") return "GET";
      if (v === null) return null;
      const text = reader.constString(v.sp, v.expression, 0);
      return text === undefined ? null : toMethod(text);
    };

    /** The method a config's `method` property names (an absent config is `GET`). */
    const configMethod = (config: ProgramExpression): HttpMethod | null => {
      const v = bound(config);
      if (v === "missing") return "GET";
      return v === null ? null : methodValue(methodProperty(v));
    };

    const boundMethod = (site: HttpCallSite): HttpMethod | null => {
      const source = site.methodSource;
      if (site.method !== null || !source) return site.method;
      if (source.kind === "value") return methodValue(source.value);
      if (source.kind === "config") return configMethod(source.config);
      // `{ method: "GET", ...init }`: the last spread that sets `method` wins. A rest element
      // (`const { json, ...rest } = init`) copies `init` unless the pattern takes `method` out.
      for (const spread of source.spreads) {
        const rest = restElement(spread);
        if (rest?.method === false) continue;
        if (rest?.method === null) return null;
        const v = !rest
          ? bound(spread)
          : "value" in rest
            ? bound(rest.value)
            : rest.parameter.parent === wrapper.fn
              ? boundParameter(rest.parameter)
              : null;
        if (v === "missing") continue;
        const method = v === null ? null : methodProperty(v);
        if (method !== undefined) return methodValue(method);
      }
      return methodValue(source.fallback);
    };

    /**
     * The URL of a site whose whole axios config is a parameter (M5A.3c): `url` and `baseURL`
     * read from the caller's object literal or const object (no `baseURL` there: the
     * instance's), with the nodes an unresolved request may show. A caller passing its own
     * parameter on is `WRAPPER_DEPTH`; any other config it can't read has no URL.
     */
    const configUrl = (
      config: NonNullable<HttpCallSite["config"]>,
    ): { urls: NormalizedUrl[]; shown: ts.Node[] } => {
      const v = bound(config.value);
      if (v !== null && v !== "missing" && isParameterName(v)) {
        return {
          urls: [{ resolved: false, reason: "WRAPPER_DEPTH", detail: WRAPPER_DEPTH_DETAIL.config }],
          shown: [],
        };
      }
      const url = v === null ? null : v === "missing" ? undefined : literalProperty(v, "url");
      const base = v === null || v === "missing" ? undefined : literalProperty(v, "baseURL");
      const target = {
        url: url ?? null,
        baseURL: base === undefined ? config.baseURL : base,
      };
      return {
        urls: normalizer.alternatives(target, bindings),
        shown: [url?.expression, base?.expression].filter((e) => e !== undefined),
      };
    };

    /**
     * A `fetch(...args)` site spreading the rest parameter at `index` (M5B.2b): the URL and
     * init are the caller's arguments from there on.
     */
    const spreadRequest = (
      site: HttpCallSite,
      index: number,
    ): { urls: NormalizedUrl[]; shown: ts.Node[]; method: HttpMethod | null } => {
      const url = argAt(index);
      const init = argAt(index + 1);
      return {
        // The caller's argument is read in the caller's scope (its own bindings, M5C.7f).
        urls: normalizer.alternatives(
          { url: url ? { sp: caller.sp, expression: url } : null, baseURL: site.baseURL },
          outer?.bindings ?? bindings,
        ),
        shown: url ? [url] : [],
        method:
          init === null
            ? null
            : init === undefined
              ? "GET"
              : configMethod({ sp: caller.sp, expression: init }),
      };
    };

    const fromSites = wrapper.sites.flatMap((site): HttpRequestFact[] => {
      const index = restIndex(site, wrapper.fn);
      const fromSpread = index === undefined ? undefined : spreadRequest(site, index);
      const fromConfig = site.config && configUrl(site.config);
      // A function inside the wrapper (one it returns: `createClient(base)` ⇒
      // `{ get: (path) => fetch(base + "/" + path) }`) whose own parameter leads the URL: this
      // call binds `base`, but `path` comes from a later call, so the route isn't known (M5A.5c).
      const inner = [...(wrapper.leading.get(site) ?? [])].some((d) => !bindings.has(d));
      const urls: NormalizedUrl[] = inner
        ? [{ resolved: false, reason: "WRAPPER_DEPTH", detail: WRAPPER_DEPTH_DETAIL.inner }]
        : given === undefined
          ? [{ resolved: false, reason: "DYNAMIC_URL", detail: DYNAMIC_URL_DETAIL.hookKey }]
          : ((fromSpread ?? fromConfig)?.urls ?? normalizer.alternatives(site, bindings));
      const confidence = weaker(site.confidence, caller.confidence);
      const read = normalizer.parameters(site);
      const urlArgs =
        (fromSpread ?? fromConfig)?.shown ??
        wrapper.fn.parameters.flatMap((d, i) => {
          const arg = args[i];
          return read.has(d) && arg ? [arg] : [];
        });
      const method = fromSpread ? fromSpread.method : boundMethod(site);
      const expression = redactedText(caller.call, urlArgs);
      return urls.map((url) => ({
        call: { client: site.client, file: site.file, site: site.site },
        ...(id === undefined ? {} : { via: id }),
        file: caller.file,
        site: caller.site,
        owners: caller.owners,
        method,
        url,
        confidence: url.resolved ? weaker(confidence, url.confidence) : confidence,
        label: url.resolved
          ? clip(`${method ?? "?"} ${url.text}`)
          : `${method ?? "?"} ${expression}`,
        expression,
      }));
    });

    // Its calls to wrappers it passes its parameters to (M5C.7f): each inlined with this
    // call's bindings, then placed at this call. A chain past the depth limit, or a cycle,
    // reads no further.
    const scope: Scope = { bindings, resolve: bound };
    const fromInner = wrapper.inner.flatMap(({ id: innerId, caller: innerCall, reads }) => {
      const innerWrapper = wrappers.get(innerId);
      if (!innerWrapper) return [];
      const ids = id === undefined ? chain : [...chain, id];
      const followed =
        ids.length < MAX_WRAPPER_DEPTH && !ids.includes(innerId)
          ? inlineWith(
              innerId,
              innerWrapper,
              innerCall,
              innerCall.call.arguments,
              "missing",
              scope,
              ids,
            )
          : inlineWith(innerId, innerWrapper, innerCall, innerCall.call.arguments, "missing").map(
              tooDeepRequest,
            );
      const expression = redactedText(
        caller.call,
        wrapper.fn.parameters.flatMap((d, i) => {
          const arg = args[i];
          return reads.has(d) && arg ? [arg] : [];
        }),
      );
      return followed.map((request) => ({
        ...request,
        ...(id === undefined ? {} : { via: id }),
        file: caller.file,
        site: caller.site,
        owners: caller.owners,
        confidence: weaker(request.confidence, caller.confidence),
        label: request.url.resolved ? request.label : `${request.method ?? "?"} ${expression}`,
        expression,
      }));
    });
    const requests = [...fromSites, ...withinBudget(fromInner)];
    // A function passing its parameter into a chain already at the depth limit.
    return tooDeep.has(caller.call) ? requests.map(tooDeepRequest) : requests;
  };

  /**
   * `requests`, or past {@link MAX_CHAIN_REQUESTS} one `DYNAMIC_URL` request per site they
   * come from (the first), so every site is still represented.
   */
  const withinBudget = (requests: HttpRequestFact[]): HttpRequestFact[] => {
    if (requests.length <= MAX_CHAIN_REQUESTS) return requests;
    const seen = new Set<string>();
    return requests.flatMap((request) => {
      const key = JSON.stringify(request.call.site);
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          ...request,
          url: { resolved: false, reason: "DYNAMIC_URL", detail: DYNAMIC_URL_DETAIL.tooComplex },
          label: `${request.method ?? "?"} ${request.expression}`,
        },
      ];
    });
  };

  /** A request made `WRAPPER_DEPTH`: its chain of wrappers is deeper than followed (M5C.7f). */
  const tooDeepRequest = (request: HttpRequestFact): HttpRequestFact => ({
    ...request,
    url: { resolved: false, reason: "WRAPPER_DEPTH", detail: WRAPPER_DEPTH_DETAIL.chain },
    label: `${request.method ?? "?"} ${request.expression}`,
  });

  // ---- wrappers over wrappers (M5C.7f) ----

  /** Calls that are some wrapper's {@link InnerCall}: its requests, not call facts. */
  const innerCalls = new Set<ts.CallExpression>();
  /** Calls passing a parameter into a chain already {@link MAX_WRAPPER_DEPTH} deep. */
  const tooDeep = new Set<ts.CallExpression>();

  /** True when wrapper `from` is `to` or reaches it through inner calls. */
  const reaches = (from: string, to: string, hops = 0): boolean =>
    from === to ||
    (hops <= MAX_WRAPPER_DEPTH &&
      (wrappers.get(from)?.inner ?? []).some((c) => reaches(c.id, to, hops + 1)));

  /** A wrapper's own parameters its requests' URLs read: its sites', and its inner calls'. */
  const urlParameters = (wrapper: Wrapper): Set<ts.ParameterDeclaration> => {
    const found = new Set<ts.ParameterDeclaration>();
    for (const site of wrapper.sites) {
      for (const d of normalizer.parameters(site)) if (d.parent === wrapper.fn) found.add(d);
    }
    for (const { reads } of wrapper.inner) for (const d of reads) found.add(d);
    return found;
  };

  /**
   * What a call to a wrapper passes on of the function `fn` it sits in: `fn`'s parameters in
   * the leading part of an argument the wrapper's URL reads (`leadingHoles`, applied to the
   * argument: `get(path)`, `get(\`${path}?${query}\`)`, not `get("/users/" + id)`), and all of
   * `fn`'s parameters those arguments read.
   */
  const passedOn = (
    wrapper: Wrapper,
    caller: Caller,
    fn: FunctionWithBody,
  ): { leading: boolean; reads: Set<ts.ParameterDeclaration> } => {
    const own = (d: ts.ParameterDeclaration): boolean => d.parent === fn;
    const args = caller.call.arguments;
    const spread = args.findIndex((a) => ts.isSpreadElement(a));
    let leading = false;
    const reads = new Set<ts.ParameterDeclaration>();
    for (const d of urlParameters(wrapper)) {
      const i = wrapper.fn.parameters.indexOf(d);
      const arg = args[i];
      if (d.dotDotDotToken || !arg || (spread !== -1 && spread <= i)) continue;
      const value = { url: { sp: caller.sp, expression: arg }, baseURL: undefined };
      if ([...normalizer.leadingParameters(value)].some(own)) leading = true;
      for (const p of normalizer.parameters(value)) if (own(p)) reads.add(p);
    }
    return { leading, reads };
  };

  /**
   * Find wrappers over wrappers among `sp`'s calls to wrappers: a symbol function that passes
   * its own parameter on as the start of a path (`passedOn`) becomes a wrapper too, that call
   * its {@link InnerCall}, unless the chain would be deeper than {@link MAX_WRAPPER_DEPTH}
   * (the call goes to `tooDeep`) or loop. Returns the IDs of the wrappers it added.
   */
  const discoverIn = (sp: ServiceProgram, callers: ReadonlyMap<string, Caller[]>): string[] => {
    const added: string[] = [];
    for (const [id, list] of [...callers].sort(([a], [b]) => compareStrings(a, b))) {
      const callee = wrapperById(id);
      if (!callee) continue;
      for (const caller of list) {
        if (caller.hook || innerCalls.has(caller.call) || tooDeep.has(caller.call)) continue;
        const around = functionAround(caller.call);
        if (!around || reaches(id, around.id)) continue;
        const found = passedOn(callee, caller, around.fn);
        if (!found.leading) continue;
        if (callee.depth >= MAX_WRAPPER_DEPTH) {
          tooDeep.add(caller.call);
          continue;
        }
        let outer = wrappers.get(around.id);
        if (!outer) {
          outer = {
            sp,
            fn: around.fn,
            file: caller.file,
            sites: [],
            leading: new Map(),
            inner: [],
            depth: 1,
          };
          wrappers.set(around.id, outer);
          owned.get(sp)?.set(around.id, outer);
          added.push(around.id);
        }
        outer.inner.push({ id, caller, reads: found.reads });
        outer.inner.sort((a, b) => compareLocations(a.caller.site, b.caller.site));
        outer.depth = Math.max(outer.depth, callee.depth + 1);
        innerCalls.add(caller.call);
      }
    }
    return added;
  };

  /** Each scanned program's calls to wrappers, gathered over the discovery rounds. */
  const callerCache = new Map<ServiceProgram, ReturnType<typeof callersIn>>();
  // Rounds: each finds wrappers over the last round's, so a chain of `MAX_WRAPPER_DEPTH` is
  // found, and one more round marks calls past it.
  let fresh: ReadonlySet<string> | undefined;
  for (let round = 0; round <= MAX_WRAPPER_DEPTH; round++) {
    const added: string[] = [];
    for (const sp of scanned) {
      resolver.asking(sp, () => {
        const found = callersIn(sp, fresh);
        const cached = callerCache.get(sp);
        if (!cached) callerCache.set(sp, found);
        else for (const [id, list] of found.callers) cached.callers.set(id, list);
        added.push(...discoverIn(sp, found.callers));
      });
    }
    if (added.length === 0) break;
    for (const id of added) names.add(symbolName(id));
    fresh = new Set(added);
  }

  /** Record that `sp`'s facts depend on the programs of a wrapper and those it calls. */
  const reached = (sp: ServiceProgram, wrapper: Wrapper, hops = 0): void => {
    // The facts now depend on the wrapper's program (inputs.ts follows `reached`).
    resolver.programOf(wrapper.file, sp);
    if (hops >= MAX_WRAPPER_DEPTH) return;
    for (const { id } of wrapper.inner) {
      const inner = wrapperById(id);
      if (inner) reached(sp, inner, hops + 1);
    }
  };

  /** `sp`'s facts, once every service's wrappers are known. */
  const factsOf = (sp: ServiceProgram): HttpFacts => {
    const calls: WrapperCallFact[] = [];
    const { callers, hooks } = callerCache.get(sp) ?? callersIn(sp);
    for (const [id, list] of [...callers].sort(([a], [b]) => compareStrings(a, b))) {
      const wrapper = wrapperById(id);
      if (!wrapper) continue;
      reached(sp, wrapper);
      // A wrapper's call to another is its own request (M5C.7f), not a call fact.
      const outside = list.filter((caller) => !innerCalls.has(caller.call));
      if (outside.length === 0) continue;
      calls.push({
        wrapper: id,
        requests: outside.flatMap((caller) => inline(id, wrapper, caller)),
      });
    }
    return {
      service: sp.service.key,
      requests: [
        ...(direct.get(sp) ?? []).flatMap(own),
        // A fetcher written in place makes its requests at the hooks that call it, else its own.
        ...(inlineIn.get(sp) ?? []).flatMap((fetcher) => {
          const inlined = (hooks.get(fetcher.fn) ?? []).flatMap((hook) =>
            inline(undefined, fetcher, hook),
          );
          return inlined.length > 0 ? inlined : fetcher.sites.flatMap(own);
        }),
      ],
      wrappers: [...(owned.get(sp) ?? [])]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([id, wrapper]): WrapperFact => {
          const inner = [...new Set(wrapper.inner.map((c) => c.id))].sort(compareStrings);
          return {
            id,
            name: symbolName(id),
            ...(inner.length > 0 ? { inner } : {}),
            requests: [
              ...wrapper.sites.flatMap(own),
              // Uncalled, its calls to other wrappers make their requests where they are.
              ...wrapper.inner.flatMap(({ id: innerId, caller }) => {
                const innerWrapper = wrapperById(innerId);
                return innerWrapper ? inline(innerId, innerWrapper, caller) : [];
              }),
            ],
          };
        }),
      calls,
    };
  };
  return programs
    .filter((sp) => !only || only.has(sp))
    .map((sp) => resolver.asking(sp, () => factsOf(sp)));
}

/**
 * The global step over every service's {@link HttpFacts} (see the file comment): each
 * service's own requests, then for each wrapper (by ID) every service's calls to it, or its
 * own requests when nothing calls it. So every collected site yields at least one request.
 * Owners are bound to the routes of `inlineHandlers` (Express's, see `owners.ts`). Sorted by
 * request location, then by the location of the call that makes it.
 */
export function bindWrappers(
  facts: readonly HttpFacts[],
  inlineHandlers: ReadonlyMap<string, readonly string[]> = new Map(),
): HttpRequest[] {
  const requests = facts.flatMap((f) => f.requests);
  const called = new Map<string, HttpRequestFact[]>();
  for (const f of facts) {
    for (const { wrapper, requests: inlined } of f.calls) {
      called.set(wrapper, [...(called.get(wrapper) ?? []), ...inlined]);
    }
  }
  const wrappers = facts.flatMap((f) => f.wrappers).sort((a, b) => compareStrings(a.id, b.id));
  // A wrapper another wrapper calls (M5C.7f) is represented by that one's requests.
  const inner = new Set(wrappers.flatMap((w) => w.inner ?? []));
  for (const wrapper of wrappers) {
    const calls = called.get(wrapper.id) ?? [];
    requests.push(...(calls.length > 0 ? calls : inner.has(wrapper.id) ? [] : wrapper.requests));
  }
  return requests
    .map((request) => ({ ...request, owners: bindOwners(request.owners, inlineHandlers) }))
    .sort((a, b) => compareLocations(a.site, b.site) || compareLocations(a.call.site, b.call.site));
}

/**
 * Inline wrapper functions (and wrappers over them): {@link collectHttpFacts}, then
 * {@link bindWrappers}. Every site yields at least one request: its own, or one per visible
 * call to its wrapper.
 */
export function inlineWrappers(
  sites: readonly HttpCallSite[],
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
  normalizer: UrlNormalizer,
  inlineHandlers: ReadonlyMap<string, readonly string[]> = new Map(),
): HttpRequest[] {
  return bindWrappers(collectHttpFacts(sites, programs, resolver, normalizer), inlineHandlers);
}
