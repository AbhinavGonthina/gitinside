// @vitest-environment node
import { parseGraph, type ArchitectureGraph, type GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { shopDemo } from "../shopDemo.testkit.js";
import { cannedHistory, HISTORY_CHUNK, HISTORY_COMMITS, historyCounts } from "./timeline.js";

// The timeline's canned history (M10.3f4, M10-design §3.4).

const graph = shopDemo();
const GET = "route:api/GET /api/orders";

function history(of: ArchitectureGraph = graph) {
  const made = cannedHistory(of);
  if (!made) throw new Error("no history");
  return made;
}

/** shop-demo with `n` more uncalled routes in one new file of the api, to fill a long history. */
function withRoutes(n: number): ArchitectureGraph {
  const route = graph.nodes.find((x) => x.id === GET);
  const parent = graph.nodes.find((x) => x.id === route?.parentId);
  if (route?.kind !== "route" || parent?.kind !== "file") throw new Error("shop-demo changed");
  const file: GraphNode = {
    ...parent,
    id: "file:api/src/more.ts",
    label: "more.ts",
    path: "apps/api/src/more.ts",
  };
  const routes = Array.from({ length: n }, (_, i): GraphNode => {
    const path = `/api/more/${String(i).padStart(2, "0")}`;
    return {
      ...route,
      id: `route:api/GET ${path}`,
      label: `GET ${path}`,
      parentId: file.id,
      path,
      source: { file: "apps/api/src/more.ts", line: i + 1, column: 1 },
    };
  });
  return { ...graph, nodes: [...graph.nodes, file, ...routes] };
}

describe("cannedHistory", () => {
  it("makes a few commits ending at the repo's own graph", () => {
    const h = history();
    expect(h.commits.map((c) => [c.name, c.message])).toEqual([
      ["example 1", "The oldest example commit"],
      ["example 2", "Add the /checkout page"],
      ["example 3", "Add the /orders page"],
      ["example 4", "Remove GET /api/orders"],
      ["example 5", "Bring back GET /api/orders"],
      // shop-demo's graph has no SHA.
      ["this commit", "Add the / page"],
    ]);
    expect(h.commits.at(-1)?.graph).toBe(graph);
    expect(h.commits.map((c) => c.counts.entries)).toEqual([2, 3, 4, 3, 4, 5]);
    expect(h.commits.map((c) => c.counts.broken)).toEqual([1, 1, 1, 2, 1, 1]);
  });

  it("draws every commit as a valid graph, the repo with parts taken out", () => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const { graph: shot } of history().commits) {
      expect(() => parseGraph(shot)).not.toThrow();
      // Only the break's unmatched call is new.
      expect(shot.nodes.filter((n) => !ids.has(n.id)).map((n) => n.kind)).toEqual(
        shot.nodes.some((n) => n.id === GET) ? [] : ["unresolved"],
      );
    }
  });

  it("diffs each commit against the one before: added entries, then one break and its fix", () => {
    const h = history();
    const diffs = h.commits.map((_, i) => h.diffAt(i));
    // The first against itself: nothing changed.
    expect(diffs[0]?.summary.nodes).toMatchObject({ added: 0, removed: 0, modified: 0 });
    const ids = (nodes: readonly { id: string }[] | undefined) => nodes?.map((n) => n.id);
    expect(ids(diffs[1]?.nodes.added)).toEqual(["page:web//checkout"]);
    expect(diffs[1]?.broken).toEqual([]);
    expect(diffs[3]?.broken.map((b) => [b.to, b.detail])).toEqual([
      [GET, "GET /api/orders was removed"],
    ]);
    expect(diffs[4]?.broken).toEqual([]);
    expect(ids(diffs[4]?.nodes.added)).toEqual([GET]);
    // Worked out once per commit.
    expect(h.diffAt(3)).toBe(diffs[3]);
  });

  it("brings at most a few entries per commit, a file at a time, and keeps to the commit cap", () => {
    const h = history(withRoutes(40));
    expect(h.commits).toHaveLength(HISTORY_COMMITS);
    for (let i = 0; i < h.commits.length; i++) {
      const entries = h
        .diffAt(i)
        .nodes.added.filter((n) => n.kind === "route" || n.kind === "page");
      expect(entries.length).toBeLessThanOrEqual(HISTORY_CHUNK);
    }
    expect(h.commits[1]?.message).toBe("Add 3 routes in more.ts");
    // Still the repo itself at the end, the break just before.
    expect(h.commits.at(-1)?.message).toMatch(/^Add /);
    expect(h.commits.at(-2)?.message).toBe("Bring back GET /api/orders");
  });

  it("leaves the break out when no service calls another's route", () => {
    const alone: ArchitectureGraph = {
      ...graph,
      edges: graph.edges.filter((e) => !(e.kind === "http" && e.to.startsWith("route:"))),
    };
    const messages = history(alone).commits.map((c) => c.message);
    expect(messages.some((m) => m.startsWith("Remove"))).toBe(false);
    expect(history(alone).commits.at(-1)?.graph).toBe(alone);
  });

  it("has no history when there's nothing to take out and nothing to break", () => {
    const bare: ArchitectureGraph = {
      ...graph,
      nodes: graph.nodes.filter((n) => n.kind !== "page" && n.kind !== "route"),
      edges: graph.edges.filter((e) => !e.to.startsWith("route:") && !e.from.startsWith("route:")),
    };
    expect(cannedHistory(bare)).toBeUndefined();
  });

  it("is the same history every time", () => {
    const names = (h: ReturnType<typeof history>) => h.commits.map((c) => [c.message, c.counts]);
    expect(names(history())).toEqual(names(history()));
  });
});

describe("historyCounts", () => {
  it("counts pages and routes, lines but imports, and requests matching no route", () => {
    expect(historyCounts(graph)).toEqual({
      entries: graph.nodes.filter((n) => n.kind === "page" || n.kind === "route").length,
      connections: graph.edges.filter((e) => e.kind !== "imports").length,
      broken: graph.edges.filter((e) => e.kind === "http" && e.confidence === "unresolved").length,
    });
  });
});
