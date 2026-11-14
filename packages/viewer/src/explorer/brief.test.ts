// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseGraph,
  type ArchitectureGraph,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { connectionsOf } from "../model/connections.js";
import { summarizeGraph } from "../model/groups.js";
import { groupedShop } from "../model/groups.testkit.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../shopDemo.testkit.js";
import {
  BRIEF_WORDS,
  briefOf,
  confidenceMix,
  factGrid,
  groupConnections,
  groupCountText,
  groupSites,
  serviceLine,
  systemFacts,
  systemSentence,
  wordCount,
} from "./brief.js";

const FIXTURES = join(process.cwd(), "../../fixtures");
const fixtures = readdirSync(FIXTURES).filter((name) => {
  try {
    readFileSync(join(FIXTURES, name, "expected.json"));
    return true;
  } catch {
    return false;
  }
});

function fixture(name: string): ArchitectureGraph {
  return parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));
}

const shop = buildHierarchy(summarizeGraph(shopDemo()));

describe("the prototype's panel text (M10.3c3)", () => {
  it("says what the repo is in one sentence, with a row of counts", () => {
    // A tie between roles keeps graph order (IDs: `service:api/` first).
    expect(systemSentence(shop)).toBe(
      "An Express API and a Next.js app, with PostgreSQL and 1 outside API.",
    );
    expect(systemFacts(shop)).toEqual([
      { value: 2, noun: "service" },
      { value: 3, noun: "page" },
      { value: 2, noun: "route" },
      { value: 1, noun: "model" },
      { value: 1, noun: "datastore" },
      { value: 1, noun: "outside API" },
    ]);
  });

  it("counts roles past the first three as other services, and grouped services too", () => {
    const index = buildHierarchy(summarizeGraph(groupedShop()));
    // The two shared packages sit in a group, but they're services all the same.
    expect(systemSentence(index)).toBe(
      "2 packages, an Express API and a Next.js app, with PostgreSQL and 4 outside APIs.",
    );
    const g = groupedShop();
    const more: GraphNode[] = ["a", "b", "c"].map((name) => ({
      id: `service:${name}/`,
      kind: "service",
      label: name,
      parentId: "system:root",
      root: name,
      layer: "infra",
    }));
    const wide = buildHierarchy({ ...g, nodes: [...g.nodes, ...more] });
    expect(systemSentence(wide)).toBe(
      "3 workers, 2 packages, an Express API and 1 other service, with PostgreSQL and 4 outside APIs.",
    );
  });

  it("lists a service's role and counts in the overview", () => {
    const api = shop.byId.get("service:api/") as GraphNode;
    expect(serviceLine(shop, api)).toBe("Express API · 2 routes · 1 model · 1 outside API");
  });

  it("briefs a service in a lead and where its connections go", () => {
    const api = shop.byId.get("service:api/") as GraphNode;
    expect(briefOf(shop, api)).toBe(
      "Express API in apps/api with 2 routes and 1 model. It calls 1 outside API and uses db.",
    );
    const web = shop.byId.get("service:web/") as GraphNode;
    expect(briefOf(shop, web)).toMatch(
      /^Next\.js app in apps\/web .*\. It calls into @shop\/api\.$/,
    );
  });

  it("says who uses a grouped package once, in the group's note", () => {
    const g = groupedShop();
    const call: GraphEdge = {
      id: "calls:symbol:web/app/page.tsx#Home->service:ui/",
      kind: "calls",
      from: "symbol:web/app/page.tsx#Home",
      to: "service:ui/",
      confidence: "exact",
      sites: [{ file: "apps/web/app/page.tsx", line: 2, column: 1 }],
    };
    const index = buildHierarchy(summarizeGraph({ ...g, edges: [...g.edges, call] }));
    expect(briefOf(index, index.byId.get("service:ui/") as GraphNode)).toBe(
      "Package in packages/ui. Grouped with shared packages: no routes, pages, or requests of its own. Used by @shop/web.",
    );
    expect(briefOf(index, index.byId.get("service:tsconfig/") as GraphNode)).toBe(
      "Package in packages/tsconfig. Grouped with shared packages: no routes, pages, or requests of its own.",
    );
    const lone = buildHierarchy(shopDemo());
    expect(briefOf(lone, lone.byId.get("datastore:infra/db") as GraphNode)).toBe(
      // Users in another service are named by their service.
      "Datastore running PostgreSQL. Used by @shop/api.",
    );
  });

  it("keeps every brief in every fixture to 30 words, the overview's too", () => {
    expect(fixtures.length).toBeGreaterThan(10);
    let longest = 0;
    for (const name of fixtures) {
      for (const graph of [fixture(name), summarizeGraph(fixture(name))]) {
        const index = buildHierarchy(graph);
        for (const node of graph.nodes) {
          const words = wordCount(briefOf(index, node));
          longest = Math.max(longest, words);
          expect(words, `${name}: ${node.id}`).toBeLessThanOrEqual(BRIEF_WORDS);
        }
      }
    }
    // The check isn't vacuous: some brief comes near the limit.
    expect(longest).toBeGreaterThan(15);
  });

  it("leaves out a clause that would pass 30 words, rather than cutting it", () => {
    const g = shopDemo();
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    // Names of several words, so the clauses together run past the limit.
    const services: GraphNode[] = ids.map((id) => ({
      id: `service:${id}/`,
      kind: "service",
      label: `the ${id} shared service package of the repo`,
      parentId: "system:root",
      root: `packages/${id}`,
    }));
    const from = "file:api/src/billing/stripe.ts";
    const site = [{ file: "apps/api/src/billing/stripe.ts", line: 1, column: 1 }];
    const unresolved: GraphNode = {
      id: "unresolved:api/src/billing/stripe.ts:9:1",
      kind: "unresolved",
      label: "fetch(url)",
      parentId: "system:root",
      reason: "DYNAMIC_URL",
      expression: "url",
      source: { file: "apps/api/src/billing/stripe.ts", line: 9, column: 1 },
    };
    const edges: GraphEdge[] = [
      ...ids.map(
        (id): GraphEdge => ({
          id: `calls:${from}->service:${id}/`,
          kind: "calls",
          from,
          to: `service:${id}/`,
          confidence: "exact",
          sites: site,
        }),
      ),
      {
        id: `http:${from}->unresolved`,
        kind: "http",
        from,
        to: unresolved.id,
        confidence: "unresolved",
        sites: site,
      },
    ];
    const index = buildHierarchy({
      ...g,
      nodes: [...g.nodes, ...services, unresolved],
      edges: [...g.edges, ...edges],
    });
    const brief = briefOf(index, index.byId.get(from) as GraphNode);
    // The first clauses stay whole; the unresolved call's, which would pass 30 words, is left out.
    expect(brief).toBe(
      "File defining chargeOrder. It calls into the s0 shared service package of the repo, the s1 shared service package of the repo and 10 more and calls 1 outside API.",
    );
    expect(wordCount(brief)).toBe(BRIEF_WORDS);
  });

  it("lays a node's facts out by where its connections go, each naming its node", () => {
    const api = shop.byId.get("service:api/") as GraphNode;
    const rows = factGrid(shop, api);
    expect(rows.map((r) => r.label)).toEqual([
      "Root",
      "Routes",
      "Models",
      "Outside APIs",
      "Data",
      "Used by",
    ]);
    expect(rows.find((r) => r.label === "Outside APIs")?.items).toEqual([
      { text: "api.stripe.com", code: true, id: "external:ext/api.stripe.com" },
    ]);
    expect(rows.find((r) => r.label === "Used by")?.items).toEqual([
      { text: "@shop/web", id: "service:web/" },
    ]);
  });

  it("groups connections by the node at the other end, with the weakest confidence", () => {
    const edge = (id: string, confidence: GraphEdge["confidence"], sites: number): GraphEdge => ({
      id,
      kind: "calls",
      from: "a",
      to: "b",
      confidence,
      sites: Array.from({ length: sites }, (_, i) => ({ file: "x.ts", line: i + 1, column: 1 })),
    });
    const b = shop.byId.get("model:api/Order") as GraphNode;
    const c = shop.byId.get("datastore:infra/db") as GraphNode;
    const groups = groupConnections([
      { edge: edge("1", "exact", 2), other: b },
      { edge: edge("2", "unresolved", 1), other: c },
      { edge: edge("3", "heuristic", 1), other: b },
    ]);
    expect(groups.map((g) => [g.other.id, g.edges.map((e) => e.id), g.weakest])).toEqual([
      ["model:api/Order", ["1", "3"], "heuristic"],
      ["datastore:infra/db", ["2"], "unresolved"],
    ]);
    const [order] = groups;
    expect(order && groupCountText(order)).toBe("3 calls");
    expect(order && confidenceMix(order)).toBe("1 exact, 1 heuristic");
  });

  it("lists a group's call sites one per line, by file and line", () => {
    const at = (file: string, line: number, column = 1) => ({ file, line, column });
    const edge = (id: string, sites: ReturnType<typeof at>[]): GraphEdge => ({
      id,
      kind: "handles",
      from: "a",
      to: "b",
      confidence: "exact",
      sites,
    });
    const other = shop.byId.get("model:api/Order") as GraphNode;
    const [group] = groupConnections([
      { edge: edge("1", [at("b.ts", 43), at("a.ts", 9)]), other },
      // Two handlers on one line, at two columns: the line is listed once.
      { edge: edge("2", [at("b.ts", 43, 30)]), other },
    ]);
    expect(group && groupSites(group)).toEqual([at("a.ts", 9), at("b.ts", 43)]);
  });

  it("counts each kind apart when one node is reached several ways", () => {
    const web = buildHierarchy(shopDemo());
    const { outgoing } = connectionsOf(web, "file:api/src/orders/handlers.ts");
    const order = groupConnections(outgoing).find((g) => g.other.id === "model:api/Order");
    expect(order && groupCountText(order)).toBe("1 read, 1 write");
  });
});
