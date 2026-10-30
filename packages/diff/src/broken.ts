import {
  ALIGN,
  alignSegments,
  compareStrings,
  edgeId,
  HttpMethod,
  parseRoutePath,
  type ArchitectureGraph,
  type BrokenEdge,
  type CallSite,
  type GraphEdge,
  type GraphNode,
  type SourceLocation,
  type UrlSegment,
} from "@gitinside/schema";

type RouteNode = Extract<GraphNode, { kind: "route" }>;
type UnresolvedNode = Extract<GraphNode, { kind: "unresolved" }>;

/** Extensions TypeScript tries for an import specifier without one, in its order. */
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

/** A `.js`-style specifier ⇒ the TypeScript sources it stands for (`./a.js` ⇒ `a.ts`). */
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/**
 * Repo-relative paths a relative import specifier can name from `fromPath`, as
 * TypeScript resolves it without `paths` or packages: the path itself, with each
 * extension, `.js` read as `.ts`, and `<path>/index.*`. `undefined` for a specifier
 * that isn't relative or climbs out of the repo.
 */
export function relativeImportTargets(fromPath: string, specifier: string): string[] | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const parts = fromPath.split("/").slice(0, -1);
  for (const piece of specifier.split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(piece);
    }
  }
  const path = parts.join("/");
  if (path === "") return undefined;
  const out = [path, ...EXTENSIONS.map((e) => path + e)];
  for (const [js, tsList] of Object.entries(JS_TO_TS)) {
    if (path.endsWith(js)) out.push(...tsList.map((ts) => path.slice(0, -js.length) + ts));
  }
  out.push(...EXTENSIONS.map((e) => `${path}/index${e}`));
  return out;
}

/** A call as an unresolved HTTP node shows it: method (`null` when unknown) and path. */
interface HttpCall {
  method: HttpMethod | null;
  segments: UrlSegment[];
}

/** Origins a route can be reached through (DESIGN.md §7.2): any but a literal remote host. */
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[^/]*\.localhost)(?::\d+)?$/;

/**
 * Read back an unresolved HTTP node's label, `<METHOD|?> <url>`, where the URL is the
 * analyzer's pattern text (`/api/users/{}`, `./users`, `{env:API_URL}/orders`,
 * `http://localhost:3000/x`; holes are `{}`). `undefined` when the label was clipped (`…`)
 * or names a remote host, which no route in the repo answers.
 */
export function parseHttpLabel(label: string): HttpCall | undefined {
  if (label.endsWith("…")) return undefined;
  const space = label.indexOf(" ");
  if (space === -1) return undefined;
  const word = label.slice(0, space);
  let url = label.slice(space + 1);
  const method = word === "?" ? null : HttpMethod.safeParse(word);
  if (method !== null && !method.success) return undefined;

  const env = /^\{env:[^}]*\}/.exec(url);
  const origin = /^(?:[a-z][a-z\d+\-.]*:)?\/\/([^/]*)/i.exec(url);
  if (env) url = url.slice(env[0].length);
  else if (origin) {
    if (!LOOPBACK.test(origin[1] ?? "")) return undefined;
    url = url.slice(origin[0].length);
  } else if (url.startsWith("./")) url = url.slice(2);
  else if (!url.startsWith("/")) return undefined;

  const segments = url
    .split("/")
    .filter((s) => s !== "")
    .map((s): UrlSegment => {
      const pieces = s.split("{}");
      const out: UrlSegment = [];
      pieces.forEach((text, i) => {
        if (i > 0) out.push({ kind: "hole" });
        if (text !== "") out.push({ kind: "text", text });
      });
      return out;
    });
  return { method: method === null ? null : method.data, segments };
}

/**
 * Whether a call could reach a route, by the analyzer's rules (`match.ts`): methods equal,
 * an `ALL` route or request, `HEAD` to a `GET` route, or an unknown method; and the path
 * aligns at any level.
 */
function reaches(call: HttpCall, route: RouteNode): boolean {
  const { method } = call;
  const methodOk =
    method === null ||
    method === "ALL" ||
    route.method === "ALL" ||
    method === route.method ||
    (method === "HEAD" && route.method === "GET");
  return methodOk && alignSegments(call.segments, parseRoutePath(route.path)) !== ALIGN.FAIL;
}

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * Head re-resolution (DESIGN.md §8.4): whether `node`, an unresolved node a head edge of
 * `edge.kind` from `source` reaches, is a call that would have resolved to `target` in base.
 */
function stillCalls(
  edge: GraphEdge,
  target: GraphNode,
  source: GraphNode,
  node: UnresolvedNode,
): boolean {
  switch (edge.kind) {
    case "http": {
      if (target.kind !== "route" || node.reason !== "NO_MATCHING_ROUTE") return false;
      const call = parseHttpLabel(node.label);
      return call !== undefined && reaches(call, target);
    }
    case "imports": {
      if (target.kind !== "file" || source.kind !== "file" || node.reason !== "UNKNOWN_SYMBOL") {
        return false;
      }
      return relativeImportTargets(source.path, node.expression)?.includes(target.path) ?? false;
    }
    case "reads":
    case "writes": {
      if (target.kind !== "model" || node.reason !== "UNKNOWN_SYMBOL") return false;
      const parts = node.expression.split(".");
      return parts.length >= 3 && parts[parts.length - 2] === lowerFirst(target.label);
    }
    default:
      return false;
  }
}

/** Why a target no longer answers, in the words shown to the user. */
function explain(
  target: GraphNode,
  replacedBy: readonly RouteNode[],
): Pick<BrokenEdge, "reason" | "detail"> {
  if (target.kind === "route" && replacedBy.length > 0) {
    const now = replacedBy.map((r) => r.label).join(" or ");
    return { reason: "ROUTE_CHANGED", detail: `${target.label} is now ${now}` };
  }
  const what =
    target.kind === "file"
      ? target.path
      : target.kind === "model"
        ? `model ${target.label}`
        : target.label;
  return { reason: "TARGET_REMOVED", detail: `${what} was removed` };
}

/** Append `value` to the list under `key`. */
function add<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

const compareLocations = (a: SourceLocation, b: SourceLocation): number =>
  compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;

/** A call site as a plain location, without the call's own facts. */
const locationOf = ({ file, line, column, endLine }: CallSite): SourceLocation =>
  endLine === undefined ? { file, line, column } : { file, line, column, endLine };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "A", "A and B", "A, B, and C". */
const listWords = (words: readonly string[]): string =>
  words.length <= 2
    ? words.join(" and ")
    : `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1] ?? ""}`;

/**
 * For a base edge whose target survives (`target` in base, `now` in head, `edge` the head
 * edge between the same endpoints): the head sites that the target's change breaks.
 * - `calls` ⇒ symbol: its required argument count rose, and the call passes at least the
 *   old count (it worked) but fewer than the new one (`PARAMETERS_ADDED`).
 * - `reads`/`writes` ⇒ model: a field was removed that the call still names
 *   (`FIELD_REMOVED`).
 */
function contractBreak(
  target: GraphNode,
  now: GraphNode,
  edge: GraphEdge,
): (Pick<BrokenEdge, "reason" | "detail"> & { sites: CallSite[] }) | undefined {
  if (edge.kind === "calls" && target.kind === "symbol" && now.kind === "symbol") {
    const was = target.requiredParams;
    const needs = now.requiredParams;
    if (was === undefined || needs === undefined || needs <= was) return undefined;
    const sites = edge.sites.filter((s) => s.args !== undefined && s.args >= was && s.args < needs);
    if (sites.length === 0) return undefined;
    return {
      reason: "PARAMETERS_ADDED",
      detail: `${now.label} now needs ${plural(needs, "argument")} (was ${was})`,
      sites,
    };
  }
  if ((edge.kind === "reads" || edge.kind === "writes") && target.kind === "model") {
    if (now.kind !== "model") return undefined;
    const kept = new Set(now.fields.map((f) => f.name));
    const removed = new Set(target.fields.map((f) => f.name).filter((name) => !kept.has(name)));
    const named = new Set<string>();
    const sites = edge.sites.filter((s) => {
      const hits = (s.missingFields ?? []).filter((name) => removed.has(name));
      for (const name of hits) named.add(name);
      return hits.length > 0;
    });
    if (sites.length === 0) return undefined;
    const fields = [...named].sort(compareStrings).map((name) => `${now.label}.${name}`);
    return {
      reason: "FIELD_REMOVED",
      detail: `${listWords(fields)} ${fields.length === 1 ? "was" : "were"} removed`,
      sites,
    };
  }
  return undefined;
}

/**
 * Broken connections (DESIGN.md §8 step 4, ADR-0087): base edges whose target is gone
 * from head (removed, not renamed) while their source, or what it was renamed to, still
 * makes the call. "Still makes the call" is decided by re-resolving head's unresolved
 * calls from that source against the base target:
 * - `http` ⇒ route: a `NO_MATCHING_ROUTE` call whose method and path reach the route by the
 *   analyzer's own path grammar. If head has a new route served by the same handler (or
 *   its renamed self), the reason is `ROUTE_CHANGED` ("POST /x is now PUT /x").
 * - `imports` ⇒ file: an `UNKNOWN_SYMBOL` relative specifier naming the file's path.
 * - `reads`/`writes` ⇒ model: an `UNKNOWN_SYMBOL` Prisma call through the model's accessor.
 * Each broken edge lists the head call sites that still make the call.
 *
 * Base edges whose target survives (by ID or rename) are broken when the target's contract
 * changed under a call that still exists in head (ADR-0088):
 * - `calls` ⇒ symbol: `PARAMETERS_ADDED` when the symbol's `requiredParams` rose and a head
 *   site passes at least the old count but fewer than the new one (sites without `args`,
 *   i.e. spreads, are never flagged).
 * - `reads`/`writes` ⇒ model: `FIELD_REMOVED` when a field was dropped from the model and a
 *   head site still names it (its `missingFields`). A renamed field reads as removed.
 *
 * Doesn't handle (no head evidence in the graph): calls to removed functions (unresolved
 * calls make no node), aliased or package imports (`@/x`, `@acme/shared`), clipped URL
 * labels, `renders`/`publishes`/`consumes`/`external_call`/`stores` edges, symbols with no
 * `requiredParams` (JavaScript, overloads, inherited constructors), parameters whose type
 * changed, and model fields whose type changed or became required.
 */
export function detectBroken(
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  renames: ReadonlyMap<string, string>,
): BrokenEdge[] {
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const headNodes = new Map(head.nodes.map((n) => [n.id, n]));
  const renamedTo = new Set(renames.values());
  const gone = (id: string) => !headNodes.has(id) && !renames.has(id);

  const headOut = new Map<string, GraphEdge[]>();
  for (const edge of head.edges) add(headOut, edge.from, edge);

  // Base route ⇒ its handlers; head handler ⇒ routes new in head that it serves.
  const handlersOf = new Map<string, string[]>();
  const newRoutesOf = new Map<string, RouteNode[]>();
  for (const edge of base.edges) {
    if (edge.kind === "handles") add(handlersOf, edge.from, edge.to);
  }
  for (const edge of head.edges) {
    const route = headNodes.get(edge.from);
    if (edge.kind !== "handles" || route?.kind !== "route") continue;
    if (baseNodes.has(route.id) || renamedTo.has(route.id)) continue;
    add(newRoutesOf, edge.to, route);
  }

  const out: BrokenEdge[] = [];
  for (const edge of base.edges) {
    const target = baseNodes.get(edge.to);
    if (target === undefined || target.kind === "unresolved" || !gone(target.id)) continue;
    const from = renames.get(edge.from) ?? edge.from;
    const source = headNodes.get(from);
    if (source === undefined) continue;

    const calls = (headOut.get(from) ?? []).filter((e) => {
      const node = headNodes.get(e.to);
      return (
        e.kind === edge.kind &&
        node?.kind === "unresolved" &&
        stillCalls(edge, target, source, node)
      );
    });
    if (calls.length === 0) continue;

    const replacedBy = new Map<string, RouteNode>();
    for (const handler of handlersOf.get(target.id) ?? []) {
      for (const route of newRoutesOf.get(renames.get(handler) ?? handler) ?? []) {
        replacedBy.set(route.id, route);
      }
    }
    const sites = new Map<string, SourceLocation>();
    for (const site of calls.flatMap((e) => e.sites)) {
      sites.set(`${site.file}:${site.line}:${site.column}`, locationOf(site));
    }
    out.push({
      edge: edge.id,
      from,
      to: target.id,
      ...explain(
        target,
        [...replacedBy.values()].sort((a, b) => compareStrings(a.id, b.id)),
      ),
      sites: [...sites.values()].sort(compareLocations),
    });
  }

  // Targets that survive but changed their contract (ADR-0088).
  const headEdges = new Map(head.edges.map((e) => [e.id, e]));
  for (const edge of base.edges) {
    const target = baseNodes.get(edge.to);
    const from = renames.get(edge.from) ?? edge.from;
    const to = renames.get(edge.to) ?? edge.to;
    const now = headNodes.get(to);
    const still = headEdges.get(edgeId(edge.kind, from, to));
    if (target === undefined || now === undefined || still === undefined) continue;
    const found = contractBreak(target, now, still);
    if (found === undefined) continue;
    out.push({
      edge: edge.id,
      from,
      to: target.id,
      reason: found.reason,
      detail: found.detail,
      sites: found.sites.map(locationOf).sort(compareLocations),
    });
  }
  return out.sort((a, b) => compareStrings(a.edge, b.edge));
}
