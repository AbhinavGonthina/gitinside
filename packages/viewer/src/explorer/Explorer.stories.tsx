/// <reference types="vite/client" />
import type { ArchitectureGraph } from "@gitinside/schema";
import type { Meta, StoryObj } from "@storybook/react";
import { withTestFiles } from "../model/filterSamples.js";
import { DEFAULT_FILTERS } from "../model/filters.js";
import { useState } from "react";
import { Explorer, type ExplorerProps } from "./Explorer.js";
import { memoryOnboarding } from "./onboarding.js";

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
        traceStart="page:web//checkout"
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

/**
 * Zoomed out to 55% with the api broken down (M4b.4b): box names stay;
 * subtitles, counts, and edge labels are gone, except the selected route's.
 */
export const ZoomedOut: Story = {
  name: "Zoomed out",
  render: () => (
    <Explore
      initialOpen={["service:api/"]}
      initialSelected="route:api/POST /api/orders"
      initialZoom={0.55}
    />
  ),
};

/**
 * Zoomed out to 25% with both services broken down: an outline of service
 * names and the lines between services; the selected folder keeps its name.
 */
export const Outline: Story = {
  render: () => (
    <Explore
      initialOpen={["service:web/", "service:api/"]}
      initialSelected="module:web/lib"
      initialZoom={0.25}
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

/**
 * The home page's request path (M4b.6a): it ends on the step whose URL the
 * analyzer couldn't resolve, shown as the unresolved call it is.
 */
export const TracingUnresolved: Story = {
  name: "Tracing, unresolved",
  render: () => <Explore initialOpen={["service:web/"]} traceStart="page:web//" initialStep={2} />,
};

/**
 * The trace picker (M4b.6b): with no start and nothing traceable selected, T
 * lists the pages and routes that have a request path, here searched for
 * "orders".
 */
export const TracePicker: Story = {
  name: "Trace picker",
  render: () => <Explore traceStart={undefined} />,
  play: async ({ canvasElement }) => {
    await typeInPalette(canvasElement, { key: "t" }, "orders");
  },
};

/**
 * The command palette (M4b.7): Ctrl+K searches every node by name and path,
 * here "orders": folders, the component, and the function named so first,
 * then files, the page, routes, and functions that start a word with it.
 */
export const Search: Story = {
  render: () => <Explore />,
  play: async ({ canvasElement }) => {
    await typeInPalette(canvasElement, { key: "k", ctrlKey: true }, "orders");
  },
};

/**
 * The filters (M4b.8b) on the demo plus a test folder, a spec, and a config
 * file: tests and config hidden by default, models hidden by hand, the chip
 * saying how much is off, and the popover open from the top bar.
 */
export const Filters: Story = {
  render: () => (
    <Explore
      graph={withTestFiles(graph)}
      initialOpen={["service:api/", "module:api/src"]}
      initialFilters={{ ...DEFAULT_FILTERS, kinds: ["model"] }}
    />
  ),
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>(".gi-topbar__filters")?.click();
    for (let tries = 0; tries < 50; tries++) {
      if (canvasElement.querySelector('.gi-filters[data-state="open"]')) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The filters didn't open");
  },
};

/**
 * The share menu (M4b.9b, M4b.10b) open from the top bar with the api broken
 * down: the link to this view with Copy link, then Export (SVG and PNG in the
 * screen's theme, or Mermaid, saved or copied).
 */
export const Share: Story = {
  render: () => (
    <Explore
      initialOpen={["service:api/"]}
      initialSelected="route:api/POST /api/orders"
      linkTo={(query) => `https://gitinside.abhinavgonthina.dev/acme/shop/a1b2c3d?${query}`}
    />
  ),
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>(".gi-share-menu__trigger")?.click();
    for (let tries = 0; tries < 50; tries++) {
      if (canvasElement.querySelector('.gi-share[data-state="open"]')) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The share menu didn't open");
  },
};

/**
 * A first visit (M4b.12a): the first of three hints, zoom in → select →
 * trace, at the top of the canvas. Here they're kept in memory, so each
 * visit to the story starts over.
 */
export const Onboarding: Story = {
  render: function Render() {
    const [store] = useState(() => memoryOnboarding());
    return <Explore onboarding={store} />;
  },
};

/** What the analyzer says about files it skipped or couldn't read (M4b.12b). */
const WARNINGS = [
  { code: "SYNTAX_ERROR", message: "';' expected.", file: "apps/web/lib/legacy/cart.ts" },
  { code: "SKIPPED_LARGE", message: "file is 3145728 bytes; skipped", file: "data/seed.json" },
  ...Array.from({ length: 7 }, (_, i) => ({
    code: "SKIPPED_GENERATED",
    message: "generated file skipped (minified)",
    file: `apps/web/public/vendor/chart.${i + 1}.min.js`,
  })),
];

/**
 * The analysis's warnings (M4b.12b): a chip above the breadcrumbs says how
 * many, and the repo overview lists them by kind, with the file and the
 * analyzer's own words; a long kind shows five and "Show all".
 */
export const Warnings: Story = {
  render: () => <Explore graph={{ ...graph, warnings: WARNINGS }} />,
};

/**
 * A repo with no TypeScript or JavaScript app (UX.md "States", M4b.12b): one
 * card where the diagram would be, with what the analysis skipped; no canvas,
 * search, filters, share, or trace.
 */
export const NoApp: Story = {
  name: "No app",
  render: () => (
    <Explore
      graph={{
        ...graph,
        nodes: graph.nodes.filter((n) => ["system", "service", "datastore"].includes(n.kind)),
        edges: [],
        warnings: [
          {
            code: "TSCONFIG_MISSING",
            message: "no tsconfig.json found; using defaults",
            file: "apps/web",
          },
          { code: "SKIPPED_SYMLINK", message: "symbolic link not followed", file: "docs/latest" },
        ],
      }}
    />
  ),
};

/** Opens a palette with a key on the explorer and types `text` into its field. */
async function typeInPalette(canvasElement: HTMLElement, key: KeyboardEventInit, text: string) {
  canvasElement
    .querySelector(".gi-explorer")
    ?.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true }));
  // The palette is drawn on React's next render.
  let field: HTMLInputElement | null = null;
  for (let tries = 0; !field && tries < 50; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    field = canvasElement.querySelector<HTMLInputElement>(".gi-palette input");
  }
  if (!field) throw new Error("The palette didn't open");
  // React tracks an input's value: set it the way typing does, then say so.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
