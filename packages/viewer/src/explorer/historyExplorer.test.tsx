import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { shopDemo } from "../shopDemo.testkit.js";
import { Explorer } from "./Explorer.js";

// The prototype's timeline drawer (M10.3f4, M10-design §3.4): `design="prototype"` only.

afterEach(cleanup);

const graph = shopDemo();
const WEB = "service:web/";

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

const drawer = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.gi-history[data-state="open"]');
const slider = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('.gi-history[data-state="open"] input[type="range"]');
const chip = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('.gi-status[data-tone="diff"]')?.textContent ?? null;
const said = (container: HTMLElement) =>
  container.querySelector('[aria-live="polite"]')?.textContent ?? "";
const historyButton = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".gi-commit__history");
const badges = (container: HTMLElement, id: string) =>
  [...(box(container, id)?.querySelectorAll(".gi-badge[data-diff]") ?? [])].map(
    (b) => b.textContent,
  );

async function opened() {
  const view = render(<Explorer graph={graph} design="prototype" />);
  const { container } = view;
  await layoutDone(container);
  const button = historyButton(container);
  if (!button) throw new Error("no History button");
  fireEvent.click(button);
  await waitFor(() => expect(drawer(container)).not.toBeNull());
  await layoutDone(container);
  return view;
}

/** Ctrl K, `query`, and a click on the result starting with `label`. */
async function pick(container: HTMLElement, query: string, label: string) {
  fireEvent.keyDown(container.querySelector(".gi-explorer") as HTMLElement, {
    key: "k",
    ctrlKey: true,
  });
  const field = await waitFor(() => {
    const found = container.ownerDocument.querySelector<HTMLInputElement>(".gi-palette input");
    expect(found).not.toBeNull();
    return found as HTMLInputElement;
  });
  fireEvent.change(field, { target: { value: query } });
  const option = await waitFor(() => {
    const found = [...container.ownerDocument.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.startsWith(label),
    );
    expect(found).toBeDefined();
    return found as HTMLElement;
  });
  fireEvent.click(option);
}

/** The slider lands on commit `at` (a key press or a click: no drag). */
async function move(container: HTMLElement, at: number) {
  const input = slider(container);
  if (!input) throw new Error("no slider");
  await act(async () => {
    fireEvent.change(input, { target: { value: String(at) } });
  });
  await layoutDone(container);
}

describe("the prototype's timeline drawer (M10.3f4)", { timeout: 30_000 }, () => {
  it("opens from History on the latest commit, drawn as a diff against the one before", async () => {
    const { container } = await opened();
    const button = historyButton(container);
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    const input = slider(container);
    // Focus on the slider, so the arrows move it at once.
    expect(document.activeElement).toBe(input);
    expect(input?.max).toBe("5");
    expect(input?.value).toBe("5");
    expect(input?.getAttribute("aria-valuetext")).toBe("this commit, 6 of 6: Add the / page");
    expect(drawer(container)?.querySelector("h2")?.textContent).toBe(
      "History · an example: 6 made-up commits",
    );
    // The overlay of that commit's change: web's new page, nothing broken.
    expect(chip(container)).toBe("Comparing example 5 → this commit");
    expect(badges(container, WEB)).toEqual(["1 added"]);
    expect(container.querySelector(".gi-edge[data-broken]")).toBeNull();
    expect(drawer(container)?.querySelector(".gi-history__commit")?.textContent).toBe(
      "this commit · Add the / page · 1 added",
    );
    // A sparkline per count, the latest commit's values beside them.
    const values = [...container.querySelectorAll(".gi-history__spark")].map((s) => s.textContent);
    expect(values).toEqual(["pages & routes5", "connections16", "broken1"]);
    // The timeline's overlay has no Base / Head switch.
    expect(container.querySelector('.gi-topbar [aria-label="Diff view"]')).toBeNull();
  });

  it("moves to another commit with the slider, the broken connection on its break", async () => {
    const { container } = await opened();
    await move(container, 3);
    expect(chip(container)).toBe("Comparing example 3 → example 4");
    expect(container.querySelector(".gi-edge[data-broken]")).not.toBeNull();
    expect(drawer(container)?.querySelector(".gi-history__commit")?.textContent).toBe(
      "example 4 · Remove GET /api/orders · 1 removed · 1 broken",
    );
    expect(said(container)).toBe("example 4: 1 removed · 1 broken");
    // The marked bar and the tick follow the handle.
    const on = [...container.querySelectorAll(".gi-history__spark")].map((s) =>
      [...s.querySelectorAll(".gi-history__bar")].findIndex((b) => b.hasAttribute("data-on")),
    );
    expect(on).toEqual([3, 3, 3]);
    // The oldest is drawn as is.
    await move(container, 0);
    expect(chip(container)).toBe("Showing example 1, the oldest");
    expect(said(container)).toBe("Showing example 1, the oldest");
    expect(container.querySelector(".gi-badge[data-diff]")).toBeNull();
  });

  it("draws a dragged commit only once the handle is let go", async () => {
    const { container } = await opened();
    const input = slider(container);
    if (!input) throw new Error("no slider");
    fireEvent.pointerDown(input);
    await act(async () => {
      fireEvent.change(input, { target: { value: "3" } });
    });
    // The words follow the handle; the canvas waits.
    expect(drawer(container)?.querySelector(".gi-history__commit")?.textContent).toBe(
      "example 4 · Remove GET /api/orders",
    );
    expect(chip(container)).toBe("Comparing example 5 → this commit");
    await act(async () => {
      fireEvent.pointerUp(input);
    });
    await layoutDone(container);
    expect(chip(container)).toBe("Comparing example 3 → example 4");
  });

  it("closes on Esc and ✕, focus back on History, and opens again from Ctrl K", async () => {
    const { container } = await opened();
    fireEvent.keyDown(slider(container) as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(drawer(container)).toBeNull());
    expect(document.activeElement).toBe(historyButton(container));
    expect(historyButton(container)?.getAttribute("aria-expanded")).toBe("false");
    expect(chip(container)).toBeNull();
    expect(said(container)).toBe("History closed");

    await pick(container, "history", "History");
    await waitFor(() => expect(drawer(container)).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(slider(container)));

    fireEvent.click(
      drawer(container)?.querySelector('[aria-label="Close history"]') as HTMLElement,
    );
    await waitFor(() => expect(drawer(container)).toBeNull());
    expect(document.activeElement).toBe(historyButton(container));
  });

  it("closes on Esc from the canvas too, in the Esc order", async () => {
    const { container } = await opened();
    fireEvent.keyDown(container.querySelector(".gi-explorer") as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(drawer(container)).toBeNull());
    expect(chip(container)).toBeNull();
    expect(said(container)).toBe("History closed");
  });

  it("ends the tour when it opens, and the tour closes it", async () => {
    const { container } = await opened();
    await pick(container, "tour", "Take the tour");
    await waitFor(() => expect(container.querySelector(".gi-tour")).not.toBeNull());
    await waitFor(() => expect(drawer(container)).toBeNull());
    fireEvent.click(historyButton(container) as HTMLElement);
    await waitFor(() => expect(drawer(container)).not.toBeNull());
    expect(container.querySelector(".gi-tour")).toBeNull();
  });

  it("isn't in the shipped explorer", async () => {
    const { container } = render(<Explorer graph={graph} />);
    await layoutDone(container);
    expect(historyButton(container)).toBeNull();
  });
});
