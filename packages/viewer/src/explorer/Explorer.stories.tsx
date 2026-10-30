/// <reference types="vite/client" />
import type { ArchitectureGraph } from "@gitinside/schema";
import type { Meta, StoryObj } from "@storybook/react";
import { Explorer, type ExplorerProps } from "./Explorer.js";
import { CHECKOUT_TRACE } from "./trace.js";

// The explorer (M4b.3b) on the analyzer's own output for fixtures/shop-demo:
// the golden graph, and the fixture's source files for the code previews.
// Nothing here is drawn by hand. Layouts run in a real Web Worker; the root's
// `data-layout-runs-in` says where, for the visual test.

const FIXTURE = "../../../../fixtures/shop-demo/";

const graph = Object.values(
  import.meta.glob<ArchitectureGraph>("../../../../fixtures/shop-demo/expected.json", {
    eager: true,
    import: "default",
  }),
)[0] as ArchitectureGraph;

const sources = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../../fixtures/shop-demo/apps/**/*.{ts,tsx,prisma}", {
      eager: true,
      query: "?raw",
      import: "default",
    }),
  ).map(([path, text]) => [path.slice(FIXTURE.length), text]),
);

const layoutWorker = () =>
  new Worker(new URL("../layout/worker.ts", import.meta.url), {
    type: "module",
    name: "gitinside-layout",
  });

function Explore(props: Partial<ExplorerProps>) {
  return (
    <div style={{ height: "100vh" }}>
      <Explorer
        graph={graph}
        sources={sources}
        trace={CHECKOUT_TRACE}
        layoutWorker={layoutWorker}
        {...props}
      />
    </div>
  );
}

const meta: Meta = {
  title: "Explorer/Explorer",
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj;

/** The system level: two services, the database, and Stripe. Click, double-click, press T. */
export const Overview: Story = { render: () => <Explore /> };

/** The api broken down in place: its routes first, then its folders, with `POST /api/orders` selected. */
export const BrokenDown: Story = {
  name: "Broken down",
  render: () => (
    <Explore initialOpen={["service:api/"]} initialSelected="route:api/POST /api/orders" />
  ),
};

/** Three levels into the web app, down to the file that calls the api, with `placeOrder` selected. */
export const DrilledDeep: Story = {
  name: "Drilled deep",
  render: () => (
    <Explore
      initialOpen={["service:web/", "module:web/lib", "file:web/lib/orders.ts"]}
      initialSelected="symbol:web/lib/orders.ts#placeOrder"
    />
  ),
};

/** The checkout request traced at the system level, on the request step. */
export const Tracing: Story = { render: () => <Explore initialStep={2} /> };

/** The trace with the api and its `src` broken down, on the step that writes the order. */
export const TracingBrokenDown: Story = {
  name: "Tracing, broken down",
  render: () => <Explore initialOpen={["service:api/", "module:api/src"]} initialStep={4} />,
};
