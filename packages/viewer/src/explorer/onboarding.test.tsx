import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shopDemo } from "../shopDemo.testkit.js";
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
