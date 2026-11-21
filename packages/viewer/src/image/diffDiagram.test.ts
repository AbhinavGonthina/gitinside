// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffGraphs } from "@gitinside/diff";
import {
  parseGraph,
  type ArchitectureGraph,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { labelPill, layoutDiffDiagram, MAX_DIFF_BOXES, renderDiffDiagram } from "./diffDiagram.js";
import { pillRect } from "./layout.js";

const FIXTURES = join(process.cwd(), "../../fixtures");
const fixture = (name: string): ArchitectureGraph =>
  parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));

const withSha = (graph: ArchitectureGraph, sha: string): ArchitectureGraph => ({
  ...graph,
  repo: { owner: "acme", name: "shop", sha },
});
const base = withSha(fixture("diff-broken-base"), "1".repeat(40));
const head = withSha(fixture("diff-broken-head"), "2".repeat(40));
const diff = diffGraphs(base, head);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A graph of one backend service holding `routes` routes, each called by a frontend page's function. */
function shop(routes: number, sha: string, label = "api"): ArchitectureGraph {
  const root: GraphNode = { id: "system:big", kind: "system", label: "big", parentId: null };
  const api: GraphNode = {
    id: "service:api/",
    kind: "service",
    label,
    parentId: root.id,
    layer: "backend",
    root: "api",
  };
  const web: GraphNode = {
    id: "service:web/",
    kind: "service",
    label: "web",
    parentId: root.id,
    layer: "frontend",
    root: "web",
  };
  const nodes: GraphNode[] = [root, api, web];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < routes; i++) {
    const route: GraphNode = {
      id: `route:api/GET /r${i}`,
      kind: "route",
      label: `GET /r${i}`,
      parentId: api.id,
      method: "GET",
      path: `/r${i}`,
    } as GraphNode;
    nodes.push(route);
    edges.push({
      id: `http:service:web/->${route.id}`,
      kind: "http",
      from: web.id,
      to: route.id,
      confidence: "exact",
      sites: [],
    } as GraphEdge);
  }
  return {
    ...fixture("diff-broken-head"),
    repo: { owner: "acme", name: "big", sha },
    nodes,
    edges,
    warnings: [],
  };
}

describe("renderDiffDiagram (M15.2a)", () => {
  it("draws the same bytes for the same diff, whatever the graphs' order", () => {
    const shuffled = {
      ...head,
      nodes: [...head.nodes].reverse(),
      edges: [...head.edges].reverse(),
    };
    expect(renderDiffDiagram(diffGraphs(base, shuffled), base, shuffled)).toBe(
      renderDiffDiagram(diff, base, head),
    );
  });

  // Pinned: the image is cached for a year per diff (ADR-0295), so a change that moves a
  // pixel must be deliberate. After an intended change, update these and say why.
  it("keeps its exact bytes in each theme", () => {
    const hashes = Object.fromEntries(
      (["auto", "dark", "light"] as const).map((theme) => [
        theme,
        sha256(renderDiffDiagram(diff, base, head, { theme })),
      ]),
    );
    expect(hashes).toEqual({
      auto: "69bb23d506ef4e510b07889c957346fc323994ce2317ea2bdbae1adf276ccdaa",
      dark: "ab9cbeaa225345a167341b7de66664f1cfc2f535fe14d283a40a7b0df2f06d67",
      light: "47281907d4c3a5674de7fdfb4bf4f099a5ec29f7f3750e1e819491395395e9f0",
    });
  });

  it("shows each change in the diff tokens' colors, with its words", () => {
    const svg = renderDiffDiagram(diff, base, head, { theme: "dark" });
    // The palette defines the diff colors only for this image.
    expect(svg).toContain("--diff-added:#4ade80");
    expect(svg).toContain("--diff-removed-fill:");
    // A removed route: dashed, its path struck through, tagged.
    expect(svg).toMatch(/stroke-dasharray="5 3" style="fill:var\(--diff-removed-fill\)/);
    expect(svg).toContain('text-decoration="line-through"');
    expect(svg).toContain(">Removed</text>");
    expect(svg).toContain(">Added</text>");
    expect(svg).toContain(">Changed</text>");
    // Broken lines: red, thicker, dashed, labeled with the reason.
    expect(svg).toContain(
      'stroke-width="2" stroke-linecap="butt" stroke-linejoin="round" stroke-dasharray="5 4" style="stroke:var(--diff-removed)"',
    );
    expect(svg).toContain(">Broken: target removed</text>");
    expect(svg).toContain(">Removed writes</text>");
    expect(svg).toContain(
      '<desc id="gi-desc">6 broken connections, 9 changed boxes and 3 changed connections.</desc>',
    );
    expect(svg).toContain("acme/shop <tspan");
    expect(svg).toContain(" · vs 1111111</text>");
  });

  it("keeps every label inside the image and off every box and change tag", () => {
    const { boxes, edges, width } = layoutDiffDiagram(diff, base, head);
    const drawn = edges.filter((p) => !p.hideLabel);
    expect(drawn).toHaveLength(edges.length);
    for (const p of drawn) {
      const pill = pillRect(p.label, labelPill(p.view).width);
      expect(pill.x).toBeGreaterThanOrEqual(0);
      expect(pill.x + pill.width).toBeLessThanOrEqual(width);
      for (const b of boxes.values()) {
        // The tag band (10px above the box) counts as the box.
        const overlaps =
          pill.x < b.x + b.width &&
          b.x < pill.x + pill.width &&
          pill.y < b.y + b.height &&
          b.y - 10 < pill.y + pill.height;
        expect(overlaps, `${p.view.label} over a box`).toBe(false);
      }
    }
  });

  it("widens the image for a label beside the last column", () => {
    const { boxes, edges, width } = layoutDiffDiagram(diff, base, head);
    const stores = edges.find((p) => p.view.label === "Removed stores");
    expect(stores?.hideLabel).toBeFalsy();
    // "Removed stores" sits right of the data column's boxes, past what the boxes need.
    const pill = pillRect(
      stores?.label ?? { x: 0, y: 0 },
      labelPill(stores?.view ?? edges[0]!.view).width,
    );
    const boxesRight = Math.max(...[...boxes.values()].map((b) => b.x + b.width));
    expect(pill.x + pill.width).toBeGreaterThan(boxesRight + 32);
    expect(pill.x + pill.width).toBeLessThanOrEqual(width - 32);
  });

  it("draws at most 40 boxes on a big diff and counts the rest in the footer", () => {
    const before = shop(0, "a".repeat(40));
    const after = shop(300, "b".repeat(40));
    const big = diffGraphs(before, after);
    const t0 = performance.now();
    const svg = renderDiffDiagram(big, before, after);
    const ms = performance.now() - t0;
    const { boxes, edges } = layoutDiffDiagram(big, before, after);
    expect(MAX_DIFF_BOXES).toBe(40);
    expect(boxes.size).toBe(40);
    expect(edges.length).toBeLessThanOrEqual(40);
    expect(svg).toMatch(/ · \d+ boxes and \d+ lines not drawn/);
    // Measured, not asserted against a clock (CI's coverage runs slower): ADR-0320 quotes it.
    expect(ms).toBeGreaterThan(0);
  });

  it("says when nothing at the architecture level changed", () => {
    const same = renderDiffDiagram(diffGraphs(base, base), base, base, { theme: "light" });
    expect(same).toContain(">No architecture-level changes.</text>");
    expect(same).toContain('<desc id="gi-desc">No architecture-level changes.</desc>');
  });

  it("escapes every piece of repo text", () => {
    const evil = '<script>alert("x")</script>&';
    const before = shop(0, "a".repeat(40), evil);
    const after = shop(2, "b".repeat(40), evil);
    after.repo = { owner: "o&<", name: 'n"', sha: "b".repeat(40) };
    const svg = renderDiffDiagram(diffGraphs(before, after), before, after);
    expect(svg).not.toContain("<script");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("o&amp;&lt;/n&quot;");
  });
});
