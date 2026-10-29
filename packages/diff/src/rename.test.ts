import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  SYSTEM_ID,
  canonicalize,
  compareStrings,
  edgeId,
  nodeId,
  parseGraph,
  stringifyGraph,
  type ArchitectureGraph,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import {
  applyDiff,
  diffGraphs,
  RENAME_THRESHOLDS,
  similarity,
  tokenize,
  type FileContents,
} from "./index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

const golden = (name: string) =>
  parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));
const fromDisk = (name: string) => (path: string) => {
  try {
    return readFileSync(join(FIXTURES, name, path), "utf8");
  } catch {
    return undefined;
  }
};

/** A body of about 60 tokens, distinct per `seed`. */
const code = (seed: string, extra = "") =>
  [
    `export function handle${seed}(input: string[]): number {`,
    `  const seen = new Set<string>();`,
    `  for (const item of input) if (item.startsWith("${seed}")) seen.add(item.trim());`,
    `  const total = [...seen].reduce((sum, item) => sum + item.length * ${seed.length}, 0);`,
    extra,
    `  return total > 100 ? total - 100 : total;`,
    `}`,
  ].join("\n");

const svc = nodeId("service", "api", "");
const system: GraphNode = { id: SYSTEM_ID, kind: "system", label: "acme/shop", parentId: null };
const service: GraphNode = {
  id: svc,
  kind: "service",
  label: "api",
  parentId: SYSTEM_ID,
  root: "",
};
const hashOf = (text: string) => {
  // Not SHA-256, but distinct per text, which is all the diff compares.
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8);
};
const file = (path: string, text: string, parentId = svc): GraphNode => ({
  id: nodeId("file", "api", path),
  kind: "file",
  label: path.slice(path.lastIndexOf("/") + 1),
  parentId,
  path,
  hash: hashOf(text),
});
const moduleNode = (path: string): GraphNode => ({
  id: nodeId("module", "api", path),
  kind: "module",
  label: path.slice(path.lastIndexOf("/") + 1),
  parentId: svc,
  path,
});
const fn = (
  path: string,
  name: string,
  line: number,
  endLine: number,
): Extract<GraphNode, { kind: "symbol" }> => ({
  id: nodeId("symbol", "api", `${path}#${name}`),
  kind: "symbol",
  label: name,
  parentId: nodeId("file", "api", path),
  symbolKind: "function",
  exported: true,
  source: { file: path, line, column: 1, endLine },
});
const graph = (sha: string, nodes: GraphNode[], edges: GraphEdge[] = []): ArchitectureGraph => ({
  schemaVersion: SCHEMA_VERSION,
  repo: { owner: "acme", name: "shop", sha },
  analyzerVersion: "0.1.0",
  nodes: [system, service, ...nodes],
  edges,
  warnings: [],
});
const contentsOf = (base: Record<string, string>, head: Record<string, string>): FileContents => ({
  base: (path) => base[path],
  head: (path) => head[path],
});
const renamedIds = (diff: ReturnType<typeof diffGraphs>) =>
  diff.nodes.renamed.map((r) => [r.from, r.node.id]);

describe("rename detection on the diff-rename fixture pair", () => {
  const base = golden("diff-rename-base");
  const head = golden("diff-rename-head");
  const diff = diffGraphs(base, head, {
    contents: { base: fromDisk("diff-rename-base"), head: fromDisk("diff-rename-head") },
  });

  it("finds the moved file, its folder, its symbols and unresolved call, and the renamed function", () => {
    const sym = (q: string) => `symbol:diff-rename/${q}`;
    expect(renamedIds(diff)).toEqual([
      ["file:diff-rename/src/routes/orders.ts", "file:diff-rename/src/orders/routes.ts"],
      ["module:diff-rename/src/routes", "module:diff-rename/src/orders"],
      [sym("src/routes/orders.ts#createOrder"), sym("src/orders/routes.ts#createOrder")],
      [sym("src/routes/orders.ts#listOrders"), sym("src/orders/routes.ts#listOrders")],
      [sym("src/routes/orders.ts#orders"), sym("src/orders/routes.ts#orders")],
      [sym("src/util/format.ts#formatTotal"), sym("src/util/format.ts#formatAmount")],
      [
        "unresolved:diff-rename/src/routes/orders.ts:15:9",
        "unresolved:diff-rename/src/orders/routes.ts:16:9",
      ],
    ]);
    expect(diff.nodes.added).toEqual([]);
    expect(diff.nodes.removed).toEqual([]);
    expect(diff.nodes.renamed[0]!.changes).toEqual(["hash", "label", "parentId", "path"]);
  });

  it("renames every edge with its endpoints instead of removing and adding it", () => {
    expect(diff.edges.added).toEqual([]);
    expect(diff.edges.removed).toEqual([]);
    expect(diff.edges.renamed).toHaveLength(base.edges.length);
    expect(diff.summary.edges.renamed).toBe(6);
  });

  it("counts routes that followed their moved file as updated, not modified", () => {
    const routes = diff.nodes.updated.filter((c) => c.node.kind === "route");
    expect(routes.map((c) => [c.node.id, c.changes])).toEqual([
      ["route:diff-rename/GET /api/orders", ["parentId", "source"]],
      ["route:diff-rename/POST /api/orders", ["parentId", "source"]],
    ]);
    expect(diff.nodes.modified.map((c) => c.node.id)).toEqual([
      "file:diff-rename/src/app.ts",
      "file:diff-rename/src/util/format.ts",
    ]);
  });

  it("still rebuilds head with applyDiff", () => {
    expect(stringifyGraph(applyDiff(base, diff))).toBe(stringifyGraph(head));
  });

  it("without contents, reports the edited file as removed + added", () => {
    const blind = diffGraphs(base, head);
    expect(blind.nodes.renamed).toEqual([]);
    expect(blind.nodes.removed).toContain("file:diff-rename/src/routes/orders.ts");
    expect(stringifyGraph(applyDiff(base, blind))).toBe(stringifyGraph(head));
  });
});

describe("rename detection rules", () => {
  it("matches an unchanged file by its hash alone, and its symbols by name", () => {
    const text = code("A");
    const before = graph("a1b2c3f", [file("src/a.ts", text), fn("src/a.ts", "handleA", 1, 7)]);
    const after = graph("d4e5f60", [file("lib/a.ts", text), fn("lib/a.ts", "handleA", 1, 7)]);
    expect(renamedIds(diffGraphs(before, after))).toEqual([
      [nodeId("file", "api", "src/a.ts"), nodeId("file", "api", "lib/a.ts")],
      [nodeId("symbol", "api", "src/a.ts#handleA"), nodeId("symbol", "api", "lib/a.ts#handleA")],
    ]);
  });

  it("leaves a tie unmatched rather than guessing", () => {
    const text = code("A");
    const before = graph("a1b2c3f", [file("src/a.ts", text), file("src/b.ts", text)]);
    const after = graph("d4e5f60", [file("lib/c.ts", text), file("lib/d.ts", text)]);
    const diff = diffGraphs(before, after);
    expect(diff.nodes.renamed).toEqual([]);
    expect(diff.summary.nodes).toMatchObject({ removed: 2, added: 2 });

    // A shared base name breaks the tie, which leaves one candidate for the other file.
    const named = graph("d4e5f60", [file("lib/a.ts", text), file("lib/d.ts", text)]);
    expect(renamedIds(diffGraphs(before, named))).toEqual([
      [nodeId("file", "api", "src/a.ts"), nodeId("file", "api", "lib/a.ts")],
      [nodeId("file", "api", "src/b.ts"), nodeId("file", "api", "lib/d.ts")],
    ]);

    // Three removed and two added: still ambiguous for every pair.
    const three = graph("a1b2c3f", [...before.nodes.slice(2), file("src/e.ts", text)]);
    expect(diffGraphs(three, after).nodes.renamed).toEqual([]);
  });

  it("matches an edited file only above the similarity threshold, best score first", () => {
    const original = code("A");
    const edited = code("A", "  if (total === 0) return -1;");
    const unrelated = code("Zebra").replaceAll("seen", "names").replaceAll("total", "count");
    expect(similarity(original, edited)).toBeGreaterThanOrEqual(RENAME_THRESHOLDS.fileSimilarity);
    expect(similarity(original, unrelated)).toBeLessThan(RENAME_THRESHOLDS.fileSimilarity);

    const before = graph("a1b2c3f", [file("src/a.ts", original)]);
    const after = graph("d4e5f60", [file("lib/x.ts", unrelated), file("lib/y.ts", edited)]);
    const contents = contentsOf(
      { "src/a.ts": original },
      { "lib/x.ts": unrelated, "lib/y.ts": edited },
    );
    expect(renamedIds(diffGraphs(before, after, { contents }))).toEqual([
      [nodeId("file", "api", "src/a.ts"), nodeId("file", "api", "lib/y.ts")],
    ]);
  });

  it("never scores files under the token floor, so short edited files stay removed + added", () => {
    const short = "export const a = 1;";
    expect(tokenize(short).length).toBeLessThan(RENAME_THRESHOLDS.minFileTokens);
    const before = graph("a1b2c3f", [file("src/a.ts", short)]);
    const after = graph("d4e5f60", [file("lib/a.ts", short.replace("1", "2"))]);
    const contents = contentsOf({ "src/a.ts": short }, { "lib/a.ts": short.replace("1", "2") });
    expect(diffGraphs(before, after, { contents }).nodes.renamed).toEqual([]);
  });

  it("tokenizes without whitespace, so reformatting doesn't lower the score", () => {
    expect(tokenize("const  x=foo(1.5,\n\t y);")).toEqual([
      "const",
      "x",
      "=",
      "foo",
      "(",
      "1.5",
      ",",
      "y",
      ")",
      ";",
    ]);
    expect(similarity(code("A"), code("A").replaceAll("\n", "\n\n  "))).toBe(1);
  });

  it("drops a same-name symbol whose body was rewritten, even though its file moved", () => {
    const rewritten = [
      "export function handleA(input: string[]): number {",
      "  let longest = 0;",
      "  for (let i = 0; i < input.length; i++) longest = Math.max(longest, input[i]!.length);",
      "  console.log('longest entry', longest, 'of', input.length, 'entries');",
      "  return longest;",
      "",
      "}",
    ].join("\n");
    const rest = [code("B"), code("C"), code("D")].join("\n\n");
    const before = `${code("A")}\n\n${rest}`;
    const after = `${rewritten}\n\n${rest}`;
    expect(similarity(before, after)).toBeGreaterThanOrEqual(RENAME_THRESHOLDS.fileSimilarity);
    const contents = contentsOf({ "src/a.ts": before }, { "lib/a.ts": after });
    const diff = diffGraphs(
      graph("a1b2c3f", [file("src/a.ts", before), fn("src/a.ts", "handleA", 1, 7)]),
      graph("d4e5f60", [file("lib/a.ts", after), fn("lib/a.ts", "handleA", 1, 7)]),
      { contents },
    );
    expect(renamedIds(diff)).toEqual([
      [nodeId("file", "api", "src/a.ts"), nodeId("file", "api", "lib/a.ts")],
    ]);
    expect(diff.nodes.removed).toEqual([nodeId("symbol", "api", "src/a.ts#handleA")]);
  });

  it("matches a function moved to another file by its body, its own name masked", () => {
    const body = code("A");
    const moved = body.replace("handleA", "handleInput");
    const before = graph("a1b2c3f", [
      file("src/a.ts", body),
      fn("src/a.ts", "handleA", 1, 7),
      file("src/b.ts", "export {};"),
    ]);
    const after = graph("d4e5f60", [
      file("src/a.ts", "export {};\n"),
      file("src/b.ts", moved),
      fn("src/b.ts", "handleInput", 1, 7),
    ]);
    const contents = contentsOf(
      { "src/a.ts": body, "src/b.ts": "export {};" },
      { "src/a.ts": "export {};\n", "src/b.ts": moved },
    );
    expect(renamedIds(diffGraphs(before, after, { contents }))).toEqual([
      [
        nodeId("symbol", "api", "src/a.ts#handleA"),
        nodeId("symbol", "api", "src/b.ts#handleInput"),
      ],
    ]);
  });

  it("moves a class's methods with the class", () => {
    const text = [
      "export class Cart {",
      "  total(items: number[]): number {",
      "    return items.reduce((sum, price) => sum + price, 0);",
      "  }",
      "}",
    ].join("\n");
    const cls = (path: string, name: string): GraphNode[] => [
      { ...fn(path, name, 1, 5), symbolKind: "class" },
      {
        ...fn(path, `${name}.total`, 2, 4),
        label: "total",
        symbolKind: "method",
        parentId: nodeId("symbol", "api", `${path}#${name}`),
      },
    ];
    const before = graph("a1b2c3f", [file("src/cart.ts", text), ...cls("src/cart.ts", "Cart")]);
    const after = graph("d4e5f60", [file("src/basket.ts", text), ...cls("src/basket.ts", "Cart")]);
    expect(renamedIds(diffGraphs(before, after)).map(([, to]) => to)).toEqual([
      nodeId("file", "api", "src/basket.ts"),
      nodeId("symbol", "api", "src/basket.ts#Cart"),
      nodeId("symbol", "api", "src/basket.ts#Cart.total"),
    ]);
  });

  it("moves a folder only when most of its files moved into one new folder", () => {
    const [a, b, c] = [code("A"), code("B"), code("C")];
    const inFolder = (dir: string, name: string, text: string) =>
      file(`${dir}/${name}`, text, nodeId("module", "api", dir));
    const before = graph("a1b2c3f", [
      moduleNode("src/util"),
      inFolder("src/util", "a.ts", a),
      inFolder("src/util", "b.ts", b),
      inFolder("src/util", "c.ts", c),
    ]);
    const all = graph("d4e5f60", [
      moduleNode("src/lib"),
      inFolder("src/lib", "a.ts", a),
      inFolder("src/lib", "b.ts", b),
      inFolder("src/lib", "c.ts", c),
    ]);
    expect(renamedIds(diffGraphs(before, all))).toContainEqual([
      nodeId("module", "api", "src/util"),
      nodeId("module", "api", "src/lib"),
    ]);

    const split = graph("d4e5f60", [
      moduleNode("src/lib"),
      moduleNode("src/old"),
      inFolder("src/lib", "a.ts", a),
      inFolder("src/old", "b.ts", b),
      inFolder("src/old", "c.ts", c),
    ]);
    const kinds = diffGraphs(before, split).nodes.renamed.map((r) => r.node.kind);
    expect(kinds).toEqual(["file", "file", "file", "module"]);
    expect(diffGraphs(before, split).nodes.renamed.at(-1)!.node.id).toBe(
      nodeId("module", "api", "src/old"),
    );
  });

  it("pairs unresolved calls in order, and only when both sides have as many", () => {
    const call = (path: string, line: number): GraphNode => ({
      id: nodeId("unresolved", "api", `${path}:${line}:3`),
      kind: "unresolved",
      label: "GET {}",
      parentId: svc,
      reason: "DYNAMIC_URL",
      expression: "fetch(url)",
      source: { file: path, line, column: 3 },
    });
    const text = "export {};";
    const before = graph("a1b2c3f", [
      file("src/a.ts", text),
      call("src/a.ts", 4),
      call("src/a.ts", 9),
    ]);
    const shifted = graph("d4e5f60", [
      file("src/a.ts", text),
      call("src/a.ts", 6),
      call("src/a.ts", 11),
    ]);
    // Listed by head ID, so `:11:` sorts before `:6:`.
    expect(renamedIds(diffGraphs(before, shifted))).toEqual([
      [call("src/a.ts", 9).id, call("src/a.ts", 11).id],
      [call("src/a.ts", 4).id, call("src/a.ts", 6).id],
    ]);

    const oneLeft = graph("d4e5f60", [file("src/a.ts", text), call("src/a.ts", 6)]);
    expect(diffGraphs(before, oneLeft).nodes.renamed).toEqual([]);
  });

  it("compares only same-name files past the pair budget, but still matches identical ones", () => {
    const original = code("A");
    const edited = code("A", "  if (total === 0) return -1;");
    const same = code("S");
    const filler = (side: string, n: number) =>
      Array.from({ length: n }, (_, i) => file(`${side}/f${i}.ts`, `${side}${i}`));
    const side = Math.ceil(Math.sqrt(RENAME_THRESHOLDS.maxFilePairs)) + 1;
    const before = graph("a1b2c3f", [
      file("src/a.ts", original),
      file("src/s.ts", same),
      ...filler("old", side),
    ]);
    const after = graph("d4e5f60", [
      file("lib/y.ts", edited),
      file("lib/s2.ts", same),
      ...filler("new", side),
    ]);
    const contents = contentsOf({ "src/a.ts": original }, { "lib/y.ts": edited });
    expect(renamedIds(diffGraphs(before, after, { contents }))).toEqual([
      [nodeId("file", "api", "src/s.ts"), nodeId("file", "api", "lib/s2.ts")],
    ]);
  });

  it("is deterministic and leaves the rename map one-to-one", () => {
    const base = golden("diff-rename-base");
    const head = golden("diff-rename-head");
    const contents = { base: fromDisk("diff-rename-base"), head: fromDisk("diff-rename-head") };
    const shuffled = {
      ...head,
      nodes: [...head.nodes].reverse(),
      edges: [...head.edges].reverse(),
    };
    const one = diffGraphs(base, head, { contents });
    expect(diffGraphs(canonicalize(base), shuffled, { contents })).toEqual(one);
    const targets = one.nodes.renamed.map((r) => r.node.id);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("maps edges through renamed endpoints", () => {
    const text = code("A");
    const from = (path: string) => nodeId("file", "api", path);
    const edge = (a: string, b: string): GraphEdge => ({
      id: edgeId("imports", from(a), from(b)),
      kind: "imports",
      from: from(a),
      to: from(b),
      confidence: "exact",
      sites: [{ file: a, line: 1, column: 1 }],
    });
    const before = graph(
      "a1b2c3f",
      [file("src/main.ts", "main"), file("src/a.ts", text)],
      [edge("src/main.ts", "src/a.ts")],
    );
    const after = graph(
      "d4e5f60",
      [file("src/main.ts", "main2"), file("lib/a.ts", text)],
      [edge("src/main.ts", "lib/a.ts")],
    );
    const diff = diffGraphs(before, after);
    expect(diff.edges.renamed).toEqual([
      {
        from: edge("src/main.ts", "src/a.ts").id,
        edge: edge("src/main.ts", "lib/a.ts"),
        changes: ["to"],
      },
    ]);
  });
});

describe("thresholds on the repo's fixtures", () => {
  /** Every source file under `fixtures/`, except the diff pair (it's a rename by design). */
  const sources: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort(compareStrings)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "node_modules" && !name.startsWith("diff-rename")) walk(path);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) {
        const relative = path.slice(FIXTURES.length + 1).replaceAll("\\", "/");
        sources.push({ path: relative, text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(FIXTURES);
  const scored = sources.filter((s) => tokenize(s.text).length >= RENAME_THRESHOLDS.minFileTokens);

  it("has enough files to mean something", () => {
    expect(scored.length).toBeGreaterThanOrEqual(30);
  });

  it("matches no two different fixture files except known near-copies", () => {
    const over: string[] = [];
    for (let i = 0; i < scored.length; i++) {
      for (let j = i + 1; j < scored.length; j++) {
        if (scored[i]!.text === scored[j]!.text) continue;
        if (similarity(scored[i]!.text, scored[j]!.text) >= RENAME_THRESHOLDS.fileSimilarity) {
          over.push(`${scored[i]!.path} ${scored[j]!.path}`);
        }
      }
    }
    // The same 13-line server with 4 lines changed: a rename to git (50%) too.
    expect(over).toEqual([
      "env-base-heuristic/apps/api/src/server.ts fetch-template-literal/src/server.ts",
    ]);
  });

  it("matches each fixture file after a 10% edit: every tenth line changed", () => {
    const missed = scored.filter((s) => {
      const edited = s.text
        .split("\n")
        .map((line, i) => (i % 10 === 4 ? `${line} // edited` : line))
        .join("\n");
      return similarity(s.text, edited) < RENAME_THRESHOLDS.fileSimilarity;
    });
    expect(missed.map((s) => s.path)).toEqual([]);
  });
});
