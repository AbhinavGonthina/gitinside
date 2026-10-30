import type { Meta, StoryObj } from "@storybook/react";
import type { CSSProperties, ReactNode } from "react";
import { cssVar } from "../tokens.js";
import { DiagramNode } from "./DiagramNode.js";
import { kindName, nodeTier, type NodeState } from "./describe.js";
import { nodeSamples, nodeStates, sampleOf, type NodeSample } from "./samples.js";

// Every node kind, every state, and frames opened in place, in whichever
// theme the toolbar selects.

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

/** A sample drawn as a node, sized the way the canvas would size its tier. */
function Sample({ sample, state = {} }: { sample: NodeSample; state?: NodeState }) {
  const { node, layer, counts } = sample;
  return (
    <DiagramNode
      node={node}
      layer={layer}
      counts={counts}
      {...state}
      style={nodeTier(node) === "icon" ? {} : { width: "100%" }}
    />
  );
}

function KindSheet() {
  const tiers = [
    { tier: "frame", title: "Frames, closed", min: 280 },
    { tier: "card", title: "Cards", min: 280 },
    { tier: "icon", title: "Icon-first", min: 136 },
  ] as const;
  return (
    <Page
      title="Nodes"
      note="Every kind in its own shape: a frontend service is a window, a backend one a box, a module a folder; routes are capsules, pages windows, models tables; datastores, queues, and outside APIs lead with their icon on a cylinder, a pipe, and a circle."
    >
      {tiers.map(({ tier, title, min }) => (
        <section key={tier} style={{ display: "grid", gap: cssVar("space-12") }}>
          <h2 style={{ margin: 0, fontSize: cssVar("font-size-14"), color: cssVar("text-muted") }}>
            {title}
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`,
              gap: cssVar("space-16"),
              justifyItems: tier === "icon" ? "start" : "stretch",
              // Each shape keeps its own height (a table is taller than a capsule).
              alignItems: "start",
            }}
          >
            {nodeSamples
              .filter((s) => nodeTier(s.node) === tier)
              .map((s) => (
                <Sample key={s.node.id} sample={s} />
              ))}
          </div>
        </section>
      ))}
    </Page>
  );
}

function StateMatrix() {
  return (
    <Page
      title="Node states"
      note="Each kind in each state. States combine: a node can be selected and traced, or selected and changed."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `120px repeat(${nodeStates.length}, 248px)`,
          gap: `${cssVar("space-16")} ${cssVar("space-16")}`,
          alignItems: "center",
        }}
      >
        <span />
        {nodeStates.map(({ name }) => (
          <span key={name} style={muted}>
            {name}
          </span>
        ))}
        {nodeSamples.map((s) => (
          <Row key={s.node.id} sample={s} />
        ))}
      </div>
    </Page>
  );
}

function Row({ sample }: { sample: NodeSample }) {
  return (
    <>
      <span style={muted}>{kindName(sample.node)}</span>
      {nodeStates.map(({ name, state }) => (
        <div key={name} style={{ display: "flex", justifyContent: "center" }}>
          <Sample sample={sample} state={state} />
        </div>
      ))}
    </>
  );
}

function FrameSheet() {
  const card = (kind: Parameters<typeof sampleOf>[0], state: NodeState = {}) => (
    <div style={{ width: 248 }}>
      <Sample sample={sampleOf(kind)} state={state} />
    </div>
  );
  const symbols = nodeSamples.filter((s) => s.node.kind === "symbol");
  const [web, api] = nodeSamples.filter((s) => s.node.kind === "service") as [
    NodeSample,
    NodeSample,
  ];
  const routes = sampleOf("module");
  return (
    <Page
      title="Frames"
      note="Breaking a node down opens it in place: the service becomes a translucent frame, and its modules open inside it."
    >
      <div style={{ display: "flex", gap: cssVar("space-24"), alignItems: "flex-start" }}>
        <DiagramNode node={api.node} counts={api.counts} expanded style={{ width: 600 }}>
          <DiagramNode
            node={routes.node}
            layer="backend"
            counts={routes.counts}
            expanded
            style={{ width: "100%" }}
          >
            {card("route", { selected: true })}
            {card("file")}
            {symbols.map((s) => (
              <div key={s.node.id} style={{ width: 248 }}>
                <Sample sample={s} />
              </div>
            ))}
          </DiagramNode>
          <div style={{ width: 260 }}>
            <DiagramNode
              node={{
                id: "module:api/src/services",
                kind: "module",
                label: "services",
                parentId: "service:api",
                path: "apps/api/src/services",
              }}
              layer="backend"
              counts={[{ value: 4, noun: "file" }]}
              style={{ width: "100%" }}
            />
          </div>
        </DiagramNode>
        <div style={{ display: "grid", gap: cssVar("space-24") }}>
          <div style={{ width: 280 }}>
            <Sample sample={web} />
          </div>
          <Sample sample={sampleOf("datastore")} />
        </div>
      </div>
    </Page>
  );
}

const meta: Meta = {
  title: "Components/Nodes",
};

export default meta;
type Story = StoryObj;

/** One node of every kind, grouped by container style. */
export const Kinds: Story = { render: () => <KindSheet /> };

/** Every kind in every state. */
export const States: Story = { render: () => <StateMatrix /> };

/** A service opened in place, with a module opened inside it. */
export const Frames: Story = { render: () => <FrameSheet /> };
