import type { GraphNode, Layer } from "@gitinside/schema";
import type { Meta, StoryObj } from "@storybook/react";
import type { CSSProperties, ReactNode } from "react";
import { DiagramNode } from "../nodes/DiagramNode.js";
import { nodeTier, type NodeState } from "../nodes/describe.js";
import { sampleOf } from "../nodes/samples.js";
import { cssVar } from "../tokens.js";
import { DiagramEdge, EdgeLabel } from "./DiagramEdge.js";
import { CONFIDENCE_TEXT, type EdgeState } from "./describe.js";
import { edgeGeometry, type Point } from "./geometry.js";
import { edgeSampleOf, edgeSamples, edgeStates, type EdgeSample } from "./samples.js";

// Every edge kind, every confidence in every state, and a small diagram in
// plain, trace, and diff modes, in whichever theme the toolbar selects.

const muted: CSSProperties = { color: cssVar("text-muted"), fontSize: cssVar("font-size-12") };

function Page({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gap: cssVar("space-24"),
        alignContent: "start",
        padding: cssVar("space-32"),
        minHeight: "100vh",
        boxSizing: "border-box",
      }}
    >
      <header>
        <h1
          style={{
            margin: 0,
            fontSize: cssVar("font-size-28"),
            fontWeight: cssVar("font-weight-semibold"),
            letterSpacing: "-0.02em",
            lineHeight: cssVar("line-height-tight"),
          }}
        >
          {title}
        </h1>
        <p style={{ margin: `${cssVar("space-8")} 0 0`, color: cssVar("text-muted") }}>{note}</p>
      </header>
      {children}
    </div>
  );
}

/** An edge to draw on a {@link Board}: a sample, its route, and its state. */
interface Drawn {
  sample: EdgeSample;
  points: Point[];
  state?: EdgeState;
  flow?: boolean;
  /** Draw the label pill (default true). */
  label?: boolean;
  /** Move the label this far below the line's middle (state matrix cells). */
  labelDy?: number;
}

/** A positioned box: an SVG layer of edges under HTML nodes and labels, as the canvas will be. */
function Board({
  width,
  height,
  edges,
  children,
}: {
  width: number;
  height: number;
  edges: readonly Drawn[];
  children?: ReactNode;
}) {
  return (
    <div style={{ position: "relative", width, height, flex: "none" }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        {edges.map(({ sample, points, state, flow = false }, i) => (
          <DiagramEdge
            key={i}
            edge={sample.edge}
            ends={sample.ends}
            layer={sample.layer}
            points={points}
            flow={flow}
            {...state}
          />
        ))}
      </svg>
      {children}
      {edges.map(({ sample, points, state, label = true, labelDy = 0 }, i) => {
        if (!label) return null;
        const { mid } = edgeGeometry(points);
        return (
          <EdgeLabel
            key={i}
            edge={sample.edge}
            layer={sample.layer}
            {...state}
            style={{ left: mid.x, top: mid.y + labelDy }}
          />
        );
      })}
    </div>
  );
}

/** A straight edge across a cell of the given width, at height `y`. */
function cellRoute(width: number, y: number): Point[] {
  return [
    { x: 4, y },
    { x: width - 4, y },
  ];
}

function ConfidenceSheet() {
  const levels = ["exact", "pattern", "heuristic", "unresolved"] as const;
  const notes = {
    exact: "Solid. The code names the target directly.",
    pattern: "Solid with a dot at the source. Matched through a route pattern.",
    heuristic: "Dashed. Matched by a naming or port heuristic.",
    unresolved: "Dotted, open arrowhead. Shown with its reason, never dropped.",
  };
  return (
    <Page
      title="Edges"
      note="Line style is confidence, the arrowhead points at the target, and the source's layer tints the line."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "160px 440px 1fr",
          gap: `${cssVar("space-24")} ${cssVar("space-32")}`,
          alignItems: "center",
        }}
      >
        {levels.map((level) => (
          <Row key={level}>
            <span style={{ fontWeight: cssVar("font-weight-medium") }}>
              {CONFIDENCE_TEXT[level]}
            </span>
            <Board
              width={440}
              height={40}
              edges={[{ sample: edgeSampleOf(level), points: cellRoute(440, 20) }]}
            />
            <span style={muted}>{notes[level]}</span>
          </Row>
        ))}
      </div>
    </Page>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: "contents" }}>{children}</div>;
}

function KindSheet() {
  return (
    <Page
      title="Edge kinds"
      note="Each relationship labeled from the analyzer's own fields: the route and protocol for requests, the fields a query names, the reason when unresolved."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
          gap: `${cssVar("space-24")} ${cssVar("space-32")}`,
        }}
      >
        {edgeSamples.map((s) => (
          <div key={s.edge.id} style={{ display: "grid", gap: cssVar("space-8") }}>
            <span style={muted}>
              <code style={{ fontFamily: cssVar("font-mono") }}>{s.edge.kind}</code> ·{" "}
              {CONFIDENCE_TEXT[s.edge.confidence]}
            </span>
            <Board
              width={360}
              height={40}
              edges={[
                {
                  sample: s,
                  points: [
                    { x: 4, y: 20 },
                    { x: 356, y: 20 },
                  ],
                },
              ]}
            />
          </div>
        ))}
      </div>
    </Page>
  );
}

function StateMatrix() {
  const levels = ["exact", "pattern", "heuristic", "unresolved"] as const;
  return (
    <Page
      title="Edge states"
      note="Each confidence in each state. Flow particles travel source to target; reduced motion turns them off, and the broken pulse with them."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `96px repeat(${levels.length}, 260px)`,
          gap: `${cssVar("space-12")} ${cssVar("space-24")}`,
          alignItems: "center",
        }}
      >
        <span />
        {levels.map((level) => (
          <span key={level} style={muted}>
            {CONFIDENCE_TEXT[level]}
          </span>
        ))}
        {edgeStates.map(({ name, state, flow }) => (
          <Row key={name}>
            <span style={muted}>{name}</span>
            {levels.map((level) => (
              <Board
                key={level}
                width={260}
                height={56}
                edges={[
                  {
                    sample: edgeSampleOf(level),
                    points: cellRoute(260, 14),
                    labelDy: 24,
                    state,
                    ...(flow ? { flow } : {}),
                  },
                ]}
              />
            ))}
          </Row>
        ))}
      </div>
    </Page>
  );
}

/* A small diagram: web → route → handler → model → datastore, plus Stripe and an unresolved call. */

const removedRoute: GraphNode = {
  id: "route:api/DELETE /api/orders/:id",
  kind: "route",
  label: "DELETE /api/orders/:id",
  parentId: "file:api/src/routes/orders.ts",
  method: "DELETE",
  path: "/api/orders/:id",
  layer: "backend",
};

type Mode = "plain" | "trace" | "diff";

interface Placed {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  layer?: Layer;
  state?: NodeState;
}

function DiagramSheet({ mode }: { mode: Mode }) {
  const web = sampleOf("service");
  const route = sampleOf("route");
  const handler = sampleOf("symbol");
  const model = sampleOf("model");
  const store = sampleOf("datastore");
  const stripe = sampleOf("external");
  const unresolved = sampleOf("unresolved");
  const trace = mode === "trace";
  const onPath: NodeState = trace ? { emphasis: "traced" } : {};
  const offPath: NodeState = trace ? { emphasis: "dimmed" } : {};

  const nodes: Placed[] = [
    { node: web.node, x: 32, y: 104, width: 240, state: onPath },
    { node: route.node, x: 512, y: 120, width: 248, state: onPath },
    { node: handler.node, x: 512, y: 264, width: 248, layer: "backend", state: onPath },
    { node: model.node, x: 960, y: 264, width: 200, state: onPath },
    { node: store.node, x: 992, y: 404, width: 136, state: onPath },
    {
      node: stripe.node,
      x: 568,
      y: 424,
      width: 136,
      state: mode === "diff" ? { diff: "added" } : offPath,
    },
    { node: unresolved.node, x: 32, y: 320, width: 260, layer: "frontend", state: offPath },
  ];
  if (mode === "diff") {
    nodes.push({ node: removedRoute, x: 512, y: 24, width: 248, state: { diff: "removed" } });
  }

  const pick = (kind: string, confidence?: string) =>
    edgeSamples.find(
      (s) => s.edge.kind === kind && (!confidence || s.edge.confidence === confidence),
    ) as EdgeSample;
  const path: EdgeState = trace ? { emphasis: "traced" } : {};
  const off: EdgeState = trace ? { emphasis: "dimmed" } : {};
  const writes = pick("writes");
  const edges: Drawn[] = [
    {
      sample: pick("http", "exact"),
      points: [
        { x: 272, y: 144 },
        { x: 512, y: 144 },
      ],
      flow: mode !== "diff",
      state: path,
    },
    {
      sample: pick("handles"),
      points: [
        { x: 636, y: 168 },
        { x: 636, y: 264 },
      ],
      flow: trace,
      state: path,
    },
    {
      sample: { ...writes, edge: { ...writes.edge, confidence: "exact" } },
      points: [
        { x: 760, y: 288 },
        { x: 960, y: 288 },
      ],
      flow: trace,
      state: path,
    },
    {
      sample: pick("stores"),
      points: [
        { x: 1060, y: 312 },
        { x: 1060, y: 404 },
      ],
      flow: trace,
      state: path,
    },
    {
      sample: pick("external_call"),
      points: [
        { x: 636, y: 312 },
        { x: 636, y: 424 },
      ],
      state: mode === "diff" ? { diff: "added" } : off,
    },
    {
      sample: pick("http", "unresolved"),
      points: [
        { x: 152, y: 190 },
        { x: 152, y: 320 },
      ],
      state: off,
    },
  ];
  if (mode === "diff") {
    edges.push({
      sample: {
        ...pick("http", "pattern"),
        edge: { ...pick("http", "pattern").edge, label: "DELETE /api/orders/:id" },
      },
      points: [
        { x: 272, y: 124 },
        { x: 392, y: 124 },
        { x: 392, y: 48 },
        { x: 512, y: 48 },
      ],
      state: { broken: "Route removed in this PR" },
    });
  }

  const titles = {
    plain: "Edges in a diagram",
    trace: "Trace",
    diff: "Diff",
  };
  const notes = {
    plain:
      "A request leaves the web app, hits its route, and reaches Postgres. Flow particles show direction; a dotted edge keeps the call that couldn't be resolved.",
    trace: "The request path in the trace color with flow along it; everything else dims to 20%.",
    diff: "A pull request removed DELETE /api/orders/:id while the web app still calls it: the broken edge pulses in red and says why. The Stripe call is new.",
  };
  return (
    <Page title={titles[mode]} note={notes[mode]}>
      <Board width={1200} height={560} edges={edges}>
        {nodes.map(({ node, x, y, width, layer, state }) => (
          <div key={node.id} style={{ position: "absolute", left: x, top: y, width }}>
            <DiagramNode
              node={node}
              layer={layer}
              {...state}
              style={nodeTier(node) === "icon" ? {} : { width: "100%" }}
            />
          </div>
        ))}
      </Board>
    </Page>
  );
}

const meta: Meta = {
  title: "Components/Edges",
};

export default meta;
type Story = StoryObj;

/** One edge per confidence level, with what its line style means. */
export const Confidence: Story = { render: () => <ConfidenceSheet /> };

/** One edge of every kind with its label. */
export const Kinds: Story = { render: () => <KindSheet /> };

/** Every confidence level in every state. */
export const States: Story = { render: () => <StateMatrix /> };

/** Edges between real nodes, with flow on the request. */
export const Diagram: Story = { render: () => <DiagramSheet mode="plain" /> };

/** The same diagram in trace mode. */
export const Trace: Story = { render: () => <DiagramSheet mode="trace" /> };

/** The same diagram in diff mode, with a broken edge. */
export const Diff: Story = { render: () => <DiagramSheet mode="diff" /> };
