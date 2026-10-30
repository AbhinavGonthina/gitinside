import { Confidence, EdgeKind, UnresolvedReason } from "@gitinside/schema";
import { composeStories } from "@storybook/react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { REASON_TEXT } from "../nodes/describe.js";
import { DiagramEdge, EdgeLabel, FLOW_PARTICLES } from "./DiagramEdge.js";
import {
  brokenText,
  CONFIDENCE_TEXT,
  EDGE_WORDS,
  edgeAccessibleName,
  edgeLabel,
  edgeLabelText,
  LINE_STYLE,
  type EdgeLike,
} from "./describe.js";
import * as stories from "./Edges.stories.js";
import { ARROW, DOT_OFFSET, edgeGeometry, type Point } from "./geometry.js";
import { edgeSampleOf, edgeSamples, edgeStates } from "./samples.js";

afterEach(cleanup);

const straight: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
];

describe("edgeGeometry", () => {
  it("ends the line at the arrowhead's base, with the tip on the last point", () => {
    const g = edgeGeometry(straight);
    expect(g.d).toBe(`M 0 0 L ${100 - ARROW.length} 0`);
    expect(g.arrow).toBe(`M 100 0 L 92 4 L 92 -4 Z`);
    expect(g.chevron).toBe(`M 92 4 L 100 0 L 92 -4`);
    expect(g.flowPath).toBe("M 0 0 L 100 0");
  });

  it("places the pattern dot just off the source and the label at half the length", () => {
    const g = edgeGeometry([
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
    ]);
    expect(g.dot).toEqual({ x: DOT_OFFSET, y: 0 });
    expect(g.mid).toEqual({ x: 50, y: 0 });
  });

  it("rounds each bend, shrinking the radius on short segments", () => {
    const g = edgeGeometry([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 6 },
      { x: 120, y: 6 },
    ]);
    expect(g.flowPath).toBe("M 0 0 L 47 0 Q 50 0 50 3 L 50 3 Q 50 6 53 6 L 120 6");
    expect(
      edgeGeometry([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ]).flowPath,
    ).toBe("M 0 0 L 90 0 Q 100 0 100 10 L 100 100");
  });

  it("points the arrowhead along the last segment, whatever its direction", () => {
    const g = edgeGeometry([
      { x: 10, y: 0 },
      { x: 10, y: -50 },
    ]);
    expect(g.arrow).toBe("M 10 -50 L 14 -42 L 6 -42 Z");
  });

  it("drops repeated points and rejects routes without two distinct points", () => {
    expect(edgeGeometry([straight[0]!, straight[0]!, straight[1]!]).flowPath).toBe("M 0 0 L 100 0");
    expect(() => edgeGeometry([straight[0]!, straight[0]!])).toThrow(/two distinct points/);
    expect(() => edgeGeometry([])).toThrow(/two distinct points/);
  });

  it("shortens the arrow on a very short last segment, and keeps the line drawable", () => {
    const g = edgeGeometry([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ]);
    expect(g.arrow).toBe("M 5 0 L 0 4 L 0 -4 Z");
    expect(g.d).toBe("M 0 0 L 0 0");
    expect(g.dot).toEqual({ x: 2.5, y: 0 });
  });

  it("is deterministic and rounds to hundredths without negative zero", () => {
    const pts = [
      { x: 0.123456, y: -0.0001 },
      { x: 33.336, y: -0.0001 },
    ];
    expect(edgeGeometry(pts)).toEqual(edgeGeometry(pts));
    expect(edgeGeometry(pts).flowPath).toBe("M 0.12 0 L 33.34 0");
  });
});

describe("describe", () => {
  const edge = (e: Partial<EdgeLike> & Pick<EdgeLike, "kind">): EdgeLike => ({
    confidence: "exact",
    ...e,
  });

  it("maps every confidence to its line style and words", () => {
    expect(LINE_STYLE).toEqual({
      exact: "solid",
      pattern: "dot",
      heuristic: "dashed",
      unresolved: "dotted",
    });
    expect(Object.keys(CONFIDENCE_TEXT).sort()).toEqual([...Confidence.options].sort());
  });

  it("has words for every edge kind", () => {
    expect(Object.keys(EDGE_WORDS).sort()).toEqual([...EdgeKind.options].sort());
  });

  it("labels a request with its route, method chip, and protocol", () => {
    expect(edgeLabel(edge({ kind: "http", label: "POST /api/orders" }))).toEqual({
      method: "POST",
      code: "/api/orders",
      notes: ["HTTP"],
    });
    expect(
      edgeLabel(edge({ kind: "http", label: "GET /api/orders", reason: "AMBIGUOUS" })).notes,
    ).toEqual(["HTTP", "ambiguous"]);
    expect(edgeLabel(edge({ kind: "http" }))).toEqual({ text: "HTTP request" });
    expect(edgeLabel(edge({ kind: "http", label: "weird" }))).toEqual({ text: "HTTP request" });
  });

  it("never claims a protocol it doesn't know", () => {
    expect(edgeLabelText(edgeLabel(edge({ kind: "external_call" })))).toBe("calls API");
  });

  it("labels reads and writes with the fields they name", () => {
    expect(edgeLabel(edge({ kind: "reads", fields: ["id", "total"] }))).toEqual({
      text: "reads",
      code: "id, total",
    });
    expect(edgeLabel(edge({ kind: "writes", fields: [] }))).toEqual({ text: "writes" });
    expect(edgeLabel(edge({ kind: "calls", reason: "AMBIGUOUS" }))).toEqual({
      text: "calls",
      notes: ["ambiguous"],
    });
  });

  it.each(UnresolvedReason.options)("explains an unresolved %s edge in words", (reason) => {
    expect(edgeLabel(edge({ kind: "http", confidence: "unresolved", reason }))).toEqual({
      text: REASON_TEXT[reason],
    });
  });

  it("counts aggregated edges with the kind's noun", () => {
    expect(edgeLabel(edge({ kind: "calls" }), 22)).toEqual({ text: "22 calls" });
    expect(edgeLabel(edge({ kind: "calls" }), 1)).toEqual({ text: "1 call" });
    expect(edgeLabel(edge({ kind: "http" }), 1204)).toEqual({ text: "1,204 requests" });
    expect(edgeLabel(edge({ kind: "publishes" }), 2)).toEqual({ text: "2 publishes" });
  });

  it("joins a label into one line of text", () => {
    expect(edgeLabelText({ method: "GET", code: "/x", notes: ["HTTP", "ambiguous"] })).toBe(
      "GET /x · HTTP · ambiguous",
    );
  });

  it("words a broken edge from the target's kind", () => {
    expect(brokenText("route")).toBe("Route removed in this PR");
    expect(brokenText("Model")).toBe("Model removed in this PR");
  });

  it("names an edge by its ends, label, confidence, and states", () => {
    const http = edgeSampleOf("exact");
    expect(edgeAccessibleName(http.edge, http.ends)).toBe(
      "submitOrder requests POST /api/orders. POST /api/orders · HTTP. Exact match",
    );
    expect(
      edgeAccessibleName(
        edge({ kind: "calls", confidence: "heuristic" }),
        {
          from: "a",
          to: "b",
        },
        {
          selected: true,
          emphasis: "traced",
          diff: "added",
          broken: "Route removed in this PR",
          count: 3,
        },
      ),
    ).toBe(
      "a calls b. 3 calls. Heuristic match. Selected. On the request path. Added in this change. Broken: Route removed in this PR",
    );
  });
});

describe("DiagramEdge", () => {
  const draw = (props: Partial<Parameters<typeof DiagramEdge>[0]> = {}) => {
    const s = edgeSampleOf("exact");
    const { container } = render(
      <svg>
        <DiagramEdge edge={s.edge} ends={s.ends} points={straight} layer="frontend" {...props} />
      </svg>,
    );
    return container.querySelector(".gi-edge") as SVGGElement;
  };

  it("draws a hit area, the line, and a filled arrowhead, named for assistive tech", () => {
    const g = draw();
    expect(g.getAttribute("role")).toBe("img");
    expect(g.getAttribute("aria-label")).toMatch(/^submitOrder requests POST \/api\/orders/);
    expect(g.getAttribute("data-layer")).toBe("frontend");
    expect(g.getAttribute("data-line")).toBe("solid");
    expect(g.querySelector(".gi-edge__hit")).not.toBeNull();
    expect(g.querySelector(".gi-edge__line")?.getAttribute("d")).toBe("M 0 0 L 92 0");
    expect(g.querySelector(".gi-edge__arrow")?.getAttribute("d")).toMatch(/Z$/);
    expect(g.querySelector(".gi-edge__dot")).toBeNull();
    expect(g.querySelector(".gi-edge__particle")).toBeNull();
  });

  it("marks pattern edges with a dot and unresolved edges with an open arrowhead", () => {
    const pattern = edgeSampleOf("pattern");
    expect(draw({ edge: pattern.edge }).querySelector(".gi-edge__dot")).not.toBeNull();
    cleanup();
    const g = draw({ edge: edgeSampleOf("unresolved").edge, flow: true });
    expect(g.getAttribute("data-line")).toBe("dotted");
    expect(g.querySelector(".gi-edge__arrow--open")?.getAttribute("d")).not.toMatch(/Z$/);
    expect(g.querySelector(".gi-edge__particle")).toBeNull();
  });

  it("draws flow particles along the full route, staggered", () => {
    const particles = [...draw({ flow: true }).querySelectorAll<SVGElement>(".gi-edge__particle")];
    expect(particles).toHaveLength(FLOW_PARTICLES);
    expect(particles.map((p) => p.style.getPropertyValue("--gi-flow-lag"))).toEqual(["0", "0.5"]);
  });

  it("sets every state as a data attribute, and passes extra attributes through", () => {
    const g = draw({
      hovered: true,
      selected: true,
      emphasis: "dimmed",
      diff: "removed",
      broken: "Route removed in this PR",
      className: "extra",
      "data-testid": "e",
    } as Partial<Parameters<typeof DiagramEdge>[0]>);
    expect(g.getAttribute("class")).toBe("gi-edge extra");
    expect(g.getAttribute("data-testid")).toBe("e");
    for (const attr of ["data-hover", "data-selected", "data-broken"]) {
      expect(g.hasAttribute(attr)).toBe(true);
    }
    expect(g.getAttribute("data-emphasis")).toBe("dimmed");
    expect(g.getAttribute("data-diff")).toBe("removed");
    expect(g.getAttribute("aria-label")).toMatch(/Broken: Route removed in this PR$/);
  });

  it("sets no state attributes by default", () => {
    const g = draw({ layer: undefined });
    for (const attr of [
      "data-layer",
      "data-hover",
      "data-selected",
      "data-emphasis",
      "data-diff",
      "data-broken",
    ]) {
      expect(g.hasAttribute(attr)).toBe(false);
    }
  });
});

describe("EdgeLabel", () => {
  const label = (props: Partial<Parameters<typeof EdgeLabel>[0]> = {}) => {
    const s = edgeSampleOf("exact");
    const { container } = render(<EdgeLabel edge={s.edge} layer={s.layer} {...props} />);
    return container.querySelector(".gi-edge-label") as HTMLElement;
  };

  it("shows the route with a method chip and protocol, hidden from assistive tech", () => {
    const el = label();
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelector(".gi-method")?.textContent).toBe("POST");
    expect(el.querySelector("code")?.textContent).toBe("/api/orders");
    expect(el.querySelector(".gi-edge-label__note")?.textContent).toBe("HTTP");
    expect(el.title).toBe("POST /api/orders · HTTP");
  });

  it("shows a count for an aggregated edge", () => {
    expect(label({ count: 22 }).textContent).toBe("22 requests");
  });

  it("leads with the diff state in words", () => {
    const el = label({ diff: "added" });
    expect(el.querySelector(".gi-edge-label__diff")?.textContent).toBe("Added");
    expect(el.getAttribute("data-diff")).toBe("added");
  });

  it("says what broke instead of the route when broken", () => {
    const el = label({ broken: "Route removed in this PR", className: "x" });
    expect(el.textContent).toBe("Route removed in this PR");
    expect(el.title).toBe("Route removed in this PR");
    expect(el.className).toBe("gi-edge-label x");
    expect(el.hasAttribute("data-broken")).toBe(true);
  });

  it("explains an unresolved edge", () => {
    const s = edgeSampleOf("unresolved");
    expect(label({ edge: s.edge }).textContent).toBe("URL built at runtime");
  });
});

describe("samples", () => {
  it("cover every edge kind and confidence", () => {
    expect([...new Set(edgeSamples.map((s) => s.edge.kind))].sort()).toEqual(
      [...EdgeKind.options].sort(),
    );
    expect([...new Set(edgeSamples.map((s) => s.edge.confidence))].sort()).toEqual(
      [...Confidence.options].sort(),
    );
  });

  it("throw for a confidence without a sample", () => {
    expect(() => edgeSampleOf("nope" as Confidence)).toThrow(/no sample/);
  });
});

describe("Edges stories", () => {
  const {
    Confidence: ConfidenceStory,
    Kinds,
    States,
    Diagram,
    Trace,
    Diff,
  } = composeStories(stories);

  it("show every confidence level", () => {
    const { container } = render(<ConfidenceStory />);
    const levels = [...container.querySelectorAll(".gi-edge")].map((e) =>
      e.getAttribute("data-confidence"),
    );
    expect(levels).toEqual(["exact", "pattern", "heuristic", "unresolved"]);
  });

  it("show every edge kind with a label", () => {
    const { container } = render(<Kinds />);
    expect(container.querySelectorAll(".gi-edge")).toHaveLength(edgeSamples.length);
    expect(container.querySelectorAll(".gi-edge-label")).toHaveLength(edgeSamples.length);
  });

  it("show every confidence in every state", () => {
    const { container } = render(<States />);
    expect(container.querySelectorAll(".gi-edge")).toHaveLength(edgeStates.length * 4);
    for (const attr of ["data-hover", "data-selected", "data-broken"]) {
      expect(container.querySelectorAll(`.gi-edge[${attr}]`)).toHaveLength(4);
    }
    for (const value of ["traced", "current", "dimmed"]) {
      expect(container.querySelectorAll(`.gi-edge[data-emphasis="${value}"]`)).toHaveLength(4);
    }
    for (const value of ["added", "changed", "removed"]) {
      expect(container.querySelectorAll(`.gi-edge[data-diff="${value}"]`)).toHaveLength(4);
    }
    expect(container.querySelectorAll(".gi-edge__particle").length).toBeGreaterThan(0);
  });

  it("draw a diagram with flow, a trace with dimming, and a diff with a broken edge", () => {
    expect(render(<Diagram />).container.querySelectorAll(".gi-edge__particle").length).toBe(
      FLOW_PARTICLES,
    );
    cleanup();
    const trace = render(<Trace />).container;
    // One hop is current (route → handler); the rest of the path is traced.
    expect(trace.querySelectorAll('.gi-edge[data-emphasis="current"]')).toHaveLength(1);
    expect(trace.querySelectorAll('.gi-edge[data-emphasis="traced"]')).toHaveLength(3);
    expect(trace.querySelectorAll('.gi-edge[data-emphasis="dimmed"]')).toHaveLength(2);
    expect(trace.querySelectorAll('.gi-node[data-emphasis="current"]')).toHaveLength(2);
    expect(trace.querySelectorAll('.gi-node[data-emphasis="traced"]')).toHaveLength(3);
    cleanup();
    const diff = render(<Diff />).container;
    expect(diff.querySelector(".gi-edge[data-broken]")).not.toBeNull();
    expect(diff.querySelector(".gi-edge-label[data-broken]")?.textContent).toBe(
      "Route removed in this PR",
    );
    expect(diff.querySelector('.gi-node[data-diff="removed"]')).not.toBeNull();
  });
});
