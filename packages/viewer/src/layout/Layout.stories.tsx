/// <reference types="vite/client" />
import type { ArchitectureGraph } from "@gitinside/schema";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useMemo, useState } from "react";
import { DiagramEdge, EdgeLabel } from "../edges/DiagramEdge.js";
import { buildHierarchy, layerOf, nodeOf } from "../model/hierarchy.js";
import { buildView, drawnEdge } from "../model/view.js";
import { DiagramNode } from "../nodes/DiagramNode.js";
import { nodeTier } from "../nodes/describe.js";
import type { LayoutResult } from "./elk.js";
import { createLayoutCache, createLayoutEngine, type LayoutEngine } from "./engine.js";
import { edgeLabelSize, frameCounts } from "./size.js";

// The ELK layout (M4b.2) of fixtures/shop-demo's golden graph, drawn with the
// real node and edge components, laid out in a real Web Worker. Not the
// explorer (M4b.3 draws from the same result with drill-down and motion):
// this shows the layout alone, at 1:1, for screenshots and the visual test's
// fit checks. `data-layout` is "pending" until the worker answers, and
// `data-layout-runs-in` says where it ran ("main" means the worker failed).

const graph = Object.values(
  import.meta.glob<ArchitectureGraph>("../../../../fixtures/shop-demo/expected.json", {
    eager: true,
    import: "default",
  }),
)[0] as ArchitectureGraph;

const index = buildHierarchy(graph);

const layoutWorker = () =>
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "gitinside-layout" });

function LaidOut({ expanded }: { expanded: readonly string[] }) {
  const view = useMemo(() => buildView(index, expanded), [expanded]);
  const [laid, setLaid] = useState<{ result: LayoutResult; runsIn: LayoutEngine["runsIn"] }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const engine = createLayoutEngine({ worker: layoutWorker });
    const cache = createLayoutCache(index, engine);
    let live = true;
    cache.layout(view).then(
      (result) => live && setLaid({ result, runsIn: engine.runsIn }),
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
      engine.dispose();
    };
  }, [view]);

  if (error) return <p role="alert">Layout failed: {error}</p>;
  if (!laid) return <div data-layout="pending" />;
  const { result, runsIn } = laid;
  const edges = new Map(view.edges.map((e) => [e.id, e]));

  return (
    <div
      data-layout="done"
      data-layout-runs-in={runsIn}
      style={{ position: "relative", width: result.width, height: result.height }}
    >
      {result.boxes.map((box) => {
        const n = view.byId.get(box.id);
        if (!n) return null;
        const frame = nodeTier(n.node) === "frame";
        return (
          <div
            key={box.id}
            style={{
              position: "absolute",
              zIndex: n.open ? 0 : 2,
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
            }}
          >
            <DiagramNode
              node={n.node}
              layer={layerOf(index, n.id)}
              counts={frame && !n.open ? frameCounts(index, n.id) : []}
              expanded={n.open}
              style={{
                width: "100%",
                height: "100%",
                ...(frame && !n.open ? { alignContent: "center" } : {}),
              }}
            />
          </div>
        );
      })}
      <svg
        width={result.width}
        height={result.height}
        role="group"
        aria-label="Connections"
        style={{ position: "absolute", inset: 0, zIndex: 1, overflow: "visible" }}
      >
        {result.edges.map((placed) => {
          const view = edges.get(placed.id);
          if (!view) return null;
          const { edge, count } = drawnEdge(view);
          return (
            <DiagramEdge
              key={placed.id}
              edge={edge}
              count={count}
              points={placed.points}
              layer={layerOf(index, view.from)}
              ends={{ from: nodeOf(index, view.from).label, to: nodeOf(index, view.to).label }}
            />
          );
        })}
      </svg>
      {result.edges.map((placed) => {
        const view = edges.get(placed.id);
        if (!view) return null;
        const { edge, count } = drawnEdge(view);
        return (
          <EdgeLabel
            key={placed.id}
            edge={edge}
            count={count}
            layer={layerOf(index, view.from)}
            data-measured-width={edgeLabelSize(view).width}
            style={{ left: placed.label.x, top: placed.label.y, zIndex: 3 }}
          />
        );
      })}
    </div>
  );
}

const meta: Meta = {
  title: "Explorer/Layout",
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj;

/** The system level: services, the database, and Stripe, left to right as a request goes. */
export const SystemLevel: Story = {
  name: "System level",
  render: () => <LaidOut expanded={[]} />,
};

/** Both services broken down: each one's routes and pages in its first column, then its folders. */
export const ServicesBrokenDown: Story = {
  name: "Services broken down",
  render: () => <LaidOut expanded={["service:web/", "service:api/"]} />,
};

/** Folders inside the api broken down too: frames nested three deep, edges routed across them. */
export const FoldersBrokenDown: Story = {
  name: "Folders broken down",
  render: () => (
    <LaidOut
      expanded={[
        "service:web/",
        "service:api/",
        "module:api/src",
        "module:api/src/orders",
        "module:api/src/routes",
      ]}
    />
  ),
};
