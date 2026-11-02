/**
 * One-level wrapper inlining (M2.3, DESIGN.md §7.1): turns collected HTTP call sites into
 * {@link HttpRequest}s. A call site whose URL or axios `baseURL` reads a parameter of the
 * function it sits in in its leading part (the start, the host, glued to the path, or the
 * first segment: `leadingHoles` in `url.ts`, M5A.3j), whose axios config is a parameter, or
 * whose method reads one is a wrapper body (`function get(path) { return fetch(BASE + path) }`);
 * a parameter that only fills a later hole or the query (`fetch(\`/api/posts/${id}\`)`)
 * leaves the request at its own call, as EVALUATION.md §1 labels it;
 * each call to that function (`get("/users")`) becomes its own request, with the parameters
 * bound to the caller's arguments and the URL normalized again. A request whose URL still
 * starts with a parameter (the caller is a wrapper too) is `WRAPPER_DEPTH`.
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
 *   `method` wins; a missing argument spreads nothing).
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
 *   alternative, at the same site (`UrlNormalizer.alternatives`, M5A.3h).
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
 * - A config parameter read through properties (`axios({ url: config.path })`), a `baseURL`
 *   in a shorthand call's config parameter (`api.get(path, config)`: the instance's applies),
 *   and axios instances passed as parameters: those sites are not collected or have no URL.
 * - Inlining more than one level: the outer callers of a wrapper's caller are not followed.
 * - A function whose route is fixed but whose method is a parameter is still a wrapper (the
 *   method is only known at its callers); see `leadingHoles` for the URL shapes misread.
 */
import ts from "typescript";
import {
  compareStrings,
  type Confidence,
  type HttpMethod,
  type SourceLocation,
} from "@gitinside/schema";
import { calleeName, type SymbolResolver } from "./calls.js";
import { isFunctionWithBody, type FunctionWithBody } from "./express.js";
import {
  locationOf,
  toMethod,
  type HttpCallSite,
  type HttpClient,
  type MethodSource,
} from "./http.js";
import { bindOwners, NO_OWNERS, ownersAt, type Owners } from "./owners.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";
import { WRAPPER_DEPTH_DETAIL, type NormalizedUrl, type UrlNormalizer } from "./url.js";
import {
  clip,
  createValueReader,
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
  /** The requests its sites make when no service calls it, in site order. */
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

/** A wrapper function and the call sites in its body that read its parameters. */
interface Wrapper {
  sp: ServiceProgram;
  fn: FunctionWithBody;
  sites: HttpCallSite[];
  /** The parameters that reach each site's leading part (`leadingParameters`), any function's. */
  leading: Map<HttpCallSite, ReadonlySet<ts.ParameterDeclaration>>;
}

/** A resolved call to a wrapper. */
interface Caller {
  sp: ServiceProgram;
  file: string;
  call: ts.CallExpression;
  site: SourceLocation;
  owners: Owners;
  confidence: Confidence;
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
 * `only` limits the facts returned to those programs (in program order), for a run that reuses
 * the others' (ADR-0176); every program's sites still find the wrappers callers are matched to.
 */
export function collectHttpFacts(
  sites: readonly HttpCallSite[],
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
  normalizer: UrlNormalizer,
  only?: ReadonlySet<ServiceProgram>,
): HttpFacts[] {
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
  const wrapperOf = (site: HttpCallSite): { id: string; fn: FunctionWithBody } | undefined => {
    const byNode = resolver.callers.get(site.call.getSourceFile());
    if (!byNode) return undefined;
    let n: ts.Node | undefined = site.call.parent;
    while (n && !byNode.has(n)) n = n.parent;
    const id = n && byNode.get(n);
    const fn = n && valueFunction(n);
    if (id === undefined || !fn || !isFunctionWithBody(fn)) return undefined;
    for (let f = enclosingFunction(site.call); f; f = enclosingFunction(f)) {
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

  const bySp = new Map<ServiceProgram, HttpCallSite[]>(programs.map((sp) => [sp, []]));
  for (const site of sites) bySp.get(site.sp)?.push(site);

  const direct = new Map<ServiceProgram, HttpCallSite[]>();
  const owned = new Map<ServiceProgram, Map<string, Wrapper>>();
  /** Every wrapper in the repo by symbol node ID: the index callers are matched against. */
  const wrappers = new Map<string, Wrapper>();
  /** Split `sp`'s sites into wrapper bodies' and the rest. */
  const findWrappers = (sp: ServiceProgram): void => {
    const plain: HttpCallSite[] = [];
    const mine = new Map<string, Wrapper>();
    for (const site of bySp.get(sp) ?? []) {
      const found = wrapperOf(site);
      const fn = found?.fn;
      // A parameter that only fills a later hole or the query leaves the route fixed here.
      const read = fn ? normalizer.leadingParameters(site) : new Set<ts.ParameterDeclaration>();
      const reads =
        fn !== undefined &&
        ([...read].some((d) => d.parent === fn) ||
          (site.config !== undefined &&
            parameterOf(site.config.value.sp, site.config.value.expression, fn) !== undefined) ||
          (site.methodSource !== undefined &&
            sourceExpressions(site.methodSource).some(
              (value) => parameterOf(value.sp, value.expression, fn) !== undefined,
            )));
      if (!found || !reads) {
        plain.push(site);
        continue;
      }
      const wrapper: Wrapper = mine.get(found.id) ?? {
        sp: site.sp,
        fn: found.fn,
        sites: [],
        leading: new Map(),
      };
      wrapper.sites.push(site);
      wrapper.leading.set(site, read);
      mine.set(found.id, wrapper);
      wrappers.set(found.id, wrapper);
    }
    direct.set(sp, plain);
    owned.set(sp, mine);
  };
  for (const sp of programs) {
    resolver.asking(sp, () => {
      findWrappers(sp);
    });
  }
  const names = new Set([...wrappers.keys()].map(symbolName));

  // ---- per service: find and inline calls to wrappers ----

  /** The service's calls to wrappers, by wrapper ID, in file and visit order. */
  const callersIn = (sp: ServiceProgram): Map<string, Caller[]> => {
    const callers = new Map<string, Caller[]>();
    if (wrappers.size === 0) return callers;
    const checker = resolver.checkerOf(sp);
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      const byNode = sourceFile && resolver.callers.get(sourceFile);
      if (!sourceFile || !byNode) continue;
      const visit = (node: ts.Node, owners: Owners): void => {
        const current = ownersAt(file, node, byNode.get(node), owners);
        if (ts.isCallExpression(node)) {
          const name = calleeName(node.expression);
          // Only resolve calls spelled like a wrapper, or through a (possibly renamed) import.
          const candidate =
            name !== undefined &&
            ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)
              ? names.has(name.text)
              : false) ||
              (ts.isIdentifier(name) &&
                ((checker.getSymbolAtLocation(name)?.flags ?? 0) & ts.SymbolFlags.Alias) !== 0));
          const target = candidate ? resolver.resolve(sp, node.expression) : undefined;
          if (name && target && wrappers.has(target.id)) {
            const list = callers.get(target.id) ?? [];
            list.push({
              sp,
              file,
              call: node,
              site: locationOf(node, file),
              owners: current,
              confidence: target.confidence,
            });
            callers.set(target.id, list);
          }
        }
        ts.forEachChild(node, (child) => {
          visit(child, current);
        });
      };
      visit(sourceFile, NO_OWNERS);
    }
    return callers;
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

  /** The requests one call to a wrapper makes: one per site in the wrapper's body. */
  const inline = (id: string, wrapper: Wrapper, caller: Caller): HttpRequestFact[] => {
    const args = caller.call.arguments;
    const spread = args.findIndex((a) => ts.isSpreadElement(a));
    const bindings = new Map<ts.ParameterDeclaration, ProgramExpression | undefined>();
    /** Parameters with no argument and no default: `undefined` at runtime. */
    const missing = new Set<ts.ParameterDeclaration>();
    wrapper.fn.parameters.forEach((d, i) => {
      if (!ts.isIdentifier(d.name)) return;
      const arg = args[i];
      if (d.dotDotDotToken || (spread !== -1 && spread <= i)) {
        bindings.set(d, undefined);
      } else if (arg) {
        bindings.set(d, { sp: caller.sp, expression: arg });
      } else if (d.initializer) {
        bindings.set(d, { sp: wrapper.sp, expression: d.initializer });
      } else {
        bindings.set(d, undefined);
        missing.add(d);
      }
    });

    /** A value with this call's bindings: `missing` for an absent argument, `null` if unknown. */
    const bound = (value: ProgramExpression): ProgramExpression | "missing" | null => {
      const d = parameterOf(value.sp, value.expression, wrapper.fn);
      if (!d) return value;
      return missing.has(d) ? "missing" : (bindings.get(d) ?? null);
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
      // `{ method: "GET", ...init }`: the last spread that sets `method` wins.
      for (const spread of source.spreads) {
        const v = bound(spread);
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

    return wrapper.sites.flatMap((site): HttpRequestFact[] => {
      const fromConfig = site.config && configUrl(site.config);
      // A function inside the wrapper (one it returns: `createClient(base)` ⇒
      // `{ get: (path) => fetch(base + "/" + path) }`) whose own parameter leads the URL: this
      // call binds `base`, but `path` comes from a later call, so the route isn't known (M5A.5c).
      const inner = [...(wrapper.leading.get(site) ?? [])].some((d) => !bindings.has(d));
      const urls: NormalizedUrl[] = inner
        ? [{ resolved: false, reason: "WRAPPER_DEPTH", detail: WRAPPER_DEPTH_DETAIL.inner }]
        : fromConfig
          ? fromConfig.urls
          : normalizer.alternatives(site, bindings);
      const confidence = weaker(site.confidence, caller.confidence);
      const read = normalizer.parameters(site);
      const urlArgs = fromConfig
        ? fromConfig.shown
        : wrapper.fn.parameters.flatMap((d, i) => {
            const arg = args[i];
            return read.has(d) && arg ? [arg] : [];
          });
      const method = boundMethod(site);
      const expression = redactedText(caller.call, urlArgs);
      return urls.map((url) => ({
        call: { client: site.client, file: site.file, site: site.site },
        via: id,
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
  };

  /** `sp`'s facts, once every service's wrappers are known. */
  const factsOf = (sp: ServiceProgram): HttpFacts => {
    const calls: WrapperCallFact[] = [];
    for (const [id, list] of [...callersIn(sp)].sort(([a], [b]) => compareStrings(a, b))) {
      const wrapper = wrappers.get(id);
      if (!wrapper) continue;
      const first = wrapper.sites[0];
      // The facts now depend on the wrapper's program (inputs.ts follows `reached`).
      if (first) resolver.programOf(first.file, sp);
      calls.push({ wrapper: id, requests: list.flatMap((caller) => inline(id, wrapper, caller)) });
    }
    return {
      service: sp.service.key,
      requests: (direct.get(sp) ?? []).flatMap(own),
      wrappers: [...(owned.get(sp) ?? [])]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([id, wrapper]) => ({
          id,
          name: symbolName(id),
          requests: wrapper.sites.flatMap(own),
        })),
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
  for (const wrapper of wrappers) {
    const calls = called.get(wrapper.id) ?? [];
    requests.push(...(calls.length > 0 ? calls : wrapper.requests));
  }
  return requests
    .map((request) => ({ ...request, owners: bindOwners(request.owners, inlineHandlers) }))
    .sort((a, b) => compareLocations(a.site, b.site) || compareLocations(a.call.site, b.call.site));
}

/**
 * Inline one level of wrapper functions: {@link collectHttpFacts}, then
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
