/**
 * `next.config`'s `basePath` and `rewrites` (ADR-0206), for the route matcher only. A Next app
 * with `basePath: "/shop"` serves `app/api/items/route.ts` at `/shop/api/items`, and its
 * rewrites send a request's path somewhere else (`/backend/:path*` ⇒
 * `http://localhost:4000/:path*`, or to another route of the app).
 *
 * The config is read as syntax with the TypeScript parser (`ConfigReader`, shared with
 * `devProxy.ts`), never loaded or run (SECURITY.md T1), and path patterns are read segment by
 * segment, never compiled.
 *
 * Patterns handled:
 * - The config: the first of `next.config.{js,mjs,ts}` (Next's order) in the folder of a
 *   service that depends on `next`, exported (`export default`, `module.exports =`) as an
 *   object, a function returning one (Next's `(phase) => config`, expression body or one
 *   top-level `return`), a top-level `const` holding either, or passed to plugin wrappers
 *   (`withBundleAnalyzer(config)`, `withPlugins([…], config)`: a call of an identifier named
 *   `with…`, its first argument that is a config object); `as` and `satisfies` are looked
 *   through.
 * - `basePath`: a literal string (`"/shop"`). The app's routes and pages are matched under it.
 * - `rewrites`: a function or method returning an array (Next's `afterFiles`) or an object of
 *   `beforeFiles`, `afterFiles`, and `fallback` arrays, each entry an object with a literal
 *   `source` and a `destination` that is a literal, or a template / `+` of one value and a
 *   literal path (`` `${process.env.API_URL}/:path*` ``: an env var's name, never its value).
 *   Entries are tried in Next's order: `beforeFiles`; then, unless a static route or page
 *   serves the path, `afterFiles`; then, unless a dynamic one does, `fallback`. The first
 *   entry whose source matches takes the request (rewrites aren't chained).
 * - Path patterns, in `source` and in the destination's path: literal segments, `:name` (one
 *   segment), and `:name?`, `:name*`, `:name+` as the last segment; the destination's params
 *   are filled from the source's. `basePath` goes in front of both unless the entry says
 *   `basePath: false`.
 *
 * Patterns not handled (the matcher matches such a request as it would without rewrites):
 * - A computed `basePath` (an env var, a template with values): routes are matched without it.
 * - Rewrites built by code (a local variable, `.map`, a spread, an `await`ed fetch), entries
 *   with `has` or `missing` conditions, regex params (`:slug(\\d+)`), params inside a
 *   segment (`/a-:b`), and wildcards not at the end: a request such an entry may take is
 *   undecided, so it's matched as before.
 * - Chained rewrites (a rewritten path checked against later entries), `i18n` and `locale`,
 *   `redirects`, `headers`, `trailingSlash`, case-insensitive matching, `public/` files, and
 *   `middleware`. `pageExtensions` and plugins that add their own rewrites are not seen.
 * - Requests from other services to the app (through a loopback host, a proxy): only its own
 *   root-relative requests go through its rewrites; its `basePath` applies to every request.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { ALIGN, alignSegments, type UrlSegment } from "@gitinside/schema";
import { ConfigReader, literalText, parseTarget, returned, strip } from "./devProxy.js";
import type { Workspace } from "./workspace.js";

/** Next's config file names, in the order Next looks for them. */
export const NEXT_CONFIG_FILES = ["next.config.js", "next.config.mjs", "next.config.ts"] as const;

/** One segment of a `source` or destination path. */
export type PatternSegment =
  | { kind: "literal"; text: string }
  /** `:name`, or with `?` (optional), `*` (zero or more), `+` (one or more) as the last one. */
  | { kind: "param"; name: string; modifier: "" | "?" | "*" | "+" };

/** Where a rewrite sends a request. */
export type RewriteTarget =
  /** Another path of the same app. */
  | { kind: "internal" }
  /** A literal origin: lowercased scheme and host (with any port). */
  | { kind: "host"; scheme: string; host: string }
  /** An origin read from an env var (only its name is kept). */
  | { kind: "env"; name: string }
  | { kind: "unknown" };

/** One `rewrites` entry. */
export interface NextRewrite {
  /** The `source` as written, for messages; undefined when it isn't a literal. */
  text: string | undefined;
  /** The `source`'s segments, undefined when they can't be read. */
  source: PatternSegment[] | undefined;
  target: RewriteTarget;
  /** The destination's path segments, undefined when they can't be read. */
  destination: PatternSegment[] | undefined;
  /** False for `basePath: false`: the source and destination aren't put under `basePath`. */
  basePath: boolean;
  /** True with `has` or `missing`: whether it applies depends on the request. */
  conditional: boolean;
}

/** What one Next app's config says. */
export interface NextConfig {
  /** The repo-relative config file. */
  config: string;
  /** `basePath`'s segments, `[]` when there is none or it isn't a literal. */
  basePath: string[];
  beforeFiles: NextRewrite[];
  afterFiles: NextRewrite[];
  fallback: NextRewrite[];
}

/** The Next config of a service, by service key. */
export type NextConfigs = (service: string) => NextConfig | undefined;

/** What a Next app's rewrites do with a root-relative request. */
export type RewrittenPath =
  /** No entry takes it: the app serves it, or nothing does. */
  | { kind: "none" }
  /** A hole, a condition, or an unread entry hides whether one takes it. */
  | { kind: "undecided" }
  /** `rule` takes it; `segments` is the path it's sent with, undefined when not known. */
  | { kind: "rewritten"; rule: NextRewrite; segments: UrlSegment[] | undefined };

/** An entry that can't be read: it may take any request. */
const UNKNOWN_REWRITE: NextRewrite = {
  text: undefined,
  source: undefined,
  target: { kind: "unknown" },
  destination: undefined,
  basePath: true,
  conditional: false,
};

const NAME = /^:([A-Za-z_][A-Za-z0-9_]*)([?*+]?)$/;
/** Characters with a meaning in Next's path patterns (path-to-regexp). */
const PATTERN_SYNTAX = /[:()*?+{}[\]\\]/;

/** A path pattern's segments, or undefined for syntax that isn't read. */
export function parsePattern(path: string): PatternSegment[] | undefined {
  if (!path.startsWith("/")) return undefined;
  const parts = path.split("/").filter((s) => s !== "");
  const out: PatternSegment[] = [];
  for (const [i, part] of parts.entries()) {
    const param = NAME.exec(part);
    if (param) {
      const [, name = "", modifier = ""] = param;
      if (modifier !== "" && i !== parts.length - 1) return undefined;
      out.push({ kind: "param", name, modifier: modifier as "" | "?" | "*" | "+" });
    } else if (PATTERN_SYNTAX.test(part)) {
      return undefined;
    } else {
      out.push({ kind: "literal", text: part });
    }
  }
  return out;
}

/** `process.env.NAME`'s name. */
function envName(e: ts.Expression): string | undefined {
  const s = strip(e);
  if (!ts.isPropertyAccessExpression(s)) return undefined;
  const env = s.expression;
  return ts.isPropertyAccessExpression(env) &&
    ts.isIdentifier(env.expression) &&
    env.expression.text === "process" &&
    env.name.text === "env"
    ? s.name.text
    : undefined;
}

const ORIGIN = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i;

/** A destination's target and path. */
function readDestination(e: ts.Expression): Pick<NextRewrite, "target" | "destination"> {
  const unknown = { target: { kind: "unknown" }, destination: undefined } as const;
  const text = literalText(e);
  if (text !== undefined) {
    if (text.startsWith("/")) {
      return {
        target: { kind: "internal" },
        destination: parsePattern(text.split(/[?#]/)[0] ?? ""),
      };
    }
    const origin = ORIGIN.exec(text);
    if (!origin) return unknown;
    const [, scheme = "", authority = "", path = ""] = origin;
    const target = parseTarget(`${scheme}://${authority}`);
    if (target.kind !== "host") return unknown;
    return {
      target: { kind: "host", scheme: target.scheme, host: target.host },
      destination: parsePattern(path === "" ? "/" : path),
    };
  }
  // One value, then a literal path: `${process.env.API_URL}/:path*` or `API + "/:path*"`.
  let head: ts.Expression | undefined;
  let path: string | undefined;
  if (ts.isTemplateExpression(e) && e.head.text === "" && e.templateSpans.length === 1) {
    const [span] = e.templateSpans;
    head = span?.expression;
    path = span?.literal.text;
  } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    head = e.left;
    path = literalText(strip(e.right));
  }
  if (!head || path === undefined || !path.startsWith("/")) return unknown;
  const name = envName(head);
  return {
    target: name === undefined ? { kind: "unknown" } : { kind: "env", name },
    destination: parsePattern(path.split(/[?#]/)[0] ?? ""),
  };
}

/** One `rewrites` entry's object. */
function readRewrite(reader: ConfigReader, e: ts.Expression): NextRewrite {
  const v = reader.value(e);
  if (!ts.isObjectLiteralExpression(v)) return UNKNOWN_REWRITE;
  const source = reader.property(v, "source");
  const destination = reader.property(v, "destination");
  const sourceText = source.kind === "found" ? literalText(reader.value(source.value)) : undefined;
  const base = reader.property(v, "basePath");
  const has = reader.property(v, "has");
  const missing = reader.property(v, "missing");
  return {
    text: sourceText,
    source: sourceText === undefined ? undefined : parsePattern(sourceText),
    ...(destination.kind === "found"
      ? readDestination(reader.value(destination.value))
      : { target: { kind: "unknown" }, destination: undefined }),
    basePath: !(
      base.kind === "found" && reader.value(base.value).kind === ts.SyntaxKind.FalseKeyword
    ),
    // A spread could hide a condition, so it counts as one.
    conditional: has.kind !== "absent" || missing.kind !== "absent",
  };
}

/** The entries of one rewrites array (`[]` for an array that can't be read: one unknown). */
function readList(reader: ConfigReader, e: ts.Expression | undefined): NextRewrite[] {
  const v = e && reader.value(e);
  if (!v || !ts.isArrayLiteralExpression(v)) return [UNKNOWN_REWRITE];
  return v.elements.map((el) =>
    ts.isSpreadElement(el) || ts.isOmittedExpression(el)
      ? UNKNOWN_REWRITE
      : readRewrite(reader, el),
  );
}

/** The phases of a `rewrites` value. */
function readRewrites(
  reader: ConfigReader,
  config: ts.ObjectLiteralExpression,
): Pick<NextConfig, "beforeFiles" | "afterFiles" | "fallback"> {
  const none = { beforeFiles: [], afterFiles: [], fallback: [] };
  const lookup = reader.property(config, "rewrites");
  if (lookup.kind === "absent") return none;
  // Unread rewrites may take any request after the filesystem: matched as before.
  const unread = { beforeFiles: [], afterFiles: [UNKNOWN_REWRITE], fallback: [] };
  let fn: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration | undefined;
  if (lookup.kind === "method") fn = lookup.method;
  if (lookup.kind === "found") {
    const v = reader.value(lookup.value);
    if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) fn = v;
  }
  const result = fn && returned(fn);
  if (!result) return unread;
  const v = reader.value(result);
  if (ts.isArrayLiteralExpression(v)) return { ...none, afterFiles: readList(reader, v) };
  if (!ts.isObjectLiteralExpression(v)) return unread;
  const phase = (name: string): NextRewrite[] => {
    const p = reader.property(v, name);
    return p.kind === "absent" ? [] : readList(reader, p.kind === "found" ? p.value : undefined);
  };
  return {
    beforeFiles: phase("beforeFiles"),
    afterFiles: phase("afterFiles"),
    fallback: phase("fallback"),
  };
}

/** A plugin wrapper: `withBundleAnalyzer`, `withPlugins`, `withSentryConfig`, … */
const isPluginWrapper = (name: string): boolean => /^with[A-Z]/.test(name);

/**
 * What a `next.config` file's text says, or undefined when its exported config can't be
 * read (then it's as if there were none).
 */
export function readNextConfig(file: string, text: string): NextConfig | undefined {
  const kind = /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const reader = new ConfigReader(source, isPluginWrapper);
  const exported = reader.exported();
  const config = exported && reader.object(exported);
  if (!config) return undefined;
  const base = reader.property(config, "basePath");
  const baseText = base.kind === "found" ? literalText(reader.value(base.value)) : undefined;
  const basePath =
    baseText?.startsWith("/") && !PATTERN_SYNTAX.test(baseText)
      ? baseText.split("/").filter((s) => s !== "")
      : [];
  return { config: file, basePath, ...readRewrites(reader, config) };
}

/** Read the `next.config` of every service that depends on `next` (`files`, repo-relative). */
export async function readNextConfigs(
  root: string,
  files: readonly string[],
  workspace: Workspace,
): Promise<NextConfigs> {
  const present = new Set(files);
  const byService = new Map<string, NextConfig>();
  for (const service of workspace.packages) {
    if (!service.dependencies.includes("next")) continue;
    const file = NEXT_CONFIG_FILES.map((name) =>
      service.dir === "" ? name : `${service.dir}/${name}`,
    ).find((f) => present.has(f));
    if (file === undefined) continue;
    const config = readNextConfig(file, await readFile(join(root, file), "utf8"));
    if (config) byService.set(service.key, config);
  }
  return (service) => byService.get(service);
}

/** Captured params by name: each a list of segments. */
type Captures = Map<string, UrlSegment[]>;

const literal = (text: string): UrlSegment => [{ kind: "text", text }];

/** How `path` meets a source pattern: captures, no match, or a hole hides which. */
function matchSource(
  pattern: readonly PatternSegment[],
  path: readonly UrlSegment[],
): Captures | "no" | "undecided" {
  const captures: Captures = new Map();
  let i = 0;
  for (const p of pattern) {
    const segment = path[i];
    if (p.kind === "literal") {
      if (!segment) return "no";
      const level = alignSegments([segment], [{ kind: "literal", text: p.text }]);
      if (level === ALIGN.FAIL) return "no";
      if (level !== ALIGN.EXACT) return "undecided";
      i++;
    } else if (p.modifier === "") {
      if (!segment) return "no";
      captures.set(p.name, [segment]);
      i++;
    } else if (p.modifier === "?") {
      captures.set(p.name, segment ? [segment] : []);
      if (segment) i++;
    } else {
      const rest = path.slice(i);
      if (p.modifier === "+" && rest.length === 0) return "no";
      captures.set(p.name, rest);
      i = path.length;
    }
  }
  return i === path.length ? captures : "no";
}

/** A destination pattern filled from the source's captures, or undefined when it can't be. */
function fill(pattern: readonly PatternSegment[], captures: Captures): UrlSegment[] | undefined {
  const out: UrlSegment[] = [];
  for (const p of pattern) {
    if (p.kind === "literal") {
      out.push(literal(p.text));
      continue;
    }
    const captured = captures.get(p.name);
    if (!captured) return undefined;
    const fits =
      p.modifier === ""
        ? captured.length === 1
        : p.modifier === "?"
          ? captured.length <= 1
          : p.modifier === "+"
            ? captured.length >= 1
            : true;
    if (!fits) return undefined;
    out.push(...captured);
  }
  return out;
}

/**
 * What `config`'s rewrites do with a root-relative request for `path` (the full path, under
 * `basePath` as the browser sends it). `served(path, staticOnly)` says whether the app's
 * routes or pages (static ones only, or any) serve a path.
 */
export function rewriteRequest(
  config: NextConfig,
  path: readonly UrlSegment[],
  served: (path: readonly UrlSegment[], staticOnly: boolean) => boolean,
): RewrittenPath {
  const base: PatternSegment[] = config.basePath.map((text) => ({ kind: "literal", text }));
  /** The first entry of `rules` taking `path` (or maybe taking it), undefined for none. */
  const take = (rules: readonly NextRewrite[]): RewrittenPath | undefined => {
    for (const rule of rules) {
      if (!rule.source) return { kind: "undecided" };
      const prefix = rule.basePath ? base : [];
      const captures = matchSource([...prefix, ...rule.source], path);
      if (captures === "no") continue;
      if (captures === "undecided" || rule.conditional) return { kind: "undecided" };
      const internal = rule.target.kind === "internal" ? prefix : [];
      return {
        kind: "rewritten",
        rule,
        segments: rule.destination && fill([...internal, ...rule.destination], captures),
      };
    }
    return undefined;
  };
  const before = take(config.beforeFiles);
  if (before) return before;
  if (served(path, true)) return { kind: "none" };
  const after = take(config.afterFiles);
  if (after) return after;
  if (served(path, false)) return { kind: "none" };
  return take(config.fallback) ?? { kind: "none" };
}
