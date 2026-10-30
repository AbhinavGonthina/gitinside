import { composeStories } from "@storybook/react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { shopDemo, shopDemoSources } from "../prototype/shopDemo.testkit.js";
import { durations } from "../tokens.js";
import * as stories from "./Explorer.stories.js";
import { Explorer } from "./Explorer.js";
import { CHECKOUT_TRACE } from "./trace.js";

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
    <Explorer graph={graph} sources={sources} trace={CHECKOUT_TRACE} {...props} />,
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

describe("Explorer", () => {
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

  it("announces the selection to screen readers", async () => {
    const { container, box } = await setup();
    fireEvent.click(box("datastore:infra/db") as HTMLElement);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "db, datastore. Selected",
    );
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
    expect(within(preview).getByText('orders.post("/", createOrder);')).toBeTruthy();
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

  it("explains unresolved calls and other kinds in words from the graph", async () => {
    await setup({ initialSelected: "unresolved:web/lib/cms.ts:3:21" });
    expect(screen.getByText(/the env var CMS_URL isn't named like an API base URL/)).toBeTruthy();
    expect(screen.getByText("fetch(`${process.env.CMS_URL}/posts`)")).toBeTruthy();
    cleanup();
    await setup({ initialSelected: "model:api/Order" });
    expect(screen.getByText("id, total, status, createdAt")).toBeTruthy();
    expect(screen.getByText("Model with 1 connection out and 2 in.")).toBeTruthy();
    cleanup();
    await setup({ initialSelected: "external:ext/api.stripe.com" });
    expect(screen.getByText("api.stripe.com", { selector: "dd code" })).toBeTruthy();
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
    expect(screen.getByText("const res = await fetch(`${API_URL}/api/orders`, {")).toBeTruthy();
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

  it("without a trace script, offers no trace", async () => {
    const { heading, press } = await setup({ trace: undefined });
    await press("t");
    expect(heading().textContent).toBe("shop-demo");
    // The start hint doesn't promise one either.
    expect(
      screen.getByText("Select a box to see what it does. Double-click a service to break it down.")
        .tagName,
    ).toBe("P");
  });

  it("can leave the top bar out for a page that brings its own", async () => {
    const { container, box, heading } = await setup({ trace: undefined, topBar: false });
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

describe("Explorer stories", () => {
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
    expect(screen.getByText('orders.post("/", createOrder);')).toBeTruthy();
  });

  it("cover the overview, drilling, and the trace at two depths", async () => {
    expect(Object.keys(all).sort()).toEqual([
      "BrokenDown",
      "DrilledDeep",
      "Overview",
      "Tracing",
      "TracingBrokenDown",
    ]);
    for (const Story of [all.Overview, all.DrilledDeep, all.Tracing, all.TracingBrokenDown]) {
      const { container } = render(<Story />);
      await settle();
      expect(container.querySelector(".gi-explorer")).not.toBeNull();
      cleanup();
    }
  });
});
