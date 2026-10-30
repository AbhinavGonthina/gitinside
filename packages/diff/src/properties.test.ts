import { createHash } from "node:crypto";
import {
  SCHEMA_VERSION,
  SYSTEM_ID,
  compareStrings,
  edgeId,
  nodeId,
  parseGraph,
  stringifyDiff,
  stringifyGraph,
  type AnalysisWarning,
  type ArchitectureGraph,
  type CallSite,
  type EdgeKind,
  type GraphDiff,
  type GraphEdge,
  type GraphNode,
  type UnresolvedReason,
} from "@gitinside/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyDiff, diffGraphs, type FileContents } from "./index.js";

/**
 * Property tests (DESIGN.md §8, TESTING.md): random base/head pairs built from a fixed
 * universe of node "slots", so base and head share most IDs, collide on file contents
 * (renames by hash and by similarity), and drop route/model/import targets that head
 * then calls as unresolved nodes (broken edges).
 *
 * A graph is built from a fixed-length vector of choices, read in an order that doesn't
 * depend on the values, so head is base's vector with some positions replaced: a
 * changed choice changes one fact, not every fact after it.
 */

/** Reads choices in a fixed order. Without a vector it reads zeros, to count them. */
class Choices {
  count = 0;
  constructor(private readonly values?: readonly number[]) {}

  /** A choice in `[0, n)`. */
  pick(n: number): number {
    const value = this.values === undefined ? 0 : this.values[this.count];
    if (value === undefined) throw new Error(`choice ${this.count} is past the vector`);
    this.count++;
    return value % n;
  }

  /** True with probability `percent` / 100. */
  flag(percent: number): boolean {
    return this.pick(100) < percent;
  }

  /** One of `items`. */
  of<T>(items: readonly T[]): T {
    return items[this.pick(items.length)] as T;
  }
}

const SERVICES = ["api", "web"] as const;
const FOLDERS = ["src", "lib"] as const;
const FILE_NAMES = ["a.ts", "b.ts", "c.ts"] as const;
const SYMBOLS = [
  { name: "load", symbolKind: "function" },
  { name: "save", symbolKind: "function" },
  { name: "Store", symbolKind: "class" },
] as const;
/** Route slots: a path and the methods it may be declared with (a changed method is a new ID). */
const ROUTES = [
  ["/users", ["GET", "POST"]],
  ["/users/:id", ["PUT", "DELETE"]],
  ["/orders", ["GET", "POST"]],
] as const;
const MODELS = ["User", "Order"] as const;
const FIELDS = ["id", "name", "total", "email"] as const;
const HTTP_CALLS = ["GET /users", "? /users", "PUT /users/{}", "? /orders"] as const;
const IMPORTS = ["./a", "./b.js", "../lib/c", "../src/a"] as const;
const PRISMA = ["prisma.user.findMany", "prisma.order.create"] as const;
const EDGE_KINDS = ["imports", "calls", "http", "handles", "reads", "writes"] as const;
/** Edge slots' kinds: `calls` three times, since a broken call needs both ends kept. */
const SLOT_KINDS = [...EDGE_KINDS, "calls", "calls"] as const;

interface FileSlot {
  service: string;
  folder: string;
  name: string;
  id: string;
  path: string;
}

const FILE_SLOTS: FileSlot[] = SERVICES.flatMap((service) =>
  FOLDERS.flatMap((folder) =>
    FILE_NAMES.map((name) => ({
      service,
      folder,
      name,
      id: nodeId("file", service, `${folder}/${name}`),
      path: `apps/${service}/${folder}/${name}`,
    })),
  ),
);
const API_FILES = FILE_SLOTS.filter((f) => f.service === "api");

const symbolId = (file: FileSlot, name: string) =>
  nodeId("symbol", file.service, `${file.folder}/${file.name}#${name}`);
const methodId = (file: FileSlot) => `${symbolId(file, "Store")}.get`;
const unresolvedId = (file: FileSlot, line: number) =>
  nodeId("unresolved", file.service, `${file.folder}/${file.name}:${line}:5`);

/** Every ID an edge endpoint can name, per pool; an endpoint absent from a graph drops its edge. */
const SYMBOL_IDS = FILE_SLOTS.flatMap((f) => [
  ...SYMBOLS.map((s) => symbolId(f, s.name)),
  methodId(f),
]);
const routeId = (method: string, path: string) => nodeId("route", "api", `${method} ${path}`);
const ROUTE_IDS = ROUTES.flatMap(([path, methods]) => methods.map((m) => routeId(m, path)));
const MODEL_IDS = MODELS.map((name) => nodeId("model", "api", name));
const HANDLERS = API_FILES.slice(0, 2).flatMap((f) => SYMBOLS.map((s) => symbolId(f, s.name)));

/** `./b` or `../lib/c`: the specifier `fromPath` imports `toPath` by, without `.ts`. */
function specifier(fromPath: string, toPath: string): string {
  const from = fromPath.split("/").slice(0, -1);
  const to = toPath.replace(/\.ts$/, "").split("/");
  let shared = 0;
  while (shared < from.length && from[shared] === to[shared]) shared++;
  const up = from.length - shared;
  return (up === 0 ? "./" : "../".repeat(up)) + to.slice(shared).join("/");
}

/**
 * The unresolved node the analyzer reports for a call of `kind` to `target`, a universe
 * ID missing from the graph: `<METHOD|?> <path>` with holes for a route, the relative
 * specifier for a file, the Prisma accessor for a model. `undefined` for other kinds.
 */
function missedCall(
  kind: EdgeKind,
  target: string,
  fromPath: string,
  knownMethod: boolean,
): { label: string; expression: string; reason: UnresolvedReason } | undefined {
  if (kind === "http") {
    const [, method = "", path = ""] = /^route:api\/(\S+) (\S+)$/.exec(target) ?? [];
    const url = path.replace(/:\w+/g, "{}");
    return {
      label: `${knownMethod ? method : "?"} ${url}`,
      expression: `fetch("${url}")`,
      reason: "NO_MATCHING_ROUTE",
    };
  }
  if (kind === "imports") {
    const file = FILE_SLOTS.find((f) => f.id === target);
    if (file === undefined) return undefined;
    const spec = specifier(fromPath, file.path);
    return { label: spec, expression: spec, reason: "UNKNOWN_SYMBOL" };
  }
  if (kind === "reads" || kind === "writes") {
    const model = MODELS[MODEL_IDS.indexOf(target)] ?? "";
    const expression = `prisma.${model.charAt(0).toLowerCase()}${model.slice(1)}.findMany`;
    return { label: expression, expression, reason: "UNKNOWN_SYMBOL" };
  }
  return undefined;
}

/** Twelve lines per template: same template ⇒ similar files, other template ⇒ different. */
const TEMPLATES = [0, 1, 2].map(
  (t) =>
    Array.from(
      { length: 12 },
      (_, i) =>
        `export function step${t}_${i}(input: number) { return input * ${i + t} + offset${t}; }`,
    ).join("\n") + "\n",
);
const EDITS = [
  "",
  "export const extra = 1;\n",
  "function tweak(x: number) {\n  return x + 1;\n}\n",
];

/** A graph and the file texts it was built from. */
interface Built {
  graph: ArchitectureGraph;
  texts: Map<string, string>;
}

/** Build a valid graph from `c`, reading the same number of choices whatever their values. */
function build(c: Choices, sha: string): Built {
  const nodes: GraphNode[] = [
    { id: SYSTEM_ID, kind: "system", label: "acme/shop", parentId: null },
  ];
  const present = new Set<string>([SYSTEM_ID]);
  const add = (node: GraphNode, keep: boolean) => {
    if (!keep || node.parentId === null || !present.has(node.parentId)) return;
    nodes.push(node);
    present.add(node.id);
  };
  const texts = new Map<string, string>();
  /** The graph's unresolved calls by what they call, for edges whose target is missing. */
  const unresolved: Record<"http" | "imports" | "prisma", GraphNode[]> = {
    http: [],
    imports: [],
    prisma: [],
  };

  for (const service of SERVICES) {
    const keep = service === "api" || c.flag(80);
    const framework = c.of([undefined, "express"]);
    add(
      {
        id: nodeId("service", service, ""),
        kind: "service",
        label: service,
        parentId: SYSTEM_ID,
        root: `apps/${service}`,
        ...(framework === undefined ? {} : { framework }),
      },
      keep,
    );
  }

  const files = FILE_SLOTS.map((slot) => ({
    slot,
    keep: c.flag(75),
    text: (TEMPLATES[c.pick(TEMPLATES.length)] ?? "") + (EDITS[c.pick(EDITS.length)] ?? ""),
  }));
  for (const service of SERVICES) {
    for (const folder of FOLDERS) {
      add(
        {
          id: nodeId("module", service, folder),
          kind: "module",
          label: folder,
          parentId: nodeId("service", service, ""),
          path: `apps/${service}/${folder}`,
        },
        files.some((f) => f.keep && f.slot.service === service && f.slot.folder === folder),
      );
    }
  }

  for (const { slot, keep, text } of files) {
    add(
      {
        id: slot.id,
        kind: "file",
        label: slot.name,
        parentId: nodeId("module", slot.service, slot.folder),
        path: slot.path,
        hash: createHash("sha256").update(text).digest("hex"),
      },
      keep,
    );
    if (present.has(slot.id)) texts.set(slot.path, text);

    SYMBOLS.forEach(({ name, symbolKind }, i) => {
      const keepSymbol = c.flag(70);
      const requiredParams = c.of([undefined, 0, 1, 2]);
      const line = 1 + 4 * i + c.pick(3);
      const exported = c.flag(50);
      add(
        {
          id: symbolId(slot, name),
          kind: "symbol",
          label: name,
          parentId: slot.id,
          symbolKind,
          exported,
          ...(requiredParams === undefined ? {} : { requiredParams }),
          source: { file: slot.path, line, column: 1, endLine: line + 1 },
        },
        keepSymbol,
      );
    });
    const keepMethod = c.flag(50);
    const methodParams = c.of([undefined, 0, 1, 2]);
    add(
      {
        id: methodId(slot),
        kind: "symbol",
        label: "get",
        parentId: symbolId(slot, "Store"),
        symbolKind: "method",
        exported: false,
        ...(methodParams === undefined ? {} : { requiredParams: methodParams }),
        source: { file: slot.path, line: 10, column: 3 },
      },
      keepMethod,
    );

    const keepCall = c.flag(65);
    const callKind = c.pick(3);
    const variant = c.pick(4);
    const line = 14 + c.pick(3);
    const id = unresolvedId(slot, line);
    const source = { file: slot.path, line, column: 5 };
    const call: GraphNode =
      callKind === 0
        ? {
            id,
            kind: "unresolved",
            label: HTTP_CALLS[variant] ?? "GET /users",
            parentId: slot.id,
            reason: "NO_MATCHING_ROUTE",
            expression: "fetch(url)",
            source,
          }
        : callKind === 1
          ? {
              id,
              kind: "unresolved",
              label: IMPORTS[variant] ?? "./a",
              parentId: slot.id,
              reason: "UNKNOWN_SYMBOL",
              expression: IMPORTS[variant] ?? "./a",
              source,
            }
          : {
              id,
              kind: "unresolved",
              label: PRISMA[variant % 2] ?? "prisma.user.findMany",
              parentId: slot.id,
              reason: "UNKNOWN_SYMBOL",
              expression: PRISMA[variant % 2] ?? "prisma.user.findMany",
              source,
            };
    add(call, keepCall);
    if (present.has(id))
      unresolved[(["http", "imports", "prisma"] as const)[callKind] ?? "http"].push(call);
  }

  /** Route ID ⇒ the symbol that serves it, from a small pool so routes share handlers. */
  const handlers = new Map<string, string>();
  for (const [path, methods] of ROUTES) {
    const keep = c.flag(70);
    const method = c.of(methods);
    const parent = API_FILES[c.pick(API_FILES.length)];
    const handler = HANDLERS[c.pick(HANDLERS.length)];
    if (parent === undefined || handler === undefined) continue;
    handlers.set(routeId(method, path), handler);
    add(
      {
        id: routeId(method, path),
        kind: "route",
        label: `${method} ${path}`,
        parentId: parent.id,
        method,
        path,
      },
      keep,
    );
  }

  MODELS.forEach((name, i) => {
    const keep = c.flag(65);
    const fields = FIELDS.map((field) => ({
      keep: c.flag(60),
      type: c.of(["String", "Int"]),
      optional: c.flag(30),
      name: field,
    }));
    add(
      {
        id: MODEL_IDS[i] ?? "",
        kind: "model",
        label: name,
        parentId: nodeId("service", "api", ""),
        fields: fields
          .filter((f) => f.keep)
          .map(({ name, type, optional }) => ({ name, type, optional })),
      },
      keep,
    );
  });

  const fileIds = FILE_SLOTS.map((f) => f.id);
  const pools: Record<(typeof EDGE_KINDS)[number], [string[], string[]]> = {
    imports: [fileIds, fileIds],
    calls: [SYMBOL_IDS, SYMBOL_IDS],
    http: [SYMBOL_IDS, ROUTE_IDS],
    handles: [ROUTE_IDS, SYMBOL_IDS],
    reads: [SYMBOL_IDS, MODEL_IDS],
    writes: [SYMBOL_IDS, MODEL_IDS],
  };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const fileOf = (node: GraphNode): string => {
    if (node.kind === "file") return node.path;
    if (node.source !== undefined) return node.source.file;
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    return parent === undefined ? "unknown.ts" : fileOf(parent);
  };
  const fileNodeOf = (node: GraphNode): Extract<GraphNode, { kind: "file" }> | undefined => {
    if (node.kind === "file") return node;
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    return parent === undefined ? undefined : fileNodeOf(parent);
  };

  const edges = new Map<string, GraphEdge>();
  for (const [route, handler] of handlers) {
    if (!present.has(route) || !present.has(handler)) continue;
    const id = edgeId("handles", route, handler);
    edges.set(id, {
      id,
      kind: "handles",
      from: route,
      to: handler,
      confidence: "exact",
      sites: [],
    });
  }
  for (let slot = 0; slot < 60; slot++) {
    const kind: EdgeKind = c.of(SLOT_KINDS);
    const [froms, tos] = pools[kind];
    const fromId = froms[c.pick(froms.length)] ?? "";
    const toPick = tos[c.pick(tos.length)] ?? "";
    // A target missing from this graph: mostly (`derive`) the call becomes an unresolved
    // node naming that target, as the analyzer reports a call to a removed route, file,
    // or model; otherwise one of the graph's unresolved calls of its kind, which may not
    // name it. Calls to removed functions and `handles` edges make no unresolved node.
    const derive = c.flag(70);
    const knownMethod = c.flag(70);
    const category = {
      http: "http",
      imports: "imports",
      reads: "prisma",
      writes: "prisma",
    } as const;
    const fallbackPick = c.pick(1000);
    const fallbacks = kind in category ? unresolved[category[kind as keyof typeof category]] : [];
    const fallback = fallbacks[fallbackPick % Math.max(fallbacks.length, 1)];
    const confidence = c.of(["exact", "pattern", "heuristic"] as const);
    const label = c.of([undefined, "load()"]);
    const fieldNames = FIELDS.filter(() => c.flag(40));
    const siteCount = c.pick(3);
    const sites: CallSite[] = [];
    for (let s = 0; s < 2; s++) {
      const line = 20 + 10 * s + c.pick(10);
      const args = c.of([undefined, 0, 1, 2]);
      const missing = FIELDS.filter(() => c.flag(25));
      if (s >= siteCount) continue;
      sites.push({
        file: "",
        line,
        column: 1,
        ...(kind === "calls" && args !== undefined ? { args } : {}),
        ...((kind === "reads" || kind === "writes") && missing.length > 0
          ? { missingFields: [...missing].sort(compareStrings) }
          : {}),
      });
    }

    const from = byId.get(fromId);
    if (from === undefined) continue;
    let to = byId.get(toPick);
    let reason: UnresolvedReason | undefined;
    const file = fileNodeOf(from);
    const missed =
      file === undefined ? undefined : missedCall(kind, toPick, file.path, knownMethod);
    if (to === undefined && derive && file !== undefined && missed !== undefined) {
      // At the call site: a slot of its own (column), so no other edge shares the node.
      const [service = "", ...rest] = file.id.slice("file:".length).split("/");
      const line = sites[0]?.line ?? 19;
      to = {
        id: nodeId("unresolved", service, `${rest.join("/")}:${line}:${9 + slot}`),
        kind: "unresolved",
        parentId: file.id,
        ...missed,
        source: { file: file.path, line, column: 9 + slot },
      };
      nodes.push(to);
      byId.set(to.id, to);
      reason = missed.reason;
    } else if (to === undefined && fallback?.kind === "unresolved") {
      to = fallback;
      reason = fallback.reason;
    }
    if (to === undefined) continue;
    const id = edgeId(kind, from.id, to.id);
    if (edges.has(id)) continue;
    const sitesFile = fileOf(from);
    edges.set(id, {
      id,
      kind,
      from: from.id,
      to: to.id,
      confidence: reason === undefined ? confidence : "unresolved",
      ...(label === undefined ? {} : { label }),
      ...(reason === undefined ? {} : { reason }),
      ...((kind === "reads" || kind === "writes") && reason === undefined
        ? { fields: [...fieldNames].sort(compareStrings) }
        : {}),
      sites: sites.map((site) => ({ ...site, file: sitesFile })),
    });
  }

  const warnings: AnalysisWarning[] = [];
  for (let w = 0; w < 4; w++) {
    const keep = c.flag(35);
    const code = c.of(["PARSE_ERROR", "SKIPPED_LARGE_FILE"]);
    const file = c.of([undefined, "apps/api/src/a.ts", "apps/web/lib/b.ts"]);
    if (keep)
      warnings.push({ code, message: `warning ${code}`, ...(file === undefined ? {} : { file }) });
  }

  return {
    graph: parseGraph({
      schemaVersion: SCHEMA_VERSION,
      repo: { owner: "acme", name: "shop", sha },
      analyzerVersion: "0.1.0",
      nodes,
      edges: [...edges.values()],
      warnings,
    }),
    texts,
  };
}

/** How many choices `build` reads. */
const LENGTH = (() => {
  const counter = new Choices();
  build(counter, "0000000");
  return counter.count;
})();

const vector = fc.array(fc.nat(9_999), { minLength: LENGTH, maxLength: LENGTH });

/** One graph. */
const graphArb = vector.map((values) => build(new Choices(values), "a1b2c3d"));

/**
 * A base/head pair: head reads base's choices with a share of them (5%, 15%, or 30%)
 * replaced, and the diff gets the file texts or not.
 */
const pairArb = fc
  .record({
    base: vector,
    alt: vector,
    mask: vector,
    rate: fc.constantFrom(5, 15, 30),
    withContents: fc.boolean(),
  })
  .map(({ base, alt, mask, rate, withContents }) => {
    const head = base.map((v, i) => ((mask[i] ?? 0) % 100 < rate ? (alt[i] ?? v) : v));
    const before = build(new Choices(base), "a1b2c3d");
    const after = build(new Choices(head), "e4f5a6b");
    const contents: FileContents | undefined = withContents
      ? { base: (p) => before.texts.get(p), head: (p) => after.texts.get(p) }
      : undefined;
    return { base: before.graph, head: after.graph, contents };
  });

const options = (contents: FileContents | undefined) =>
  contents === undefined ? {} : { contents };

/** Fixed seed, so a run is reproducible and the reachability check sees the same pairs. */
const RUNS = { numRuns: 300, seed: 20261029 };

const ids = (list: readonly { id: string }[]) => list.map((r) => r.id).sort(compareStrings);
const sorted = (list: readonly string[]) => [...list].sort(compareStrings);

/** Renames as sorted `from => to` strings; `flip` reads them backwards. */
const pairs = (list: readonly { from: string; to: string }[]) =>
  list.map(({ from, to }) => `${from} => ${to}`).sort(compareStrings);
const renamedNodes = (d: GraphDiff, flip = false) =>
  pairs(
    d.nodes.renamed.map((r) =>
      flip ? { from: r.node.id, to: r.from } : { from: r.from, to: r.node.id },
    ),
  );
const renamedEdges = (d: GraphDiff, flip = false) =>
  pairs(
    d.edges.renamed.map((r) =>
      flip ? { from: r.edge.id, to: r.from } : { from: r.from, to: r.edge.id },
    ),
  );

const reversed = (g: ArchitectureGraph): ArchitectureGraph => ({
  ...g,
  nodes: [...g.nodes].reverse(),
  edges: g.edges.map((e) => ({ ...e, sites: [...e.sites].reverse() })).reverse(),
  warnings: [...g.warnings].reverse(),
});

// 300 diffs per property take a few seconds, more under coverage on a loaded machine.
describe("diff properties (fast-check)", { timeout: 60_000 }, () => {
  // Guards against vacuous properties: the pairs below must include each case at least once.
  it("the generator reaches renames, broken edges of every reason, and warnings", () => {
    const counts = new Map<string, number>();
    const seen = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);
    for (const { base, head, contents } of fc.sample(pairArb, RUNS)) {
      const d = diffGraphs(base, head, options(contents));
      if (d.nodes.renamed.length > 0) seen(contents === undefined ? "rename" : "rename+contents");
      if (d.edges.renamed.length > 0) seen("edge rename");
      if (d.nodes.modified.length > 0) seen("modified");
      if (d.nodes.updated.length > 0) seen("updated");
      if (d.warnings.added.length > 0) seen("warning");
      for (const reason of new Set(d.broken.map((b) => b.reason))) seen(reason);
    }
    expect([...counts.keys()].sort(compareStrings)).toEqual(
      [
        "FIELD_REMOVED",
        "PARAMETERS_ADDED",
        "ROUTE_CHANGED",
        "TARGET_REMOVED",
        "edge rename",
        "modified",
        "rename",
        "rename+contents",
        "updated",
        "warning",
      ].sort(compareStrings),
    );
  });

  it("diff(g, g) is empty", () => {
    fc.assert(
      fc.property(graphArb, fc.boolean(), ({ graph, texts }, withContents) => {
        const read = (p: string) => texts.get(p);
        const d = diffGraphs(
          graph,
          graph,
          withContents ? { contents: { base: read, head: read } } : {},
        );
        const empty = { added: [], removed: [], modified: [], updated: [], renamed: [] };
        expect(d.nodes).toEqual(empty);
        expect(d.edges).toEqual(empty);
        expect(d.broken).toEqual([]);
        expect(d.warnings).toEqual({ added: [], removed: [] });
      }),
      RUNS,
    );
  });

  it("apply(base, diff(base, head)) equals head", () => {
    fc.assert(
      fc.property(pairArb, ({ base, head, contents }) => {
        const d = diffGraphs(base, head, options(contents));
        expect(stringifyGraph(applyDiff(base, d))).toBe(stringifyGraph(head));
      }),
      RUNS,
    );
  });

  it("added(diff(a, b)) equals removed(diff(b, a)), and renames invert", () => {
    fc.assert(
      fc.property(pairArb, ({ base, head, contents }) => {
        const flipped =
          contents === undefined ? undefined : { base: contents.head, head: contents.base };
        const forward = diffGraphs(base, head, options(contents));
        const backward = diffGraphs(head, base, options(flipped));
        expect(ids(forward.nodes.added)).toEqual(sorted(backward.nodes.removed));
        expect(sorted(forward.nodes.removed)).toEqual(ids(backward.nodes.added));
        expect(ids(forward.edges.added)).toEqual(sorted(backward.edges.removed));
        expect(sorted(forward.edges.removed)).toEqual(ids(backward.edges.added));
        expect(renamedNodes(forward)).toEqual(renamedNodes(backward, true));
        expect(renamedEdges(forward)).toEqual(renamedEdges(backward, true));
        expect(forward.warnings.added).toEqual(backward.warnings.removed);
        expect(forward.warnings.removed).toEqual(backward.warnings.added);
      }),
      RUNS,
    );
  });

  it("broken edges never point to nodes that exist unchanged in head", () => {
    fc.assert(
      fc.property(pairArb, ({ base, head, contents }) => {
        const d = diffGraphs(base, head, options(contents));
        const baseEdges = new Map(base.edges.map((e) => [e.id, e]));
        const headIds = new Set(head.nodes.map((n) => n.id));
        const modified = new Set(d.nodes.modified.map((m) => m.node.id));
        const gone = new Set([...d.nodes.removed, ...d.nodes.renamed.map((r) => r.from)]);
        for (const broken of d.broken) {
          expect(baseEdges.get(broken.edge)?.to).toBe(broken.to);
          expect(headIds.has(broken.from)).toBe(true);
          if (headIds.has(broken.to)) expect(modified.has(broken.to)).toBe(true);
          else expect(gone.has(broken.to)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("the diff doesn't depend on input order", () => {
    fc.assert(
      fc.property(pairArb, ({ base, head, contents }) => {
        expect(stringifyDiff(diffGraphs(reversed(base), reversed(head), options(contents)))).toBe(
          stringifyDiff(diffGraphs(base, head, options(contents))),
        );
      }),
      RUNS,
    );
  });
});
