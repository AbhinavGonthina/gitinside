import { composeStories } from "@storybook/react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewExport } from "../export/files.js";
import { SAMPLE_TESTS, withTestFiles } from "../model/filterSamples.js";
import { NO_FILTERS } from "../model/filters.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { shopDemo, shopDemoSources } from "../shopDemo.testkit.js";
import { durations } from "../tokens.js";
import { decodeState, DEFAULT_STATE, encodeState, type ExplorerState } from "./deepLink.js";
import * as stories from "./Explorer.stories.js";
import { Explorer, PLAY_STEP_MS } from "./Explorer.js";
import { traceFrom } from "./trace.js";

const CHECKOUT = "page:web//checkout";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const graph = shopDemo();
const index = buildHierarchy(graph);
const sources = shopDemoSources([
  "apps/api/src/routes/orders.ts",
  "apps/api/src/orders/handlers.ts",
  "apps/web/lib/orders.ts",
]);

const WEB = "service:web/";
const API = "service:api/";
const SRC = "module:api/src";
const ROUTE = "route:api/POST /api/orders";
const PLACE_ORDER = "symbol:web/lib/orders.ts#placeOrder";

/** The line a node of the demo graph is defined on. */
function sourceLine(id: string): number {
  const node = index.byId.get(id);
  const line = node && "source" in node ? node.source?.line : undefined;
  if (line === undefined) throw new Error(`no source line for ${id}`);
  return line;
}

/**
 * Matches the code preview's line reading `text` (indentation aside, like
 * `getByText`), whether it's still plain or already split into Shiki's token
 * spans (M4b.5b).
 */
function codeLine(text: string) {
  return (_: string, el: Element | null) =>
    el?.matches(".gi-code__line > code") === true && el.textContent?.trim() === text;
}

/** Waits until the canvas has drawn the current level (layouts run on the main thread here). */
async function settle() {
  await waitFor(
    () => {
      const canvas = document.querySelector(".gi-drill");
      expect(canvas?.getAttribute("data-layout")).toBe("done");
      expect(canvas?.hasAttribute("aria-busy")).toBe(false);
    },
    { timeout: 10_000 },
  );
}

async function setup(props: Partial<Parameters<typeof Explorer>[0]> = {}) {
  const view = render(
    <Explorer graph={graph} sources={sources} traceStart={CHECKOUT} {...props} />,
  );
  await settle();
  /** A box on the canvas by node ID (not one folding away). */
  const box = (id: string) =>
    [...view.container.querySelectorAll<HTMLElement>(".gi-drill__node:not([data-leaving])")]
      .find((el) => el.dataset.nodeId === id)
      ?.querySelector<HTMLElement>(":scope > .gi-node") ?? null;
  /** Whether a box is broken down (a frame or an open file). */
  const isOpen = (id: string) => box(id)?.parentElement?.hasAttribute("data-open");
  const heading = () =>
    within(screen.getByRole("complementary")).getByRole("heading", { level: 2 });
  const root = () => view.container.querySelector(".gi-explorer") as HTMLElement;
  /** A key on the explorer (or `target`), then the next level drawn. */
  const press = async (key: string, target: Element = root()) => {
    fireEvent.keyDown(target, { key });
    await settle();
  };
  const act2 = async (fn: () => void) => {
    fn();
    await settle();
  };
  const crumbs = () => screen.getByRole("navigation", { name: "Drill-down path" }).textContent;
  return { ...view, box, isOpen, heading, press, act: act2, crumbs };
}

// Each test lays out several levels with ELK on the main thread; under CI's
// coverage instrumentation that outlasts vitest's 5 s default (M4b.3b1).
describe("Explorer", { timeout: 30_000 }, () => {
  it("opens at the system level with the repo overview in the inspector", async () => {
    const { container, box, heading, crumbs } = await setup();
    expect(container.querySelectorAll(".gi-drill__node")).toHaveLength(4);
    expect(box(WEB)).not.toBeNull();
    expect(box("datastore:infra/db")).not.toBeNull();
    expect(heading().textContent).toBe("shop-demo");
    expect(screen.getByText(/2 services, 1 datastore and 1 outside API/)).toBeTruthy();
    // One aggregated request edge, labeled with its count.
    expect(screen.getByText("2 requests")).toBeTruthy();
    expect(crumbs()).toBe("shop-demo");
  });

  it("selects on click, highlights the node's edges, and clears on the canvas", async () => {
    const { container, box, heading } = await setup();
    fireEvent.click(box(API) as HTMLElement);
    expect(heading().textContent).toBe("@shop/api");
    expect(box(API)?.hasAttribute("data-selected")).toBe(true);
    expect(container.querySelectorAll(".gi-edge[data-selected]")).toHaveLength(3);
    expect(screen.getByText("Express", { selector: "dd" })).toBeTruthy();
    fireEvent.click(screen.getByRole("region", { name: "Diagram" }));
    expect(heading().textContent).toBe("shop-demo");
  });

  it("announces the selection and what it connects to, and its clearing (UX.md)", async () => {
    const { container, box } = await setup();
    const live = () => container.querySelector('[aria-live="polite"]')?.textContent;
    fireEvent.click(box("datastore:infra/db") as HTMLElement);
    expect(live()).toBe("db, datastore. Called by Order.");
    fireEvent.click(box(API) as HTMLElement);
    // The web app's two calls to it, its payment provider, and its database, in graph order.
    expect(live()).toBe(
      "@shop/api, service. Calls api.stripe.com, db. Called by listOrders, placeOrder.",
    );
    fireEvent.click(screen.getByRole("region", { name: "Diagram" }));
    expect(live()).toBe("Selection cleared");
  });

  it("draws the boxes as a tree: level, place, broken down, selected (M4b.11)", async () => {
    const { box, act } = await setup({ initialSelected: ROUTE });
    const tree = screen.getByRole("tree", { name: "Architecture" });
    const top = buildView(index, []).childrenOf.get(index.root.id) ?? [];
    expect(within(tree).getAllByRole("treeitem")).toHaveLength(top.length);
    const api = box(API) as HTMLElement;
    expect(api.getAttribute("role")).toBe("treeitem");
    expect(api.getAttribute("aria-level")).toBe("1");
    expect(api.getAttribute("aria-setsize")).toBe(String(top.length));
    expect(api.getAttribute("aria-posinset")).toBe(String(top.indexOf(API) + 1));
    expect(api.getAttribute("aria-expanded")).toBe("false");
    // The box holding the selection is selected; the state isn't repeated in its name.
    expect(api.getAttribute("aria-selected")).toBe("true");
    expect(api.getAttribute("aria-label")).toBe("@shop/api, service");
    // Nothing inside a datastore: no expanded state at all.
    const db = box("datastore:infra/db") as HTMLElement;
    expect(db.hasAttribute("aria-expanded")).toBe(false);
    expect(db.getAttribute("aria-selected")).toBe("false");

    await act(() => fireEvent.keyDown(api, { key: "Enter" }));
    expect(box(API)?.getAttribute("aria-expanded")).toBe("true");
    const inside = buildView(index, [API]).childrenOf.get(API) ?? [];
    const route = box(ROUTE) as HTMLElement;
    expect(route.getAttribute("aria-level")).toBe("2");
    expect(route.getAttribute("aria-setsize")).toBe(String(inside.length));
    expect(route.getAttribute("aria-posinset")).toBe(String(inside.indexOf(ROUTE) + 1));
    expect(route.getAttribute("aria-selected")).toBe("true");
    expect(box(API)?.getAttribute("aria-selected")).toBe("false");
  });

  it("moves focus to the nearest box with the arrow keys", async () => {
    const { container, box } = await setup();
    const rect = (id: string) => {
      const el = box(id)?.parentElement as HTMLElement;
      return { x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
    };
    const ids = buildView(index, []).childrenOf.get(index.root.id) ?? [];
    // The leftmost box, then right as far as it goes, each step further right.
    const first = [...ids].sort((a, b) => rect(a).x - rect(b).x)[0] as string;
    (box(first) as HTMLElement).focus();
    const visited = [first];
    for (;;) {
      const from = document.activeElement as HTMLElement;
      const event = fireEvent.keyDown(from, { key: "ArrowRight" });
      // The page never scrolls on an arrow, even at the last box.
      expect(event).toBe(false);
      const to = (document.activeElement as HTMLElement).parentElement?.dataset.nodeId;
      if (!to || to === visited.at(-1)) break;
      expect(rect(to).x).toBeGreaterThan(rect(visited.at(-1) as string).x);
      visited.push(to);
    }
    expect(visited.length).toBeGreaterThan(1);
    // Left goes back the way it came.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(box(visited.at(-2) as string));
    // With a modifier, an arrow is left alone (the browser's or a screen reader's).
    const before = document.activeElement;
    expect(fireEvent.keyDown(before as HTMLElement, { key: "ArrowLeft", shiftKey: true })).toBe(
      true,
    );
    expect(document.activeElement).toBe(before);
    // Arrows don't select or break down.
    expect(container.querySelector("[data-selected]")).toBeNull();
  });

  it("breaks a service down in place, routes first, and goes back up with Esc or a breadcrumb", async () => {
    const { container, box, press, act, crumbs } = await setup();
    await act(() => fireEvent.doubleClick(box(API) as HTMLElement));
    expect(box(API)?.getAttribute("data-expanded")).toBe("true");
    // The service's first level: its routes, then its folders.
    const inside = buildView(index, [API]).childrenOf.get(API) ?? [];
    expect(inside[0]).toMatch(/^route:/);
    for (const id of inside) expect(box(id)).not.toBeNull();
    expect(box(SRC)).not.toBeNull();
    expect(crumbs()).toBe("shop-demo@shop/api");
    await press("Escape");
    expect(box(SRC)).toBeNull();

    await act(() => fireEvent.doubleClick(box(API) as HTMLElement));
    await act(() => fireEvent.click(screen.getByRole("button", { name: "shop-demo" })));
    expect(box(SRC)).toBeNull();
    // Datastores have nothing inside, so they don't open.
    fireEvent.doubleClick(box("datastore:infra/db") as HTMLElement);
    await settle();
    expect(container.querySelectorAll(".gi-drill__node:not([data-leaving])")).toHaveLength(4);
  });

  it("drills any number of levels, Esc closing the last opened first", async () => {
    const { box, press, act, crumbs, container } = await setup();
    await act(() => fireEvent.doubleClick(box(API) as HTMLElement));
    await act(() => fireEvent.doubleClick(box(SRC) as HTMLElement));
    expect(box(SRC)?.getAttribute("data-expanded")).toBe("true");
    expect(box("module:api/src/orders")).not.toBeNull();
    expect(crumbs()).toBe("shop-demo@shop/apisrc");
    // A breadcrumb goes back to its level, closing what's inside it.
    await act(() => fireEvent.click(screen.getByRole("button", { name: "@shop/api" })));
    expect(box("module:api/src/orders")).toBeNull();
    expect(box(SRC)).not.toBeNull();
    await act(() => fireEvent.doubleClick(box(SRC) as HTMLElement));
    await press("Escape");
    expect(box("module:api/src/orders")).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("Back to @shop/api");
    await press("Escape");
    expect(box(SRC)).toBeNull();
    expect(crumbs()).toBe("shop-demo");
  });

  it("breaks down with Enter or the inspector's button, and selects with Space", async () => {
    const { box, heading, act } = await setup();
    fireEvent.keyDown(box(WEB) as HTMLElement, { key: " " });
    expect(heading().textContent).toBe("@shop/web");
    await act(() => fireEvent.click(screen.getByRole("button", { name: /Break down/ })));
    expect(box("module:web/lib")).not.toBeNull();
    expect(screen.getByText("3 calls")).toBeTruthy();
    // The unresolved call is drawn, with its reason, not dropped.
    expect(box("unresolved:web/lib/cms.ts:3:21")).not.toBeNull();
    expect(screen.getByText("No route in the repo matches")).toBeTruthy();
    // Enter on a box that can't open selects it instead.
    fireEvent.keyDown(box("unresolved:web/lib/cms.ts:3:21") as HTMLElement, { key: "Enter" });
    expect(heading().textContent).toBe("GET {env:CMS_URL}/posts");
    await act(() => fireEvent.keyDown(box("module:web/lib") as HTMLElement, { key: "Enter" }));
    expect(box("file:web/lib/orders.ts")).not.toBeNull();
    // The open frame selects with Enter.
    fireEvent.keyDown(box(WEB) as HTMLElement, { key: "Enter" });
    expect(heading().textContent).toBe("@shop/web");
    expect(screen.queryByRole("button", { name: /Break down/ })).toBeNull();
  });

  it("shows a route's facts, connections, and code, and drills to a connection", async () => {
    const { box, isOpen, heading, act } = await setup({ initialSelected: ROUTE });
    expect(screen.getByText("/api/orders", { selector: "dd code" })).toBeTruthy();
    const preview = screen.getByRole("figure");
    expect(within(preview).getByText(codeLine('orders.post("/", createOrder);'))).toBeTruthy();
    expect(preview.querySelector("[data-highlight]")?.textContent).toContain("orders.post");
    // No commit SHA in the fixture graph, so no GitHub link rather than a branch link.
    expect(within(preview).queryByText("Open on GitHub")).toBeNull();
    // At the system level, the box holding the selection is marked.
    expect(box(API)?.hasAttribute("data-selected")).toBe(true);

    await act(() => fireEvent.click(screen.getByRole("button", { name: /placeOrder/ })));
    expect(heading().textContent).toBe("placeOrder");
    // Drilled down to its file, so the function itself is its own selected box.
    expect(isOpen(WEB)).toBe(true);
    expect(isOpen("module:web/lib")).toBe(true);
    expect(isOpen("file:web/lib/orders.ts")).toBe(true);
    expect(box(PLACE_ORDER)?.hasAttribute("data-selected")).toBe(true);

    await act(() => fireEvent.click(screen.getByRole("button", { name: /^POST \/api\/orders/ })));
    expect(heading().textContent).toBe("POST/api/orders"); // method chip, then the path
    // A route needs only its service open; the web app stays as it was.
    expect(box(ROUTE)?.hasAttribute("data-selected")).toBe(true);
    expect(isOpen(API)).toBe(true);
    expect(isOpen(SRC)).toBe(false);
    expect(box(PLACE_ORDER)).not.toBeNull();
  });

  it("loads a selection's code through loadSource, once per file, with Open on GitHub at the line", async () => {
    let finish: (text: string | undefined) => void = () => {};
    const loadSource = vi.fn(
      (_path: string) =>
        new Promise<string | undefined>((resolve) => {
          finish = resolve;
        }),
    );
    const shaGraph = { ...graph, repo: { ...graph.repo, sha: "0123456789abcdef" } };
    const { act } = await setup({
      graph: shaGraph,
      sources: undefined,
      loadSource,
      initialSelected: ROUTE,
    });
    const line = sourceLine(ROUTE);
    const href = `https://github.com/${graph.repo.owner}/${graph.repo.name}/blob/0123456789abcdef/apps/api/src/routes/orders.ts#L${line}`;
    // Open on GitHub is there before (and whether or not) the code arrives.
    expect(screen.getByRole("link", { name: /Open on GitHub/ }).getAttribute("href")).toBe(href);
    expect(screen.getByRole("figure").getAttribute("aria-busy")).toBe("true");
    expect(loadSource).toHaveBeenCalledWith("apps/api/src/routes/orders.ts");

    await act(() => finish(sources["apps/api/src/routes/orders.ts"]));
    await waitFor(() =>
      expect(
        within(screen.getByRole("figure")).getByText(codeLine('orders.post("/", createOrder);')),
      ).toBeTruthy(),
    );
    expect(
      screen.getByRole("link", { name: "apps/api/src/routes/orders.ts" }).getAttribute("href"),
    ).toBe(href);

    // Away (another file, another load) and back: the route's file is already
    // here, so no second load and no loading frame.
    await act(() => fireEvent.click(screen.getByRole("button", { name: /placeOrder/ })));
    expect(loadSource).toHaveBeenCalledTimes(2);
    expect(loadSource).toHaveBeenLastCalledWith("apps/web/lib/orders.ts");
    // Checked in the click's own render, before any promise settles.
    fireEvent.click(screen.getByRole("button", { name: /^POST \/api\/orders/ }));
    expect(screen.getByRole("figure").hasAttribute("aria-busy")).toBe(false);
    await settle();
    expect(
      within(screen.getByRole("figure")).getByText(codeLine('orders.post("/", createOrder);')),
    ).toBeTruthy();
    expect(loadSource).toHaveBeenCalledTimes(2);
  });

  it("says when a selection's code couldn't load, keeping the GitHub link", async () => {
    const loadSource = vi.fn(async () => undefined);
    await setup({
      graph: { ...graph, repo: { ...graph.repo, sha: "0123456789abcdef" } },
      sources: undefined,
      loadSource,
      initialSelected: ROUTE,
    });
    await waitFor(() => expect(screen.getByText("Couldn't load this file.")).toBeTruthy());
    expect(screen.getByRole("link", { name: "apps/api/src/routes/orders.ts" })).toBeTruthy();
  });

  it("shows no code section without a way to get the file, but still links to GitHub", async () => {
    await setup({
      graph: { ...graph, repo: { ...graph.repo, sha: "0123456789abcdef" } },
      sources: undefined,
      initialSelected: ROUTE,
    });
    expect(screen.queryByRole("figure")).toBeNull();
    expect(screen.getByRole("link", { name: /Open on GitHub/ })).toBeTruthy();
  });

  it("explains unresolved calls and other kinds in words from the graph", async () => {
    await setup({ initialSelected: "unresolved:web/lib/cms.ts:3:21" });
    expect(screen.getByText(/The env var CMS_URL isn't named like an API base URL/)).toBeTruthy();
    expect(screen.getByText("fetch(`${process.env.CMS_URL}/posts`)")).toBeTruthy();
    cleanup();
    await setup({ initialSelected: "model:api/Order" });
    expect(screen.getByText("id, total, status, createdAt")).toBeTruthy();
    expect(
      screen.getByText(
        "Model with 4 fields. Stored in db. Read by listOrders. Written by createOrder.",
      ),
    ).toBeTruthy();
    cleanup();
    await setup({ initialSelected: "external:ext/api.stripe.com" });
    expect(screen.getByText("api.stripe.com", { selector: "dd code" })).toBeTruthy();
    cleanup();
    // A folder's facts start with its path (its Facts section was empty before).
    await setup({ initialSelected: "module:web/lib" });
    expect(screen.getByText("Path", { selector: "dt" })).toBeTruthy();
    expect(screen.getByText("apps/web/lib", { selector: "dd code" })).toBeTruthy();
    cleanup();
    await setup({ initialSelected: "datastore:infra/db" });
    expect(screen.getByText("postgres")).toBeTruthy();
  });

  it("traces with T: dims what's off the path, steps through hops, and exits with Esc", async () => {
    const { container, box, heading, press, act } = await setup();
    await press("t");
    expect(heading().textContent).toBe("page /checkout renders Checkout");
    expect(screen.getByText(/Happens inside @shop\/web; break it down to watch it/)).toBeTruthy();
    expect(screen.getByText("Tracing")).toBeTruthy();
    // The first hop happens inside @shop/web, so that box is the current hop.
    const emphasis = (id: string) => box(id)?.getAttribute("data-emphasis");
    expect(emphasis(WEB)).toBe("current");
    expect(emphasis(API)).toBe("traced");
    expect(container.querySelectorAll(".gi-edge[data-emphasis='traced']")).toHaveLength(3);
    expect(container.querySelectorAll(".gi-edge[data-emphasis='current']")).toHaveLength(0);
    expect(container.querySelectorAll(".gi-edge__particle").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Next step/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next step/ }));
    expect(heading().textContent).toBe("placeOrder requests POST /api/orders");
    expect(screen.getByText(/Heuristic match\. Goes from @shop\/web to @shop\/api/)).toBeTruthy();
    // The hop's two ends and its edge are current; the rest of the path stays traced.
    expect(emphasis(WEB)).toBe("current");
    expect(emphasis(API)).toBe("current");
    expect(emphasis("datastore:infra/db")).toBe("traced");
    const hop = container.querySelectorAll(".gi-edge[data-emphasis='current']");
    expect([...hop].map((e) => e.getAttribute("data-kind"))).toEqual(["http"]);
    expect(container.querySelectorAll(".gi-edge[data-emphasis='traced']")).toHaveLength(2);
    expect(container.querySelector(".gi-edge-label[data-emphasis='current']")).not.toBeNull();
    // The trace owns the edges' look; nothing is drawn as selected meanwhile.
    expect(container.querySelector(".gi-edge[data-selected]")).toBeNull();
    expect(hop[0]?.getAttribute("aria-label")).toMatch(/Current step of the request path$/);
    expect(
      screen.getByText(codeLine("const res = await fetch(`${API_URL}/api/orders`, {")),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(heading().textContent).toBe("Checkout calls placeOrder");
    fireEvent.click(screen.getByRole("button", { name: /createOrder writes Order/ }));
    expect(screen.getByText("Step 5 of 8")).toBeTruthy();
    await act(() => fireEvent.click(screen.getByRole("button", { name: /Break down @shop\/api/ })));
    // Inside the service, the boxes holding the hop's ends are current, the open frame neither.
    expect(emphasis(SRC)).toBe("current");
    expect(emphasis("module:api/prisma")).toBe("current");
    expect(emphasis(ROUTE)).toBe("traced");
    expect(emphasis(WEB)).toBe("traced");
    expect(box(API)?.hasAttribute("data-emphasis")).toBe(false);
    // A hop inside a closed module offers to break it down, at any depth.
    fireEvent.click(screen.getByRole("button", { name: /createOrder calls chargeOrder/ }));
    expect(screen.getByText(/Happens inside src; break it down to watch it\./)).toBeTruthy();
    await act(() => fireEvent.click(screen.getByRole("button", { name: /Break down src/ })));
    expect(screen.getByText(/Goes from orders to billing on the canvas/)).toBeTruthy();
    expect(emphasis("module:api/src/orders")).toBe("current");

    await press("Escape");
    expect(heading().textContent).toBe("shop-demo");
    expect(box(WEB)?.hasAttribute("data-emphasis")).toBe(false);
    await press("Escape");
    expect(box("module:api/src/orders")).toBeNull();
    await press("Escape");
    expect(box(SRC)).toBeNull();
    await press("Escape"); // nothing left to undo
  });

  it("lists a node once per edge in the inspector, without duplicate React keys (M4a review)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await setup({ initialSelected: SRC });
    const calls = screen.getByRole("heading", { name: /^Calls/ }).closest("section") as HTMLElement;
    const order = within(calls).getAllByRole("button", { name: /^Order/ });
    expect(order.map((b) => b.textContent?.match(/reads|writes/)?.[0])).toEqual([
      "reads",
      "writes",
    ]);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it("closes the legend before anything else on Esc, focus back on its button (M4a review)", async () => {
    const { container, box, press } = await setup({ initialOpen: [API] });
    const toggle = screen.getByRole("button", { name: "Legend" });
    fireEvent.click(toggle);
    const close = screen.getByRole("button", { name: "Close legend" });
    close.focus();
    vi.useFakeTimers();
    fireEvent.keyDown(close, { key: "Escape" });
    // It plays its exit, out of reach of the pointer and screen readers, then unmounts.
    const leaving = container.querySelector(".gi-legend");
    expect(leaving?.getAttribute("data-state")).toBe("closing");
    expect(leaving?.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("region", { name: "Legend" })).toBeNull();
    act(() => vi.advanceTimersByTime(durations.fast));
    vi.useRealTimers();
    expect(container.querySelector(".gi-legend")).toBeNull();
    expect(box(SRC)).not.toBeNull(); // still broken down
    expect(document.activeElement).toBe(toggle);
    await press("Escape", toggle);
    expect(box(SRC)).toBeNull();
  });

  it("tabs through the canvas in reading order: a frame, then what's inside it (M4a review)", async () => {
    const { container } = await setup({ initialOpen: [API] });
    const ids = [...container.querySelectorAll<HTMLElement>(".gi-drill__node")].map(
      (el) => el.dataset.nodeId,
    );
    const view = buildView(index, [API]);
    expect(ids).toEqual(view.nodes.map((n) => n.id));
    // Right after the service come its routes, then its folders.
    expect(ids[ids.indexOf(API) + 1]).toBe("route:api/GET /api/orders");
    expect(ids.indexOf(ROUTE)).toBeLessThan(ids.indexOf(SRC));
  });

  it("keeps keyboard focus in the explorer when a trace control disappears (M4a review)", async () => {
    const { box, heading, press } = await setup({ initialSelected: "page:web//checkout" });
    // "Trace from here" is replaced by the step player: focus lands on the current step.
    const start = screen.getByRole("button", { name: /Trace from here/ });
    start.focus();
    fireEvent.click(start);
    expect(document.activeElement?.textContent).toBe("1page /checkout renders Checkout");
    // The last step disables "Next step"; Esc from the player removes it.
    const next = screen.getByRole("button", { name: /Next step/ });
    next.focus();
    for (let i = 0; i < 7; i++) fireEvent.click(next);
    expect(document.activeElement?.getAttribute("aria-current")).toBe("step");
    await press("Escape", document.activeElement as Element);
    expect(heading().textContent).toBe("/checkout");
    // Back on the box the trace started from, so the next Esc still works.
    expect(document.activeElement).toBe(box(WEB));
    await press("Escape", document.activeElement as Element);
    expect(heading().textContent).toBe("shop-demo");
  });

  it("traces from the top bar and from the start page's inspector, and ignores modified keys", async () => {
    const { container, box, heading, press } = await setup({ initialOpen: [WEB] });
    // A key pressed on a node bubbles up to the explorer.
    await press("T", box("module:web/lib") as HTMLElement);
    expect(heading().textContent).toBe("page /checkout renders Checkout");
    // The page is drawn at the service's first level; its function is in a closed folder.
    expect(screen.getByText(/Goes from \/checkout to app on the canvas/)).toBeTruthy();
    // The status chip's exit, then the top bar's button both ways.
    fireEvent.click(screen.getByTitle("Exit trace"));
    expect(heading().textContent).toBe("shop-demo");
    const topBar = within(container.querySelector(".gi-topbar") as HTMLElement);
    fireEvent.click(topBar.getByRole("button", { name: "Trace a request" }));
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
    fireEvent.click(topBar.getByRole("button", { name: "Exit trace" }));
    fireEvent.keyDown(box("module:web/lib") as HTMLElement, { key: "t", ctrlKey: true });
    expect(heading().textContent).toBe("shop-demo");
    cleanup();
    await setup({ initialSelected: "page:web//checkout" });
    fireEvent.click(screen.getByRole("button", { name: /Trace from here/ }));
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
  });

  it("without a start, traces the selected page or route, or picks one", async () => {
    const { container, box, heading, press } = await setup({
      traceStart: undefined,
      initialOpen: [API],
    });
    const topBar = within(container.querySelector(".gi-topbar") as HTMLElement);
    const traceButton = () => topBar.getByRole("button", { name: "Trace a request" });
    const picker = () => screen.queryByRole("dialog", { name: "Trace a request" });
    const field = () => screen.getByRole("combobox", { name: "Trace from a page or route" });
    // Nothing traceable selected: T opens the picker, with focus in its field.
    await press("t");
    expect(heading().textContent).toBe("shop-demo");
    expect(picker()).not.toBeNull();
    expect(document.activeElement).toBe(field());
    // Esc closes the picker only: the service stays broken down.
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(picker()).toBeNull();
    expect(box(SRC)).not.toBeNull();
    // The top bar's button with a service selected opens it too; a pick traces it.
    fireEvent.click(box(API) as HTMLElement);
    traceButton().focus();
    fireEvent.click(traceButton());
    expect(heading().textContent).toBe("@shop/api");
    // Reopened within the first one's exit (the same element), focus still moves into the field.
    expect(document.activeElement).toBe(field());
    // T typed in the field is a letter, not the shortcut.
    fireEvent.keyDown(field(), { key: "t" });
    fireEvent.change(field(), { target: { value: "get orders" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "GET /api/ordersapps/api/src/routes/orders.tsRoute",
    ]);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(picker()).toBeNull();
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    const live = () => container.querySelector("[aria-live]")?.textContent;
    expect(live()).toBe("Tracing from GET /api/orders");
    // Focus went back to the button it opened from, now Exit trace, so the keys keep working.
    const exit = topBar.getByRole("button", { name: "Exit trace" });
    expect(document.activeElement).toBe(exit);
    fireEvent.click(exit);
    // The overview's hint says how to pick one.
    fireEvent.click(container.querySelector(".gi-explorer__canvas") as HTMLElement);
    expect(container.querySelector(".gi-inspector__empty")?.textContent).toMatch(
      /^Select a box to see what it does\. Double-click a service to break it down, or press T\s*to pick a page or route and trace its request path\.$/,
    );
    // A folder can't be traced from.
    fireEvent.click(box(SRC) as HTMLElement);
    expect(screen.queryByRole("button", { name: /Trace from here/ })).toBeNull();
    // Any route can: its path is computed from the graph.
    fireEvent.click(box("route:api/GET /api/orders") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Trace from here/ }));
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    expect(live()).toBe("Tracing from GET /api/orders");
    // The chip names the route with its method: GET and POST share the path.
    expect(container.querySelector(".gi-explorer__pin code")?.textContent).toBe("GET /api/orders");
    expect(heading().textContent).toBe("GET /api/orders handled by listOrders");
    const steps = within(container.querySelector(".gi-explorer__steps") as HTMLElement);
    expect(steps.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "1GET /api/orders handled by listOrders",
      "2listOrders reads Order",
      "3Order stored in db",
    ]);
    // Exiting and using the top bar traces the selection, the route, again.
    await press("t");
    fireEvent.click(traceButton());
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
  });

  it("closes the picker with Esc, focus back on the box it opened from", async () => {
    const { box } = await setup({ traceStart: undefined });
    const api = box(API) as HTMLElement;
    api.focus();
    fireEvent.keyDown(api, { key: "t" });
    const field = screen.getByRole("combobox", { name: "Trace from a page or route" });
    expect(document.activeElement).toBe(field);
    // The field's Esc bubbles to the explorer, which mustn't close it a second time (and drop focus).
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Trace a request" })).toBeNull();
    expect(document.activeElement).toBe(api);
  });

  it("searches every node with Ctrl+K and flies to the pick, drilling down (UX.md)", async () => {
    const { container, box, isOpen, heading } = await setup();
    const palette = () => screen.queryByRole("dialog", { name: "Search the diagram" });
    const field = () => screen.getByRole("combobox", { name: "Search services, files, routes" });
    const api = box(API) as HTMLElement;
    api.focus();
    fireEvent.keyDown(api, { key: "k", ctrlKey: true });
    expect(palette()).not.toBeNull();
    expect(document.activeElement).toBe(field());
    // Esc closes only the palette, focus back where it was; T and + typed in it are text.
    fireEvent.keyDown(field(), { key: "t" });
    fireEvent.keyDown(field(), { key: "+" });
    expect(screen.queryByText(/^Step 1/)).toBeNull();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(palette()).toBeNull();
    expect(document.activeElement).toBe(api);
    // ⌘K opens it too, and Ctrl+K again closes it.
    fireEvent.keyDown(api, { key: "K", metaKey: true });
    expect(palette()).not.toBeNull();
    fireEvent.keyDown(field(), { key: "k", ctrlKey: true });
    expect(palette()).toBeNull();
    // Ctrl+Shift+K is not the shortcut.
    fireEvent.keyDown(api, { key: "K", ctrlKey: true, shiftKey: true });
    expect(palette()).toBeNull();

    // A function three levels down: Enter drills to its file, selects it, and focuses its box.
    fireEvent.keyDown(api, { key: "k", ctrlKey: true });
    fireEvent.change(field(), { target: { value: "place order" } });
    expect(screen.getAllByRole("option")[0]?.textContent).toBe(
      "placeOrderapps/web/lib/orders.tsFunction",
    );
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(palette()).toBeNull();
    expect(heading().textContent).toBe("placeOrder");
    await settle();
    expect(isOpen(WEB)).toBe(true);
    expect(isOpen("module:web/lib")).toBe(true);
    expect(isOpen("file:web/lib/orders.ts")).toBe(true);
    expect(box(PLACE_ORDER)?.hasAttribute("data-selected")).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(box(PLACE_ORDER)));
    expect(container.querySelector("[aria-live]")?.textContent).toBe(
      "placeOrder, function. Calls POST /api/orders. Called by Checkout.",
    );
  });

  it("opens the palette from the top bar's field and with Ctrl+K on the page", async () => {
    const { container, heading } = await setup();
    const palette = () => screen.queryByRole("dialog", { name: "Search the diagram" });
    const topBar = within(container.querySelector(".gi-topbar") as HTMLElement);
    const search = topBar.getByRole("button", { name: /Search services, files, routes/ });
    expect(search.getAttribute("aria-keyshortcuts")).toBe("Control+K");
    search.focus();
    fireEvent.click(search);
    expect(palette()).not.toBeNull();
    // A click on the scrim closes it, focus back on the field it opened from.
    fireEvent.click(container.querySelector(".gi-palette-scrim") as HTMLElement);
    expect(palette()).toBeNull();
    expect(document.activeElement).toBe(search);
    // Nothing focused: Ctrl+K on the page opens it; a click picks.
    search.blur();
    expect(fireEvent.keyDown(document.body, { key: "k", ctrlKey: true })).toBe(false);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stripe" } });
    const stripe = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.startsWith("api.stripe.com"));
    fireEvent.click(stripe as HTMLElement);
    expect(palette()).toBeNull();
    expect(heading().textContent).toBe("api.stripe.com");
  });

  it("says where a long path stops (UX.md: up to 12 hops)", async () => {
    const chain = Array.from({ length: 15 }, (_, k) => ({
      id: `symbol:api/src/chain.ts#f${k}`,
      kind: "symbol" as const,
      label: `f${k}`,
      parentId: "service:api/",
      symbolKind: "function" as const,
      exported: true,
    }));
    // POST /api/orders is handled by f0, which calls f1, … f14.
    const hops = chain.map((n, k) => {
      const kind = k === 0 ? ("handles" as const) : ("calls" as const);
      const from = k === 0 ? ROUTE : `symbol:api/src/chain.ts#f${k - 1}`;
      return {
        id: `${kind}:${from}->${n.id}`,
        kind,
        from,
        to: n.id,
        confidence: "exact" as const,
        sites: [],
      };
    });
    const long = {
      ...graph,
      nodes: [...graph.nodes, ...chain],
      edges: [...graph.edges.filter((e) => e.from !== ROUTE), ...hops],
    };
    await setup({ graph: long, traceStart: ROUTE, initialStep: 0 });
    expect(screen.getByText("Step 1 of 12")).toBeTruthy();
    expect(
      screen.getByText(
        "The path goes on past 12 hops, from f11. Trace from further in to follow it.",
      ),
    ).toBeTruthy();
  });

  it("plays the steps by itself, pauses, gives way to a step picked by hand, and replays", async () => {
    await setup({ initialStep: 0 });
    vi.useFakeTimers();
    const at = (n: number) => expect(screen.getByText(`Step ${n} of 8`)).toBeTruthy();
    const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    const play = screen.getByRole("button", { name: "Play" });
    await act(async () => fireEvent.click(play));
    // One button: Play becomes Pause in place, so focus stays on it.
    expect(screen.getByRole("button", { name: "Pause" })).toBe(play);
    await wait(PLAY_STEP_MS - 1);
    at(1);
    await wait(1);
    at(2);
    await wait(PLAY_STEP_MS);
    at(3);
    await act(async () => fireEvent.click(play));
    expect(play.textContent).toBe("Play");
    await wait(PLAY_STEP_MS * 2);
    at(3);
    // Previous, Next, or the list take over from the player.
    await act(async () => fireEvent.click(play));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Next step/ })));
    at(4);
    expect(play.textContent).toBe("Play");
    await wait(PLAY_STEP_MS * 2);
    at(4);
    // Played to the end, it stops there and offers to start over.
    await act(async () => fireEvent.click(play));
    for (let i = 0; i < 6; i++) await wait(PLAY_STEP_MS);
    at(8);
    expect(play.textContent).toBe("Replay");
    await act(async () => fireEvent.click(play));
    at(1);
    expect(play.textContent).toBe("Pause");
    // Ending the trace stops it.
    await act(async () => fireEvent.click(screen.getByTitle("Exit trace")));
    await wait(PLAY_STEP_MS * 2);
    expect(screen.queryByText(/^Step \d of 8$/)).toBeNull();
  });

  it("pulses the current hop's line the way the request goes", async () => {
    const { container } = await setup({ initialStep: 0 });
    const pulses = () => [...container.querySelectorAll(".gi-edge__pulse")];
    // The first hop happens inside @shop/web: no line to pulse.
    expect(pulses()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /placeOrder requests POST/ }));
    expect(pulses()).toHaveLength(1);
    expect(pulses()[0]?.closest(".gi-edge")?.getAttribute("data-emphasis")).toBe("current");
    expect(pulses()[0]?.closest(".gi-edge")?.getAttribute("data-kind")).toBe("http");
    expect(pulses()[0]?.getAttribute("data-pulse")).toBe("forward");
    cleanup();

    // A queue's consumer is drawn worker → queue, but the request goes queue → worker.
    const jobs = {
      id: "queue:infra/jobs",
      kind: "queue" as const,
      label: "jobs",
      parentId: index.root.id,
      layer: "infra" as const,
      engine: "bullmq",
    };
    const work = {
      id: "symbol:api/src/work.ts#work",
      kind: "symbol" as const,
      label: "work",
      parentId: API,
      symbolKind: "function" as const,
      exported: true,
    };
    const hop = (kind: "publishes" | "consumes", from: string, to: string) => ({
      id: `${kind}:${from}->${to}`,
      kind,
      from,
      to,
      confidence: "exact" as const,
      sites: [],
    });
    const queued = {
      ...graph,
      nodes: [...graph.nodes, jobs, work],
      edges: [
        ...graph.edges,
        hop("publishes", "symbol:api/src/orders/handlers.ts#createOrder", jobs.id),
        hop("consumes", work.id, jobs.id),
      ],
    };
    const again = await setup({ graph: queued, traceStart: ROUTE, initialStep: 0 });
    fireEvent.click(screen.getByRole("button", { name: /createOrder publishes to jobs/ }));
    const forward = again.container.querySelectorAll(".gi-edge__pulse");
    expect([...forward].map((p) => p.getAttribute("data-pulse"))).toEqual(["forward"]);
    fireEvent.click(screen.getByRole("button", { name: /jobs consumed by work/ }));
    const backward = again.container.querySelectorAll(".gi-edge__pulse");
    expect([...backward].map((p) => p.getAttribute("data-pulse"))).toEqual(["backward"]);
  });

  it("can leave the top bar out for a page that brings its own", async () => {
    const { container, box, heading } = await setup({ traceStart: undefined, topBar: false });
    expect(container.querySelector(".gi-topbar")).toBeNull();
    expect(container.querySelector(".gi-explorer")?.hasAttribute("data-bare")).toBe(true);
    fireEvent.click(box(API) as HTMLElement);
    expect(heading().textContent).toBe("@shop/api");
    cleanup();
    const full = await setup();
    expect(full.container.querySelector(".gi-explorer")?.hasAttribute("data-bare")).toBe(false);
  });

  it("says where its layouts ran: the main thread without a worker", async () => {
    const { container } = await setup();
    expect(container.querySelector(".gi-explorer")?.getAttribute("data-layout-runs-in")).toBe(
      "main",
    );
  });

  it("toggles the legend beside the minimap of the top level", async () => {
    await setup({ initialOpen: [API] });
    expect(screen.queryByRole("region", { name: "Legend" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Legend" }));
    expect(screen.getByRole("region", { name: "Legend" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close legend" }));
    expect(screen.queryByRole("region", { name: "Legend" })).toBeNull();
    expect(screen.getByRole("img", { name: /Minimap of 4 boxes/ })).toBeTruthy();
  });

  it("reopens a closing legend in place", async () => {
    const { container } = await setup();
    const toggle = screen.getByRole("button", { name: "Legend" });
    fireEvent.click(toggle);
    const legend = container.querySelector(".gi-legend");
    expect(legend?.getAttribute("data-state")).toBe("open");
    fireEvent.click(toggle);
    expect(legend?.getAttribute("data-state")).toBe("closing");
    fireEvent.click(toggle);
    // The same element, open again: no flash of a fresh mount.
    expect(container.querySelector(".gi-legend")).toBe(legend);
    expect(legend?.getAttribute("data-state")).toBe("open");
    expect(legend?.hasAttribute("inert")).toBe(false);
  });

  it("swaps the inspector's content for a new selection, and a trace step's without moving focus", async () => {
    const { box, heading } = await setup();
    const panel = () => screen.getByRole("complementary");
    fireEvent.click(box(API) as HTMLElement);
    const api = panel();
    fireEvent.click(box("datastore:infra/db") as HTMLElement);
    expect(heading().textContent).toBe("db");
    // A fresh panel per selection, so its content plays the swap and starts at the top.
    expect(panel()).not.toBe(api);

    fireEvent.click(box(WEB) as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Trace a request/ }));
    const trace = panel();
    const header = trace.querySelector(".gi-inspector__header");
    const steps = trace.querySelector(".gi-explorer__steps");
    const next = screen.getByRole("button", { name: /Next step/ });
    next.focus();
    fireEvent.click(next);
    // The step's header is new; the panel, the steps list, and the focused button are kept.
    expect(panel()).toBe(trace);
    expect(trace.querySelector(".gi-inspector__header")).not.toBe(header);
    expect(trace.querySelector(".gi-explorer__steps")).toBe(steps);
    expect(document.activeElement).toBe(next);
  });
});

/** The camera drawn on the canvas, read back from its transform. */
function cameraOf(container: HTMLElement) {
  const transform = container.querySelector<HTMLElement>(".gi-explorer__drill")?.style.transform;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(transform ?? "");
  if (!m) throw new Error(`no camera in ${transform}`);
  return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) };
}

/** A box's top-left corner as drawn on the canvas (its layout place through the camera). */
function onCanvas(container: HTMLElement, el: HTMLElement | null) {
  const wrapper = el?.parentElement;
  if (!wrapper) throw new Error("no box");
  const c = cameraOf(container);
  return {
    x: parseFloat(wrapper.style.left) * c.zoom + c.x,
    y: parseFloat(wrapper.style.top) * c.zoom + c.y,
  };
}

describe("Explorer pan and zoom", { timeout: 30_000 }, () => {
  // Room for the system level at 100%.
  const CANVAS = { width: 1600, height: 1000 };
  // jsdom has no layout: every observed element reports a 1600 × 1000 canvas.
  // Nor PointerEvent (jsdom 25): without one, fired pointer events lose their
  // pointer ID and coordinates.
  beforeEach(() => {
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        readonly pointerId: number;
        readonly pointerType: string;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
          this.pointerType = init.pointerType ?? "mouse";
        }
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly report: ResizeObserverCallback) {}
        observe() {
          this.report(
            [{ contentRect: CANVAS } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const level = () =>
    screen.getByRole("group", { name: "Zoom" }).querySelector("output")?.textContent;
  const canvas = () => screen.getByRole("region", { name: "Diagram" });

  it("fits the level centered, zooms with the buttons and keys, and fits again with 0", async () => {
    const { container, press } = await setup();
    const fit = cameraOf(container);
    expect(fit.zoom).toBe(1);
    expect(fit.x).toBeGreaterThan(0);
    expect(level()).toBe("100%");

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(level()).toBe("125%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(level()).toBe("80%");
    // The buttons don't reach the canvas's click, which clears the selection.
    await press("+");
    await press("=");
    expect(level()).toBe("125%");
    await press("-");
    expect(level()).toBe("100%");
    expect(cameraOf(container)).toEqual(fit);
    await press("+");
    await press("0");
    expect(cameraOf(container)).toEqual(fit);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit to screen" }));
    expect(cameraOf(container)).toEqual(fit);
    // Zoom buttons and keys glide like a panel; a refit after drilling with the layout.
    expect(container.querySelector(".gi-explorer__drill")?.getAttribute("data-camera-motion")).toBe(
      "standard",
    );
  });

  it("thins the canvas's text out as it zooms out, and brings it back with a fit (M4b.4b)", async () => {
    const { container } = await setup();
    const detail = () => container.querySelector<HTMLElement>(".gi-drill")?.dataset.detail;
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    expect(detail()).toBe("full");
    fireEvent.click(zoomOut);
    expect([level(), detail()]).toEqual(["80%", "full"]);
    fireEvent.click(zoomOut);
    expect([level(), detail()]).toEqual(["64%", "names"]);
    fireEvent.click(zoomOut);
    fireEvent.click(zoomOut);
    expect([level(), detail()]).toEqual(["41%", "names"]);
    fireEvent.click(zoomOut);
    expect([level(), detail()]).toEqual(["33%", "outline"]);
    // Zooming out drops no box or line: the canvas only fades their text.
    expect(container.querySelectorAll(".gi-drill__node:not([data-leaving])").length).toBe(
      buildView(index, []).nodes.length,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fit to screen" }));
    expect([level(), detail()]).toEqual(["100%", "full"]);
  });

  it("starts at a given zoom centered on the level, and fits with 0", async () => {
    const { container, press } = await setup({ initialZoom: 0.33 });
    const detail = () => container.querySelector<HTMLElement>(".gi-drill")?.dataset.detail;
    await waitFor(() => expect(level()).toBe("33%"));
    expect(detail()).toBe("outline");
    const start = cameraOf(container);
    // The level's center is at the canvas's center.
    const stage = container.querySelector<HTMLElement>(".gi-drill__stage") as HTMLElement;
    const middle = {
      x: parseFloat(stage.style.width) / 2,
      y: parseFloat(stage.style.height) / 2,
    };
    expect(middle.x * start.zoom + start.x).toBeCloseTo(CANVAS.width / 2, 0);
    expect(middle.y * start.zoom + start.y).toBeCloseTo(CANVAS.height / 2, 0);
    await press("0");
    expect([level(), detail()]).toEqual(["100%", "full"]);
  });

  it("zooms around the pointer with Ctrl + wheel, and pans with the wheel", async () => {
    const { container } = await setup();
    const fit = cameraOf(container);
    fireEvent.wheel(canvas(), { deltaY: -125, ctrlKey: true, clientX: 300, clientY: 200 });
    const zoomed = cameraOf(container);
    expect(zoomed.zoom).toBeCloseTo(Math.SQRT2, 2);
    // The diagram point under the pointer stays under it.
    expect((300 - zoomed.x) / zoomed.zoom).toBeCloseTo((300 - fit.x) / fit.zoom, 0);
    expect(container.querySelector(".gi-explorer__drill")?.getAttribute("data-camera-motion")).toBe(
      "none",
    );

    fireEvent.wheel(canvas(), { deltaX: 30, deltaY: 40 });
    expect(cameraOf(container)).toEqual({ ...zoomed, x: zoomed.x - 30, y: zoomed.y - 40 });
    // Lines (deltaMode 1) are 16px; Shift turns a vertical wheel sideways.
    fireEvent.wheel(canvas(), { deltaY: 2, deltaMode: 1, shiftKey: true });
    expect(cameraOf(container).x).toBe(zoomed.x - 30 - 32);
  });

  it("pans by dragging, even from a box, without selecting or clearing on the release", async () => {
    const { container, box, heading } = await setup({ initialSelected: API });
    const fit = cameraOf(container);
    const web = box(WEB) as HTMLElement;
    fireEvent.pointerDown(web, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(web, { pointerId: 1, clientX: 160, clientY: 90 });
    expect(canvas().hasAttribute("data-panning")).toBe(true);
    fireEvent.pointerUp(web, { pointerId: 1, clientX: 160, clientY: 90 });
    fireEvent.click(web);
    expect(cameraOf(container)).toEqual({ ...fit, x: fit.x + 60, y: fit.y - 10 });
    expect(canvas().hasAttribute("data-panning")).toBe(false);
    expect(heading().textContent).toBe("@shop/api");

    // A press that barely moves is still a click.
    fireEvent.pointerDown(web, { pointerId: 2, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(web, { pointerId: 2, clientX: 102, clientY: 101 });
    fireEvent.pointerUp(web, { pointerId: 2, clientX: 102, clientY: 101 });
    fireEvent.click(web);
    expect(heading().textContent).toBe("@shop/web");
    expect(cameraOf(container).x).toBe(fit.x + 60);

    // The overlays keep their own pointer: no pan from the zoom controls.
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    fireEvent.pointerDown(zoomIn, { pointerId: 3, button: 0, clientX: 900, clientY: 20 });
    fireEvent.pointerMove(zoomIn, { pointerId: 3, clientX: 700, clientY: 20 });
    expect(cameraOf(container).x).toBe(fit.x + 60);
  });

  it("pinch-zooms with two fingers around their midpoint", async () => {
    const { container } = await setup();
    const fit = cameraOf(container);
    const c = canvas();
    fireEvent.pointerDown(c, { pointerId: 1, pointerType: "touch", clientX: 400, clientY: 300 });
    fireEvent.pointerDown(c, { pointerId: 2, pointerType: "touch", clientX: 600, clientY: 300 });
    fireEvent.pointerMove(c, { pointerId: 2, pointerType: "touch", clientX: 800, clientY: 300 });
    const pinched = cameraOf(container);
    // The fingers went from 200px apart to 400px: twice the zoom (the 200% limit).
    expect(pinched.zoom).toBe(2);
    // The midpoint moved from 500 to 600, and the diagram with it.
    expect((600 - pinched.x) / pinched.zoom).toBeCloseTo((500 - fit.x) / fit.zoom, 1);
  });

  it("never pans the diagram off the canvas", async () => {
    const { container } = await setup();
    for (let i = 0; i < 40; i++) fireEvent.wheel(canvas(), { deltaX: 500 });
    const far = cameraOf(container);
    const drill = container.querySelector<HTMLElement>(".gi-drill__stage") as HTMLElement;
    const width = parseFloat(drill.style.width);
    // The diagram's right edge stays 48px in from the canvas's left.
    expect(far.x + width * far.zoom).toBeCloseTo(48, 1);
  });

  it("keeps a broken-down box in place once the camera is hand-set; follows the fit until then", async () => {
    const { container, box, act } = await setup();
    const fit = cameraOf(container);
    await act(() => fireEvent.doubleClick(box(API) as HTMLElement));
    // Still fitted: the bigger level is refitted, gliding with the layout.
    const refit = cameraOf(container);
    expect(refit).not.toEqual(fit);
    expect(container.querySelector(".gi-explorer__drill")?.getAttribute("data-camera-motion")).toBe(
      "layout",
    );
    await act(() =>
      fireEvent.keyDown(container.querySelector(".gi-explorer") as Element, { key: "Escape" }),
    );
    expect(cameraOf(container)).toEqual(fit);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const before = onCanvas(container, box(API));
    await act(() => fireEvent.doubleClick(box(API) as HTMLElement));
    const after = onCanvas(container, box(API));
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
    expect(cameraOf(container).zoom).toBe(1.25);
  });

  it("moves the camera to a box focused from the keyboard when it's off the canvas (M4b.11)", async () => {
    const { container, box } = await setup();
    const fitted = cameraOf(container);
    const wholly = (id: string) => {
      const corner = onCanvas(container, box(id));
      const { width, height } = (box(id)?.parentElement as HTMLElement).style;
      const zoom = cameraOf(container).zoom;
      return (
        corner.x >= 0 &&
        corner.y >= 0 &&
        corner.x + parseFloat(width) * zoom <= CANVAS.width &&
        corner.y + parseFloat(height) * zoom <= CANVAS.height
      );
    };
    // Focus on a box already in view leaves a fitted camera fitted.
    (box(API) as HTMLElement).focus();
    await waitFor(() => expect(document.activeElement).toBe(box(API)));
    expect(cameraOf(container)).toEqual(fitted);
    // Zoomed in and panned far off, every box is off the canvas.
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.wheel(canvas(), { deltaX: 5000, deltaY: 5000 });
    expect(wholly(API)).toBe(false);
    (box(API) as HTMLElement).blur();
    (box(API) as HTMLElement).focus();
    await waitFor(() => expect(wholly(API)).toBe(true));
    // An arrow key's box comes into view too.
    fireEvent.wheel(canvas(), { deltaX: 5000, deltaY: 5000 });
    fireEvent.keyDown(box(API) as HTMLElement, { key: "ArrowLeft" });
    const left = (document.activeElement as HTMLElement).parentElement?.dataset.nodeId as string;
    expect(left).not.toBe(API);
    await waitFor(() => expect(wholly(left)).toBe(true));
    expect(container.querySelector(".gi-explorer__drill")?.getAttribute("data-camera-motion")).toBe(
      "standard",
    );
  });

  it("flies to a connection picked in the inspector when it's off the canvas", async () => {
    const { container, box, act } = await setup({ initialSelected: ROUTE });
    // Zoomed in on the top-left corner, far from the web app's files.
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.wheel(canvas(), { deltaX: -5000, deltaY: -5000 });
    await act(() => fireEvent.click(screen.getByRole("button", { name: /placeOrder/ })));
    // The flight starts in an effect after the new level is drawn, so it can
    // land a render after `data-layout` says done: wait for it.
    await waitFor(() => {
      const corner = onCanvas(container, box(PLACE_ORDER));
      const { width, height } = (box(PLACE_ORDER)?.parentElement as HTMLElement).style;
      const zoom = cameraOf(container).zoom;
      expect(corner.x).toBeGreaterThanOrEqual(0);
      expect(corner.y).toBeGreaterThanOrEqual(0);
      expect(corner.x + parseFloat(width) * zoom).toBeLessThanOrEqual(CANVAS.width);
      expect(corner.y + parseFloat(height) * zoom).toBeLessThanOrEqual(CANVAS.height);
    });
  });

  it("zooms in on a palette pick until it reads at 100%, centered", async () => {
    const { container, box } = await setup();
    // Zoomed out to the outline, where a function's name isn't drawn.
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(level()).toBe("33%");
    const root = container.querySelector(".gi-explorer") as HTMLElement;
    fireEvent.keyDown(root, { key: "k", ctrlKey: true });
    const field = screen.getByRole("combobox", { name: "Search services, files, routes" });
    fireEvent.change(field, { target: { value: "placeOrder" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();
    await waitFor(() => {
      expect(level()).toBe("100%");
      const corner = onCanvas(container, box(PLACE_ORDER));
      const { width, height } = (box(PLACE_ORDER)?.parentElement as HTMLElement).style;
      expect(corner.x + parseFloat(width) / 2).toBeCloseTo(CANVAS.width / 2, 0);
      expect(corner.y + parseFloat(height) / 2).toBeCloseTo(CANVAS.height / 2, 0);
    });
  });

  it("moves the view to where the minimap is pressed, and follows a drag on it", async () => {
    const { container } = await setup();
    const map = screen.getByRole("img", { name: /Minimap/ });
    vi.spyOn(map, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 128 }),
    );
    const frame = container.querySelector(".gi-minimap__viewport") as SVGRectElement;
    // Fitted at 100%, the frame is the canvas: as wide in diagram px.
    const scale = Number(frame.getAttribute("width")) / CANVAS.width;
    fireEvent.pointerDown(map, { pointerId: 1, button: 0, clientX: 100, clientY: 64 });
    const pressed = cameraOf(container);
    fireEvent.pointerMove(map, { pointerId: 1, clientX: 110, clientY: 64 });
    const dragged = cameraOf(container);
    expect(dragged.x - pressed.x).toBeCloseTo(-10 / scale, 0);
    fireEvent.pointerUp(map, { pointerId: 1 });
    fireEvent.pointerMove(map, { pointerId: 1, clientX: 150, clientY: 64 });
    expect(cameraOf(container)).toEqual(dragged);
  });

  it("leaves + − 0 to a text field", async () => {
    const { container } = await setup();
    const input = document.createElement("input");
    container.querySelector(".gi-explorer")?.append(input);
    fireEvent.keyDown(input, { key: "+" });
    expect(level()).toBe("100%");
  });
});

describe("Explorer stories", { timeout: 30_000 }, () => {
  const all = composeStories(stories);
  // jsdom has no Worker: the stories' layouts fall back to the main thread, with a warning.
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it("load the fixture graph and its sources through Vite", async () => {
    const { container } = render(<all.BrokenDown />);
    await settle();
    expect(container.querySelector('[data-expanded="true"]')?.getAttribute("aria-label")).toMatch(
      /^@shop\/api/,
    );
    expect(screen.getByText(codeLine('orders.post("/", createOrder);'))).toBeTruthy();
  });

  it("cover the overview, drilling, zooming out, and the trace at two depths and to an unresolved end", async () => {
    expect(Object.keys(all).sort()).toEqual([
      "BrokenDown",
      "DrilledDeep",
      "Filters",
      "Onboarding",
      "Outline",
      "Overview",
      "Search",
      "Share",
      "TracePicker",
      "Tracing",
      "TracingBrokenDown",
      "TracingUnresolved",
      "ZoomedOut",
    ]);
    for (const Story of [
      all.Overview,
      all.DrilledDeep,
      all.ZoomedOut,
      all.Outline,
      all.Tracing,
      all.TracingBrokenDown,
    ]) {
      const { container } = render(<Story />);
      await settle();
      expect(container.querySelector(".gi-explorer")).not.toBeNull();
      cleanup();
    }
    render(<all.TracingUnresolved />);
    await settle();
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    // The step says why the analyzer couldn't follow the request, in its own words.
    expect(
      screen.getByText(
        /^Unresolved \(No route in the repo matches\)\. The env var CMS_URL isn't named like an API base URL/,
      ),
    ).toBeTruthy();
  });

  it("show the first of three hints in the onboarding story, and none in the others", async () => {
    const { container } = render(<all.Onboarding />);
    await settle();
    const hint = container.querySelector('.gi-hint[data-state="open"]');
    expect(hint?.querySelector("h2")?.textContent).toBe("Zoom in");
    expect(hint?.textContent).toContain("Tip 1 of 3");
    cleanup();
    const overview = render(<all.Overview />);
    await settle();
    expect(overview.container.querySelector(".gi-hint")).toBeNull();
  });

  it("open the trace picker and search it in the picker story", async () => {
    const { container } = render(<all.TracePicker />);
    await settle();
    await act(async () => all.TracePicker.play?.({ canvasElement: container }));
    const names = screen
      .getAllByRole("option")
      .map((o) => o.querySelector(".gi-palette__name")?.textContent);
    expect(names).toEqual(["/orders", "GET /api/orders", "POST /api/orders"]);
    // Opened with nothing focused: once picked, focus lands on the first step, not the page.
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(screen.getByText(/^Step 1 of \d+$/)).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-current")).toBe("step");
  });

  it("open the share menu with its link and Export in the share story", async () => {
    const { container } = render(<all.Share />);
    await settle();
    await act(async () => all.Share.play?.({ canvasElement: container }));
    const field = screen.getByRole("textbox", { name: "Link to this view" }) as HTMLInputElement;
    expect(field.value).toBe(
      "https://gitinside.abhinavgonthina.dev/acme/shop/a1b2c3d?open=service:api/&sel=route:api/POST%20/api/orders",
    );
    expect(screen.getByRole("group", { name: "Export this view" })).toBeTruthy();
  });

  it("open the command palette and search it in the search story", async () => {
    const { container } = render(<all.Search />);
    await settle();
    await act(async () => all.Search.play?.({ canvasElement: container }));
    expect(screen.getByRole("dialog", { name: "Search the diagram" })).toBeTruthy();
    const names = screen
      .getAllByRole("option")
      .map((o) => o.querySelector(".gi-palette__name")?.textContent);
    expect(names.slice(0, 4)).toEqual(["orders", "orders", "Orders", "orders"]);
    expect(names).toContain("POST /api/orders");
    // Opened with nothing focused: once picked, focus lands on the picked box.
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    await settle();
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-label")).toBe("orders, module");
      expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
    });
  });

  it("open the filters popover in the filters story, with the chip saying what's off", async () => {
    const { container } = render(<all.Filters />);
    await settle();
    await act(async () => all.Filters.play?.({ canvasElement: container }));
    expect(container.querySelector('.gi-filters[data-state="open"]')).not.toBeNull();
    expect(container.querySelector(".gi-status__open")?.textContent).toBe("2 filters · 7 hidden");
    expect(container.querySelector('.gi-drill__node[data-node-id="model:api/Order"]')).toBeNull();
  });
});

describe("Explorer filters", { timeout: 30_000 }, () => {
  const testGraph = withTestFiles(graph);
  const CREATES = "symbol:api/src/__tests__/orders.test.ts#createsAnOrder";
  const filtersButton = (container: HTMLElement) =>
    within(container.querySelector(".gi-topbar") as HTMLElement).getByRole("button", {
      name: /^Filters/,
    });
  /** The open popover (a closing one stays for its exit, inert). */
  const popover = () => document.querySelector<HTMLElement>('.gi-filters[data-state="open"]');
  const chip = () => document.querySelector(".gi-status__open");
  /** A choice in the popover's group, by its text. */
  const choice = (group: string, name: RegExp) => {
    const open = popover();
    if (!open) throw new Error("the filters aren't open");
    const found = within(within(open).getByRole("group", { name: group }))
      .getAllByRole("button")
      .find((b) => name.test(b.textContent ?? ""));
    if (!found) throw new Error(`no ${String(name)} in ${group}`);
    return found;
  };

  it("starts with tests and config hidden, and says so on the canvas only when that hides something", async () => {
    const { container, box } = await setup({ graph: testGraph, initialOpen: [API, SRC] });
    expect(filtersButton(container).textContent).toBe("Filters1");
    expect(chip()?.textContent).toBe("1 filter · 6 hidden");
    expect(box(SAMPLE_TESTS)).toBeNull();
    expect(box(SRC)).not.toBeNull();
    cleanup();
    // The shop demo has no tests: the setting is on, but there's nothing to say on the canvas.
    const shop = await setup();
    expect(filtersButton(shop.container).textContent).toBe("Filters1");
    expect(chip()).toBeNull();
  });

  it("opens from the top bar, filters the canvas as you choose, and closes with Esc", async () => {
    const { container, box } = await setup({ graph: testGraph });
    const button = filtersButton(container);
    button.focus();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("switch", { name: "Hide tests and config" }),
    );
    fireEvent.click(choice("Layers", /Backend/));
    await settle();
    expect(box(API)).toBeNull();
    expect(box(WEB)).not.toBeNull();
    expect(filtersButton(container).textContent).toBe("Filters2");
    expect(chip()?.textContent).toMatch(/^2 filters · \d+ hidden$/);
    // Esc closes only the popover, focus back on the button.
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(box(WEB)).not.toBeNull();
  });

  it("opened with nothing focused, Esc leaves focus on what opens it, not the page", async () => {
    const { container } = await setup({ graph: testGraph });
    // A click that doesn't focus (a story's play, a script): the page has focus.
    fireEvent.click(filtersButton(container));
    fireEvent.keyDown(screen.getByRole("switch", { name: "Hide tests and config" }), {
      key: "Escape",
    });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(filtersButton(container));
  });

  it("clears from the chip, keeping imports off; shows imports when asked", async () => {
    const { container, box } = await setup({ graph: testGraph, initialOpen: [API, SRC] });
    const imports = () => container.querySelectorAll('.gi-edge[data-kind="imports"]').length;
    expect(imports()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await settle();
    expect(box(SAMPLE_TESTS)).not.toBeNull();
    expect(chip()).toBeNull();
    expect(filtersButton(container).textContent).toBe("Filters");
    expect(imports()).toBe(0);
    fireEvent.click(filtersButton(container));
    fireEvent.click(choice("Connections", /Imports/));
    await settle();
    expect(imports()).toBeGreaterThan(0);
    // Showing more than the default isn't a filter.
    expect(filtersButton(container).textContent).toBe("Filters");
  });

  it("closes on a press outside it, and the chip opens it on the canvas", async () => {
    const { container } = await setup({ graph: testGraph });
    fireEvent.click(chip() as HTMLElement);
    expect(popover()?.closest('[data-place="top-left"]')).not.toBeNull();
    // A press inside it doesn't close it; one on the canvas does.
    fireEvent.mouseDown(screen.getByRole("switch", { name: "Hide tests and config" }));
    expect(popover()).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole("region", { name: "Diagram" }));
    expect(popover()).toBeNull();
    // From the top bar, it opens under the zoom controls.
    fireEvent.click(filtersButton(container));
    expect(popover()?.closest('[data-place="top-right"]')).not.toBeNull();
    fireEvent.click(filtersButton(container));
    expect(popover()).toBeNull();
  });

  it("without its top bar, opens from a Filters button on the canvas", async () => {
    await setup({ topBar: false, initialFilters: NO_FILTERS });
    expect(chip()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(popover()).not.toBeNull();
  });

  it("finds a hidden node in search, says so, and shows it when picked", async () => {
    const { container, box, heading } = await setup({ graph: testGraph });
    fireEvent.keyDown(container.querySelector(".gi-explorer") as Element, {
      key: "k",
      ctrlKey: true,
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "createsAnOrder" } });
    const [first] = screen.getAllByRole("option");
    expect(first?.textContent).toMatch(/FunctionHidden by filters$/);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(heading().textContent).toBe("createsAnOrder");
    await settle();
    await waitFor(() => expect(box(CREATES)?.hasAttribute("data-selected")).toBe(true));
    expect(filtersButton(container).textContent).toBe("Filters");
  });

  it("says when the selection is hidden, and shows it again", async () => {
    // At the system level, the closed service box holds the selected route.
    const { box, heading } = await setup({ initialSelected: ROUTE });
    expect(box(API)?.hasAttribute("data-selected")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(choice("Kinds", /Routes/));
    await settle();
    // A hidden selection isn't drawn as its service.
    expect(box(API)?.hasAttribute("data-selected")).toBe(false);
    expect(heading().textContent).toBe("POST/api/orders");
    expect(screen.getByRole("heading", { name: "Hidden by filters" })).toBeTruthy();
    const show = screen.getByRole("button", { name: "Show on canvas" });
    show.focus();
    fireEvent.click(show);
    await settle();
    expect(box(API)?.hasAttribute("data-selected")).toBe(true);
    // The button went with the note: focus moves to the box holding the selection.
    await waitFor(() => expect(document.activeElement).toBe(box(API)));
    expect(screen.queryByRole("heading", { name: "Hidden by filters" })).toBeNull();
  });

  it("traces through hidden nodes, says which, and shows a hidden start", async () => {
    const { container, press } = await setup({
      initialFilters: { ...NO_FILTERS, kinds: ["symbol"] },
    });
    await press("t");
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
    expect(screen.getByText(/Checkout is hidden by filters\.$/)).toBeTruthy();
    const show = screen.getByRole("button", { name: "Show Checkout" });
    show.focus();
    fireEvent.click(show);
    await settle();
    expect(screen.queryByText(/is hidden by filters/)).toBeNull();
    // The button is gone: focus goes to the current step, so T and Esc keep working.
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-current")).toBe("step"));
    expect(filtersButton(container).textContent).toBe("Filters");
    cleanup();
    // Tracing from a page the filters hide shows it first.
    const hidden = await setup({ initialFilters: { ...NO_FILTERS, kinds: ["page"] } });
    expect(hidden.box(CHECKOUT)).toBeNull();
    await hidden.press("t");
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
    expect(filtersButton(hidden.container).textContent).toBe("Filters");
  });
});

describe("Explorer deep links", { timeout: 30_000 }, () => {
  const routeSteps = traceFrom(index, ROUTE).steps.length;

  it("opens a linked trace at its step, with no `traceStart`", async () => {
    await setup({ traceStart: undefined, initialTrace: ROUTE, initialStep: 1 });
    expect(screen.getByText(`Step 2 of ${routeSteps}`)).toBeTruthy();
    expect(screen.getByText("POST /api/orders", { selector: ".gi-status code" })).toBeTruthy();
    cleanup();
    // Its first step when no step is given; a start that can't be traced is ignored.
    await setup({ traceStart: undefined, initialTrace: ROUTE });
    expect(screen.getByText(`Step 1 of ${routeSteps}`)).toBeTruthy();
    cleanup();
    await setup({ traceStart: undefined, initialTrace: API });
    expect(screen.queryByText(/^Step \d+ of/)).toBeNull();
  });

  it("opens with the linked connection kinds hidden", async () => {
    const { container } = await setup({ initialOpen: [WEB], initialHiddenKinds: ["calls"] });
    expect(container.querySelectorAll('.gi-edge[data-kind="calls"]')).toHaveLength(0);
    expect(container.querySelectorAll('.gi-edge[data-kind="imports"]').length).toBeGreaterThan(0);
  });

  it("reports what a link keeps as it changes, not on the first render", async () => {
    const onStateChange = vi.fn<(state: ExplorerState) => void>();
    const { box, press, act } = await setup({ onStateChange, initialSelected: WEB });
    expect(onStateChange).not.toHaveBeenCalled();
    const last = () => encodeState(onStateChange.mock.lastCall?.[0] ?? DEFAULT_STATE);
    await act(() => fireEvent.doubleClick(box(API) as HTMLElement));
    expect(last()).toBe("open=service:api/&sel=service:web/");
    fireEvent.click(box(ROUTE) as HTMLElement);
    expect(last()).toBe("open=service:api/&sel=route:api/POST%20/api/orders");
    await press("t");
    expect(last()).toBe(
      "open=service:api/&sel=route:api/POST%20/api/orders&trace=route:api/POST%20/api/orders",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(last()).toMatch(/&trace=route:api\/POST%20\/api\/orders&step=2$/);
    // Ending the trace drops it from the link (the start is kept only for focus).
    await press("Escape");
    expect(last()).toBe("open=service:api/&sel=route:api/POST%20/api/orders");
    // Closing a level, and the filters.
    await press("Escape");
    expect(last()).toBe("sel=route:api/POST%20/api/orders");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Hide tests and config" }));
    await settle();
    expect(last()).toBe("sel=route:api/POST%20/api/orders&tests=shown");
    // A state change a link doesn't keep (zoom) reports nothing.
    const calls = onStateChange.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(onStateChange).toHaveBeenCalledTimes(calls);
  });

  it("reopens a reported state as it was", async () => {
    const onStateChange = vi.fn<(state: ExplorerState) => void>();
    const first = await setup({ onStateChange });
    await first.act(() => fireEvent.doubleClick(first.box(API) as HTMLElement));
    await first.act(() => fireEvent.doubleClick(first.box(SRC) as HTMLElement));
    fireEvent.click(first.box(ROUTE) as HTMLElement);
    await first.press("t");
    const link = encodeState(onStateChange.mock.lastCall?.[0] ?? DEFAULT_STATE);
    cleanup();
    const { state } = decodeState(link, index);
    const again = await setup({
      traceStart: undefined,
      initialOpen: state.open,
      initialSelected: state.selected,
      initialTrace: state.trace,
      initialStep: state.step,
      initialFilters: state.filters,
      initialHiddenKinds: state.hiddenKinds,
    });
    expect(again.isOpen(API)).toBe(true);
    expect(again.isOpen(SRC)).toBe(true);
    expect(screen.getByText(`Step 1 of ${routeSteps}`)).toBeTruthy();
    expect(again.crumbs()).toBe("shop-demo@shop/apisrc");
  });

  it("shares the current state's link from the top bar, through `linkTo`", async () => {
    const linkTo = vi.fn((query: string) => `https://example.test/acme/shop?${query}`);
    const { box, act, isOpen } = await setup({ linkTo });
    await act(() => fireEvent.doubleClick(box(API) as HTMLElement));
    fireEvent.click(box(ROUTE) as HTMLElement);
    const share = screen.getByRole("button", { name: "Share" });
    fireEvent.click(share);
    expect(share.getAttribute("aria-expanded")).toBe("true");
    const field = screen.getByRole("textbox", { name: "Link to this view" }) as HTMLInputElement;
    expect(field.value).toBe(
      "https://example.test/acme/shop?open=service:api/&sel=route:api/POST%20/api/orders",
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy link" }));
    // Esc closes only the menu: the explorer stays at its level, focus back on Share.
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(share.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(share);
    expect(isOpen(API)).toBe(true);
  });

  it("keeps `exportRef` on the view as drawn, and exports from the top bar's share menu", async () => {
    const exportRef: { current: ViewExport | undefined } = { current: undefined };
    const { box, act } = await setup({ exportRef });
    const top = exportRef.current;
    expect(top?.name).toBe("fixtures-shop-demo");
    expect(top?.mermaid()).not.toContain("subgraph");
    await act(() => fireEvent.doubleClick(box(API) as HTMLElement));
    await waitFor(() => expect(exportRef.current).not.toBe(top));
    const opened = exportRef.current;
    // The level on screen: the API broken down around its routes.
    expect(opened?.mermaid()).toMatch(/subgraph n\d+ \["@shop\/api"\]/);
    expect(opened?.mermaid()).toContain("POST /api/orders");
    expect(opened?.svg("light")).toContain("@shop/api");
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const exporting = screen.getByRole("group", { name: "Export this view" });
    for (const name of ["SVG", "PNG", "Mermaid", "Copy Mermaid"])
      expect(within(exporting).getByRole("button", { name })).toBeTruthy();
  });

  it("links to this page by default, just the page at the opening state", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const field = screen.getByRole("textbox", { name: "Link to this view" }) as HTMLInputElement;
    expect(field.value).toBe(`${window.location.origin}${window.location.pathname}`);
  });
});
