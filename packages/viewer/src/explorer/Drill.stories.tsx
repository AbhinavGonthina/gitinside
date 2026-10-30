/// <reference types="vite/client" />
import type { ArchitectureGraph } from "@gitinside/schema";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { createLayoutCache, createLayoutEngine, type LayoutEngine } from "../layout/engine.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { DrillCanvas } from "./DrillCanvas.js";
import { useDrill, type Expansion } from "./drill.js";

// The drill-down canvas (M4b.3a) on fixtures/shop-demo's golden graph, laid
// out in a real Web Worker. Double-click or Enter breaks a box down in place;
// Esc goes back up a level. Not the explorer yet (M4b.3b): no selection,
// inspector, or fit. `data-layout-runs-in` says where the layout ran, for the
// visual test ("main" means the worker failed).

const graph = Object.values(
  import.meta.glob<ArchitectureGraph>("../../../../fixtures/shop-demo/expected.json", {
    eager: true,
    import: "default",
  }),
)[0] as ArchitectureGraph;

const index = buildHierarchy(graph);

const layoutWorker = () =>
  new Worker(new URL("../layout/worker.ts", import.meta.url), {
    type: "module",
    name: "gitinside-layout",
  });

function Drilling({ initial }: { initial: Expansion }) {
  const drill = useDrill(index, initial);
  const engine = useMemo(() => createLayoutEngine({ worker: layoutWorker }), []);
  const cache = useMemo(() => createLayoutCache(index, engine), [engine]);
  const [runsIn, setRunsIn] = useState<LayoutEngine["runsIn"]>();
  useEffect(() => () => engine.dispose(), [engine]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    if (drill.up() !== undefined) event.preventDefault();
  }

  return (
    <div data-layout-runs-in={runsIn} onKeyDown={onKeyDown}>
      <DrillCanvas
        index={index}
        view={drill.view}
        cache={cache}
        onOpen={drill.open}
        onLayout={() => setRunsIn(engine.runsIn)}
      />
    </div>
  );
}

const meta: Meta = {
  title: "Explorer/Drill-down",
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj;

/** The system level. Double-click a service (or focus it and press Enter) to break it down. */
export const SystemLevel: Story = {
  name: "System level",
  render: () => <Drilling initial={[]} />,
};

/**
 * Four levels into the api, down to the routes file: its routes have moved
 * from the service's first column into the file, under the file's own row.
 */
export const InsideTheApi: Story = {
  name: "Inside the api",
  render: () => (
    <Drilling
      initial={[
        "service:api/",
        "module:api/src",
        "module:api/src/routes",
        "file:api/src/routes/orders.ts",
      ]}
    />
  ),
};
