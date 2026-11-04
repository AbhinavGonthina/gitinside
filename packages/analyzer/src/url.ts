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
 *   `const { X } = process.env`. `env ?? fallback` and `env || fallback` read as the env var
 *   carrying the fallback's parts (ADR-0158): at the start of a URL, a literal fallback URL or
 *   root-relative path adds its path after the env base (`?? "http://localhost:4000/api/v1"`
 *   ⇒ `{env:X}/api/v1/…`) and records its host; later on, a fallback of text and holes takes
 *   the env var's place (`/api/${process.env.V || "v1"}` ⇒ `/api/v1`).
 * - `window.location.origin` (also `location`, `self.location`, `globalThis.location`,
 *   `document.location`): the page's own origin, so the URL is root-relative.
 * - `new URL(url, base?)`, `.href`, `.toString()`, and `String(x)`. A relative `url` is
 *   resolved with WHATWG rules when both sides are literal; a root-relative `url` (`/x`)
 *   keeps only the base's origin, which may be an env var or `location.origin`.
 * - A ternary, and a local `let` read where several values may reach it (`lets.ts`): one
 *   value when every option normalizes to the same parts, else a hole; `alternatives()`
 *   instead gives one URL per option (M5A.3h, ADR-0166), so `cond ? "/a" : "/b"` is two
 *   requests, and `/x${page ? "?page=" + page : ""}` is one.
 * - axios `baseURL` + URL combined the way axios does: an absolute URL ignores the base;
 *   otherwise one `/` joins them. An ofetch `baseURL` (`baseJoin: "withBase"`, M5C.3c) joins
 *   the same way, except that a URL already starting with the base is left alone (ufo's
 *   `withBase`), decided only when the base is one literal and the URL starts with text.
 *   ky's bases (M5C.3e): ky 2's `prefix` and ky 1's `prefixUrl` join as axios's, except that
 *   under `prefixUrl` a URL starting with `/` is `DYNAMIC_URL` (ky throws on it); ky 2's
 *   `baseUrl` resolves the URL against it (`resolveKyBaseUrl`).
 *
 * URL rules (DESIGN.md §7.2):
 * - A literal origin (`https://api.example.com`) becomes a `host` base; scheme and host are
 *   lowercased, and credentials (`user:pass@`) are dropped. A hole in the host before any `:`
 *   is `DYNAMIC_URL`; one in the port is kept as `{}` in the host text, and one in a password
 *   is dropped with it.
 * - An env var is a base only at the very start of the URL; elsewhere it is a hole, unless
 *   its fallback is text and holes.
 * - Query strings and fragments are dropped at the first literal `?` or `#`.
 * - Empty segments (trailing and doubled slashes) are dropped.
 * - A URL that starts with a hole, or whose path (on a non-`host` base) is only holes, is
 *   `DYNAMIC_URL`: there is nothing to match it on.
 *
 * Parameters (M2.3): an identifier parameter is a hole marked `param`. While inlining a
 * wrapper call (`normalize(site, bindings)`), a bound parameter reads the caller's argument
 * in the caller's scope, and a URL or `baseURL` that still starts with an unbound parameter
 * is `WRAPPER_DEPTH` rather than `DYNAMIC_URL`. Only a parameter in the URL's leading part
 * makes a function a wrapper ({@link leadingHoles}, M5A.3j). See `wrappers.ts`.
 *
 * Not handled (each becomes a hole, so usually `DYNAMIC_URL`):
 * - `var` variables, `let`s `lets.ts` can't follow, destructured parameters, function results, array
 *   `.join()`, `.concat()`, `path.join`, `URLSearchParams` built into the path.
 * - Mutating a `URL` after creation (`u.pathname = …`) and relative `new URL()` URLs whose
 *   base isn't literal (the base's path is unknown).
 * - An env var inside the host (`https://${process.env.HOST}/x`).
 * - A hole that holds a `?` (`/search${qs}`) or several segments; the matcher treats a hole
 *   as part of one segment.
 * - ofetch's `withBase` check against a base that isn't one literal (an env var), or a URL
 *   whose leading text is only part of the base before a hole (`/a${x}` on `/api`): joined as
 *   axios would. ufo's protocol-relative URLs (`//host/x`) and `./`/`../` segments likewise.
 * - ky: an absolute URL under a `prefix` or `prefixUrl` stands alone (ky would glue it on), and
 *   a `baseUrl` with a `?` or `#`, or a relative URL starting with `.`, `?`, or `#`, under it
 *   (a hole). ky 1 adds one `/` without trimming the prefix's own slashes; joined as axios's.
 */
import ts from "typescript";
import type { Confidence, UrlSegment } from "@gitinside/schema";
import type { SymbolResolver } from "./calls.js";
import type { HttpCallSite } from "./http.js";
import type { ServiceProgram } from "./program.js";
import { letValues } from "./lets.js";
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

/** More literal text than this (characters) collapses to one hole. */
const MAX_TEXT = 2048;

/**
 * Expressions one `parts()`/`normalize()` call may visit. Consts that repeat each other
 * (`a1 = a0 + a0`, `a2 = a1 + a1`, …) grow exponentially; past the budget the URL is
 * `DYNAMIC_URL` with {@link DYNAMIC_URL_DETAIL}`.tooComplex`.
 */
const MAX_STEPS = 10_000;

/**
 * Paths {@link UrlNormalizer.alternatives} follows for one site (one per combination of
 * ternary branches and `let` values). Past this, alternatives that differ become a hole.
 */
export const MAX_PATHS = 8;

/** One piece of a URL value. */
export type UrlPart =
  | { kind: "text"; text: string }
  /**
   * A value only known at runtime. `param` marks a function parameter nothing is bound to,
   * which a caller of a wrapper could supply (M2.3).
   */
  | {
      kind: "hole";
      param?: true;
      /** The value was too large or too complex to read (see {@link MAX_STEPS}). */
      overflow?: true;
    }
  /**
   * An environment variable, by name, with the parts of the fallback the code gives it
   * (`process.env.X ?? "http://localhost:4000/api"`), if any (ADR-0158).
   */
  | { kind: "env"; name: string; fallback?: UrlPart[] }
  /** The page's own origin (`window.location.origin`). */
  | { kind: "origin" };

/** A path segment and its pieces, defined with the route grammar in the schema (ADR-0087). */
export type { UrlSegment, UrlSegmentPart } from "@gitinside/schema";

/** What the path is relative to. */
export type UrlBase =
  /** Root-relative (`/api/x`): the calling page's own origin. */
  | { kind: "path" }
  /** Relative to the current page's folder (`api/x`). */
  | { kind: "page" }
  /** A literal origin. `scheme` is `null` for protocol-relative URLs (`//cdn.x.com`). */
  | { kind: "host"; scheme: string | null; host: string }
  /**
   * An origin read from an environment variable. `fallbackHost` is the host (and port) of a
   * literal fallback URL in the code, which says whether the default points at this machine.
   */
  | { kind: "env"; name: string; fallbackHost?: string };

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
  emptyHost: "the URL has an empty host",
  tooComplex: "the URL is too large or too complex to read statically",
  hookKey: "the SWR key is an array, which the fetcher may take whole or spread",
  rtkBaseQuery:
    "the RTK Query baseQuery isn't fetchBaseQuery or a function passing its arguments on to one, so it isn't followed",
  kyBases: "more than one of ky's prefixUrl, prefix, and baseUrl is set, which isn't followed",
  kyPrefixUrlSlash: "ky refuses a URL starting with / under a prefixUrl, so this request fails",
} as const;

export type DynamicUrlDetail = (typeof DYNAMIC_URL_DETAIL)[keyof typeof DYNAMIC_URL_DETAIL];

/** Why a URL is `WRAPPER_DEPTH`, in words shown to the user. */
export const WRAPPER_DEPTH_DETAIL = {
  url: "the URL starts with a parameter of the calling function, a wrapper more than one call deep",
  baseURL:
    "the axios baseURL starts with a parameter of the calling function, a wrapper more than one call deep",
  config:
    "the axios config is a parameter of the calling function, a wrapper more than one call deep",
  inner:
    "the URL's leading part is a parameter of a function inside the wrapper, a wrapper more than one call deep",
} as const;

export type WrapperDepthDetail = (typeof WRAPPER_DEPTH_DETAIL)[keyof typeof WRAPPER_DEPTH_DETAIL];

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
  | { resolved: false; reason: "DYNAMIC_URL"; detail: DynamicUrlDetail }
  | { resolved: false; reason: "WRAPPER_DEPTH"; detail: WrapperDepthDetail };

/**
 * Values bound to a wrapper's parameters while inlining one call to it (M2.3): the caller's
 * argument or the parameter's default, `undefined` when neither is readable.
 */
export type ParameterBindings = ReadonlyMap<ts.ParameterDeclaration, ProgramExpression | undefined>;

const HOLE: UrlPart = { kind: "hole" };
const OVERFLOW_HOLE: UrlPart = { kind: "hole", overflow: true };
const text = (value: string): UrlPart => ({ kind: "text", text: value });

/** `scheme://` or `//` at the start of a URL (axios's `isAbsoluteURL`). */
const ABSOLUTE = /^([a-z][a-z\d+\-.]*:)?\/\//i;

/** A literal origin at the start of a URL. */
const ORIGIN = /^[a-z][a-z\d+\-.]*:\/\/[^/?#]*/i;

/**
 * Join adjacent text parts and drop empty ones. Returns a single hole past {@link MAX_PARTS}
 * parts or {@link MAX_TEXT} characters of text.
 */
export function mergeParts(parts: readonly UrlPart[]): UrlPart[] {
  const out: UrlPart[] = [];
  let length = 0;
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text === "") continue;
      length += part.text.length;
      if (length > MAX_TEXT) return [OVERFLOW_HOLE];
      const last = out[out.length - 1];
      if (last?.kind === "text") {
        out[out.length - 1] = text(last.text + part.text);
        continue;
      }
    }
    out.push(part);
  }
  return out.length > MAX_PARTS ? [OVERFLOW_HOLE] : out;
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
 * An env var or the page origin after the start of a URL: an env var's fallback when it is a
 * path piece of text and holes (`/api/${process.env.VERSION || "v1"}` reads `/api/v1`), else a
 * hole. An absolute (`http://h`) or protocol-relative (`//h`) fallback is a whole URL, not a
 * path piece, so it's a hole too.
 */
function laterPart(part: UrlPart): UrlPart[] {
  if (part.kind === "origin") return [HOLE];
  if (part.kind !== "env") return [part];
  const { fallback } = part;
  if (!fallback?.every((p) => p.kind === "text" || p.kind === "hole")) return [HOLE];
  const [path = ""] = fallback
    .map((p) => (p.kind === "text" ? p.text : "{}"))
    .join("")
    .split(/[?#]/);
  return path.includes("://") || path.startsWith("//") ? [HOLE] : fallback;
}

/**
 * What an env base's fallback adds (ADR-0158): a literal URL or root-relative path
 * (`?? "http://localhost:4000/api/v1"`) gives its path as a prefix and its host, if any.
 * A fallback whose path has a hole, or that isn't such a URL, adds nothing.
 */
function envFallback(fallback: readonly UrlPart[] | undefined): {
  prefix: UrlPart[];
  host?: string;
} {
  if (fallback === undefined) return { prefix: [] };
  const result = toUrlPattern(fallback);
  if ("detail" in result) return { prefix: [] };
  const { base, segments } = result.pattern;
  if (base.kind !== "host" && base.kind !== "path") return { prefix: [] };
  if (segments.some((segment) => segment.some((p) => p.kind === "hole"))) return { prefix: [] };
  const path = segments.map((segment) => "/" + segmentText(segment)).join("");
  // Keep a trailing slash, so `?? "http://h/api/"` then `"users"` reads `/api/users`.
  const last = stripQuery(fallback).at(-1);
  const slash = last?.kind === "text" && last.text.endsWith("/") ? "/" : "";
  const prefix = path + slash === "" ? [] : [text(path + slash)];
  return base.kind === "host" ? { prefix, host: base.host } : { prefix };
}

/** A literal segment's text (holes are `{}`). */
const segmentText = (segment: UrlSegment): string =>
  segment.map((p) => (p.kind === "text" ? p.text : "{}")).join("");

/**
 * Read a list of parts as a URL (see the file comment for the rules). Returns the pattern,
 * or the reason it is `DYNAMIC_URL`. Idempotent: `toUrlPattern(patternParts(p))` is `p`.
 */
export function toUrlPattern(
  input: readonly UrlPart[],
): { pattern: UrlPattern } | { detail: DynamicUrlDetail } {
  // An env var or the page origin only counts as a base at the very start.
  const parts = stripQuery(
    mergeParts(mergeParts(input).flatMap((p, i) => (i > 0 ? laterPart(p) : [p]))),
  );
  const first = parts[0];
  if (!first) return { pattern: { base: { kind: "page" }, segments: [] } };
  if (first.kind === "hole") return { detail: DYNAMIC_URL_DETAIL.leadingHole };

  let base: UrlBase;
  let rest: UrlPart[];
  if (first.kind === "env") {
    const { prefix, host } = envFallback(first.fallback);
    base =
      host === undefined
        ? { kind: "env", name: first.name }
        : { kind: "env", name: first.name, fallbackHost: host };
    rest = mergeParts([...prefix, ...parts.slice(1)]);
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
      // Credentials (`user:pass@`) are dropped so they never reach the graph.
      host = host.slice(host.lastIndexOf("@") + 1);
      // `https:///x` or `https://user@/x`: no host to name an external node by.
      if (host === "" || host.startsWith(":")) return { detail: DYNAMIC_URL_DETAIL.emptyHost };
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
  if (base.kind === "env") {
    // The fallback's path is already in the segments; only its host is left to carry.
    out.push(
      base.fallbackHost === undefined
        ? { kind: "env", name: base.name }
        : { kind: "env", name: base.name, fallback: [text(`//${base.fallbackHost}`)] },
    );
  }
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

/** Stands for an env var, the page origin, or a hole while {@link leadingHoles} reads text. */
const VALUE_MARK = "\u0000";

/** A literal origin, or its start, at the start of a URL (`https://h:8080`, `https://`). */
const LEADING_ORIGIN = /^([a-z][a-z\d+\-.]*:)?\/\/[^/?#]*/i;

/**
 * The parameter holes in a URL's parts that reach its leading part (M5A.3j, ADR-0164): only a
 * parameter there makes a function a wrapper, since EVALUATION.md §1 places a request whose
 * route the function fixes at the function's own call. A parameter hole is leading when no
 * literal `?` or `#` comes before it and it is:
 * - at the start, in the host or port, or right after the base (an env var, the page origin,
 *   or a literal origin): `fetch(url)`, `${API}${path}`, `https://${host}/x`;
 * - glued to the path's text, so the argument brings its own slash: `/api${path}`,
 *   `https://h/v1${endpoint}` (unless its segment already holds a hole: `/c/${id}-${slug}`);
 * - the first path segment: `${API}/${resource}`.
 *
 * A hole after a literal path segment and a `/` (`/posts/${id}`), or in the query, isn't.
 * Not handled: a parameter glued to text inside a segment (`/posts/post-${id}`) reads like a
 * path, and a first segment after a literal base's own path (`"https://h/api/" + resource`)
 * like an id.
 */
export function leadingHoles(parts: readonly UrlPart[]): Set<UrlPart> {
  const found = new Set<UrlPart>();
  let before = "";
  for (const part of parts) {
    if (part.kind === "text") {
      before += part.text;
      continue;
    }
    if (part.kind === "hole" && part.param === true && leadingAt(before)) found.add(part);
    before += VALUE_MARK;
  }
  return found;
}

/** True when a hole after `before` (text, with values as {@link VALUE_MARK}) is leading. */
function leadingAt(before: string): boolean {
  if (/[?#]/.test(before)) return false;
  let path = before;
  if (path.startsWith(VALUE_MARK)) {
    path = path.slice(VALUE_MARK.length);
  } else {
    const origin = LEADING_ORIGIN.exec(path);
    // Still in the host or port.
    if (origin && origin[0].length === path.length) return true;
    if (origin) path = path.slice(origin[0].length);
  }
  if (path === "") return true;
  const segment = path.slice(path.lastIndexOf("/") + 1);
  if (segment !== "") return !segment.includes(VALUE_MARK);
  return /^\/+$/.test(path);
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
 * Combine an ofetch `baseURL` with a request URL the way ofetch does (ufo's `withBase`, M5C.3c):
 * a URL whose leading text already starts with a literal base, its trailing `/` dropped
 * (`withoutTrailingSlash`), is left alone, so `ofetch("/api/users", { baseURL: "/api" })` is
 * `/api/users`; otherwise as {@link joinBaseURL}. Like ufo, the check is a plain prefix test.
 */
export function withBase(base: readonly UrlPart[], url: readonly UrlPart[]): UrlPart[] {
  const b = mergeParts(base);
  const u = mergeParts(url);
  const [only] = b;
  const head = u[0];
  if (b.length === 1 && only?.kind === "text" && head?.kind === "text") {
    const prefix = (only.text.endsWith("/") ? only.text.slice(0, -1) : only.text) || "/";
    if (only.text !== "" && head.text.startsWith(prefix)) return u;
  }
  return joinBaseURL(base, url);
}

/**
 * Resolve a request URL against ky 2's `baseUrl` (M5C.3e), as ky does with URL resolution
 * against the page: a root-relative URL keeps only the base's origin (none for a
 * root-relative base, so the URL stands alone), and a relative one replaces the base's last
 * path segment (`users` on `/api/` is `/api/users`, on `/api` it's `/users`). A base whose last
 * segment can't be found (an env var alone before a relative URL), and `.`/`..`, `?`, `#`, or
 * `//` at the URL's start, give a hole. Absolute URLs never get here (`normalizeSite`).
 */
export function resolveKyBaseUrl(base: readonly UrlPart[], url: readonly UrlPart[]): UrlPart[] {
  const u = mergeParts(url);
  const b = mergeParts(base);
  const head = u[0];
  const first = b[0];
  const last = b[b.length - 1];
  if (b.length === 0) return u;
  if (head?.kind !== "text" || /^(\.|\?|#|\/\/)/.test(head.text)) return [HOLE];
  if (head.text.startsWith("/")) {
    if (first?.kind === "text" && first.text.startsWith("/") && !first.text.startsWith("//")) {
      return u;
    }
    return resolveURL(u, b);
  }
  if (last?.kind !== "text") return [HOLE];
  const origin = b.length === 1 ? ORIGIN.exec(last.text) : null;
  const directory =
    origin && origin[0].length === last.text.length
      ? `${last.text}/`
      : last.text.slice(0, last.text.lastIndexOf("/") + 1);
  if (directory === "") return [HOLE];
  return mergeParts([...b.slice(0, -1), text(directory), ...u]);
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
  if (origin?.kind === "env") return [fallbackOrigin(origin), ...u];
  if (origin?.kind === "origin") return [origin, ...u];
  if (origin?.kind === "text") {
    const match = ORIGIN.exec(origin.text);
    // The host must end inside this literal, not run on into a hole.
    if (match && (match[0].length < origin.text.length || b.length === 1)) {
      return mergeParts([text(match[0]), ...u]);
    }
  }
  return [HOLE];
}

/**
 * An env var whose fallback keeps only its literal origin: a root-relative `new URL()` drops
 * the base's path, the fallback's included.
 */
function fallbackOrigin(env: Extract<UrlPart, { kind: "env" }>): UrlPart {
  const fallback = mergeParts(env.fallback ?? []);
  const head = fallback[0];
  const match = head?.kind === "text" ? ORIGIN.exec(head.text) : null;
  // As in `resolveURL`: the host must end inside this literal, not run on into a hole.
  if (
    head?.kind === "text" &&
    match &&
    (match[0].length < head.text.length || fallback.length === 1)
  ) {
    return { kind: "env", name: env.name, fallback: [text(match[0])] };
  }
  return { kind: "env", name: env.name };
}

/** Normalizes call-site URLs, reading values with one resolver's checkers. */
export interface UrlNormalizer {
  /** The parts an expression evaluates to; anything not statically known is a hole. */
  parts(value: ProgramExpression): UrlPart[];
  /**
   * A call site's URL, combined with its axios `baseURL`, as a pattern or `DYNAMIC_URL`.
   * With `bindings` (inlining a wrapper call), a URL or base that still starts with an
   * unbound parameter is `WRAPPER_DEPTH`: only a caller further out could supply it.
   */
  normalize(
    site: Pick<HttpCallSite, "url" | "baseURL" | "baseJoin" | "urlDetail">,
    bindings?: ParameterBindings,
  ): NormalizedUrl;
  /**
   * Like `normalize`, but one result per URL the code fixes statically (M5A.3h, ADR-0166):
   * each ternary branch and each value a `let` may hold where it is read is followed on its
   * own path, and paths that read the same are kept once, in path order (`true` branches and
   * earlier values first). Past {@link MAX_PATHS} paths, `normalize`'s single result.
   */
  alternatives(
    site: Pick<HttpCallSite, "url" | "baseURL" | "baseJoin" | "urlDetail">,
    bindings?: ParameterBindings,
  ): NormalizedUrl[];
  /** The parameters a call site's URL and `baseURL` read, which a wrapper caller could bind. */
  parameters(site: Pick<HttpCallSite, "url" | "baseURL">): ReadonlySet<ts.ParameterDeclaration>;
  /**
   * The parameters that reach the leading part of a call site's URL or `baseURL`
   * ({@link leadingHoles}): those that make its function a wrapper (M5A.3j). A parameter
   * whose position is lost (`new URL(path, base)`) counts as leading.
   */
  leadingParameters(
    site: Pick<HttpCallSite, "url" | "baseURL">,
  ): ReadonlySet<ts.ParameterDeclaration>;
}

/** Create a {@link UrlNormalizer} (see the file comment for what it reads). */
export function createUrlNormalizer(resolver: SymbolResolver): UrlNormalizer {
  const reader = createValueReader(resolver);
  /** The weakest import confidence crossed during the current `normalize` call. */
  let confidence: Confidence = "exact";
  const note = (c: Confidence): void => {
    confidence = weaker(confidence, c);
  };
  /** The wrapper parameters bound for the current `normalize` call, if inlining. */
  let bindings: ParameterBindings | undefined;
  /** Parameters read without a binding during the current evaluation. */
  const used = new Set<ts.ParameterDeclaration>();
  /** The parameter each unbound parameter's hole stands for (`leadingParameters`). */
  const holes = new Map<UrlPart, ts.ParameterDeclaration>();
  /**
   * While `alternatives` runs one path: the option to take at each choice point (`0` past
   * the end), and the option taken and the number of options at each point reached so far.
   */
  let choices: { forced: number[]; taken: number[]; counts: number[] } | undefined;

  /**
   * One of several values an expression may have (ternary branches, a `let`'s reaching
   * values). Following one path in `alternatives`, the path's option; otherwise the value
   * when every option reads the same, else a hole.
   */
  const choose = (options: readonly (() => UrlPart[])[]): UrlPart[] => {
    const [only] = options;
    if (options.length === 1 && only) return only();
    if (choices) {
      const pick = choices.forced[choices.taken.length] ?? 0;
      choices.taken.push(pick);
      choices.counts.push(options.length);
      return options[pick]?.() ?? [HOLE];
    }
    const all = options.map((option) => option());
    const first = JSON.stringify(all[0]);
    return all.every((p) => JSON.stringify(p) === first) && all[0] ? all[0] : [HOLE];
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

  /** A parameter read: its bound value while inlining, else a parameter hole. */
  const parameterParts = (
    sp: ServiceProgram,
    e: ts.Identifier,
    d: ts.ParameterDeclaration,
    hops: number,
  ): UrlPart[] => {
    if (bindings?.has(d)) {
      const bound = bindings.get(d);
      if (!bound) return [HOLE];
      // The argument is read in the caller's scope, where these bindings don't apply.
      const outer = bindings;
      bindings = undefined;
      try {
        return partsOf(bound.sp, bound.expression, hops + 1);
      } finally {
        bindings = outer;
      }
    }
    used.add(d);
    const literal = literalType(sp, e);
    if (literal) return literal;
    // A hole of its own, so `leadingParameters` can tell where this parameter landed.
    const hole: UrlPart = { kind: "hole", param: true };
    holes.set(hole, d);
    return [hole];
  };

  const identifierParts = (sp: ServiceProgram, e: ts.Identifier, hops: number): UrlPart[] => {
    const symbol = reader.symbolAt(sp, e);
    const found = symbol && reader.resolveDeclaration(sp, symbol, hops + 1);
    if (found) {
      const d = found.declaration;
      if (ts.isParameter(d) && ts.isIdentifier(d.name)) return parameterParts(sp, e, d, hops);
      if (ts.isVariableDeclaration(d) && d.initializer && isConst(d)) {
        note(found.confidence);
        return partsOf(found.sp, d.initializer, hops + 1);
      }
      if (ts.isVariableDeclaration(d) && found.sp === sp) {
        // A local `let`: each value that can reach this read is an alternative (M5A.3h).
        const values = letValues(d, e, (id) => reader.symbolAt(sp, id) === symbol);
        if (values) return choose(values.map((v) => () => partsOf(sp, v, hops + 1)));
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

  /** Expressions visited by the current `parts()` call (see {@link MAX_STEPS}). */
  let steps = 0;

  const partsOf = (sp: ServiceProgram, expression: ts.Expression, hops: number): UrlPart[] => {
    if (hops > MAX_HOPS) return [HOLE];
    if (++steps > MAX_STEPS) return [OVERFLOW_HOLE];
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
        // `process.env.API_URL ?? "http://localhost:3000/api"`: the env var is the base, and
        // the fallback says what follows it and where it points by default (ADR-0158).
        const left = partsOf(sp, e.left, hops + 1);
        const [env] = left;
        if (left.length !== 1 || env?.kind !== "env") return [HOLE];
        if (env.fallback !== undefined) return left;
        // A parameter only in the fallback doesn't make the function a wrapper.
        const usedBefore = new Set(used);
        const fallback = partsOf(sp, e.right, hops + 1);
        used.clear();
        for (const d of usedBefore) used.add(d);
        return [{ kind: "env", name: env.name, fallback: mergeParts(fallback) }];
      }
      return [HOLE];
    }
    if (ts.isConditionalExpression(e)) {
      return choose([
        () => partsOf(sp, e.whenTrue, hops + 1),
        () => partsOf(sp, e.whenFalse, hops + 1),
      ]);
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

  const parts = (value: ProgramExpression): UrlPart[] => {
    steps = 0;
    return mergeParts(partsOf(value.sp, value.expression, 0));
  };

  /** True when part of a value was too large or complex to read. */
  const overflowed = (p: readonly UrlPart[]): boolean =>
    p.some((part) => part.kind === "hole" && part.overflow === true);

  const dynamic = (detail: DynamicUrlDetail): NormalizedUrl => ({
    resolved: false,
    reason: "DYNAMIC_URL",
    detail,
  });

  /** True when inlining and the parts start with a parameter no binding supplied. */
  const startsWithParameter = (p: readonly UrlPart[]): boolean => {
    const first = p[0];
    return bindings !== undefined && first?.kind === "hole" && first.param === true;
  };

  const normalize = (
    site: Pick<HttpCallSite, "url" | "baseURL" | "baseJoin" | "urlDetail">,
    scope?: ParameterBindings,
  ): NormalizedUrl => {
    confidence = "exact";
    bindings = scope;
    try {
      return normalizeSite(site);
    } finally {
      bindings = undefined;
      used.clear();
      holes.clear();
    }
  };

  const normalizeSite = (
    site: Pick<HttpCallSite, "url" | "baseURL" | "baseJoin" | "urlDetail">,
  ): NormalizedUrl => {
    if (site.url === null) return dynamic(site.urlDetail ?? DYNAMIC_URL_DETAIL.url);
    let url = parts(site.url);
    if (overflowed(url)) return dynamic(DYNAMIC_URL_DETAIL.tooComplex);
    if (startsWithParameter(url)) return deeper(WRAPPER_DEPTH_DETAIL.url);
    if (url[0]?.kind === "hole") return dynamic(DYNAMIC_URL_DETAIL.leadingHole);
    if (site.baseURL !== undefined && !isAbsolute(url)) {
      if (site.baseURL === null) return dynamic(DYNAMIC_URL_DETAIL.baseURL);
      const base = parts(site.baseURL);
      if (overflowed(base)) return dynamic(DYNAMIC_URL_DETAIL.tooComplex);
      if (startsWithParameter(base)) return deeper(WRAPPER_DEPTH_DETAIL.baseURL);
      if (base[0]?.kind === "hole") return dynamic(DYNAMIC_URL_DETAIL.baseLeadingHole);
      const head = mergeParts(url)[0];
      // ky 1 throws on this ("`input` must not begin with a slash when using `prefixUrl`").
      if (site.baseJoin === "kyPrefixUrl" && head?.kind === "text" && head.text.startsWith("/")) {
        return dynamic(DYNAMIC_URL_DETAIL.kyPrefixUrlSlash);
      }
      url =
        site.baseJoin === "withBase"
          ? withBase(base, url)
          : site.baseJoin === "kyBaseUrl"
            ? resolveKyBaseUrl(base, url)
            : joinBaseURL(base, url);
      if (overflowed(url)) return dynamic(DYNAMIC_URL_DETAIL.tooComplex);
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

  const alternatives = (
    site: Pick<HttpCallSite, "url" | "baseURL" | "baseJoin" | "urlDetail">,
    scope?: ParameterBindings,
  ): NormalizedUrl[] => {
    const out: NormalizedUrl[] = [];
    const seen = new Set<string>();
    let forced: number[] = [];
    for (let path = 0; path < MAX_PATHS; path++) {
      const state = { forced, taken: [] as number[], counts: [] as number[] };
      choices = state;
      let url: NormalizedUrl;
      try {
        url = normalize(site, scope);
      } finally {
        choices = undefined;
      }
      const key = JSON.stringify(url);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(url);
      }
      // The next path: the last choice point with an option left takes its next option.
      let i = state.taken.length - 1;
      while (i >= 0 && (state.taken[i] ?? 0) + 1 >= (state.counts[i] ?? 0)) i--;
      if (i < 0) return out;
      forced = [...state.taken.slice(0, i), (state.taken[i] ?? 0) + 1];
    }
    // Too many paths: the alternatives that differ collapse to a hole, as without them.
    return [normalize(site, scope)];
  };

  const deeper = (detail: WrapperDepthDetail): NormalizedUrl => ({
    resolved: false,
    reason: "WRAPPER_DEPTH",
    detail,
  });

  const parameters = (
    site: Pick<HttpCallSite, "url" | "baseURL">,
  ): ReadonlySet<ts.ParameterDeclaration> => {
    used.clear();
    if (site.url) parts(site.url);
    if (site.baseURL) parts(site.baseURL);
    const found = new Set(used);
    used.clear();
    holes.clear();
    return found;
  };

  const leadingParameters = (
    site: Pick<HttpCallSite, "url" | "baseURL">,
  ): ReadonlySet<ts.ParameterDeclaration> => {
    used.clear();
    holes.clear();
    const found = new Set<ts.ParameterDeclaration>();
    /** Parameters with a hole of their own left in the URL's or base's parts. */
    const placed = new Set<ts.ParameterDeclaration>();
    // The URL and the base on their own: axios's join adds a `/` that the URL doesn't have.
    for (const value of [site.url, site.baseURL]) {
      if (!value) continue;
      const p = parts(value);
      const leading = leadingHoles(p);
      for (const part of p) {
        const d = holes.get(part);
        if (!d) continue;
        placed.add(d);
        if (leading.has(part)) found.add(d);
      }
    }
    // A parameter whose hole was absorbed (`new URL(path, base)`, a ternary) may be anywhere.
    for (const d of used) if (!placed.has(d)) found.add(d);
    used.clear();
    holes.clear();
    return found;
  };

  return { parts, normalize, alternatives, parameters, leadingParameters };
}
