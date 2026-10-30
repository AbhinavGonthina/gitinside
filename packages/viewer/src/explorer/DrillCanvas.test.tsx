import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayoutInput, LayoutResult } from "../layout/elk.js";
import { createLayoutCache, type LayoutCache } from "../layout/engine.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { REDUCED_MOTION_QUERY } from "../motion.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { durations } from "../tokens.js";
import { DrillCanvas } from "./DrillCanvas.js";
import { useDrill, type Expansion } from "./drill.js";

const index = buildHierarchy(shopDemo());
const API = "service:api/";
const DB = "datastore:infra/db";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Not on jsdom's Element by default; only some tests add it.
  delete (Element.prototype as Partial<Element>).animate;
});

/** A stand-in layout: boxes in a row by drawing order, open ones wider, every edge a short line. */
function fakeLayout(input: LayoutInput): LayoutResult {
  return {
    boxes: input.nodes.map((n, i) => ({
      id: n.id,
      x: i * 100,
      y: n.parent ? 60 : 0,
      width: n.header === undefined ? 80 : 400,
      height: 40,
    })),
    edges: input.edges.map((e, i) => ({
      id: e.id,
      points: [
        { x: 0, y: i * 10 },
        { x: 50, y: i * 10 },
      ],
      label: { x: 25, y: i * 10 },
    })),
    width: input.nodes.length * 100,
    height: 200,
  };
}

/** A cache whose layouts resolve when the test says so. */
function deferredCache() {
  const waiting: (() => void)[] = [];
  const cache = createLayoutCache(index, {
    layout: (input) =>
      new Promise<LayoutResult>((resolve) => waiting.push(() => resolve(fakeLayout(input)))),
  });
  return {
    cache,
    async resolveAll() {
      await act(async () => {
        for (const go of waiting.splice(0)) go();
      });
    },
  };
}

const quickCache = () => createLayoutCache(index, { layout: async (input) => fakeLayout(input) });

function Harness({ cache, initial = [] }: { cache: LayoutCache; initial?: Expansion }) {
  const drill = useDrill(index, initial);
  return (
    <>
      <button type="button" onClick={() => drill.up()}>
        Up
      </button>
      <DrillCanvas index={index} view={drill.view} cache={cache} onOpen={drill.open} />
    </>
  );
}

const canvas = () => document.querySelector<HTMLElement>(".gi-drill");
const wrapper = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".gi-drill__node:not([data-leaving])")].find(
    (el) => el.dataset.nodeId === id,
  );
const nodeEl = (id: string) => wrapper(id)?.querySelector<HTMLElement>(":scope > .gi-node");
const flush = () => act(async () => undefined);

type AnimateCall = { el: Element; frames: Keyframe[]; options: KeyframeAnimationOptions };

/** Records Web Animations calls (jsdom has none). */
function stubAnimate(): AnimateCall[] {
  const calls: AnimateCall[] = [];
  Element.prototype.animate = function (this: Element, frames, options) {
    calls.push({
      el: this,
      frames: frames as Keyframe[],
      options: options as KeyframeAnimationOptions,
    });
    return { cancel() {}, finished: Promise.resolve() } as unknown as Animation;
  };
  return calls;
}

describe("DrillCanvas", () => {
  it("is pending until its first layout, then draws every box, line, and pill", async () => {
    const { cache, resolveAll } = deferredCache();
    render(<Harness cache={cache} />);
    expect(canvas()?.dataset.layout).toBe("pending");
    expect(canvas()?.getAttribute("aria-busy")).toBe("true");

    await resolveAll();
    const view = buildView(index, []);
    expect(canvas()?.dataset.layout).toBe("done");
    expect(canvas()?.hasAttribute("aria-busy")).toBe(false);
    expect(view.nodes.map((n) => wrapper(n.id)?.dataset.nodeId)).toEqual(
      view.nodes.map((n) => n.id),
    );
    expect(document.querySelectorAll(".gi-drill__lines .gi-edge")).toHaveLength(view.edges.length);
    expect(document.querySelectorAll(".gi-drill__labels .gi-edge-label")).toHaveLength(
      view.edges.length,
    );
    expect(wrapper(API)?.style.left).toBe(`${view.nodes.findIndex((n) => n.id === API) * 100}px`);
  });

  it("draws a cached state at once, with no pending frame", async () => {
    const cache = quickCache();
    const view = buildView(index, [API]);
    await cache.layout(view);
    render(<DrillCanvas index={index} view={view} cache={cache} />);
    expect(canvas()?.dataset.layout).toBe("done");
    expect(wrapper(API)?.dataset.open).toBe("");
  });

  it("draws its detail level and marks the lines inside one service (M4b.4b)", async () => {
    const cache = quickCache();
    const view = buildView(index, [API, "module:api/src"]);
    await cache.layout(view);
    const { rerender } = render(<DrillCanvas index={index} view={view} cache={cache} />);
    expect(canvas()?.dataset.detail).toBe("full");
    const inner = view.edges.filter(
      (e) => index.service.get(e.from) === API && index.service.get(e.to) === API,
    );
    expect(inner.length).toBeGreaterThan(0);
    expect(inner.length).toBeLessThan(view.edges.length);
    expect(document.querySelectorAll(".gi-drill__lines .gi-edge[data-inner]")).toHaveLength(
      inner.length,
    );
    expect(canvas()?.style.getPropertyValue("--gi-name-scale")).toBe("1");
    rerender(
      <DrillCanvas
        index={index}
        view={view}
        cache={cache}
        zoom={0.3}
        style={{ transform: "scale(0.3)" }}
      />,
    );
    expect(canvas()?.dataset.detail).toBe("outline");
    // The host's style is kept beside the service names' scale.
    expect(canvas()?.style.transform).toBe("scale(0.3)");
    expect(canvas()?.style.getPropertyValue("--gi-name-scale")).toBe("2.86");
    // Only the text fades: every box, line, and pill is still drawn.
    expect(document.querySelectorAll(".gi-drill__lines .gi-edge")).toHaveLength(view.edges.length);
    expect(document.querySelectorAll(".gi-drill__labels .gi-edge-label")).toHaveLength(
      view.edges.length,
    );
  });

  it("asks to break a box down on double-click or Enter, only when it can open", async () => {
    const onOpen = vi.fn();
    render(
      <DrillCanvas
        index={index}
        view={buildView(index, [])}
        cache={quickCache()}
        onOpen={onOpen}
      />,
    );
    await flush();
    fireEvent.doubleClick(nodeEl(API) as HTMLElement);
    fireEvent.keyDown(nodeEl(API) as HTMLElement, { key: "Enter" });
    fireEvent.doubleClick(nodeEl(DB) as HTMLElement);
    fireEvent.keyDown(nodeEl(DB) as HTMLElement, { key: "Enter" });
    expect(onOpen.mock.calls).toEqual([[API], [API]]);
    expect(nodeEl(API)?.hasAttribute("data-can-open")).toBe(true);
    expect(nodeEl(DB)?.hasAttribute("data-can-open")).toBe(false);
  });

  it("asks to select on click, Space, or Enter on a box that can't open further", async () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(
      <DrillCanvas
        index={index}
        view={buildView(index, [API])}
        cache={quickCache()}
        onOpen={onOpen}
        onSelect={onSelect}
      />,
    );
    await flush();
    fireEvent.click(nodeEl(DB) as HTMLElement);
    fireEvent.keyDown(nodeEl(DB) as HTMLElement, { key: " " });
    fireEvent.keyDown(nodeEl(DB) as HTMLElement, { key: "Enter" });
    // api is open already, so Enter selects it; x does nothing.
    fireEvent.keyDown(nodeEl(API) as HTMLElement, { key: "Enter" });
    fireEvent.keyDown(nodeEl(API) as HTMLElement, { key: "x" });
    expect(onSelect.mock.calls).toEqual([[DB], [DB], [DB], [API]]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("draws each box's and line's look from the host", async () => {
    const view = buildView(index, []);
    const [first] = view.edges;
    render(
      <DrillCanvas
        index={index}
        view={view}
        cache={quickCache()}
        boxLook={(n) =>
          n.id === API ? { selected: true, emphasis: "current" } : { emphasis: "dimmed" }
        }
        lineLook={(e) => (e === first ? { emphasis: "traced", flow: true } : { selected: true })}
      />,
    );
    await flush();
    expect(nodeEl(API)?.hasAttribute("data-selected")).toBe(true);
    expect(nodeEl(API)?.getAttribute("data-emphasis")).toBe("current");
    expect(nodeEl(DB)?.getAttribute("data-emphasis")).toBe("dimmed");
    const lines = document.querySelectorAll(".gi-drill__lines .gi-edge");
    expect(lines[0]?.getAttribute("data-emphasis")).toBe("traced");
    expect(lines[0]?.querySelector(".gi-edge__particle")).not.toBeNull();
    expect(lines[1]?.hasAttribute("data-selected")).toBe(true);
    const pills = document.querySelectorAll(".gi-drill__labels .gi-edge-label");
    expect(pills[0]?.getAttribute("data-emphasis")).toBe("traced");
  });

  it("keeps the current level drawn (busy) until the next one is laid out", async () => {
    const { cache, resolveAll } = deferredCache();
    render(<Harness cache={cache} />);
    await resolveAll();
    fireEvent.doubleClick(nodeEl(API) as HTMLElement);
    await flush();
    expect(canvas()?.getAttribute("aria-busy")).toBe("true");
    expect(wrapper(API)?.hasAttribute("data-open")).toBe(false);

    await resolveAll();
    expect(canvas()?.hasAttribute("aria-busy")).toBe(false);
    expect(wrapper(API)?.hasAttribute("data-open")).toBe(true);
  });

  it("grows the opened box in place, brings its children out of its center, then fades the lines in", async () => {
    const calls = stubAnimate();
    render(<Harness cache={quickCache()} />);
    await flush();
    expect(calls, "no motion on the first draw").toEqual([]);
    const before = buildView(index, []);
    const apiBefore = before.nodes.findIndex((n) => n.id === API) * 100;

    fireEvent.doubleClick(nodeEl(API) as HTMLElement);
    await flush();
    const after = buildView(index, [API]);
    const apiAfter = after.nodes.findIndex((n) => n.id === API) * 100;

    const api = calls.find((c) => c.el === wrapper(API));
    expect(api?.frames[0]).toMatchObject({
      transform: `translate(${apiBefore - apiAfter}px, 0px)`,
      width: "80px",
      opacity: 1,
    });
    expect(api?.frames[1]).toMatchObject({ transform: "translate(0px, 0px)", width: "400px" });
    expect(api?.options).toMatchObject({ duration: durations.layout, fill: "none" });

    const children = after.childrenOf.get(API) ?? [];
    expect(children.length).toBeGreaterThan(0);
    for (const id of children) {
      const call = calls.find((c) => c.el === wrapper(id));
      // Emerges transparent from api's old center (x 40 in, y 20 down, minus half its own size).
      expect(call?.frames[0]).toMatchObject({
        transform: `translate(${apiBefore + 40 - 40 - after.nodes.findIndex((n) => n.id === id) * 100}px, ${20 - 20 - 60}px)`,
        opacity: 0,
      });
      expect(call?.frames[1]).toMatchObject({ opacity: 1 });
    }
    const faded = calls.filter((c) => c.el.matches(".gi-drill__lines, .gi-drill__labels"));
    expect(faded).toHaveLength(2);
    expect(faded[0]?.frames).toEqual([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }]);
  });

  it("folds a closed box's children into it, then removes them", async () => {
    const calls = stubAnimate();
    render(<Harness cache={quickCache()} initial={[API]} />);
    await flush();
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Up" })));
    const inside = buildView(index, [API]).childrenOf.get(API) ?? [];
    const ghosts = [...document.querySelectorAll<HTMLElement>(".gi-drill__node[data-leaving]")];
    expect(ghosts.map((g) => g.dataset.nodeId)).toEqual(inside);
    for (const g of ghosts) {
      expect(g.getAttribute("aria-hidden")).toBe("true");
      expect(g.hasAttribute("inert")).toBe(true);
      const call = calls.find((c) => c.el === g);
      expect(call?.frames[1]).toMatchObject({ opacity: 0 });
      expect(call?.options.fill).toBe("forwards");
    }
    expect(wrapper(API)?.hasAttribute("data-open")).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(durations.layout - 1));
    expect(document.querySelectorAll("[data-leaving]").length).toBe(inside.length);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(document.querySelectorAll("[data-leaving]")).toHaveLength(0);
  });

  it("changes instantly under reduced motion: no glides, nothing left behind", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === REDUCED_MOTION_QUERY,
      media: query,
    }));
    const calls = stubAnimate();
    render(<Harness cache={quickCache()} initial={[API]} />);
    await flush();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Up" })));
    fireEvent.doubleClick(nodeEl(API) as HTMLElement);
    await flush();
    expect(wrapper(API)?.hasAttribute("data-open")).toBe(true);
    expect(calls).toEqual([]);
    expect(document.querySelectorAll("[data-leaving]")).toHaveLength(0);
  });

  it("keeps keyboard focus on the box it opened, though its element changes", async () => {
    render(<Harness cache={quickCache()} />);
    await flush();
    const closed = nodeEl(API) as HTMLElement;
    closed.focus();
    fireEvent.keyDown(closed, { key: "Enter" });
    await flush();
    const opened = nodeEl(API);
    expect(opened).not.toBe(closed);
    expect(document.activeElement).toBe(opened);
  });

  it("puts focus on the closed box when going up replaces the focused element", async () => {
    render(<Harness cache={quickCache()} initial={[API]} />);
    await flush();
    nodeEl(API)?.focus();
    // Esc in the explorer; a click on "Up" here would move focus to the button.
    await act(async () => {
      screen.getByRole("button", { name: "Up" }).click();
    });
    await flush();
    expect(document.activeElement).toBe(nodeEl(API));
  });

  it("says when a level can't be laid out", async () => {
    const cache = createLayoutCache(index, {
      layout: () => Promise.reject(new Error("ELK ran out of memory")),
    });
    render(<DrillCanvas index={index} view={buildView(index, [])} cache={cache} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't lay out this level: ELK ran out of memory",
    );
  });
});
