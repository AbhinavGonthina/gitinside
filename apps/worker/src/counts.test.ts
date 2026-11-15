import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { graphCounts } from "./counts.js";

const fixture = (name: string): ArchitectureGraph =>
  parseGraph(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../fixtures/${name}/expected.json`, import.meta.url)),
        "utf8",
      ),
    ),
  );

const ofKind = (graph: ArchitectureGraph, kind: string) =>
  graph.nodes.filter((node) => node.kind === kind).length;

describe("graphCounts", () => {
  it("counts a graph's files, nodes, edges, unresolved nodes, services, and broken calls", () => {
    const graph = fixture("diff-broken-head");
    expect(graphCounts(graph)).toEqual({
      files: ofKind(graph, "file"),
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      unresolved: ofKind(graph, "unresolved"),
      services: ofKind(graph, "service"),
      // A POST and a DELETE to `/api/orders` routes the service doesn't have (ADR-0299).
      broken: 2,
    });
    expect(ofKind(graph, "service")).toBeGreaterThan(0);
  });

  it("counts several services", () => {
    const graph = fixture("shop-demo");
    expect(graphCounts(graph).services).toBe(2);
  });

  it("doesn't count a request that matches no route for another reason as broken", () => {
    const graph = fixture("next-app-router");
    // A font loaded next to its module: `NO_MATCHING_ROUTE`, but no route is missing.
    expect(
      graph.edges.some((edge) => edge.kind === "http" && edge.reason === "NO_MATCHING_ROUTE"),
    ).toBe(true);
    expect(graphCounts(graph).broken).toBe(0);
  });
});
