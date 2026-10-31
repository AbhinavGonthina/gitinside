import type { ArchitectureGraph, GraphNode } from "@gitinside/schema";
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import { layoutInput, runLayout, type LayoutResult } from "../layout/elk.js";
import { buildHierarchy, type HierarchyIndex } from "../model/hierarchy.js";
import { buildView, type GraphView } from "../model/view.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { viewMermaid } from "./mermaid.js";
import { renderViewSvg } from "./svg.js";

const elk = new ELK();

/** A view of the graph with `open` broken down, and its ELK layout. */
async function laidOut(
  graph: ArchitectureGraph,
  open: string[],
): Promise<{ index: HierarchyIndex; view: GraphView; layout: LayoutResult }> {
  const index = buildHierarchy(graph);
  const view = buildView(index, open);
  return { index, view, layout: await runLayout(elk, layoutInput(index, view)) };
}

/** Parses an SVG document the way a browser would, failing on any XML error. */
function parse(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  expect(doc.documentElement.tagName).toBe("svg");
  return doc;
}

/** Every `var(--x)` the markup uses is defined by its own `<style>`. */
function expectVarsDefined(svg: string): void {
  const style = /<style>(.*)<\/style>/s.exec(svg)?.[1] ?? "";
  const defined = new Set([...style.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]));
  const used = new Set([...svg.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
  expect(used.size).toBeGreaterThan(0);
  for (const name of used) expect(defined, name).toContain(name);
}

const OPEN = [
  "service:api/",
  "module:api/src",
  "module:api/src/routes",
  "file:api/src/routes/orders.ts",
];

/** shop-demo with hostile names where a repo owner chooses them. */
function hostile(): ArchitectureGraph {
  const graph = shopDemo();
  const evil = (n: GraphNode): GraphNode => {
    if (n.id === "service:api/") return { ...n, label: `api"]-->x[<script>alert(1)</script>` };
    if (n.id === "module:api/src") return { ...n, label: "%%{init: {'theme':'dark'}}%%\nend" };
    if (n.kind === "route") return { ...n, path: `/a"|b<img src=x onerror=alert(1)>` };
    return n;
  };
  return {
    ...graph,
    repo: { ...graph.repo, name: "shop\n%%{init}%%" },
    nodes: graph.nodes.map(evil),
  };
}

describe("renderViewSvg", () => {
  it("draws the view at its layout's positions, open frames behind the lines", async () => {
    const { index, view, layout } = await laidOut(shopDemo(), OPEN);
    const svg = renderViewSvg(index, view, layout, { theme: "dark" });
    const doc = parse(svg);
    expectVarsDefined(svg);
    const root = doc.documentElement;
    expect(Number(root.getAttribute("width"))).toBe(Math.max(layout.width, 480));
    expect(Number(root.getAttribute("height"))).toBe(layout.height + 44);

    // Three open frames (and the folders' tabs), tinted translucently, drawn before any line.
    const tinted = [...svg.matchAll(/<rect[^>]*fill-opacity:0\.06/g)];
    expect(tinted).toHaveLength(3);
    const firstLine = svg.search(/<path d="[^"]*" fill="none" stroke-width/);
    expect(firstLine).toBeGreaterThan(0);
    expect(svg.lastIndexOf("fill-opacity:0.06")).toBeLessThan(firstLine);

    // One arrowhead or chevron per line, and one pill per line.
    const pills = [...svg.matchAll(/rx="9\.5" style="fill:var\(--s2\)/g)];
    expect(pills).toHaveLength(layout.edges.length);

    // Each open frame's box is where the layout put it.
    const api = layout.boxes.find((b) => b.id === "service:api/");
    expect(api).toBeDefined();
    expect(svg).toContain(`x="${(api?.x ?? 0) + 0.5}" y="${(api?.y ?? 0) + 0.5}"`);
    // Names from inside the open frames, and the footer.
    for (const text of [
      "@shop/api",
      ">src<",
      ">routes<",
      "orders.ts",
      "/api/orders",
      "GitInside",
    ]) {
      expect(svg).toContain(text);
    }
    expect(doc.querySelector("desc")?.textContent).toMatch(
      /^\d+ parts and \d+ connections, with @shop\/api, src, routes and orders\.ts broken down\.$/,
    );
  });

  it("gives the same bytes for the same view, and the themes differ only in color", async () => {
    const a = await laidOut(shopDemo(), OPEN);
    const b = await laidOut(shopDemo(), OPEN);
    const dark = renderViewSvg(a.index, a.view, a.layout, { theme: "dark" });
    expect(renderViewSvg(b.index, b.view, b.layout, { theme: "dark" })).toBe(dark);
    const light = renderViewSvg(a.index, a.view, a.layout, { theme: "light" });
    expect(light).not.toBe(dark);
    const noStyle = (s: string) => s.replace(/<style>.*<\/style>/s, "");
    expect(noStyle(light)).toBe(noStyle(dark));
    expectVarsDefined(light);
  });

  it("draws the closed top level with the README image's frames and tiles", async () => {
    const { index, view, layout } = await laidOut(shopDemo(), []);
    const svg = renderViewSvg(index, view, layout, { theme: "light" });
    parse(svg);
    expect(svg).not.toContain("fill-opacity");
    // Closed frames keep their stacked edge.
    expect(svg).toContain("var(--lip-");
    expect(svg).toMatch(/<desc id="gi-desc">\d+ parts and \d+ connections\.<\/desc>/);
  });

  it("escapes every name a repo chooses", async () => {
    const { index, view, layout } = await laidOut(hostile(), OPEN);
    const svg = renderViewSvg(index, view, layout, { theme: "dark" });
    const doc = parse(svg);
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<img");
    expect(doc.querySelectorAll("script, img, foreignObject")).toHaveLength(0);
    expect(svg).toContain("&lt;script");
  });
});

describe("viewMermaid", () => {
  it("writes each visible node once, open ones as subgraphs around their inside", async () => {
    const { index, view } = await laidOut(shopDemo(), OPEN);
    const text = viewMermaid(index, view);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^%% .+, drawn by GitInside from the code$/);
    expect(lines[1]).toBe("flowchart LR");
    expect(text.endsWith("\n")).toBe(true);

    const subgraphs = lines.filter((l) => /^\s*subgraph /.test(l));
    expect(subgraphs).toHaveLength(4);
    expect(lines.filter((l) => l.trim() === "end")).toHaveLength(4);
    // The service wraps the folders, which wrap the file: deeper indents.
    const indent = (l: string) => l.length - l.trimStart().length;
    expect(subgraphs.map(indent)).toEqual([2, 4, 6, 8]);

    // A node row is its ID then its shape's bracket; a line row is an ID, a space, an arrow.
    const declared = lines.filter((l) => /^\s+(?:n\d+[[({]|subgraph n\d+ )/.test(l));
    expect(declared).toHaveLength(view.nodes.length);
    const arrows = lines.filter((l) => /^\s+n\d+ -\.?->\|"[^"]*"\| n\d+$/.test(l));
    expect(arrows).toHaveLength(view.edges.length);
    expect(text).toContain('(["POST /api/orders"])');
  });

  it("is the same text for the same view, and dots lines that aren't exact or pattern matches", async () => {
    const graph = shopDemo();
    const { index, view } = await laidOut(graph, []);
    expect(viewMermaid(index, view)).toBe(
      viewMermaid(buildHierarchy(graph), buildView(buildHierarchy(graph), [])),
    );
    const weak = view.edges.filter(
      (e) => e.confidence === "heuristic" || e.confidence === "unresolved",
    );
    const dotted = viewMermaid(index, view)
      .split("\n")
      .filter((l) => l.includes(" -.->|"));
    expect(dotted).toHaveLength(weak.length);
  });

  it("escapes names so they can't close a label, start a directive, or carry HTML", async () => {
    const { index, view } = await laidOut(hostile(), OPEN);
    const text = viewMermaid(index, view);
    const lines = text.trimEnd().split("\n");
    expect(text).not.toContain("<");
    expect(text).not.toContain("%%{");
    expect(text).not.toMatch(/"\]-->x/);
    // Two header lines, then node, subgraph, end, and line rows only: no line break got
    // through, and no label holds a quote, a brace, or a bar.
    const label = '"[^"{}|]*"';
    const row = new RegExp(
      `^\\s+(?:n\\d+\\S{1,2}${label}\\S{1,2}|subgraph n\\d+ \\[${label}\\]|end|n\\d+ -\\.?->\\|${label}\\| n\\d+)$`,
    );
    for (const line of lines.slice(2)) expect(line).toMatch(row);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).toContain("#37;#37;");
  });
});
