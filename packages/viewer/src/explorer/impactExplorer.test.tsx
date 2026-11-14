import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../shopDemo.testkit.js";
import type { ExplorerState } from "./deepLink.js";
import { Explorer } from "./Explorer.js";
import { impactOf } from "./impact.js";

// The prototype's impact analysis (M10.3f1, M10-design §3.2): `design="prototype"` only.

afterEach(cleanup);

const graph = shopDemo();
const ORDER = "model:api/Order";
const API = "service:api/";
const WEB = "service:web/";
const DB = "datastore:infra/db";
const CHECKOUT = "page:web//checkout";

async function layoutDone(container: HTMLElement) {
  await waitFor(
    () => expect(container.querySelector(".gi-drill")?.getAttribute("data-layout")).toBe("done"),
    { timeout: 10_000 },
  );
}

/** A drawn box's own `.gi-node` (where its look is). */
function box(container: HTMLElement, id: string): HTMLElement | null {
  const wrapper = [...container.querySelectorAll<HTMLElement>(".gi-drill__node")].find(
    (n) => n.dataset.nodeId === id && !n.hasAttribute("data-leaving"),
  );
  return wrapper?.querySelector<HTMLElement>(":scope > .gi-node") ?? null;
}

const emphasis = (container: HTMLElement, id: string) =>
  box(container, id)?.getAttribute("data-emphasis") ?? null;

const panel = (container: HTMLElement) => container.querySelector<HTMLElement>(".gi-inspector");

function button(container: HTMLElement, text: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>("button")].find((b) =>
    b.textContent?.trim().startsWith(text),
  );
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

/** Shop-demo's dependents of Order inside each service, as the canvas should count them. */
function expected() {
  const index = buildHierarchy(shopDemo());
  const impact = impactOf(index, ORDER);
  const inside = (service: string) =>
    [...impact.dependents].filter((id) => index.service.get(id) === service).length;
  return { total: impact.dependents.size, api: inside(API), web: inside(WEB) };
}

describe("the prototype's impact analysis (M10.3f1)", { timeout: 30_000 }, () => {
  it("lights what depends on the selection, dims the rest, and lists it by service", async () => {
    const onStateChange = vi.fn<(state: ExplorerState) => void>();
    const { container } = render(
      <Explorer
        graph={graph}
        design="prototype"
        initialSelected={ORDER}
        onStateChange={onStateChange}
      />,
    );
    await layoutDone(container);
    const want = expected();
    expect(want.web).toBeGreaterThan(0);
    fireEvent.click(button(container, "What depends on this?"));

    await waitFor(() => expect(container.querySelector(".gi-impact")).not.toBeNull());
    // The status chip names the target and the count.
    const chip = container.querySelector<HTMLElement>('.gi-status[data-tone="impact"]');
    expect(chip?.textContent).toContain(`What depends on Order · ${want.total}`);
    // At the system level: both services hold dependents (counted on their boxes, less nothing:
    // neither is a dependent itself); the datastore and the outside API are dimmed.
    expect(emphasis(container, WEB)).toBe("impact");
    expect(emphasis(container, API)).toBe("impact");
    expect(box(container, WEB)?.textContent).toContain(
      `${want.web} ${want.web === 1 ? "dependent" : "dependents"}`,
    );
    expect(emphasis(container, DB)).toBe("dimmed");
    expect(emphasis(container, "external:ext/api.stripe.com")).toBe("dimmed");
    // The panel: its heading has focus (the button that started it went), then where and paths.
    const heading = panel(container)?.querySelector("h2");
    expect(heading?.textContent).toBe("What depends onOrder");
    expect(document.activeElement).toBe(heading);
    expect(panel(container)?.textContent).toContain(`${want.total} things, in 2 services`);
    expect([...(panel(container)?.querySelectorAll("h3") ?? [])].map((h) => h.textContent)).toEqual(
      [
        "Where2",
        `Paths${Math.min(5, panel(container)?.querySelectorAll(".gi-impact__path").length ?? 0)}`,
      ],
    );
    // The deep link keeps it.
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ impact: ORDER, trace: null }),
      ),
    );

    // A service's row opens to its dependents; a dependent selects its node, impact staying on.
    const toggle = panel(container)?.querySelector<HTMLElement>(".gi-connection__sites-toggle");
    fireEvent.click(toggle as HTMLElement);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    // Each says where it lives, so two functions named `handler` tell apart.
    const where = [
      ...(panel(container)?.querySelectorAll(".gi-impact__nodes .gi-connection__edge") ?? []),
    ].map((e) => e.textContent);
    expect(where.length).toBeGreaterThan(0);
    // By its end (file and folder), the whole path in the row's tooltip.
    for (const w of where) expect(w).toMatch(/^…\/[^/\s]+\/[^/\s]+\.tsx?$/);
    expect(
      panel(container)?.querySelector(".gi-impact__nodes .gi-connection")?.getAttribute("title"),
    ).toMatch(/^apps\/\S+\.tsx?$/);

    // Esc ends it: the looks go, focus on the target's box (inside @shop/api, closed).
    fireEvent.keyDown(heading as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".gi-impact")).toBeNull());
    expect(emphasis(container, WEB)).toBeNull();
    expect(emphasis(container, DB)).toBeNull();
    expect(container.querySelector('.gi-status[data-tone="impact"]')).toBeNull();
    expect(document.activeElement).toBe(box(container, API));
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ impact: null })),
    );
  });

  it("toggles with I on the selection, says so, and a trace ends it", async () => {
    const { container } = render(
      <Explorer graph={graph} design="prototype" initialSelected={ORDER} />,
    );
    await layoutDone(container);
    const canvas = container.querySelector(".gi-drill") as HTMLElement;
    fireEvent.keyDown(canvas, { key: "i" });
    await waitFor(() => expect(container.querySelector(".gi-impact")).not.toBeNull());
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toMatch(/^What depends on Order: \d+ things, in 2 services$/);
    fireEvent.keyDown(canvas, { key: "I" });
    await waitFor(() => expect(container.querySelector(".gi-impact")).toBeNull());
    expect(live?.textContent).toBe("Stopped showing what depends on Order");

    // Starting a trace ends it; the trace's looks win.
    fireEvent.keyDown(canvas, { key: "i" });
    await waitFor(() => expect(container.querySelector(".gi-impact")).not.toBeNull());
    fireEvent.keyDown(canvas, { key: "t" });
    // Nothing traceable is selected, so T opens the picker; pick the checkout page.
    const option = await waitFor(() => {
      const o = [...container.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (el) => el.textContent?.includes("/checkout"),
      );
      expect(o).toBeDefined();
      return o as HTMLElement;
    });
    fireEvent.click(option);
    await waitFor(() =>
      expect(container.querySelector(".gi-explorer__step[aria-current]")).not.toBeNull(),
    );
    expect(container.querySelector(".gi-impact")).toBeNull();
    expect(container.querySelector('.gi-status[data-tone="impact"]')).toBeNull();
    // Ending the trace doesn't bring the impact back.
    fireEvent.keyDown(canvas, { key: "Escape" });
    await waitFor(() =>
      expect(container.querySelector(".gi-explorer__step[aria-current]")).toBeNull(),
    );
    expect(container.querySelector(".gi-impact")).toBeNull();
  });

  it("frames the boxes it lights, once, on a measured canvas", async () => {
    // jsdom has no `ResizeObserver`; the explorer settles only once its canvas has a size.
    const canvasSize = { width: 420, height: 300 };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly report: ResizeObserverCallback) {}
        observe() {
          this.report(
            [{ contentRect: canvasSize } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {}
      },
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const { container } = render(
      <Explorer graph={graph} design="prototype" initialSelected={ORDER} />,
    );
    await layoutDone(container);
    const root = container.querySelector<HTMLElement>(".gi-explorer") as HTMLElement;
    await waitFor(() => expect(root.hasAttribute("data-settled")).toBe(true));
    expect(root.hasAttribute("data-hand-camera")).toBe(false);
    fireEvent.keyDown(container.querySelector(".gi-drill") as HTMLElement, { key: "i" });
    await waitFor(() => expect(root.hasAttribute("data-hand-camera")).toBe(true));
    // Both lit services wholly on the canvas, under the camera's transform.
    const transform = (container.querySelector<HTMLElement>(".gi-explorer__drill")?.style
      .transform ?? "") as string;
    const [x, y, zoom] = (
      /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(transform) ?? []
    )
      .slice(1)
      .map(Number);
    for (const id of [WEB, API]) {
      const wrapper = box(container, id)?.parentElement as HTMLElement;
      const left = Number.parseFloat(wrapper.style.left) * zoom! + x!;
      const top = Number.parseFloat(wrapper.style.top) * zoom! + y!;
      const right = left + Number.parseFloat(wrapper.style.width) * zoom!;
      const bottom = top + Number.parseFloat(wrapper.style.height) * zoom!;
      expect([left >= 0, top >= 0, right <= canvasSize.width, bottom <= canvasSize.height]).toEqual(
        [true, true, true, true],
      );
    }
  });

  it("says to select a box first when I has nothing to ask about", async () => {
    const { container } = render(<Explorer graph={graph} design="prototype" />);
    await layoutDone(container);
    fireEvent.keyDown(container.querySelector(".gi-drill") as HTMLElement, { key: "i" });
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Select a box first to see what depends on it",
    );
    expect(container.querySelector(".gi-impact")).toBeNull();
  });

  it("opens from a deep link's impact, never beside a trace", async () => {
    const { container } = render(
      <Explorer graph={graph} design="prototype" initialImpact={ORDER} />,
    );
    await layoutDone(container);
    expect(container.querySelector(".gi-impact")).not.toBeNull();
    expect(emphasis(container, WEB)).toBe("impact");
    cleanup();
    const traced = render(
      <Explorer graph={graph} design="prototype" initialImpact={ORDER} initialTrace={CHECKOUT} />,
    );
    await layoutDone(traced.container);
    expect(traced.container.querySelector(".gi-impact")).toBeNull();
    expect(traced.container.querySelector(".gi-explorer__step[aria-current]")).not.toBeNull();
  });

  it("finds What depends on the selection in Ctrl K", async () => {
    const { container } = render(
      <Explorer graph={graph} design="prototype" initialSelected={ORDER} />,
    );
    await layoutDone(container);
    fireEvent.keyDown(container.querySelector(".gi-drill") as HTMLElement, {
      key: "k",
      ctrlKey: true,
    });
    const field = await waitFor(() => {
      const f = container.ownerDocument.querySelector<HTMLInputElement>(
        '.gi-palette-scrim[data-state="open"] input',
      );
      expect(f).not.toBeNull();
      return f as HTMLInputElement;
    });
    await act(async () => {
      fireEvent.change(field, { target: { value: "depends" } });
    });
    const option = [
      ...container.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((o) => o.textContent?.includes("What depends on Order?"));
    expect(option).toBeDefined();
    fireEvent.click(option as HTMLElement);
    await waitFor(() => expect(container.querySelector(".gi-impact")).not.toBeNull());
  });

  it("isn't in the shipped design: no button, no I, no linked impact", async () => {
    const { container } = render(
      <Explorer graph={graph} initialSelected={ORDER} initialImpact={ORDER} />,
    );
    await layoutDone(container);
    expect(container.querySelector(".gi-impact")).toBeNull();
    expect(container.textContent).not.toContain("What depends on this?");
    fireEvent.keyDown(container.querySelector(".gi-drill") as HTMLElement, { key: "i" });
    expect(container.querySelector(".gi-impact")).toBeNull();
    expect(emphasis(container, WEB)).toBeNull();
  });
});
