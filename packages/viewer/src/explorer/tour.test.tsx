import type { ArchitectureGraph } from "@gitinside/schema";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { summarizeGraph } from "../model/groups.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { systemSentence } from "./brief.js";
import type { ExplorerState } from "./deepLink.js";
import { asWorker, FakeWorker } from "../layout/fakeWorker.testkit.js";
import { BREAKING_DELAY, Explorer, PLAY_STEP_MS } from "./Explorer.js";
import { hubOf } from "./framing.js";
import { impactOf } from "./impact.js";
import { suggestTraces } from "./suggest.js";
import { TOUR_HOPS, tourImpactTarget, tourSteps } from "./tour.js";

// The prototype's guided tour (M10.3f2a, M10-design §3.1): `design="prototype"` only.

afterEach(cleanup);

const graph = shopDemo();
const index = buildHierarchy(summarizeGraph(graph));
const HUB = "service:api/";

/** The model the most depends on, worked out the long way. */
function mostDepended(): { id: string; count: number } {
  const counts = graph.nodes
    .filter((n) => n.kind === "model")
    .map((n) => ({ id: n.id, count: impactOf(index, n.id).dependents.size }))
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
  const best = counts[0];
  if (!best) throw new Error("shop-demo has no model");
  return best;
}

describe("the tour's steps (M10.3f2a)", () => {
  it("follows the repo: its layers, its hub, its suggested trace, and its most depended-on model", () => {
    const hub = index.byId.get(HUB);
    // The hub the explorer frames and offers is the one asked for here.
    expect(hubOf(buildView(index, []))).toBe(HUB);
    const suggestion = suggestTraces(index)[0];
    const steps = tourSteps(index, { hub, suggestion });
    expect(steps.map((s) => s.title)).toEqual([
      "The system",
      "Break it down",
      "Trace a request",
      "What depends on this",
    ]);
    expect(steps.map((s) => s.action)).toEqual([
      { kind: "system" },
      { kind: "breakdown", hub: HUB },
      { kind: "trace", start: suggestion?.node.id },
      { kind: "impact", target: mostDepended().id },
    ]);
    expect(steps[0]?.text).toContain(systemSentence(index));
    const routes = graph.nodes.filter(
      (n) => n.kind === "route" && index.service.get(n.id) === HUB,
    ).length;
    expect(routes).toBeGreaterThan(1);
    expect(steps[1]?.text).toBe(
      `@shop/api opens to its ${routes} routes, grouped by path, each found by parsing the code.`,
    );
    expect(steps[2]?.text).toContain(`: ${suggestion?.shape}.`);
    const target = index.byId.get(mostDepended().id);
    expect(steps[3]?.text).toContain(
      `Everything that would feel a change to ${target?.label}: ${mostDepended().count} things`,
    );
  });

  it("leaves out a step the repo can't show, never faking it", () => {
    const noModels: ArchitectureGraph = {
      ...graph,
      nodes: graph.nodes.filter((n) => n.kind !== "model"),
      edges: graph.edges.filter((e) => !e.from.startsWith("model:") && !e.to.startsWith("model:")),
    };
    const bare = buildHierarchy(noModels);
    expect(tourImpactTarget(bare)).toBeUndefined();
    expect(tourSteps(bare, {}).map((s) => s.action.kind)).toEqual(["system"]);
  });
});

describe("the tour in the explorer (M10.3f2a)", { timeout: 60_000 }, () => {
  /** The explorer on a measured canvas (it settles only once its canvas has a size). */
  async function touring(
    props: { startTour?: boolean; worker?: FakeWorker } = { startTour: true },
  ) {
    const { worker } = props;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly report: ResizeObserverCallback) {}
        observe() {
          this.report(
            [{ contentRect: { width: 900, height: 600 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {}
      },
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const states: ExplorerState[] = [];
    const view = render(
      <Explorer
        graph={graph}
        design="prototype"
        startTour={props.startTour}
        tourField={<input aria-label="Your repo" />}
        onStateChange={(s) => states.push(s)}
        layoutWorker={worker && (() => asWorker(worker))}
      />,
    );
    const { container } = view;
    await waitFor(
      () => expect(container.querySelector(".gi-drill")?.getAttribute("data-layout")).toBe("done"),
      { timeout: 10_000 },
    );
    const root = container.querySelector<HTMLElement>(".gi-explorer") as HTMLElement;
    await waitFor(() => expect(root.hasAttribute("data-settled")).toBe(true));
    const card = () => container.querySelector<HTMLElement>(".gi-tour");
    const heading = () => card()?.querySelector<HTMLElement>("h2") ?? null;
    const live = () => container.querySelector('[aria-live="polite"]')?.textContent;
    const press = (key: string) => {
      const at = document.activeElement;
      if (!(at instanceof HTMLElement)) throw new Error("nothing has focus");
      fireEvent.keyDown(at, { key });
    };
    return { ...view, root, states, card, heading, live, press, last: () => states.at(-1) };
  }
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const suggestion = suggestTraces(index)[0];

  it("walks its steps with the keys alone, doing each one's action on the diagram", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { container, root, card, heading, live, press, last } = await touring();

    // Step 1: the card docked at the top of the inspector, its heading focused and read out.
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    const side = container.querySelector(".gi-explorer__side");
    expect(side?.firstElementChild).toBe(card());
    expect(side?.querySelector(":scope > .gi-inspector")).not.toBeNull();
    expect(card()?.textContent).toContain("Tour · 1 of 4");
    expect(heading()?.textContent).toBe("The system");
    expect(live()).toMatch(/^Tour, step 1 of 4: The system\. Each column is one layer/);
    expect(root.dataset.tour).toBe("system");
    expect(
      [...(card()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Back"),
    ).toHaveProperty("disabled", true);
    // Each band knows its place, so they brighten in turn.
    const bands = [...container.querySelectorAll<HTMLElement>(".gi-drill__band")];
    expect(bands.map((b) => b.style.getPropertyValue("--gi-band-at"))).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);

    // → : the hub breaks down and is selected.
    press("ArrowRight");
    await waitFor(() => expect(last()?.open).toEqual([HUB]));
    expect(last()?.selected).toBe(HUB);
    expect(card()?.textContent).toContain("Tour · 2 of 4");
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(heading()?.textContent).toBe("Break it down");
    expect(root.dataset.tour).toBe("breakdown");

    // → : the suggested trace, its path opened from the system level, plays its first hops only.
    press("ArrowRight");
    await waitFor(() => expect(last()?.trace).toBe(suggestion?.node.id));
    expect(last()?.step).toBe(0);
    expect(last()?.selected).toBeNull();
    // Opened as from the system level (M10.3d2): the path's services, not the hub left open.
    expect(last()?.open.length).toBeGreaterThan(0);
    expect(last()?.open).not.toEqual([HUB]);
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    for (let i = 0; i < TOUR_HOPS + 2; i++) await tick(PLAY_STEP_MS);
    expect(last()?.step).toBe(TOUR_HOPS - 1);
    expect(container.querySelector('.gi-status[data-tone="trace"]')).not.toBeNull();

    // → : impact on the model the most depends on; the trace ends, its path closes. No box takes
    // focus on the way (the trace's focus recovery put it on the trace's start, and the camera
    // followed it off impact's framing).
    const boxFocus: string[] = [];
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.matches(".gi-drill__node > .gi-node")) {
        boxFocus.push(e.target.parentElement?.dataset.nodeId ?? "");
      }
    };
    document.addEventListener("focusin", onFocusIn);
    onTestFinished(() => document.removeEventListener("focusin", onFocusIn));
    press("ArrowRight");
    await waitFor(() => expect(last()?.impact).toBe(mostDepended().id));
    expect(last()?.trace).toBeNull();
    expect(last()?.open).toEqual([]);
    expect(container.querySelector(".gi-explorer__side .gi-impact")).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(boxFocus).toEqual([]);
    document.removeEventListener("focusin", onFocusIn);

    // → : Done, on the first view; "Paste your own repo" goes to the page's field.
    press("ArrowRight");
    await waitFor(() => expect(heading()?.textContent).toBe("Your turn"));
    expect(last()?.impact).toBeNull();
    expect(live()).toMatch(/^Your turn\./);
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    const paste = [...(card()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Paste your own repo",
    );
    fireEvent.click(paste as HTMLElement);
    const field = card()?.querySelector("input");
    expect(document.activeElement).toBe(field);
    // Arrows in the field are the field's.
    press("ArrowLeft");
    expect(heading()?.textContent).toBe("Your turn");

    // ← from the heading: back to impact, redone.
    act(() => heading()?.focus());
    press("ArrowLeft");
    await waitFor(() => expect(last()?.impact).toBe(mostDepended().id));
    expect(heading()?.textContent).toBe("What depends on this");

    // Esc in the card skips the tour: the card goes, focus on a box, the diagram as it is.
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    press("Escape");
    await waitFor(() => expect(card()).toBeNull());
    expect(live()).toBe("Tour ended");
    expect(document.activeElement?.matches(".gi-drill__node > .gi-node")).toBe(true);
    expect(last()?.impact).toBe(mostDepended().id);
    expect(root.dataset.tour).toBeUndefined();
    expect(container.querySelector(".gi-explorer__side")).toBeNull();
  });

  it("redoes a step the reader wandered off from, and Next, Back, and Skip work by click", async () => {
    const { card, heading, press, last } = await touring();
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    const click = (text: string) => {
      const found = [...(card()?.querySelectorAll<HTMLElement>("button") ?? [])].find(
        (b) => b.textContent?.startsWith(text) || b.getAttribute("aria-label") === text,
      );
      if (!found) throw new Error(`no button "${text}"`);
      fireEvent.click(found);
    };
    click("Next");
    await waitFor(() => expect(last()?.open).toEqual([HUB]));
    // The reader closes the hub (Esc on the canvas: up a level) and goes on to the trace...
    const boxEl = document.querySelector<HTMLElement>(".gi-drill__node > .gi-node") as HTMLElement;
    act(() => boxEl.focus());
    press("Escape");
    await waitFor(() => expect(last()?.open).toEqual([]));
    expect(card()).not.toBeNull();
    click("Next");
    await waitFor(() => expect(last()?.trace).toBe(suggestion?.node.id));
    // ...and Back breaks the hub down again, the trace over.
    click("Back");
    await waitFor(() => expect(last()?.open).toEqual([HUB]));
    expect(last()?.trace).toBeNull();
    click("Skip tour");
    await waitFor(() => expect(card()).toBeNull());
  });

  it("keeps reading the step while a slow break-down lays out, saying nothing over it", async () => {
    const fake = new FakeWorker();
    const { heading, live, press, last } = await touring({ startTour: true, worker: fake });
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    fake.holding = true;
    press("ArrowRight");
    const said = live();
    expect(said).toMatch(/^Tour, step 2 of 4: Break it down\./);
    await new Promise((resolve) => setTimeout(resolve, BREAKING_DELAY + 100));
    expect(document.querySelector("[data-breaking]")).not.toBeNull();
    expect(live()).toBe(said);
    fake.release();
    await waitFor(() => expect(last()?.open).toEqual([HUB]));
    await waitFor(() => expect(document.querySelector("[data-breaking]")).toBeNull());
    expect(live()).toBe(said);
  });

  it("lands the trace on its third hop at once under reduced motion, never playing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { heading, press, last } = await touring();
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    press("ArrowRight");
    await waitFor(() => expect(last()?.open).toEqual([HUB]));
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    press("ArrowRight");
    await waitFor(() => expect(last()?.trace).toBe(suggestion?.node.id));
    expect(last()?.step).toBe(TOUR_HOPS - 1);
    await tick(PLAY_STEP_MS * 3);
    expect(last()?.step).toBe(TOUR_HOPS - 1);
  });

  it('starts from Ctrl K\'s "Take the tour" without being asked to, and not in the shipped design', async () => {
    const { card, heading } = await touring({});
    expect(card()).toBeNull();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const field = await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>(
        '.gi-palette-scrim[data-state="open"] input',
      );
      expect(input).not.toBeNull();
      return input as HTMLInputElement;
    });
    fireEvent.change(field, { target: { value: "tour" } });
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options[0]?.textContent).toContain("Take the tour");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(card()?.textContent).toContain("Tour · 1 of 4"));
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    cleanup();

    const shipped = render(<Explorer graph={graph} startTour />);
    await waitFor(() =>
      expect(shipped.container.querySelector(".gi-drill")?.getAttribute("data-layout")).toBe(
        "done",
      ),
    );
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const input = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>(
        '.gi-palette-scrim[data-state="open"] input',
      );
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    fireEvent.change(input, { target: { value: "take the tour" } });
    expect(
      [...document.querySelectorAll('[role="option"]')].some((o) =>
        o.textContent?.includes("Take the tour"),
      ),
    ).toBe(false);
    expect(shipped.container.querySelector(".gi-tour")).toBeNull();
  });
});
