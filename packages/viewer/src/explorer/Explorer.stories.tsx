/// <reference types="vite/client" />
import { diffGraphs } from "@gitinside/diff";
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

/**
 * A hint over boxes (M5.13b4): three levels into the web app at full size,
 * so boxes run under the hint, which is drawn above them (cal.diy's boxes
 * covered its words: the camera's transform painted after it).
 */
export const OnboardingOverBoxes: Story = {
  name: "Onboarding over boxes",
  render: function Render() {
    const [store] = useState(() => memoryOnboarding());
    return (
      <Explore
        onboarding={store}
        initialOpen={["service:web/", "module:web/lib", "file:web/lib/orders.ts"]}
        initialZoom={1}
      />
    );
  },
};

// The analyzer's output for fixtures/next-server-actions (ADR-0203).
const ACTIONS = "../../../../fixtures/next-server-actions/";
const actionsGraph = Object.values(
  import.meta.glob<ArchitectureGraph>("../../../../fixtures/next-server-actions/expected.json", {
    eager: true,
    import: "default",
  }),
)[0] as ArchitectureGraph;
const actionsSources = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../../fixtures/next-server-actions/{app,lib}/**/*.{ts,tsx}", {
      eager: true,
      query: "?raw",
      import: "default",
    }),
  ).map(([path, text]) => [path.slice(ACTIONS.length), text]),
);

/**
 * Server actions (M5C.3a2): a client component's calls of `"use server"`
 * functions say "calls · server action" on the line and in the inspector;
 * the page's server-side `listTodos` call stays a plain call.
 */
export const ServerActions: Story = {
  name: "Server actions",
  render: () => (
    <Explore
      graph={actionsGraph}
      sources={actionsSources}
      traceStart="page:todo-actions//todos"
      initialOpen={[
        "service:todo-actions/",
        "module:todo-actions/app/todos",
        "file:todo-actions/app/todos/TodoItem.tsx",
        "file:todo-actions/app/todos/actions.ts",
      ]}
      initialSelected="symbol:todo-actions/app/todos/TodoItem.tsx#TodoItem"
      initialZoom={0.8}
    />
  ),
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

// Diff mode (M6.9b) on the analyzer's output for the fixtures/diff-* pairs,
// diffed here by `packages/diff` with both sides' files (so renames pair).
const DIFF_PAIR = import.meta.glob<ArchitectureGraph>("../../../../fixtures/diff-*/expected.json", {
  eager: true,
  import: "default",
});
const DIFF_FILES = import.meta.glob<string>(
  "../../../../fixtures/diff-*/{src/**/*.ts,prisma/*.prisma}",
  { eager: true, query: "?raw", import: "default" },
);
/** `fixtures/<name>-base` and `-head`, and their diff. */
function diffPair(name: string) {
  const side = (version: "base" | "head") => {
    const folder = `../../../../fixtures/${name}-${version}/`;
    return {
      graph: DIFF_PAIR[`${folder}expected.json`] as ArchitectureGraph,
      file: (path: string) => DIFF_FILES[`${folder}${path}`],
    };
  };
  const [base, head] = [side("base"), side("head")];
  const diff = diffGraphs(base.graph, head.graph, {
    contents: { base: base.file, head: head.file },
  });
  return { base: base.graph, head: head.graph, diff };
}
const diffBroken = diffPair("diff-broken");
const diffRename = diffPair("diff-rename");

function ExploreDiff({
  pair = diffBroken,
  ...props
}: Partial<ExplorerProps> & { pair?: ReturnType<typeof diffPair> }) {
  return (
    <Explore
      graph={pair.head}
      sources={undefined}
      traceStart={undefined}
      diff={{ base: pair.base, diff: pair.diff, baseName: "main", headName: "PR #12" }}
      {...props}
    />
  );
}

/** Switches diff mode to `name` (Base or Head) from the top bar or the canvas, once the canvas is drawn. */
async function showVersion(canvasElement: HTMLElement, name: "Base" | "Head") {
  for (let tries = 0; tries < 250; tries++) {
    const radio = [...canvasElement.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (r) => r.textContent === name,
    );
    if (radio && canvasElement.querySelector('.gi-drill[data-layout="done"]')) {
      radio.click();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${name} couldn't be shown`);
}

/**
 * Diff mode (M6.9b): a PR that removes routes, a file, and a model, at the
 * system level. The service's badges say what changed inside it, the chip
 * what's compared, and the top bar offers Base, Head, and Overlay.
 */
export const Diff: Story = { render: () => <ExploreDiff /> };

/**
 * The same PR broken down: added, changed, and removed (ghosted) boxes, and
 * the connections it breaks drawn dashed red with the diff's own words.
 */
export const DiffBrokenDown: Story = {
  name: "Diff, broken down",
  render: () => <ExploreDiff initialOpen={["service:diff-broken/", "module:diff-broken/src"]} />,
};

/**
 * The same PR zoomed out to 40% (M6.11g2): the pills have faded, so each
 * added, changed, or removed line carries its state's glyph (+, ~, −), not
 * only its color; broken lines keep their dashes and pills (their own ×
 * glyph shows at outline, below).
 */
export const DiffZoomedOut: Story = {
  name: "Diff, zoomed out",
  render: () => (
    <ExploreDiff
      initialOpen={["service:diff-broken/", "module:diff-broken/src"]}
      initialZoom={0.4}
    />
  ),
};

/**
 * The same PR at outline detail, 25% (M6.11l): every pill has faded, broken
 * ones too, so a broken line carries a glyph of its own (×). Under reduced
 * motion it doesn't pulse, and the glyph is what tells it from a dashed
 * heuristic line besides its color (WCAG 1.4.1; `visual/diff.visual.ts`).
 */
export const DiffOutline: Story = {
  name: "Diff, outline",
  render: () => (
    <ExploreDiff
      initialOpen={["service:diff-broken/", "module:diff-broken/src"]}
      initialZoom={0.25}
    />
  ),
};

/**
 * Head alone (M6.9c2): the service counts only head's routes and models, and
 * a line standing for connections head partly dropped says what's left.
 */
export const DiffHead: Story = {
  name: "Diff, head",
  render: () => <ExploreDiff />,
  play: ({ canvasElement }) => showVersion(canvasElement, "Head"),
};

/**
 * Base on a PR that moves a file (M6.9c2): the renamed file keeps its place
 * and takes the name base had, `orders.ts` (head's `routes.ts`).
 */
export const DiffRenamedBase: Story = {
  name: "Diff, renamed, base",
  render: () => (
    <ExploreDiff
      pair={diffRename}
      initialOpen={[
        "service:diff-rename/",
        "module:diff-rename/src",
        "module:diff-rename/src/orders",
      ]}
      initialSelected="file:diff-rename/src/orders/routes.ts"
    />
  ),
  play: ({ canvasElement }) => showVersion(canvasElement, "Base"),
};

/**
 * Without the top bar, as on the website (M6.9e2b): Base, Head, and Overlay
 * sit beside the "Comparing" chip on the canvas, here on Head.
 */
export const DiffBare: Story = {
  name: "Diff, without the top bar",
  render: () => <ExploreDiff topBar={false} />,
  play: ({ canvasElement }) => showVersion(canvasElement, "Head"),
};

/**
 * A row picked in the changes list (M6.9d): the explorer breaks the service
 * down to the removed route, selects it, and zooms in to read it; the
 * inspector lists the route's own change. The play ends once focus is on
 * the route's box, which is drawn a layout after the click (M5B.9: CI's shot
 * sometimes came before it, without the focus ring).
 */
export const DiffChangePicked: Story = {
  name: "Diff, change picked",
  render: () => <ExploreDiff />,
  play: async ({ canvasElement }) => {
    const route = '[data-node-id="route:diff-broken/DELETE /api/orders/:id"] > .gi-node';
    let clicked = false;
    for (let tries = 0; tries < 500; tries++) {
      const row = canvasElement.querySelector<HTMLElement>(
        '.gi-changes button[aria-label^="Removed: DELETE /api/orders/:id"]',
      );
      if (!clicked && row && canvasElement.querySelector('.gi-drill[data-layout="done"]')) {
        row.click();
        clicked = true;
      }
      if (clicked && document.activeElement === canvasElement.querySelector(route)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      clicked ? "The picked route's box didn't get focus" : "The changes list's row wasn't drawn",
    );
  },
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
