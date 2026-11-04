/**
 * Dev proxies between a SPA and its API (ADR-0204), for the route matcher only: Vite's
 * `server.proxy` and Create React App's `package.json` `"proxy"`. A root-relative request
 * from such an app goes to the proxy's target, with the path the proxy really sends
 * (`/api/users` reaching `/users` through `rewrite: (p) => p.replace(/^\/api/, "")`).
 *
 * Config files are read as syntax with the TypeScript parser, never loaded or run (SECURITY.md
 * T1), and a `rewrite`'s regex is read character by character, never compiled.
 *
 * Patterns handled:
 * - Vite: `vite.config.{js,mjs,ts,cjs,mts,cts}` (the first in Vite's own order) exporting
 *   (`export default`, `module.exports =`) an object, `defineConfig(…)` of one, a function
 *   returning one (expression body, or one top-level `return`), or a top-level `const` holding
 *   any of these; `as` and `satisfies` are looked through.
 * - Its `server.proxy` entries, in order (Vite uses the first whose key the path starts with,
 *   as a plain string prefix): a string value (the target), or an object with a literal
 *   `target` (`http(s)`/`ws(s)` URL; its path goes in front, credentials are dropped) and a
 *   `rewrite` of the form `(path) => path.replace(<pattern>, "<text>")` (arrow, function, or
 *   method; expression or one `return`), the pattern a regex literal of plain characters
 *   (`A–Z a–z 0–9 _ ~ -`, escaped `/ . - _ ~`), optionally anchored with `^` and flagged `g`,
 *   or a string (its first occurrence).
 * - Create React App: a `package.json` that depends on `react-scripts` and has a string
 *   `"proxy"`: every request is sent to it unchanged (CRA has no rewrite).
 * - Which config applies to a request: the nearest folder above the calling file (its own
 *   included, never above its service's folder) that holds a Vite config or a `package.json`
 *   decides; a Vite config there wins over the `package.json`.
 *
 * Patterns not handled (an entry the matcher can't decide falls back to matching as before):
 * - Regex keys (`"^/api/.*"`), computed keys, and spreads: a request reaching such an entry
 *   in order is undecided, since the entry may take it.
 * - A target that isn't a literal URL (an env var, a template with values): the request is
 *   still proxied, to an unknown server.
 * - A `rewrite` of any other shape, a replacement with `$` patterns, other regex syntax or
 *   flags: the proxied path is unknown, and the matcher says so.
 * - `bypass`, `configure`, `preview.proxy`, a config's `root` or `base`, Vite configs named on
 *   the command line, CRA's `src/setupProxy.js` (http-proxy-middleware), webpack-dev-server's
 *   `devServer.proxy`, and Angular's `proxy.conf.json`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import type { UrlSegment } from "@gitinside/schema";
import { serviceForFile, type Workspace } from "./workspace.js";

/** Where a proxy entry sends requests. */
export type ProxyTarget =
  /** A literal URL: lowercased scheme and host (with any port), and its path (`""` or `/v1`). */
  { kind: "host"; scheme: string; host: string; path: string } | { kind: "unknown" };

/** A `rewrite` read as one string replacement. */
export interface ProxyRewrite {
  from: string;
  to: string;
  /** True for a `^` regex: only a match at the start counts; else the first occurrence. */
  anchored: boolean;
}

/** One proxy entry. */
export interface ProxyRule {
  /** The path prefix the entry takes, or undefined for one that can't be read. */
  context: string | undefined;
  /** Undefined when the path isn't rewritten; `unknown` for a rewrite that isn't read. */
  rewrite: ProxyRewrite | "unknown" | undefined;
  target: ProxyTarget;
}

/** The proxy entries of one app's config. */
export interface DevProxy {
  /** The repo-relative config file the entries come from. */
  config: string;
  rules: ProxyRule[];
}

/** The dev proxy serving requests made in a repo-relative file, if any. */
export type DevProxies = (file: string) => DevProxy | undefined;

/** What a proxy does with a request. */
export type ProxiedPath =
  /** No entry takes it: the dev server answers it. */
  | { kind: "direct" }
  /** A hole or an unread entry hides which entry takes it. */
  | { kind: "undecided" }
  /** `rule` takes it; `segments` is the path the target gets, undefined when not known. */
  | { kind: "proxied"; rule: ProxyRule; segments: UrlSegment[] | undefined };

/** Vite's config file names, in the order Vite looks for them. */
export const VITE_CONFIG_FILES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
] as const;

const UNKNOWN_RULE: ProxyRule = {
  context: undefined,
  rewrite: "unknown",
  target: { kind: "unknown" },
};

/** Stands for a hole while a path is handled as text. */
const HOLE_MARK = "\u0000";

/** Nested configs, functions, and consts followed before giving up. */
const MAX_HOPS = 8;

/** A property's value (or method): found, absent, or hidden behind a spread or computed key. */
type Lookup =
  | { kind: "found"; value: ts.Expression }
  | { kind: "method"; method: ts.MethodDeclaration }
  | { kind: "absent" }
  | { kind: "unknown" };

const propertyName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : ts.isNumericLiteral(name)
      ? name.text
      : undefined;

function strip(e: ts.Expression): ts.Expression {
  let out = e;
  while (
    ts.isParenthesizedExpression(out) ||
    ts.isAsExpression(out) ||
    ts.isSatisfiesExpression(out) ||
    ts.isTypeAssertionExpression(out)
  ) {
    out = out.expression;
  }
  return out;
}

/** Reads one config file's syntax. */
class ConfigReader {
  /** Top-level `const` initializers by name (`let`/`var` may change, so they aren't kept). */
  private readonly consts = new Map<string, ts.Expression>();

  constructor(private readonly source: ts.SourceFile) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) this.consts.set(d.name.text, d.initializer);
      }
    }
  }

  /** The exported config expression, if the file has one. */
  exported(): ts.Expression | undefined {
    let out: ts.Expression | undefined;
    for (const statement of this.source.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) out = statement.expression;
      if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = statement.expression.left;
        if (
          ts.isPropertyAccessExpression(left) &&
          ts.isIdentifier(left.expression) &&
          left.expression.text === "module" &&
          left.name.text === "exports"
        ) {
          out = statement.expression.right;
        }
      }
    }
    return out;
  }

  /** `e` with consts followed and wrappers removed. */
  value(e: ts.Expression, hops = 0): ts.Expression {
    const s = strip(e);
    if (hops < MAX_HOPS && ts.isIdentifier(s)) {
      const init = this.consts.get(s.text);
      if (init) return this.value(init, hops + 1);
    }
    return s;
  }

  /** The object a config expression stands for: through `defineConfig(…)` and functions. */
  object(e: ts.Expression, hops = 0): ts.ObjectLiteralExpression | undefined {
    if (hops > MAX_HOPS) return undefined;
    const v = this.value(e);
    if (ts.isObjectLiteralExpression(v)) return v;
    if (ts.isCallExpression(v) && ts.isIdentifier(v.expression)) {
      const [arg] = v.arguments;
      return v.expression.text === "defineConfig" && arg ? this.object(arg, hops + 1) : undefined;
    }
    if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) {
      const result = returned(v);
      return result ? this.object(result, hops + 1) : undefined;
    }
    return undefined;
  }

  /** A property of an object literal; the last one wins, as in JavaScript. */
  property(object: ts.ObjectLiteralExpression, name: string): Lookup {
    let out: Lookup = { kind: "absent" };
    for (const p of object.properties) {
      if (ts.isSpreadAssignment(p)) {
        out = { kind: "unknown" };
        continue;
      }
      const key =
        p.name && ts.isComputedPropertyName(p.name) ? undefined : p.name && propertyName(p.name);
      if (key === undefined) {
        out = { kind: "unknown" };
        continue;
      }
      if (key !== name) continue;
      if (ts.isPropertyAssignment(p)) out = { kind: "found", value: p.initializer };
      else if (ts.isShorthandPropertyAssignment(p)) out = { kind: "found", value: p.name };
      else if (ts.isMethodDeclaration(p)) out = { kind: "method", method: p };
      else out = { kind: "unknown" };
    }
    return out;
  }

  /** The rules of a `server.proxy` table. */
  rules(table: ts.ObjectLiteralExpression): ProxyRule[] {
    return table.properties.map((p): ProxyRule => {
      if (ts.isSpreadAssignment(p)) return UNKNOWN_RULE;
      const key = p.name && !ts.isComputedPropertyName(p.name) ? propertyName(p.name) : undefined;
      // Vite reads a key starting with `^` as a regex.
      const context = key === undefined || key.startsWith("^") ? undefined : key;
      if (ts.isPropertyAssignment(p)) return { context, ...this.entry(p.initializer) };
      if (ts.isShorthandPropertyAssignment(p)) return { context, ...this.entry(p.name) };
      return { ...UNKNOWN_RULE, context };
    });
  }

  /** What one proxy entry's value says. */
  private entry(e: ts.Expression): Omit<ProxyRule, "context"> {
    const v = this.value(e);
    const target = literalText(v);
    if (target !== undefined) return { rewrite: undefined, target: parseTarget(target) };
    if (!ts.isObjectLiteralExpression(v))
      return { rewrite: "unknown", target: { kind: "unknown" } };
    const t = this.property(v, "target");
    const text = t.kind === "found" ? literalText(this.value(t.value)) : undefined;
    const r = this.property(v, "rewrite");
    return {
      target: text === undefined ? { kind: "unknown" } : parseTarget(text),
      rewrite:
        r.kind === "absent"
          ? undefined
          : r.kind === "found"
            ? (readRewrite(this.value(r.value)) ?? "unknown")
            : r.kind === "method"
              ? (rewriteOf(r.method) ?? "unknown")
              : "unknown",
    };
  }
}

/** A string literal's or plain template's text. */
function literalText(e: ts.Expression): string | undefined {
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : undefined;
}

/** The expression a function returns: its expression body, or its one top-level `return`. */
function returned(
  fn: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration,
): ts.Expression | undefined {
  const { body } = fn;
  if (!body) return undefined;
  if (!ts.isBlock(body)) return body;
  const returns = body.statements.filter(ts.isReturnStatement);
  const [only] = returns;
  return returns.length === 1 ? only?.expression : undefined;
}

/** A literal target URL, or unknown for another scheme or a value that isn't a URL. */
function parseTarget(text: string): ProxyTarget {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { kind: "unknown" };
  }
  const scheme = url.protocol.slice(0, -1);
  if (!["http", "https", "ws", "wss"].includes(scheme) || url.host === "") {
    return { kind: "unknown" };
  }
  const segments = url.pathname.split("/").filter((s) => s !== "");
  return {
    kind: "host",
    scheme,
    host: url.host,
    path: segments.length > 0 ? `/${segments.join("/")}` : "",
  };
}

/** Characters a regex escape may stand for, and plain characters kept as they are. */
const ESCAPABLE = new Set(["/", ".", "-", "_", "~"]);
const PLAIN = /^[A-Za-z0-9_~-]$/;

/** A regex literal's text read as a literal string, or undefined for other regex syntax. */
function regexLiteral(text: string): { from: string; anchored: boolean } | undefined {
  const end = text.lastIndexOf("/");
  const flags = text.slice(end + 1);
  if (flags !== "" && flags !== "g") return undefined;
  let body = text.slice(1, end);
  const anchored = body.startsWith("^");
  if (anchored) body = body.slice(1);
  let from = "";
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c === "\\") {
      const next = body.charAt(i + 1);
      if (!ESCAPABLE.has(next)) return undefined;
      from += next;
      i++;
    } else if (PLAIN.test(c)) {
      from += c;
    } else {
      return undefined;
    }
  }
  return { from, anchored };
}

/** A `(path) => path.replace(pattern, "text")` function, or undefined for any other value. */
function readRewrite(e: ts.Expression): ProxyRewrite | undefined {
  if (!ts.isArrowFunction(e) && !ts.isFunctionExpression(e)) return undefined;
  return rewriteOf(e);
}

function rewriteOf(
  fn: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration,
): ProxyRewrite | undefined {
  const [param] = fn.parameters;
  if (fn.parameters.length !== 1 || !param || !ts.isIdentifier(param.name)) return undefined;
  const body = returned(fn);
  const call = body && strip(body);
  if (!call || !ts.isCallExpression(call) || call.arguments.length !== 2) return undefined;
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== "replace" ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== param.name.text
  ) {
    return undefined;
  }
  const [pattern, replacement] = call.arguments.map(strip);
  const to = replacement && literalText(replacement);
  // `$&`, `$1`, … are replacement patterns.
  if (to === undefined || to.includes("$") || !pattern) return undefined;
  if (ts.isRegularExpressionLiteral(pattern)) {
    const read = regexLiteral(pattern.text);
    return read ? { ...read, to } : undefined;
  }
  const from = literalText(pattern);
  return from === undefined ? undefined : { from, to, anchored: false };
}

/**
 * The proxy rules of a Vite config's text: `[]` when it has no proxy, one unknown rule when
 * the proxy table (or what holds it) can't be read, and undefined when the config itself
 * can't be.
 */
export function readViteProxy(file: string, text: string): ProxyRule[] | undefined {
  const kind = /\.[mc]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const reader = new ConfigReader(source);
  const exported = reader.exported();
  const config = exported && reader.object(exported);
  if (!config) return undefined;
  const server = reader.property(config, "server");
  if (server.kind === "absent") return [];
  const serverObject = server.kind === "found" ? reader.value(server.value) : undefined;
  if (!serverObject || !ts.isObjectLiteralExpression(serverObject)) return [UNKNOWN_RULE];
  const proxy = reader.property(serverObject, "proxy");
  if (proxy.kind === "absent") return [];
  const table = proxy.kind === "found" ? reader.value(proxy.value) : undefined;
  if (!table || !ts.isObjectLiteralExpression(table)) return [UNKNOWN_RULE];
  return reader.rules(table);
}

/** CRA's proxy rule from a `package.json`'s text, or undefined when it has none. */
function readCraProxy(text: string): ProxyRule[] | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const m = manifest as Record<string, unknown>;
  const has = (field: string): boolean => {
    const deps = m[field];
    return typeof deps === "object" && deps !== null && "react-scripts" in deps;
  };
  if (!has("dependencies") && !has("devDependencies")) return undefined;
  const { proxy } = m;
  if (typeof proxy !== "string") return undefined;
  return [{ context: "/", rewrite: undefined, target: parseTarget(proxy) }];
}

const dirName = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Build {@link DevProxies} from the repo's Vite configs and `package.json` files. */
export function devProxies(
  files: readonly { file: string; text: string }[],
  workspace: Workspace,
): DevProxies {
  /** Folder ⇒ the proxy deciding there (undefined: a package without one). */
  const byDir = new Map<string, DevProxy | undefined>();
  const rank = (file: string): number => {
    const i = (VITE_CONFIG_FILES as readonly string[]).indexOf(baseName(file));
    return i < 0 ? VITE_CONFIG_FILES.length : i;
  };
  // Vite configs first, in Vite's order, so each folder keeps the one Vite would load.
  const sorted = [...files].sort((a, b) => rank(a.file) - rank(b.file));
  for (const { file, text } of sorted) {
    const dir = dirName(file);
    if (byDir.has(dir)) continue;
    const rules =
      baseName(file) === "package.json" ? readCraProxy(text) : readViteProxy(file, text);
    byDir.set(dir, rules ? { config: file, rules } : undefined);
  }
  return (file) => {
    const service = serviceForFile(workspace, file);
    if (!service) return undefined;
    let dir = dirName(file);
    for (;;) {
      if (byDir.has(dir)) return byDir.get(dir);
      if (dir === service.dir || dir === "") return undefined;
      dir = dirName(dir);
    }
  };
}

/** Read every Vite config and `package.json` in the inventory (`files`, repo-relative). */
export async function readDevProxies(
  root: string,
  files: readonly string[],
  workspace: Workspace,
): Promise<DevProxies> {
  const names = new Set<string>([...VITE_CONFIG_FILES, "package.json"]);
  const configs = files.filter((f) => names.has(baseName(f)));
  const read = await Promise.all(
    configs.map(async (file) => ({ file, text: await readFile(join(root, file), "utf8") })),
  );
  return devProxies(read, workspace);
}

/** A path as text, with {@link HOLE_MARK} for each hole. */
const pathText = (segments: readonly UrlSegment[]): string =>
  "/" +
  segments.map((s) => s.map((p) => (p.kind === "text" ? p.text : HOLE_MARK)).join("")).join("/");

/** Path text back into segments. */
function toSegments(text: string): UrlSegment[] {
  return text
    .split("/")
    .filter((s) => s !== "")
    .map((segment) =>
      segment.split(HOLE_MARK).flatMap((piece, i): UrlSegment => {
        const out: UrlSegment = i > 0 ? [{ kind: "hole" }] : [];
        if (piece !== "") out.push({ kind: "text", text: piece });
        return out;
      }),
    );
}

/** A proxied path for messages: `/users/{}`. */
export const formatProxyPath = (segments: readonly UrlSegment[]): string =>
  pathText(segments).replaceAll(HOLE_MARK, "{}");

/**
 * The text a rewrite makes of `text` (whose literal start is `known`), or undefined when a
 * hole hides whether, or where, the pattern matches.
 */
function applyRewrite(text: string, known: string, rewrite: ProxyRewrite): string | undefined {
  const complete = known.length === text.length;
  const { from, to } = rewrite;
  if (rewrite.anchored) {
    if (known.startsWith(from)) return to + text.slice(from.length);
    return complete || !from.startsWith(known) ? text : undefined;
  }
  // The first occurrence lies wholly before any hole, or there is none at all.
  const at = known.indexOf(from);
  if (at >= 0) return text.slice(0, at) + to + text.slice(at + from.length);
  return complete ? text : undefined;
}

/** What `proxy` does with a root-relative request for `segments`. */
export function proxyRequest(proxy: DevProxy, segments: readonly UrlSegment[]): ProxiedPath {
  const text = pathText(segments);
  const hole = text.indexOf(HOLE_MARK);
  const known = hole < 0 ? text : text.slice(0, hole);
  for (const rule of proxy.rules) {
    const { context } = rule;
    if (context === undefined) return { kind: "undecided" };
    if (!known.startsWith(context)) {
      if (hole >= 0 && context.startsWith(known)) return { kind: "undecided" };
      continue;
    }
    if (rule.rewrite === "unknown") return { kind: "proxied", rule, segments: undefined };
    const rewritten = rule.rewrite ? applyRewrite(text, known, rule.rewrite) : text;
    const target = rule.target.kind === "host" ? rule.target.path : "";
    return {
      kind: "proxied",
      rule,
      segments: rewritten === undefined ? undefined : toSegments(`${target}/${rewritten}`),
    };
  }
  return { kind: "direct" };
}
