/// <reference types="vite/client" />
import type { ArchitectureGraph } from "@gitinside/schema";
import type { Meta, StoryObj } from "@storybook/react";
import { ExplorerPrototype, type ExplorerPrototypeProps } from "./ExplorerPrototype.js";
import { CHECKOUT_TRACE } from "./trace.js";

// The clickable prototype for the design gate (ROADMAP M4a.7), on the
// analyzer's own output for fixtures/shop-demo: the golden graph, and the
// fixture's source files for the code previews. Nothing here is drawn by hand.

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

function Explorer(props: Partial<ExplorerPrototypeProps>) {
  return (
    <div style={{ height: "100vh" }}>
      <ExplorerPrototype graph={graph} sources={sources} trace={CHECKOUT_TRACE} {...props} />
    </div>
  );
}

const meta: Meta = {
  title: "Prototype/Explorer",
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj;

/** The system level: two services, the database, and Stripe. Click, double-click, press T. */
export const Overview: Story = { render: () => <Explorer /> };

/** The api service broken down in place, with `POST /api/orders` selected (on the module that holds it). */
export const BrokenDown: Story = {
  name: "Broken down",
  render: () => (
    <Explorer initialOpen="service:api/" initialSelected="route:api/POST /api/orders" />
  ),
};

/** The checkout request traced at the system level, on the request step. */
export const Tracing: Story = { render: () => <Explorer initialStep={2} /> };

/** The trace with api broken down, on the step that writes the order. */
export const TracingBrokenDown: Story = {
  name: "Tracing, broken down",
  render: () => <Explorer initialOpen="service:api/" initialStep={4} />,
};
