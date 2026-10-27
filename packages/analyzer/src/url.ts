/**
 * URL expression normalizer (M2.2, DESIGN.md §7.2): turns the URL and `baseURL` expressions
 * of an {@link HttpCallSite} into a {@link UrlPattern} (a base plus path segments made of
 * literal text and holes) for the route matcher (M2.4), or into `DYNAMIC_URL` with a
 * readable detail. Nothing is evaluated by running code: values are read from the syntax and
 * the checker, and anything else becomes a hole.
 *
 * Works in two layers, so the second can be tested without TypeScript:
 * 1. `parts()` evaluates an expression to a flat list of {@link UrlPart}s.
 * 2. {@link toUrlPattern} reads that list as a URL: base, segments, query stripped.
 *
 * Expressions handled:
 * - String literals, no-substitution templates, and numeric literals.
 * - Template literals and `+` concatenation, part by part.
 * - Identifiers holding a `const` (same module, imported, or from a workspace package via
 *   the shared resolver, at that import's confidence), properties of const object literals
 *   (`API.users`, `API["users"]`), string enum members, and otherwise any identifier or
 *   property whose type is a single string or number literal (`declare const X: "/api"`).
 * - Env vars: `process.env.X`, `process.env["X"]`, `import.meta.env.X`, and
 *   `const { X } = process.env`. `env ?? fallback` and `env || fallback` read as the env var.
 * - `window.location.origin` (also `location`, `self.location`, `globalThis.location`,
 *   `document.location`): the page's own origin, so the URL is root-relative.
 * - `new URL(url, base?)`, `.href`, `.toString()`, and `String(x)`. A relative `url` is
 *   resolved with WHATWG rules when both sides are literal; a root-relative `url` (`/x`)
 *   keeps only the base's origin, which may be an env var or `location.origin`.
 * - A ternary whose two branches normalize to the same parts.
 * - axios `baseURL` + URL combined the way axios does: an absolute URL ignores the base;
 *   otherwise one `/` joins them.
 *
 * URL rules (DESIGN.md §7.2):
 * - A literal origin (`https://api.example.com`) becomes a `host` base; scheme and host are
 *   lowercased. A hole in the host before any `:` is `DYNAMIC_URL`; one in the port is kept
 *   as `{}` in the host text.
 * - An env var is a base only at the very start of the URL; elsewhere it is a hole.
 * - Query strings and fragments are dropped at the first literal `?` or `#`.
 * - Empty segments (trailing and doubled slashes) are dropped.
 * - A URL that starts with a hole, or whose path (on a non-`host` base) is only holes, is
 *   `DYNAMIC_URL`: there is nothing to match it on.
 *
 * Not handled (each becomes a hole, so usually `DYNAMIC_URL`):
 * - `let`/`var` variables, parameters, function results (wrappers are M2.3), array
 *   `.join()`, `.concat()`, `path.join`, `URLSearchParams` built into the path.
 * - Mutating a `URL` after creation (`u.pathname = …`) and relative `new URL()` URLs whose
 *   base isn't literal (the base's path is unknown).
 * - An env var inside the host (`https://${process.env.HOST}/x`).
 * - A hole that holds a `?` (`/search${qs}`) or several segments; the matcher treats a hole
 *   as part of one segment.
 */
import ts from "typescript";
import type { Confidence } from "@gitinside/schema";
import type { SymbolResolver } from "./calls.js";
import type { HttpCallSite } from "./http.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";
import {
  createValueReader,
  isConst,
  MAX_HOPS,
  objectProperty,
  weaker,
  type ProgramExpression,
} from "./values.js";

/** More parts than this (from repeated concatenation) collapse to one hole. */
const MAX_PARTS = 256;

/** One piece of a URL value. */
export type UrlPart =
  | { kind: "text"; text: string }
  /** A value only known at runtime. */
  | { kind: "hole" }
  /** An environment variable, by name. */
  | { kind: "env"; name: string }
  /** The page's own origin (`window.location.origin`). */
  | { kind: "origin" };

/** A piece of a path segment. */
export type UrlSegmentPart = { kind: "text"; text: string } | { kind: "hole" };

/** One path segment: never empty, never containing `/`. */
export type UrlSegment = UrlSegmentPart[];

/** What the path is relative to. */
export type UrlBase =
  /** Root-relative (`/api/x`): the calling page's own origin. */
  | { kind: "path" }
  /** Relative to the current page's folder (`api/x`). */
  | { kind: "page" }
  /** A literal origin. `scheme` is `null` for protocol-relative URLs (`//cdn.x.com`). */
  | { kind: "host"; scheme: string | null; host: string }
  /** An origin read from an environment variable. */
  | { kind: "env"; name: string };

/** A normalized URL: a base and its path segments. */
export interface UrlPattern {
  base: UrlBase;
  segments: UrlSegment[];
}

/** Why a URL is `DYNAMIC_URL`, in words shown to the user. */
export const DYNAMIC_URL_DETAIL = {
  url: "the URL can't be read statically",
  leadingHole: "the URL starts with a value only known at runtime",
  baseURL: "the axios baseURL can't be read statically",
  baseLeadingHole: "the axios baseURL starts with a value only known at runtime",
  host: "the host is only known at runtime",
  onlyHoles: "every path segment is only known at runtime",
} as const;

export type DynamicUrlDetail = (typeof DYNAMIC_URL_DETAIL)[keyof typeof DYNAMIC_URL_DETAIL];

/** The outcome of normalizing one call site's URL. */
export type NormalizedUrl =
  | {
      resolved: true;
      pattern: UrlPattern;
      /** {@link formatUrlPattern} of the pattern. */
      text: string;
      /** `exact`, or the weaker confidence of a workspace import a value came through. */
      confidence: Confidence;
    }
  | { resolved: false; reason: "DYNAMIC_URL"; detail: DynamicUrlDetail };

const HOLE: UrlPart = { kind: "hole" };
const text = (value: string): UrlPart => ({ kind: "text", text: value });

/** `scheme://` or `//` at the start of a URL (axios's `isAbsoluteURL`). */
const ABSOLUTE = /^([a-z][a-z\d+\-.]*:)?\/\//i;

/** A literal origin at the start of a URL. */
const ORIGIN = /^[a-z][a-z\d+\-.]*:\/\/[^/?#]*/i;

/** Join adjacent text parts and drop empty ones. Returns a single hole past {@link MAX_PARTS}. */
export function mergeParts(parts: readonly UrlPart[]): UrlPart[] {
  const out: UrlPart[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text === "") continue;
      const last = out[out.length - 1];
      if (last?.kind === "text") {
        out[out.length - 1] = text(last.text + part.text);
        continue;
      }
    }
    out.push(part);
  }
  return out.length > MAX_PARTS ? [HOLE] : out;
}

/** True when merged parts start with `scheme://` or `//`. */
function isAbsolute(parts: readonly UrlPart[]): boolean {
  const first = parts[0];
  return first?.kind === "text" && ABSOLUTE.test(first.text);
}

/** Everything before the first literal `?` or `#`. */
function stripQuery(parts: readonly UrlPart[]): UrlPart[] {
  const out: UrlPart[] = [];
  for (const part of parts) {
    if (part.kind !== "text") {
      out.push(part);
      continue;
    }
    const cut = part.text.search(/[?#]/);
    if (cut === -1) {
      out.push(part);
      continue;
    }
    out.push(text(part.text.slice(0, cut)));
    break;
  }
  return mergeParts(out);
}

/** Split parts (with no base left in them) into non-empty path segments. */
function toSegments(parts: readonly UrlPart[]): UrlSegment[] {
  const segments: UrlSegment[] = [];
  let current: UrlSegment = [];
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (const part of parts) {
    if (part.kind !== "text") {
      current.push({ kind: "hole" });
      continue;
    }
    part.text.split("/").forEach((piece, i) => {
      if (i > 0) flush();
      if (piece !== "") current.push({ kind: "text", text: piece });
    });
  }
  flush();
  return segments;
}

/**
 * Read a list of parts as a URL (see the file comment for the rules). Returns the pattern,
 * or the reason it is `DYNAMIC_URL`. Idempotent: `toUrlPattern(patternParts(p))` is `p`.
 */
export function toUrlPattern(
  input: readonly UrlPart[],
): { pattern: UrlPattern } | { detail: DynamicUrlDetail } {
  // An env var or the page origin only counts as a base at the very start.
  const parts = stripQuery(
    mergeParts(input).map((p, i) =>
      i > 0 && (p.kind === "env" || p.kind === "origin") ? HOLE : p,
    ),
  );
  const first = parts[0];
  if (!first) return { pattern: { base: { kind: "page" }, segments: [] } };
  if (first.kind === "hole") return { detail: DYNAMIC_URL_DETAIL.leadingHole };

  let base: UrlBase;
  let rest: UrlPart[];
  if (first.kind === "env") {
    base = { kind: "env", name: first.name };
    rest = parts.slice(1);
  } else if (first.kind === "origin") {
    base = { kind: "path" };
    rest = parts.slice(1);
  } else {
    const absolute = ABSOLUTE.exec(first.text);
    if (absolute) {
      const scheme = absolute[1] ? absolute[1].slice(0, -1).toLowerCase() : null;
      const after = [text(first.text.slice(absolute[0].length)), ...parts.slice(1)];
      let host = "";
      rest = [];
      for (let i = 0; i < after.length; i++) {
        const part = after[i];
        if (!part) continue;
        if (part.kind !== "text") {
          // Only a port may be dynamic; anything earlier makes the host unknown.
          if (!host.includes(":")) return { detail: DYNAMIC_URL_DETAIL.host };
          host += "{}";
          continue;
        }
        const slash = part.text.indexOf("/");
        if (slash === -1) {
          host += part.text;
          continue;
        }
        host += part.text.slice(0, slash);
        rest = [text(part.text.slice(slash)), ...after.slice(i + 1)];
        break;
      }
      base = { kind: "host", scheme, host: host.toLowerCase() };
    } else {
      base = first.text.startsWith("/") ? { kind: "path" } : { kind: "page" };
      rest = parts;
    }
  }

  const segments = toSegments(rest);
  if (
    base.kind !== "host" &&
    segments.length > 0 &&
    segments.every((segment) => segment.every((p) => p.kind === "hole"))
  ) {
    return { detail: DYNAMIC_URL_DETAIL.onlyHoles };
  }
  return { pattern: { base, segments } };
}

/** The parts a pattern reads back from (the inverse of {@link toUrlPattern}). */
export function patternParts(pattern: UrlPattern): UrlPart[] {
  const out: UrlPart[] = [];
  const { base } = pattern;
  if (base.kind === "env") out.push({ kind: "env", name: base.name });
  if (base.kind === "host")
    out.push(text(`${base.scheme === null ? "" : base.scheme + ":"}//${base.host}`));
  pattern.segments.forEach((segment, i) => {
    if (i > 0 || base.kind !== "page") out.push(text("/"));
    for (const p of segment) out.push(p.kind === "text" ? text(p.text) : HOLE);
  });
  if (base.kind === "path" && pattern.segments.length === 0) out.push(text("/"));
  return mergeParts(out);
}

/**
 * A pattern as text: `/api/users/{}`, `{env:API_URL}/orders`, `https://api.example.com/v1`,
 * or `./users` for page-relative URLs. Holes are `{}`.
 */
export function formatUrlPattern(pattern: UrlPattern): string {
  const path = pattern.segments
    .map((segment) => segment.map((p) => (p.kind === "text" ? p.text : "{}")).join(""))
    .join("/");
  const { base } = pattern;
  switch (base.kind) {
    case "path":
      return `/${path}`;
    case "page":
      return `./${path}`;
    case "host":
      return `${base.scheme === null ? "" : base.scheme + ":"}//${base.host}${path ? "/" + path : ""}`;
    case "env":
      return `{env:${base.name}}${path ? "/" + path : ""}`;
  }
}

/**
 * Combine an axios `baseURL` with a request URL the way axios does: an absolute URL or an
 * empty base leaves the URL alone, an empty URL is the base, and otherwise one `/` joins
 * them (`base.replace(/\/?\/$/, "") + "/" + url.replace(/^\/+/, "")`).
 */
export function joinBaseURL(base: readonly UrlPart[], url: readonly UrlPart[]): UrlPart[] {
  const u = mergeParts(url);
  const b = mergeParts(base);
  if (isAbsolute(u) || b.length === 0) return u;
  if (u.length === 0) return b;
  const last = b[b.length - 1];
  const head = u[0];
  const left =
    last?.kind === "text" ? [...b.slice(0, -1), text(last.text.replace(/\/?\/$/, ""))] : b;
  const right = head?.kind === "text" ? [text(head.text.replace(/^\/+/, "")), ...u.slice(1)] : u;
  return mergeParts([...left, text("/"), ...right]);
}

/**
 * `new URL(url, base)`: an absolute URL stands alone; two literals resolve with WHATWG
 * rules; a root-relative URL keeps the base's origin (literal, env var, or page origin).
 * Anything else is a hole, because the base's path is unknown.
 */
export function resolveURL(url: readonly UrlPart[], base: readonly UrlPart[]): UrlPart[] {
  const u = mergeParts(url);
  const head = u[0];
  if (head?.kind === "text" && /^[a-z][a-z\d+\-.]*:/i.test(head.text)) return u;
  const b = stripQuery(base);
  const origin = b[0];
  if (head?.kind === "text" && u.length === 1 && origin?.kind === "text" && b.length === 1) {
    try {
      return [text(new URL(head.text, origin.text).href)];
    } catch {
      return [HOLE];
    }
  }
  if (head?.kind !== "text" || !head.text.startsWith("/") || head.text.startsWith("//")) {
    return [HOLE];
  }
  if (origin?.kind === "env" || origin?.kind === "origin") return [origin, ...u];
  if (origin?.kind === "text") {
    const match = ORIGIN.exec(origin.text);
    // The host must end inside this literal, not run on into a hole.
    if (match && (match[0].length < origin.text.length || b.length === 1)) {
      return mergeParts([text(match[0]), ...u]);
    }
  }
  return [HOLE];
}

/** Normalizes call-site URLs, reading values with one resolver's checkers. */
export interface UrlNormalizer {
  /** The parts an expression evaluates to; anything not statically known is a hole. */
  parts(value: ProgramExpression): UrlPart[];
  /** A call site's URL, combined with its axios `baseURL`, as a pattern or `DYNAMIC_URL`. */
  normalize(site: Pick<HttpCallSite, "url" | "baseURL">): NormalizedUrl;
}

/** Create a {@link UrlNormalizer} (see the file comment for what it reads). */
export function createUrlNormalizer(resolver: SymbolResolver): UrlNormalizer {
  const reader = createValueReader(resolver);
  /** The weakest import confidence crossed during the current `normalize` call. */
  let confidence: Confidence = "exact";
  const note = (c: Confidence): void => {
    confidence = weaker(confidence, c);
  };

  /** True when an identifier names a global, not something the repo declares. */
  const isGlobal = (sp: ServiceProgram, identifier: ts.Identifier, name: string): boolean => {
    if (identifier.text !== name) return false;
    const declarations = reader.symbolAt(sp, identifier)?.declarations ?? [];
    return declarations.every((d) => d.getSourceFile().isDeclarationFile);
  };

  /** True for `process.env` and `import.meta.env`. */
  const isEnvObject = (sp: ServiceProgram, expression: ts.Expression): boolean => {
    const e = unwrap(expression);
    if (!ts.isPropertyAccessExpression(e) || e.name.text !== "env") return false;
    const object = unwrap(e.expression);
    if (ts.isIdentifier(object)) return isGlobal(sp, object, "process");
    return ts.isMetaProperty(object) && object.keywordToken === ts.SyntaxKind.ImportKeyword;
  };

  /** The env var a `process.env.X` or `process.env["X"]` read names. */
  const envName = (sp: ServiceProgram, e: ts.Expression): string | undefined => {
    if (ts.isPropertyAccessExpression(e) && isEnvObject(sp, e.expression)) return e.name.text;
    if (
      ts.isElementAccessExpression(e) &&
      ts.isStringLiteralLike(e.argumentExpression) &&
      isEnvObject(sp, e.expression)
    ) {
      return e.argumentExpression.text;
    }
    return undefined;
  };

  /** True for `location.origin` on the global `location` (or `window.location`, …). */
  const isLocationOrigin = (sp: ServiceProgram, e: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(e) || e.name.text !== "origin") return false;
    const location = unwrap(e.expression);
    if (ts.isIdentifier(location)) return isGlobal(sp, location, "location");
    if (!ts.isPropertyAccessExpression(location) || location.name.text !== "location") {
      return false;
    }
    const owner = unwrap(location.expression);
    return (
      ts.isIdentifier(owner) &&
      ["document", "globalThis", "self", "window"].some((name) => isGlobal(sp, owner, name))
    );
  };

  /** A single string or number literal type, as text. */
  const literalType = (sp: ServiceProgram, e: ts.Expression): UrlPart[] | undefined => {
    const type = resolver.checkerOf(sp).getTypeAtLocation(e);
    if (type.isStringLiteral()) return [text(type.value)];
    if (type.isNumberLiteral()) return [text(String(type.value))];
    return undefined;
  };

  /** The env var a destructuring `const { X } = process.env` binds. */
  const destructuredEnv = (sp: ServiceProgram, d: ts.Declaration): string | undefined => {
    if (!ts.isBindingElement(d) || !ts.isObjectBindingPattern(d.parent)) return undefined;
    const declaration = d.parent.parent;
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
    if (!isEnvObject(sp, declaration.initializer)) return undefined;
    const key = d.propertyName ?? d.name;
    return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
  };

  const identifierParts = (sp: ServiceProgram, e: ts.Identifier, hops: number): UrlPart[] => {
    const symbol = reader.symbolAt(sp, e);
    const found = symbol && reader.resolveDeclaration(sp, symbol, hops + 1);
    if (found) {
      const d = found.declaration;
      if (ts.isVariableDeclaration(d) && d.initializer && isConst(d)) {
        note(found.confidence);
        return partsOf(found.sp, d.initializer, hops + 1);
      }
      const env = destructuredEnv(found.sp, d);
      if (env !== undefined) {
        note(found.confidence);
        return [{ kind: "env", name: env }];
      }
    }
    return literalType(sp, e) ?? [HOLE];
  };

  /** A property of a const object literal, if `object` names one. */
  const constProperty = (
    sp: ServiceProgram,
    object: ts.Expression,
    name: string,
    hops: number,
  ): UrlPart[] | undefined => {
    const found = reader.constObject(sp, object, hops + 1);
    if (!found) return undefined;
    const value = objectProperty(found.sp, found.expression, name);
    if (!value) return [HOLE];
    note(found.confidence);
    return partsOf(value.sp, value.expression, hops + 1);
  };

  const partsOf = (sp: ServiceProgram, expression: ts.Expression, hops: number): UrlPart[] => {
    if (hops > MAX_HOPS) return [HOLE];
    const e = unwrap(expression);
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return [text(e.text)];
    if (ts.isTemplateExpression(e)) {
      const out: UrlPart[] = [text(e.head.text)];
      for (const span of e.templateSpans) {
        out.push(...partsOf(sp, span.expression, hops + 1), text(span.literal.text));
      }
      return mergeParts(out);
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        return mergeParts([...partsOf(sp, e.left, hops + 1), ...partsOf(sp, e.right, hops + 1)]);
      }
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        // `process.env.API_URL ?? "http://localhost:3000"`: the env var is the deployed value.
        const left = partsOf(sp, e.left, hops + 1);
        return left.length === 1 && left[0]?.kind === "env" ? left : [HOLE];
      }
      return [HOLE];
    }
    if (ts.isConditionalExpression(e)) {
      const a = partsOf(sp, e.whenTrue, hops + 1);
      const b = partsOf(sp, e.whenFalse, hops + 1);
      return JSON.stringify(a) === JSON.stringify(b) ? a : [HOLE];
    }
    if (ts.isNewExpression(e)) {
      const callee = unwrap(e.expression);
      const args = e.arguments ?? [];
      if (!ts.isIdentifier(callee) || !isURLConstructor(sp, callee)) return [HOLE];
      if (args.some((a) => ts.isSpreadElement(a))) return [HOLE];
      const [url, base] = args;
      if (!url) return [HOLE];
      const urlParts = partsOf(sp, url, hops + 1);
      return base ? resolveURL(urlParts, partsOf(sp, base, hops + 1)) : urlParts;
    }
    if (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression);
      if (e.arguments.length === 0 && ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "toString") return partsOf(sp, callee.expression, hops + 1);
      }
      const [only] = e.arguments;
      if (
        e.arguments.length === 1 &&
        only &&
        !ts.isSpreadElement(only) &&
        ts.isIdentifier(callee) &&
        isGlobal(sp, callee, "String")
      ) {
        return partsOf(sp, only, hops + 1);
      }
      return [HOLE];
    }
    const env = envName(sp, e);
    if (env !== undefined) return [{ kind: "env", name: env }];
    if (isLocationOrigin(sp, e)) return [{ kind: "origin" }];
    if (ts.isIdentifier(e)) return identifierParts(sp, e, hops);
    if (ts.isPropertyAccessExpression(e)) {
      const fromEnum = reader.enumString(sp, e);
      if (fromEnum !== undefined) return [text(fromEnum)];
      const property = constProperty(sp, e.expression, e.name.text, hops);
      if (property) return property;
      const literal = literalType(sp, e);
      if (literal) return literal;
      // `url.href` where `url` is a `new URL(...)`.
      return e.name.text === "href" ? partsOf(sp, e.expression, hops + 1) : [HOLE];
    }
    if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
      return (
        constProperty(sp, e.expression, e.argumentExpression.text, hops) ??
        literalType(sp, e) ?? [HOLE]
      );
    }
    return [HOLE];
  };

  /** True when a callee is the global `URL` class or `URL` imported from `url`/`node:url`. */
  const isURLConstructor = (sp: ServiceProgram, callee: ts.Identifier): boolean => {
    const declarations = reader.symbolAt(sp, callee)?.declarations ?? [];
    if (declarations.every((d) => d.getSourceFile().isDeclarationFile)) {
      return callee.text === "URL";
    }
    return declarations.every((d) => {
      if (!ts.isImportSpecifier(d) || (d.propertyName ?? d.name).text !== "URL") return false;
      const specifier = d.parent.parent.parent.moduleSpecifier;
      return ts.isStringLiteralLike(specifier) && ["node:url", "url"].includes(specifier.text);
    });
  };

  const parts = (value: ProgramExpression): UrlPart[] =>
    mergeParts(partsOf(value.sp, value.expression, 0));

  const dynamic = (detail: DynamicUrlDetail): NormalizedUrl => ({
    resolved: false,
    reason: "DYNAMIC_URL",
    detail,
  });

  const normalize = (site: Pick<HttpCallSite, "url" | "baseURL">): NormalizedUrl => {
    confidence = "exact";
    if (site.url === null) return dynamic(DYNAMIC_URL_DETAIL.url);
    let url = parts(site.url);
    if (url[0]?.kind === "hole") return dynamic(DYNAMIC_URL_DETAIL.leadingHole);
    if (site.baseURL !== undefined && !isAbsolute(url)) {
      if (site.baseURL === null) return dynamic(DYNAMIC_URL_DETAIL.baseURL);
      const base = parts(site.baseURL);
      if (base[0]?.kind === "hole") return dynamic(DYNAMIC_URL_DETAIL.baseLeadingHole);
      url = joinBaseURL(base, url);
    }
    const result = toUrlPattern(url);
    if ("detail" in result) return dynamic(result.detail);
    return {
      resolved: true,
      pattern: result.pattern,
      text: formatUrlPattern(result.pattern),
      confidence,
    };
  };

  return { parts, normalize };
}
