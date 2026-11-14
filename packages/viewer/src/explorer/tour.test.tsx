import type { ArchitectureGraph } from "@gitinside/schema";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { SHARED_GROUP, summarizeGraph } from "../model/groups.js";
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
import { tourBreak } from "./tourBreak.js";

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
    const broken = tourBreak(graph);
    const steps = tourSteps(index, { hub, suggestion, broken });
    expect(steps.map((s) => s.title)).toEqual([
      "The system",
      "Break it down",
      "Trace a request",
      "A broken connection",
      "What depends on this",
    ]);
    expect(steps.map((s) => s.action)).toEqual([
      { kind: "system" },
      { kind: "breakdown", hub: HUB },
      { kind: "trace", start: suggestion?.node.id },
      { kind: "broken", route: broken?.route.id },
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
    expect(steps[3]?.text).toBe(
      "An example PR removes GET /api/orders, which listOrders still calls. The diff draws that line broken: this is what the PR bot flags.",
    );
    const target = index.byId.get(mostDepended().id);
    expect(steps[4]?.text).toContain(
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
    props: {
      startTour?: boolean;
      worker?: FakeWorker;
      graph?: ArchitectureGraph;
      canvas?: { width: number; height: number };
    } = {
      startTour: true,
    },
  ) {
    const { worker, canvas = { width: 900, height: 600 } } = props;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly report: ResizeObserverCallback) {}
        observe() {
          this.report(
            [{ contentRect: canvas } as ResizeObserverEntry],
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
        graph={props.graph ?? graph}
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
    expect(card()?.textContent).toContain("Tour · 1 of 5");
    expect(heading()?.textContent).toBe("The system");
    expect(live()).toMatch(/^Tour, step 1 of 5: The system\. Each column is one layer/);
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
    expect(card()?.textContent).toContain("Tour · 2 of 5");
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

    // From here on no box takes focus on the way (the trace's focus recovery put it on the trace's
    // start, and the camera followed it off the next step's framing).
    const boxFocus: string[] = [];
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.matches(".gi-drill__node > .gi-node")) {
        boxFocus.push(e.target.parentElement?.dataset.nodeId ?? "");
      }
    };
    document.addEventListener("focusin", onFocusIn);
    onTestFinished(() => document.removeEventListener("focusin", onFocusIn));

    // → : the canned PR in diff mode, on the first view: the trace over, the broken line and its
    // pill drawn, the chip saying it's an example, the panel listing the break.
    press("ArrowRight");
    await waitFor(() => expect(root.dataset.tour).toBe("broken"));
    expect(last()?.trace).toBeNull();
    expect(last()?.open).toEqual([]);
    expect(heading()?.textContent).toBe("A broken connection");
    expect(live()).toMatch(/^Tour, step 4 of 5: A broken connection\. An example PR removes /);
    await waitFor(
      () => expect(container.querySelector(".gi-edge-label[data-broken]")).not.toBeNull(),
      { timeout: 10_000 },
    );
    expect(container.querySelector(".gi-edge-label[data-broken]")?.textContent).toContain(
      "was removed",
    );
    // shop-demo has no commit, so the repo is named by its name.
    expect(container.querySelector('.gi-status[data-tone="diff"]')?.textContent).toBe(
      "Comparing shop-demo → an example PR",
    );
    expect(container.querySelector(".gi-explorer__side .gi-changes")).not.toBeNull();
    // The example shows its overlay only: no Base / Head / Overlay switch in the bar.
    expect(container.querySelector('[aria-label="Diff view"]')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading()));

    // → : impact on the model the most depends on, out of diff mode.
    press("ArrowRight");
    await waitFor(() => expect(last()?.impact).toBe(mostDepended().id));
    expect(container.querySelector('.gi-status[data-tone="diff"]')).toBeNull();
    await waitFor(() => expect(container.querySelector(".gi-edge[data-broken]")).toBeNull());
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

  it("leaves the broken connection's diff mode on Back, Next, and Skip", async () => {
    const { container, root, card, heading, last } = await touring();
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    const click = (text: string) => {
      const found = [...(card()?.querySelectorAll<HTMLElement>("button") ?? [])].find(
        (b) => b.textContent?.startsWith(text) || b.getAttribute("aria-label") === text,
      );
      if (!found) throw new Error(`no button "${text}"`);
      fireEvent.click(found);
    };
    const diffOn = () => container.querySelector('.gi-status[data-tone="diff"]') !== null;
    const toBroken = async () => {
      for (let i = 0; i < 3; i++) click("Next");
      await waitFor(() => expect(root.dataset.tour).toBe("broken"));
      await waitFor(() =>
        expect(container.querySelector(".gi-edge-label[data-broken]")).not.toBeNull(),
      );
      expect(diffOn()).toBe(true);
    };
    await toBroken();
    // Back: the trace again, on the repo's own graph.
    click("Back");
    await waitFor(() => expect(last()?.trace).toBe(suggestion?.node.id));
    expect(diffOn()).toBe(false);
    await waitFor(() => expect(container.querySelector(".gi-edge[data-broken]")).toBeNull());
    // Next: into it again, then on to impact.
    click("Next");
    await waitFor(() => expect(diffOn()).toBe(true));
    click("Next");
    await waitFor(() => expect(last()?.impact).toBe(mostDepended().id));
    expect(diffOn()).toBe(false);
    // Skip from the step: the tour and its diff mode go together.
    click("Back");
    await waitFor(() => expect(diffOn()).toBe(true));
    click("Skip tour");
    await waitFor(() => expect(card()).toBeNull());
    expect(diffOn()).toBe(false);
    await waitFor(() => expect(container.querySelector(".gi-edge[data-broken]")).toBeNull());
    expect(last()?.version).toBe("overlay");
  });

  it("frames the broken line's two ends on a small canvas", async () => {
    const canvas = { width: 420, height: 300 };
    const { container, root, heading, press } = await touring({ startTour: true, canvas });
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    for (const kind of ["breakdown", "trace", "broken"]) {
      press("ArrowRight");
      await waitFor(() => expect(root.dataset.tour).toBe(kind));
      await waitFor(() => expect(document.activeElement).toBe(heading()));
    }
    await waitFor(() => expect(root.hasAttribute("data-hand-camera")).toBe(true));
    const transform = container.querySelector<HTMLElement>(".gi-explorer__drill")?.style.transform;
    const [x = 0, y = 0, zoom = 1] = (
      /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(transform ?? "") ?? []
    )
      .slice(1)
      .map(Number);
    // The caller's service (web) and the removed route's (api), wholly on the canvas.
    for (const id of ["service:web/", HUB]) {
      const wrapper = container.querySelector<HTMLElement>(
        `.gi-drill__node[data-node-id="${id}"]`,
      ) as HTMLElement;
      const left = Number.parseFloat(wrapper.style.left) * zoom + x;
      const top = Number.parseFloat(wrapper.style.top) * zoom + y;
      const right = left + Number.parseFloat(wrapper.style.width) * zoom;
      const bottom = top + Number.parseFloat(wrapper.style.height) * zoom;
      expect([left >= 0, top >= 0, right <= canvas.width, bottom <= canvas.height]).toEqual([
        true,
        true,
        true,
        true,
      ]);
    }
  });

  it("keeps the system level's groups in the broken connection's diff mode", async () => {
    // Two packages with nothing of their own: the prototype draws them as one "Shared packages".
    const system = graph.nodes.find((n) => n.kind === "system")?.id ?? "";
    const lib = (name: string): ArchitectureGraph["nodes"][number] => ({
      id: `service:${name}/`,
      kind: "service",
      label: `@shop/${name}`,
      parentId: system,
      root: `packages/${name}`,
    });
    const shared: ArchitectureGraph = {
      ...graph,
      nodes: [...graph.nodes, lib("lib-a"), lib("lib-b")],
    };
    const { container, root, heading, press } = await touring({ startTour: true, graph: shared });
    const drawn = (id: string) => container.querySelector(`[data-node-id="${id}"]`) !== null;
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(drawn(SHARED_GROUP)).toBe(true);
    for (const kind of ["breakdown", "trace", "broken"]) {
      press("ArrowRight");
      await waitFor(() => expect(root.dataset.tour).toBe(kind));
      await waitFor(() => expect(document.activeElement).toBe(heading()));
    }
    await waitFor(() =>
      expect(container.querySelector(".gi-edge-label[data-broken]")).not.toBeNull(),
    );
    expect(drawn(SHARED_GROUP)).toBe(true);
    expect(drawn("service:lib-a/")).toBe(false);
  });

  it("keeps reading the step while a slow break-down lays out, saying nothing over it", async () => {
    const fake = new FakeWorker();
    const { heading, live, press, last } = await touring({ startTour: true, worker: fake });
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    fake.holding = true;
    press("ArrowRight");
    const said = live();
    expect(said).toMatch(/^Tour, step 2 of 5: Break it down\./);
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
    await waitFor(() => expect(card()?.textContent).toContain("Tour · 1 of 5"));
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
