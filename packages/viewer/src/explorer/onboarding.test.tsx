import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shopDemo } from "../shopDemo.testkit.js";
import { READABLE_ZOOM } from "./camera.js";
import { Explorer } from "./Explorer.js";
import {
  browserOnboarding,
  hintSteps,
  memoryOnboarding,
  ONBOARDING_KEY,
  type OnboardingStore,
} from "./onboarding.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const graph = shopDemo();
const CHECKOUT = "page:web//checkout";
const API = "service:api/";
const DB = "datastore:infra/db";

describe("browserOnboarding", () => {
  it("is done once remembered, in localStorage", () => {
    const store = browserOnboarding();
    expect(store.done()).toBe(false);
    store.remember();
    expect(localStorage.getItem(ONBOARDING_KEY)).toBe("done");
    expect(browserOnboarding().done()).toBe(true);
  });

  it("shows the hints when storage can't be read, and doesn't throw when it can't be written", () => {
    const blocked = browserOnboarding(() => {
      throw new Error("SecurityError");
    });
    expect(blocked.done()).toBe(false);
    expect(() => blocked.remember()).not.toThrow();
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    expect(() => browserOnboarding(() => full).remember()).not.toThrow();
    expect(browserOnboarding(() => undefined).done()).toBe(false);
  });

  it("ignores another value under its key", () => {
    localStorage.setItem(ONBOARDING_KEY, "later");
    expect(browserOnboarding().done()).toBe(false);
  });
});

describe("hintSteps", () => {
  const fresh = {
    canBreakDown: true,
    opened: false,
    selected: false,
    canTrace: true,
    tracing: false,
  };

  it("is zoom in → select → trace on a fresh visit (UX.md)", () => {
    expect(hintSteps(fresh)).toEqual(["zoom", "select", "trace"]);
  });

  it("leaves out what a deep link already did", () => {
    expect(hintSteps({ ...fresh, opened: true })).toEqual(["select", "trace"]);
    expect(hintSteps({ ...fresh, selected: true })).toEqual(["zoom", "trace"]);
    expect(hintSteps({ ...fresh, tracing: true })).toEqual(["zoom", "select"]);
  });

  it("leaves out what this repo can't do", () => {
    expect(hintSteps({ ...fresh, canBreakDown: false })).toEqual(["select", "trace"]);
    expect(hintSteps({ ...fresh, canTrace: false })).toEqual(["zoom", "select"]);
  });
});

/** Waits until the canvas has drawn the current level. */
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

async function setup(
  onboarding: OnboardingStore | undefined,
  props: Partial<Parameters<typeof Explorer>[0]> = {},
) {
  const view = render(
    <Explorer graph={graph} traceStart={CHECKOUT} onboarding={onboarding} {...props} />,
  );
  await settle();
  const box = (id: string) =>
    [...view.container.querySelectorAll<HTMLElement>(".gi-drill__node:not([data-leaving])")]
      .find((el) => el.dataset.nodeId === id)
      ?.querySelector<HTMLElement>(":scope > .gi-node") ?? null;
  /** The open hint (not one playing its exit). */
  const hint = () => view.container.querySelector<HTMLElement>('.gi-hint[data-state="open"]');
  const title = () => hint()?.querySelector("h2")?.textContent;
  const count = () => hint()?.querySelector(".gi-hint__count")?.textContent;
  const button = (name: string) =>
    within(hint() as HTMLElement).getByRole("button", { name }) as HTMLElement;
  return { ...view, box, hint, title, count, button };
}

/** A store that counts `remember()` calls. */
function spyStore(done = false) {
  const store = memoryOnboarding(done);
  const remember = vi.spyOn(store, "remember");
  return { store, remember };
}

describe("Explorer onboarding", { timeout: 30_000 }, () => {
  it("shows no hints without a store, or once done", async () => {
    const without = await setup(undefined);
    expect(without.container.querySelector(".gi-hint")).toBeNull();
    cleanup();
    const done = await setup(memoryOnboarding(true));
    expect(done.container.querySelector(".gi-hint")).toBeNull();
  });

  it("shows three hints in turn with Next, then remembers on Done", async () => {
    const { store, remember } = spyStore();
    const { hint, title, count, button } = await setup(store);
    expect(hint()?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Zoom in" })).toBe(hint());
    expect(count()).toBe("Tip 1 of 3");
    const next = button("Next");
    fireEvent.click(next);
    expect(title()).toBe("Select a box");
    expect(count()).toBe("Tip 2 of 3");
    fireEvent.click(button("Next"));
    expect(title()).toBe("Trace a request");
    // The same button, renamed, so focus on it stays put between hints.
    expect(button("Done")).toBe(next);
    expect(remember).not.toHaveBeenCalled();
    fireEvent.click(button("Done"));
    expect(hint()).toBeNull();
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("moves on when the reader does what a hint says, and remembers after the last", async () => {
    const { store, remember } = spyStore();
    const { box, title } = await setup(store);
    // Selecting during "Zoom in" isn't what it asks: it stays.
    fireEvent.click(box(API) as HTMLElement);
    expect(title()).toBe("Zoom in");
    fireEvent.doubleClick(box(API) as HTMLElement);
    await settle();
    expect(title()).toBe("Select a box");
    fireEvent.click(box(DB) as HTMLElement);
    expect(title()).toBe("Trace a request");
    fireEvent.keyDown(document.querySelector(".gi-explorer") as HTMLElement, { key: "t" });
    await settle();
    expect(document.querySelector('.gi-hint[data-state="open"]')).toBeNull();
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it('remembers "Don\'t show again"; the close button and Esc hide them for this visit only', async () => {
    const never = spyStore();
    const first = await setup(never.store);
    fireEvent.click(first.button("Don't show again"));
    expect(first.hint()).toBeNull();
    expect(never.remember).toHaveBeenCalledTimes(1);
    cleanup();

    const closed = spyStore();
    const second = await setup(closed.store);
    fireEvent.click(second.button("Close tips"));
    expect(second.hint()).toBeNull();
    cleanup();
    const third = await setup(closed.store);
    const next = third.button("Next");
    next.focus();
    fireEvent.keyDown(next, { key: "Escape" });
    expect(third.hint()).toBeNull();
    expect(closed.remember).not.toHaveBeenCalled();
    // Esc only closed the hints: nothing else went back.
    expect(document.querySelector('.gi-explorer [aria-live="polite"]')?.textContent).toBe("");
  });

  it("puts focus on a box when the hint it was in closes", async () => {
    const { button } = await setup(memoryOnboarding());
    const close = button("Close tips");
    close.focus();
    fireEvent.click(close);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.matches(".gi-drill__node > .gi-node")).toBe(true);
    cleanup();

    const again = await setup(memoryOnboarding(), { initialSelected: API });
    const done = again.button("Don't show again");
    done.focus();
    fireEvent.click(done);
    expect(document.activeElement).toBe(again.box(API));
  });

  it("leaves out hints a deep link already did, and keeps clicks on a hint off the canvas", async () => {
    const { title, count, hint, box } = await setup(memoryOnboarding(), {
      initialOpen: [API],
      initialSelected: DB,
    });
    expect(title()).toBe("Trace a request");
    expect(count()).toBe("Tip 1 of 1");
    fireEvent.click(hint() as HTMLElement);
    // The click didn't reach the canvas, which would clear the selection.
    expect(box(DB)?.hasAttribute("data-selected")).toBe(true);
  });

  /**
   * Stubs a measured canvas of `canvas` px (jsdom lays nothing out) with the
   * hint's pin laid out as a browser would: 16px down, 170px tall.
   */
  function measuredCanvas(canvas: { width: number; height: number }) {
    const pin = { top: 16, height: 170 };
    beforeEach(() => {
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
      const pinned = (el: HTMLElement, value: number) =>
        el.matches('.gi-explorer__pin[data-place="top-center"]') ? value : 0;
      vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return pinned(this, pin.top);
      });
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return pinned(this, pin.height);
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });
    return pin;
  }

  /** The camera drawn on the canvas, read back from its transform. */
  const cameraOf = (container: HTMLElement) => {
    const transform = container.querySelector<HTMLElement>(".gi-explorer__drill")?.style.transform;
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(transform ?? "");
    if (!m) throw new Error(`no camera in ${transform}`);
    return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) };
  };

  describe("a trace deep link on a measured canvas (M9.7f)", () => {
    // taxonomy's README link at 1280 × 800: the trace's frame of step 1 ran
    // under "Tip 1 of 1", though the first view fits below it (M9.2g). The
    // demo's hops are short, so a short canvas puts the centered one under.
    const PIN = measuredCanvas({ width: 1280, height: 480 });
    /** The tops of the current hop's ends as drawn, in canvas px. */
    const endTops = (container: HTMLElement) => {
      const c = cameraOf(container);
      return [
        ...container.querySelectorAll<HTMLElement>(
          '.gi-drill__node:not([data-leaving]) > .gi-node[data-emphasis="current"]',
        ),
      ].map((el) => parseFloat((el.parentElement as HTMLElement).style.top) * c.zoom + c.y);
    };

    it("frames the trace's first hop below the hint's card", async () => {
      const { container, count } = await setup(memoryOnboarding(), { initialTrace: CHECKOUT });
      expect(count()).toMatch(/^Tip 1 of /);
      // The level's fit is below the card at 58%; the trace's start then
      // zooms its first hop in to the readable zoom (a camera of its own).
      await waitFor(
        () =>
          expect(container.querySelector(".gi-explorer")?.hasAttribute("data-hand-camera")).toBe(
            true,
          ),
        { timeout: 10_000 },
      );
      expect(cameraOf(container).zoom).toBe(READABLE_ZOOM);
      const tops = endTops(container);
      expect(tops.length).toBeGreaterThan(0);
      for (const top of tops) expect(top).toBeGreaterThanOrEqual(PIN.top + PIN.height + 16);
    });
  });

  describe("on a measured canvas (M9.2g)", () => {
    // Short enough that the system level's fit reaches the top inset, where
    // the hint's card would cover boxes (pawtograder/platform at 1440 × 900).
    const PIN = measuredCanvas({ width: 640, height: 400 });
    /** The top of the highest box drawn, in canvas px. */
    const topBox = (container: HTMLElement) => {
      const c = cameraOf(container);
      const tops = [
        ...container.querySelectorAll<HTMLElement>(".gi-drill__node:not([data-leaving])"),
      ].map((el) => parseFloat(el.style.top) * c.zoom + c.y);
      return Math.min(...tops);
    };

    it("fits the first view below the hint's card, and takes the room back once it closes", async () => {
      const plain = await setup(undefined);
      const fit = cameraOf(plain.container);
      // Without a hint the level starts at the inset, where the card would be.
      expect(topBox(plain.container)).toBeLessThan(PIN.top + PIN.height);
      cleanup();

      const { container, button } = await setup(memoryOnboarding());
      await waitFor(() =>
        expect(topBox(container)).toBeGreaterThanOrEqual(PIN.top + PIN.height + 16),
      );
      // Next: the room stays (the next card is measured the same).
      await act(() => fireEvent.click(button("Next")));
      expect(topBox(container)).toBeGreaterThanOrEqual(PIN.top + PIN.height + 16);
      await act(() => fireEvent.click(button("Close tips")));
      await waitFor(() => expect(cameraOf(container)).toEqual(fit));
    });

    it("leaves a camera the reader set alone", async () => {
      const { container, button } = await setup(memoryOnboarding(), { initialZoom: 1 });
      await waitFor(() =>
        expect(container.querySelector(".gi-explorer")?.hasAttribute("data-hand-camera")).toBe(
          true,
        ),
      );
      const set = cameraOf(container);
      await act(() => fireEvent.click(button("Close tips")));
      expect(cameraOf(container)).toEqual(set);
    });
  });

  it("doesn't offer a trace when the repo has nothing to trace", async () => {
    const quiet = {
      ...graph,
      nodes: graph.nodes.filter((n) => n.kind !== "page" && n.kind !== "route"),
    };
    const ids = new Set(quiet.nodes.map((n) => n.id));
    const { count, button, title } = await setup(memoryOnboarding(), {
      graph: { ...quiet, edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) },
      traceStart: undefined,
    });
    expect(count()).toBe("Tip 1 of 2");
    fireEvent.click(button("Next"));
    expect(title()).toBe("Select a box");
    expect(button("Done")).toBeTruthy();
  });
});
