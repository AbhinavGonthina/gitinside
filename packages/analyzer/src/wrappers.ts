/**
 * One-level wrapper inlining (M2.3, DESIGN.md §7.1): turns collected HTTP call sites into
 * {@link HttpRequest}s. A call site whose URL, axios `baseURL`, or method reads a parameter of
 * the function it sits in is a wrapper body (`function get(path) { return fetch(BASE + path) }`);
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
 *   functions, and CommonJS `exports.x = function` / `module.exports = { x() {} }`.
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
 *
 * Patterns not handled:
 * - Functions nested inside other functions, object literals that aren't exported symbols,
 *   and wrappers only ever passed around as values (no visible call): their sites stay
 *   as they are, so a parameter at the start of the URL is `DYNAMIC_URL`.
 * - A wrapper with visible callers that is also called invisibly (as a callback): only the
 *   visible calls become requests.
 * - Calls spelled with neither a wrapper's name nor an import alias (`const g = get; g()`),
 *   unless some wrapper in the repo has that name: they aren't resolved.
 * - Destructured parameters (`({ path }) => fetch(path)`), `arguments`, and parameters
 *   reassigned in the body (the caller's value is assumed to reach the call).
 * - A URL held entirely in a config parameter (`api.request(config)` with `config.url`), and
 *   axios instances passed as parameters: those sites are not collected or have no URL.
 * - Inlining more than one level: the outer callers of a wrapper's caller are not followed.
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
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";
import type { NormalizedUrl, UrlNormalizer } from "./url.js";
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
  /** Position of the callee name of the wrapper call when inlined, else of the call. */
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

/** A wrapper function whose body is in a service, as a fact. */
export interface WrapperFact {
  /** The symbol node ID of the wrapper. */
  id: string;
  /** The name a call to it is spelled with (the last part of its qualified name). */
  name: string;
  /** The requests its sites make when no service calls it, in site order. */
  requests: HttpRequest[];
}

/** A service's calls to one wrapper (in any service), inlined. */
export interface WrapperCallFact {
  /** The symbol node ID of the wrapper called. */
  wrapper: string;
  /** One request per call and wrapper site, in call order, then site order. */
  requests: HttpRequest[];
}

/**
 * What the HTTP stage found in one service before the global binding step. Plain data
 * (ADR-0092): every TypeScript question is answered by the time it exists.
 */
export interface HttpFacts {
  /** The service's key. */
  service: string;
  /** Requests of the service's sites that aren't wrapper bodies, in site order. */
  requests: HttpRequest[];
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
}

/** A resolved call to a wrapper. */
interface Caller {
  sp: ServiceProgram;
  file: string;
  call: ts.CallExpression;
  site: SourceLocation;
  owners: string[];
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
 * order (see the file comment). `sites` are {@link collectHttpCalls}'s, and `inlineHandlers`
 * comes from the Express detector, as for that function. A service's facts depend only on
 * its own analysis and the programs it reached (the wrappers it calls are recorded with
 * `programOf`), except for the candidate filter: a call is resolved only when it is spelled
 * like some wrapper in the repo or through an import alias (ADR-0092).
 */
export function collectHttpFacts(
  sites: readonly HttpCallSite[],
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
  normalizer: UrlNormalizer,
  inlineHandlers: ReadonlyMap<ts.Node, readonly string[]> = new Map(),
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

  /** The symbol node ID of the wrapper function a site sits directly in, if any. */
  const wrapperOf = (site: HttpCallSite): { id: string; fn: FunctionWithBody } | undefined => {
    const fn = enclosingFunction(site.call);
    const byNode = resolver.callers.get(site.call.getSourceFile());
    if (!fn || !byNode) return undefined;
    for (let n: ts.Node | undefined = fn; n; n = n.parent) {
      const id = byNode.get(n);
      if (id !== undefined) return valueFunction(n) === fn ? { id, fn } : undefined;
    }
    return undefined;
  };

  /** A site's own request, as when nothing inlines it. */
  const own = (site: HttpCallSite): HttpRequest => {
    const url = normalizer.normalize(site);
    return {
      call: { client: site.client, file: site.file, site: site.site },
      file: site.file,
      site: site.site,
      owners: site.owners,
      method: site.method,
      url,
      confidence: url.resolved ? weaker(site.confidence, url.confidence) : site.confidence,
      ...ownText(site, url),
    };
  };

  // ---- per service: find wrappers ----

  const bySp = new Map<ServiceProgram, HttpCallSite[]>(programs.map((sp) => [sp, []]));
  for (const site of sites) bySp.get(site.sp)?.push(site);

  const direct = new Map<ServiceProgram, HttpCallSite[]>();
  const owned = new Map<ServiceProgram, Map<string, Wrapper>>();
  /** Every wrapper in the repo by symbol node ID: the index callers are matched against. */
  const wrappers = new Map<string, Wrapper>();
  for (const sp of programs) {
    const plain: HttpCallSite[] = [];
    const mine = new Map<string, Wrapper>();
    for (const site of bySp.get(sp) ?? []) {
      const found = wrapperOf(site);
      const fn = found?.fn;
      const read = fn ? normalizer.parameters(site) : new Set<ts.ParameterDeclaration>();
      const reads =
        fn !== undefined &&
        ([...read].some((d) => d.parent === fn) ||
          (site.methodSource !== undefined &&
            sourceExpressions(site.methodSource).some(
              (value) => parameterOf(value.sp, value.expression, fn) !== undefined,
            )));
      if (!found || !reads) {
        plain.push(site);
        continue;
      }
      const wrapper = mine.get(found.id) ?? { sp: site.sp, fn: found.fn, sites: [] };
      wrapper.sites.push(site);
      mine.set(found.id, wrapper);
      wrappers.set(found.id, wrapper);
    }
    direct.set(sp, plain);
    owned.set(sp, mine);
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
      const visit = (node: ts.Node, owners: readonly string[]): void => {
        const symbol = byNode.get(node);
        const current = inlineHandlers.get(node) ?? (symbol !== undefined ? [symbol] : owners);
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
              site: locationOf(name, file),
              owners: [...current].sort(compareStrings),
              confidence: target.confidence,
            });
            callers.set(target.id, list);
          }
        }
        ts.forEachChild(node, (child) => {
          visit(child, current);
        });
      };
      visit(sourceFile, []);
    }
    return callers;
  };

  /** The `method` property of an object literal or const object (`null`: not readable). */
  const methodProperty = (value: ProgramExpression): ConfigValue => {
    const e = unwrap(value.expression);
    const object = ts.isObjectLiteralExpression(e)
      ? { sp: value.sp, expression: e }
      : reader.constObject(value.sp, e, 0);
    return object ? objectProperty(object.sp, object.expression, "method") : null;
  };

  /** The requests one call to a wrapper makes: one per site in the wrapper's body. */
  const inline = (id: string, wrapper: Wrapper, caller: Caller): HttpRequest[] => {
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

    return wrapper.sites.map((site): HttpRequest => {
      const url = normalizer.normalize(site, bindings);
      const confidence = weaker(site.confidence, caller.confidence);
      const read = normalizer.parameters(site);
      const urlArgs = wrapper.fn.parameters.flatMap((d, i) => {
        const arg = args[i];
        return read.has(d) && arg ? [arg] : [];
      });
      const method = boundMethod(site);
      const expression = redactedText(caller.call, urlArgs);
      return {
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
      };
    });
  };

  return programs.map((sp): HttpFacts => {
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
      requests: (direct.get(sp) ?? []).map(own),
      wrappers: [...(owned.get(sp) ?? [])]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([id, wrapper]) => ({ id, name: symbolName(id), requests: wrapper.sites.map(own) })),
      calls,
    };
  });
}

/**
 * The global step over every service's {@link HttpFacts} (see the file comment): each
 * service's own requests, then for each wrapper (by ID) every service's calls to it, or its
 * own requests when nothing calls it. So every collected site yields at least one request.
 * Sorted by request location, then by the location of the call that makes it.
 */
export function bindWrappers(facts: readonly HttpFacts[]): HttpRequest[] {
  const requests = facts.flatMap((f) => f.requests);
  const called = new Map<string, HttpRequest[]>();
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
  return requests.sort(
    (a, b) => compareLocations(a.site, b.site) || compareLocations(a.call.site, b.call.site),
  );
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
  inlineHandlers: ReadonlyMap<ts.Node, readonly string[]> = new Map(),
): HttpRequest[] {
  return bindWrappers(collectHttpFacts(sites, programs, resolver, normalizer, inlineHandlers));
}
