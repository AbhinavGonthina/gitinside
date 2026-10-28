import { composeStories } from "@storybook/react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExplorerPrototype } from "./ExplorerPrototype.js";
import * as stories from "./Prototype.stories.js";
import { shopDemo, shopDemoSources } from "./shopDemo.testkit.js";
import { CHECKOUT_TRACE } from "./trace.js";

afterEach(cleanup);

const graph = shopDemo();
const sources = shopDemoSources([
  "apps/api/src/routes/orders.ts",
  "apps/api/src/orders/handlers.ts",
  "apps/web/lib/orders.ts",
]);

function setup(props: Partial<Parameters<typeof ExplorerPrototype>[0]> = {}) {
  const view = render(
    <ExplorerPrototype graph={graph} sources={sources} trace={CHECKOUT_TRACE} {...props} />,
  );
  const node = (label: string) =>
    view.container.querySelector<HTMLElement>(`.gi-node[aria-label^="${label},"]`);
  const heading = () =>
    within(screen.getByRole("complementary")).getByRole("heading", { level: 2 });
  const press = (key: string, target: Element = view.container.firstElementChild as Element) =>
    fireEvent.keyDown(target, { key });
  return { ...view, node, heading, press };
}

describe("ExplorerPrototype", () => {
  it("opens at the system level with the repo overview in the inspector", () => {
    const { container, node, heading } = setup();
    expect(container.querySelectorAll(".gi-proto__node")).toHaveLength(4);
    expect(node("@shop/web")).not.toBeNull();
    expect(node("db")).not.toBeNull();
    expect(heading().textContent).toBe("shop-demo");
    expect(screen.getByText(/2 services, 1 datastore and 1 outside API/)).toBeTruthy();
    // One aggregated request edge, labeled with its count.
    expect(screen.getByText("2 requests")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Drill-down path" }).textContent).toBe(
      "shop-demo",
    );
  });

  it("selects on click, highlights the node's edges, and clears on the canvas", () => {
    const { container, node, heading } = setup();
    fireEvent.click(node("@shop/api") as HTMLElement);
    expect(heading().textContent).toBe("@shop/api");
    expect(node("@shop/api")?.hasAttribute("data-selected")).toBe(true);
    expect(container.querySelectorAll(".gi-edge[data-selected]")).toHaveLength(3);
    expect(screen.getByText("Express", { selector: "dd" })).toBeTruthy();
    fireEvent.click(screen.getByRole("region", { name: "Diagram" }));
    expect(heading().textContent).toBe("shop-demo");
  });

  it("announces the selection to screen readers", () => {
    const { container, node } = setup();
    fireEvent.click(node("db") as HTMLElement);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "db, datastore. Selected",
    );
  });

  it("breaks a service down on double-click and goes back up with Esc or the breadcrumb", () => {
    const { container, node, press } = setup();
    fireEvent.doubleClick(node("@shop/api") as HTMLElement);
    expect(node("@shop/api")?.getAttribute("data-expanded")).toBe("true");
    expect(node("src")).not.toBeNull();
    expect(node("prisma")).not.toBeNull();
    expect(screen.getByText("writes")).toBeTruthy();
    expect(container.querySelectorAll(".gi-proto__node[data-inner]")).toHaveLength(2);
    press("Escape");
    expect(node("src")).toBeNull();

    fireEvent.doubleClick(node("@shop/api") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "shop-demo" }));
    expect(node("src")).toBeNull();
    // Datastores have nothing inside, so they don't open.
    fireEvent.doubleClick(node("db") as HTMLElement);
    expect(container.querySelectorAll(".gi-proto__node")).toHaveLength(4);
  });

  it("breaks down with Enter or the inspector's button, and selects with Space", () => {
    const { node, heading } = setup();
    fireEvent.keyDown(node("@shop/web") as HTMLElement, { key: " " });
    expect(heading().textContent).toBe("@shop/web");
    fireEvent.click(screen.getByRole("button", { name: /Break down/ }));
    expect(node("lib")).not.toBeNull();
    expect(screen.getByText("3 calls")).toBeTruthy();
    // The unresolved call is drawn, with its reason, not dropped.
    expect(node("GET {env:CMS_URL}/posts")).not.toBeNull();
    expect(screen.getByText("No route in the repo matches")).toBeTruthy();
    // Enter on a child that can't open selects it instead.
    fireEvent.keyDown(node("lib") as HTMLElement, { key: "Enter" });
    expect(heading().textContent).toBe("lib");
    fireEvent.keyDown(node("lib") as HTMLElement, { key: "x" });
    expect(heading().textContent).toBe("lib");
    fireEvent.keyDown(node("@shop/api") as HTMLElement, { key: "Enter" });
    expect(node("src")).not.toBeNull();
    expect(node("lib")).toBeNull();
  });

  it("shows a route's facts, connections, and code, and flies to a connection", () => {
    const { node, heading } = setup({ initialSelected: "route:api/POST /api/orders" });
    expect(screen.getByText("/api/orders", { selector: "dd code" })).toBeTruthy();
    const preview = screen.getByRole("figure");
    expect(within(preview).getByText('orders.post("/", createOrder);')).toBeTruthy();
    expect(preview.querySelector("[data-highlight]")?.textContent).toContain("orders.post");
    // No commit SHA in the fixture graph, so no GitHub link rather than a branch link.
    expect(within(preview).queryByText("Open on GitHub")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /placeOrder/ }));
    expect(heading().textContent).toBe("placeOrder");
    // Selecting a connection drills into its service and marks the box holding it.
    expect(node("@shop/web")?.getAttribute("data-expanded")).toBe("true");
    expect(node("lib")?.hasAttribute("data-selected")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^POST \/api\/orders/ }));
    expect(heading().textContent).toBe("POST/api/orders"); // method chip, then the path
    // The other service opened instead (one level at a time), marking the module holding it.
    expect(node("lib")).toBeNull();
    expect(node("src")?.hasAttribute("data-selected")).toBe(true);
  });

  it("explains unresolved calls and other kinds in words from the graph", () => {
    setup({ initialSelected: "unresolved:web/lib/cms.ts:3:21" });
    expect(screen.getByText(/the env var CMS_URL isn't named like an API base URL/)).toBeTruthy();
    expect(screen.getByText("fetch(`${process.env.CMS_URL}/posts`)")).toBeTruthy();
    cleanup();
    setup({ initialSelected: "model:api/Order" });
    expect(screen.getByText("id, total, status, createdAt")).toBeTruthy();
    expect(screen.getByText("Model with 1 connection out and 2 in.")).toBeTruthy();
    cleanup();
    setup({ initialSelected: "external:ext/api.stripe.com" });
    expect(screen.getByText("api.stripe.com", { selector: "dd code" })).toBeTruthy();
    cleanup();
    setup({ initialSelected: "datastore:infra/db" });
    expect(screen.getByText("postgres")).toBeTruthy();
  });

  it("traces with T: dims what's off the path, steps through hops, and exits with Esc", () => {
    const { container, node, heading, press } = setup();
    press("t");
    expect(heading().textContent).toBe("page /checkout renders Checkout");
    expect(screen.getByText(/Happens inside @shop\/web; break it down to watch it/)).toBeTruthy();
    expect(screen.getByText("Tracing")).toBeTruthy();
    expect(node("@shop/web")?.getAttribute("data-emphasis")).toBe("traced");
    expect(container.querySelectorAll(".gi-edge[data-emphasis='traced']")).toHaveLength(3);
    expect(container.querySelectorAll(".gi-edge__particle").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Next step/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next step/ }));
    expect(heading().textContent).toBe("placeOrder requests POST /api/orders");
    expect(screen.getByText(/Heuristic match\. Goes from @shop\/web to @shop\/api/)).toBeTruthy();
    expect(container.querySelector(".gi-edge[data-selected]")?.getAttribute("data-kind")).toBe(
      "http",
    );
    expect(screen.getByText("const res = await fetch(`${API_URL}/api/orders`, {")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(heading().textContent).toBe("Checkout calls placeOrder");
    fireEvent.click(screen.getByRole("button", { name: /createOrder writes Order/ }));
    expect(screen.getByText("Step 5 of 8")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Break down @shop\/api/ }));
    expect(node("src")?.getAttribute("data-emphasis")).toBe("traced");
    expect(node("@shop/api")?.hasAttribute("data-emphasis")).toBe(false);
    // Inside a module the prototype can't open, it doesn't offer to.
    fireEvent.click(screen.getByRole("button", { name: /handled by createOrder/ }));
    expect(screen.getByText(/Happens inside src\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Break down src/ })).toBeNull();

    press("Escape");
    expect(heading().textContent).toBe("shop-demo");
    expect(node("@shop/web")?.hasAttribute("data-emphasis")).toBe(false);
    press("Escape");
    expect(node("src")).toBeNull();
    press("Escape"); // nothing left to undo
  });

  it("lists a node once per edge in the inspector, without duplicate React keys (M4a review)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setup({ initialSelected: "module:api/src" });
    const calls = screen.getByRole("heading", { name: /^Calls/ }).closest("section") as HTMLElement;
    const order = within(calls).getAllByRole("button", { name: /^Order/ });
    expect(order.map((b) => b.textContent?.match(/reads|writes/)?.[0])).toEqual([
      "reads",
      "writes",
    ]);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it("closes the legend before anything else on Esc, focus back on its button (M4a review)", () => {
    const { container, node, press } = setup({ initialOpen: "service:api/" });
    const toggle = screen.getByRole("button", { name: "Legend" });
    fireEvent.click(toggle);
    const close = screen.getByRole("button", { name: "Close legend" });
    close.focus();
    press("Escape", close);
    expect(container.querySelector(".gi-legend")).toBeNull();
    expect(node("src")).not.toBeNull(); // still broken down
    expect(document.activeElement).toBe(toggle);
    press("Escape", toggle);
    expect(node("src")).toBeNull();
  });

  it("tabs through the canvas in reading order (M4a review)", () => {
    const { container } = setup({ initialOpen: "service:api/" });
    const ids = [...container.querySelectorAll<HTMLElement>(".gi-proto__node")].map(
      (el) => el.dataset.nodeId,
    );
    expect(ids).toEqual([
      "service:web/",
      "service:api/",
      "module:api/prisma",
      "module:api/src",
      "datastore:infra/db",
      "external:ext/api.stripe.com",
    ]);
  });

  it("keeps keyboard focus in the explorer when a trace control disappears (M4a review)", () => {
    const { node, heading, press } = setup({ initialSelected: "page:web//checkout" });
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
    press("Escape", document.activeElement as Element);
    expect(heading().textContent).toBe("/checkout");
    // Back on the box the trace started from, so the next Esc still works.
    expect(document.activeElement).toBe(node("@shop/web"));
    press("Escape", document.activeElement as Element);
    expect(heading().textContent).toBe("shop-demo");
  });

  it("traces from the top bar and from the start page's inspector, and ignores modified keys", () => {
    const { container, node, heading, press } = setup({ initialOpen: "service:web/" });
    // A key pressed on a node bubbles up to the explorer.
    press("T", node("lib") as HTMLElement);
    expect(heading().textContent).toBe("page /checkout renders Checkout");
    // On a step inside an open service, the hop is drawn, so there's nothing to break down.
    expect(screen.getByText(/Happens inside app\./)).toBeTruthy();
    // The status chip's exit, then the top bar's button both ways.
    fireEvent.click(screen.getByTitle("Exit trace"));
    expect(heading().textContent).toBe("shop-demo");
    const topBar = within(container.querySelector(".gi-topbar") as HTMLElement);
    fireEvent.click(topBar.getByRole("button", { name: "Trace a request" }));
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
    fireEvent.click(topBar.getByRole("button", { name: "Exit trace" }));
    fireEvent.keyDown(node("lib") as HTMLElement, { key: "t", ctrlKey: true });
    expect(heading().textContent).toBe("shop-demo");
    cleanup();
    setup({ initialSelected: "page:web//checkout" });
    fireEvent.click(screen.getByRole("button", { name: /Trace from here/ }));
    expect(screen.getByText("Step 1 of 8")).toBeTruthy();
  });

  it("without a trace script, offers no trace", () => {
    const { heading, press } = setup({ trace: undefined });
    press("t");
    expect(heading().textContent).toBe("shop-demo");
  });

  it("toggles the legend beside the minimap", () => {
    setup();
    expect(screen.queryByRole("region", { name: "Legend" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Legend" }));
    expect(screen.getByRole("region", { name: "Legend" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close legend" }));
    expect(screen.queryByRole("region", { name: "Legend" })).toBeNull();
    expect(screen.getByRole("img", { name: /Minimap of 4 boxes/ })).toBeTruthy();
  });
});

describe("Prototype stories", () => {
  const all = composeStories(stories);

  it("load the fixture graph and its sources through Vite", () => {
    const { container } = render(<all.BrokenDown />);
    expect(container.querySelector('[data-expanded="true"]')?.getAttribute("aria-label")).toMatch(
      /^@shop\/api/,
    );
    expect(screen.getByText('orders.post("/", createOrder);')).toBeTruthy();
  });

  it("cover the overview, a broken-down service, and the trace at both levels", () => {
    expect(Object.keys(all).sort()).toEqual([
      "BrokenDown",
      "Overview",
      "Tracing",
      "TracingBrokenDown",
    ]);
    for (const Story of [all.Overview, all.Tracing, all.TracingBrokenDown]) {
      const { container } = render(<Story />);
      expect(container.querySelector(".gi-proto")).not.toBeNull();
      cleanup();
    }
  });
});
