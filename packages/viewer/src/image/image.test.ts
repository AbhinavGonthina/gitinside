import type { ArchitectureGraph, GraphEdge, GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../contrast.js";
import { glyphNames } from "../icons/glyphs.js";
import { themeTokens } from "../tokens.js";
import { shopDemo } from "../prototype/shopDemo.testkit.js";
import { BADGE_COLORS, BADGE_HEIGHT, renderBadge } from "./badge.js";
import {
  BADGE_MESSAGE_MAX,
  badgeMessage,
  layoutTopLevel,
  MAX_ROWS,
  renderDiagram,
  rowsFor,
  topLevelCounts,
} from "./diagram.js";
import { attrs, esc, fit, glyphMarkup, num, textWidth } from "./markup.js";
import { imageColors, mix, paletteCss } from "./palette.js";

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

const root: GraphNode = { id: "system:demo", kind: "system", label: "demo", parentId: null };

function graphOf(nodes: GraphNode[], edges: GraphEdge[] = []): ArchitectureGraph {
  return {
    schemaVersion: shopDemo().schemaVersion,
    repo: { owner: "acme", name: "demo", sha: "0123456789abcdef0123456789abcdef01234567" },
    analyzerVersion: "0.1.0",
    nodes: [root, ...nodes],
    edges,
    warnings: [],
  };
}

const service = (id: string, label = id): GraphNode => ({
  id,
  kind: "service",
  label,
  parentId: root.id,
  layer: "backend",
  root: `packages/${id}`,
});

const datastore = (id: string): GraphNode => ({
  id,
  kind: "datastore",
  label: id,
  parentId: root.id,
  layer: "data",
  engine: "postgres",
});

const edge = (from: string, to: string, kind: GraphEdge["kind"] = "calls"): GraphEdge => ({
  id: `${kind}:${from}->${to}`,
  kind,
  from,
  to,
  confidence: "exact",
  sites: [],
});

describe("markup", () => {
  it("escapes XML's special characters and replaces what XML can't carry", () => {
    expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
    expect(esc("a\u0000b\u001fc\ud800d\udc00e￿")).toBe("a�b�c�d�e�");
    // Tabs, newlines, and real surrogate pairs are valid XML and stay.
    expect(esc("a\tb\n😀")).toBe("a\tb\n😀");
  });

  it("writes numbers with at most two decimals and attributes in order, skipping undefined", () => {
    expect(num(1.005)).toBe("1");
    expect(num(-0.001)).toBe("0");
    expect(num(2.345)).toBe("2.35");
    expect(attrs({ x: 1.5, id: `a"b`, skip: undefined })).toBe(' x="1.5" id="a&quot;b"');
  });

  it("serializes every glyph from its React artwork, props as attribute names", () => {
    for (const name of glyphNames) {
      const markup = glyphMarkup(name);
      expect(markup, name).toMatch(/^<(path|rect|circle|ellipse)/);
      expect(markup).not.toMatch(/undefined|\[object/);
      parse(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`);
    }
    expect(glyphMarkup("unresolved")).toContain('stroke-dasharray="0 3.24"');
    expect(glyphMarkup("module")).toBe(
      '<path d="M3.75 7a2 2 0 0 1 2-2h3.6l2 2.25h6.9a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2Z"/>',
    );
  });

  it("estimates text widths and cuts text to fit with an ellipsis", () => {
    expect(textWidth("abc", 10, true)).toBeCloseTo(18);
    expect(textWidth("WWW", 10)).toBeGreaterThan(textWidth("iii", 10));
    expect(fit("short", 200, 12)).toBe("short");
    const cut = fit("a-really-long-package-name-that-overflows", 80, 12);
    expect(cut.endsWith("…")).toBe(true);
    expect(textWidth(cut, 12)).toBeLessThanOrEqual(80);
    expect(fit("abcdef", 1, 12)).toBe("…");
  });
});

describe("palette", () => {
  it("mixes colors the way CSS color-mix in srgb does", () => {
    expect(mix("#ffffff", 50, "#000000")).toBe("#808080");
    expect(mix("#123456", 100, "#000000")).toBe("#123456");
    expect(mix("#123456", 0, "#abcdef")).toBe("#abcdef");
  });

  it("defines every color per theme, logos falling back to text where they'd be faint", () => {
    const brand = { slug: "nextdotjs", title: "Next.js", hex: "#000000", path: "M0 0" };
    expect(imageColors("light", [brand])["brand-nextdotjs"]).toBe("#000000");
    expect(imageColors("dark", [brand])["brand-nextdotjs"]).toBe(themeTokens.dark.text);
    expect(imageColors("dark", []).canvas).toBe(themeTokens.dark.canvas);
  });

  it("follows the reader's color scheme only in auto", () => {
    expect(paletteCss("auto", [])).toContain("@media (prefers-color-scheme: light)");
    expect(paletteCss("dark", [])).not.toContain("@media");
    expect(paletteCss("light", [])).toContain(`--canvas:${themeTokens.light.canvas}`);
  });
});

describe("renderBadge", () => {
  it("is a well-formed 20px SVG naming GitInside and the message", () => {
    const svg = renderBadge({ message: "3 services · 2 datastores" });
    const doc = parse(svg);
    expect(doc.documentElement.getAttribute("height")).toBe(String(BADGE_HEIGHT));
    expect(doc.documentElement.getAttribute("aria-label")).toBe(
      "GitInside: 3 services · 2 datastores",
    );
    expect(doc.getElementsByTagName("text")).toHaveLength(2);
    expect(renderBadge({ message: "3 services · 2 datastores" })).toBe(svg);
  });

  it("grows with its message and cuts very long ones", () => {
    const width = (message: string) =>
      Number(parse(renderBadge({ message })).documentElement.getAttribute("width"));
    expect(width("view diagram")).toBeLessThan(width("12 services · 4 datastores"));
    const long = renderBadge({ message: "x".repeat(200) });
    expect(long).toContain(`${"x".repeat(47)}…<`);
  });

  it("escapes the message", () => {
    const svg = renderBadge({ message: `<script>alert("x")</script>` });
    parse(svg);
    expect(svg).not.toContain("<script");
  });

  it("uses the muted tone for states that aren't a diagram", () => {
    expect(renderBadge({ message: "not analyzed", tone: "muted" })).toContain(
      `fill="${BADGE_COLORS.muted.fill}"`,
    );
  });

  it("keeps every text color at 4.5:1 or more on its fill", () => {
    for (const { fill, text } of [BADGE_COLORS.label, BADGE_COLORS.accent, BADGE_COLORS.muted]) {
      expect(contrastRatio(text, fill)).toBeGreaterThanOrEqual(4.5);
    }
    // The mark is a graphic: 3:1.
    expect(contrastRatio(BADGE_COLORS.label.mark, BADGE_COLORS.label.fill)).toBeGreaterThanOrEqual(
      3,
    );
  });
});

describe("renderDiagram", () => {
  const graph = shopDemo();

  it("draws the top level of a real graph as a well-formed, titled SVG", () => {
    const svg = renderDiagram(graph);
    const doc = parse(svg);
    expect(doc.getElementsByTagName("title")[0]?.textContent).toBe(
      `${graph.repo.owner}/${graph.repo.name} architecture`,
    );
    const desc = doc.getElementsByTagName("desc")[0]?.textContent ?? "";
    expect(desc).toMatch(/^\d+ services?/);
    const text = doc.documentElement.textContent ?? "";
    const rootId = graph.nodes.find((n) => n.kind === "system")?.id;
    const top = graph.nodes.filter((n) => n.parentId === rootId);
    expect(top.length).toBeGreaterThan(2);
    for (const n of top) expect(text).toContain(n.label);
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
    expectVarsDefined(svg);
  });

  it("gives the same bytes for the same graph", () => {
    expect(renderDiagram(shopDemo())).toBe(renderDiagram(shopDemo()));
    expect(renderDiagram(graph, { theme: "light" })).toBe(renderDiagram(graph, { theme: "light" }));
  });

  it("follows the reader's theme by default and fixes it when asked", () => {
    expect(renderDiagram(graph)).toContain("prefers-color-scheme");
    const dark = renderDiagram(graph, { theme: "dark" });
    expect(dark).not.toContain("prefers-color-scheme");
    expect(dark).toContain(`--canvas:${themeTokens.dark.canvas}`);
    expectVarsDefined(renderDiagram(graph, { theme: "light" }));
  });

  it("draws lines with their confidence as line style and counts for aggregates", () => {
    const nodes = [service("a"), service("b"), service("c"), service("d")];
    const svg = renderDiagram(
      graphOf(nodes, [
        { ...edge("a", "b"), confidence: "heuristic" },
        { ...edge("b", "c"), confidence: "pattern" },
        { ...edge("c", "d"), confidence: "unresolved", reason: "DYNAMIC_URL" },
      ]),
    );
    parse(svg);
    expect(svg).toContain('stroke-dasharray="6 4"');
    expect(svg).toContain('stroke-dasharray="0 5"');
    expect(svg).toMatch(/<circle[^>]* r="2.5"/);
    expect(svg).toContain("URL built at runtime");
  });

  it("wraps a tall column into balanced sub-columns", () => {
    const stores = Array.from({ length: 8 }, (_, i) => datastore(`db${i}`));
    const { boxes } = layoutTopLevel(graphOf([service("api"), ...stores]));
    const xs = new Set(stores.map((s) => boxes.get(s.id)?.x));
    expect(xs.size).toBe(2);
    const perColumn = [...xs].map((x) => stores.filter((s) => boxes.get(s.id)?.x === x).length);
    expect(perColumn).toEqual([4, 4]);
    expect(MAX_ROWS).toBe(5);
    // Data sits right of the backend column.
    expect(Math.min(...stores.map((s) => boxes.get(s.id)?.x ?? 0))).toBeGreaterThan(
      boxes.get("api")?.x ?? Infinity,
    );
  });

  it("wraps big columns into more rows, so the image stays about 16:10 rather than a strip", () => {
    expect([1, 8, 15].map(rowsFor)).toEqual([5, 5, 5]);
    expect(rowsFor(80)).toBe(12);
    const services = Array.from({ length: 80 }, (_, i) =>
      service(`s${String(i).padStart(2, "0")}`),
    );
    const { width, height } = layoutTopLevel(graphOf(services));
    expect(width / height).toBeGreaterThan(1);
    expect(width / height).toBeLessThan(2.5);
  });

  it("routes a line between non-neighbors of one column beside it, not through the boxes between", () => {
    const nodes = [service("a"), service("b"), service("c")];
    const { boxes, edges } = layoutTopLevel(graphOf(nodes, [edge("a", "c"), edge("a", "b")]));
    const right = Math.max(
      ...nodes.map((n) => (boxes.get(n.id)?.x ?? 0) + (boxes.get(n.id)?.width ?? 0)),
    );
    const [around, next] = edges;
    expect(around?.view.to).toBe("c");
    expect(around?.points.map((p) => p.x).some((x) => x > right)).toBe(true);
    // Neighbors are joined directly, inside the column.
    expect(next?.points.every((p) => p.x <= right)).toBe(true);
  });

  it("routes lines into a wrapped sub-column through the gap between rows, entering from the top", () => {
    const stores = Array.from({ length: 8 }, (_, i) => datastore(`db${i}`));
    const { boxes, edges } = layoutTopLevel(
      graphOf(
        [service("api"), ...stores],
        [edge("api", "db0", "reads"), edge("api", "db7", "reads")],
      ),
    );
    const [first, wrapped] = edges;
    const db0 = boxes.get("db0");
    const db7 = boxes.get("db7");
    // The first sub-column is entered from the side, as on the canvas.
    expect(first?.points.at(-1)).toEqual({ x: db0?.x, y: (db0?.y ?? 0) + (db0?.height ?? 0) / 2 });
    // The second is entered from the top, after running along the gap above the target's row.
    const end = wrapped?.points.at(-1);
    expect(end).toEqual({ x: (db7?.x ?? 0) + (db7?.width ?? 0) / 2, y: db7?.y });
    const run = wrapped?.points.at(-2);
    expect(run?.y).toBe((db7?.y ?? 0) - 20);
    const db3 = boxes.get("db3");
    // That gap clears the box in the first sub-column on the same row.
    expect(
      (run?.y ?? 0) > (db3?.y ?? 0) + (db3?.height ?? 0) || (run?.y ?? 0) < (db3?.y ?? 0),
    ).toBe(true);
  });

  it("leaves a wrapped source from its bottom when another sub-column is in the way", () => {
    const pages = Array.from(
      { length: 6 },
      (_, i): GraphNode => ({
        ...service(`web${i}`),
        layer: "frontend",
      }),
    );
    const { boxes, edges } = layoutTopLevel(
      graphOf([...pages, service("api")], [edge("web0", "api")]),
    );
    const web0 = boxes.get("web0");
    const [line] = edges;
    expect(line?.points[0]).toEqual({
      x: (web0?.x ?? 0) + (web0?.width ?? 0) / 2,
      y: (web0?.y ?? 0) + (web0?.height ?? 0),
    });
    expect(line?.points.at(-1)?.x).toBe(boxes.get("api")?.x);
  });

  it("escapes hostile names from the repo", () => {
    const evil = `</text><script>alert(1)</script><text a="`;
    const svg = renderDiagram(
      graphOf([
        service("a", evil),
        {
          id: "x",
          kind: "external",
          label: evil,
          parentId: root.id,
          layer: "external",
          host: `${evil}\u0001`,
        },
      ]),
    );
    parse(svg);
    expect(svg).not.toContain("<script");
    expect(svg).toContain("&lt;/text&gt;");
  });

  it("draws cards for other top-level kinds, with unresolved ones dotted", () => {
    const svg = renderDiagram(
      graphOf([
        {
          id: "u",
          kind: "unresolved",
          label: "fetch(url)",
          parentId: root.id,
          reason: "DYNAMIC_URL",
          expression: "fetch(url)",
        },
        { id: "m", kind: "module", label: "lib", parentId: root.id, path: "lib" },
        { id: "q", kind: "queue", label: "jobs", parentId: root.id, engine: "unknownmq" },
      ]),
    );
    parse(svg);
    expectVarsDefined(svg);
    expect(svg).toContain('stroke-dasharray="1.5 2.5"');
    expect(svg).toContain("unknownmq queue");
  });

  it("says so when the commit has nothing at the top level", () => {
    const svg = renderDiagram(graphOf([]));
    parse(svg);
    expect(svg).toContain("No services found in this commit.");
    expect(topLevelCounts(graphOf([]))).toEqual([]);
  });

  it("counts the top level by kind", () => {
    const counts = topLevelCounts(
      graphOf([
        service("a"),
        datastore("d"),
        { id: "x", kind: "external", label: "x", parentId: root.id, host: "api.stripe.com" },
      ]),
    );
    expect(counts.map((c) => [c.value, c.noun])).toEqual([
      [1, "service"],
      [1, "datastore"],
      [1, "outside API"],
    ]);
  });

  it("words the badge from the counts, leaving off kinds that don't fit", () => {
    expect(badgeMessage(graphOf([]))).toBe("no services found");
    const external = (id: string): GraphNode => ({
      id,
      kind: "external",
      label: id,
      parentId: root.id,
      host: `${id}.example.com`,
    });
    expect(badgeMessage(graphOf([service("a"), datastore("d"), external("x")]))).toBe(
      "1 service · 1 datastore · 1 outside API",
    );
    const many = (n: number, make: (id: string) => GraphNode) =>
      Array.from({ length: n }, (_, i) => make(`${make.name}${i}`));
    const big = graphOf([...many(1200, service), ...many(12, datastore), ...many(10, external)]);
    // "1,200 services · 12 datastores · 10 outside APIs" is 49 characters.
    expect(badgeMessage(big)).toBe("1,200 services · 12 datastores");
    expect(badgeMessage(big).length).toBeLessThanOrEqual(BADGE_MESSAGE_MAX);
  });
});
