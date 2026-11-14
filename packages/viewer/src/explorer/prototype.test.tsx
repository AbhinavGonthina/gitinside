import type { ArchitectureGraph } from "@gitinside/schema";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { groupedShop } from "../model/groups.testkit.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { Explorer } from "./Explorer.js";

// The M10 redesign under review (M10.3): `design="prototype"` only, the shipped explorer unchanged.

afterEach(cleanup);

const graph = shopDemo();

async function drawn(design?: "current" | "prototype") {
  const view = render(<Explorer graph={graph} design={design} />);
  await waitFor(
    () => {
      const canvas = view.container.querySelector(".gi-drill");
      expect(canvas?.getAttribute("data-layout")).toBe("done");
    },
    { timeout: 10_000 },
  );
  const left = (id: string) => {
    const el = [...view.container.querySelectorAll<HTMLElement>(".gi-drill__node")].find(
      (n) => n.dataset.nodeId === id,
    );
    return Number.parseFloat(el?.style.left ?? "NaN");
  };
  const bands = [...view.container.querySelectorAll<HTMLElement>(".gi-drill__band")];
  return { view, left, bands };
}

const grouped = groupedShop();

async function drawnWith(g: ArchitectureGraph, design: "current" | "prototype") {
  const view = render(<Explorer graph={g} design={design} />);
  await waitFor(
    () => {
      const canvas = view.container.querySelector(".gi-drill");
      expect(canvas?.getAttribute("data-layout")).toBe("done");
    },
    { timeout: 10_000 },
  );
  const box = (id: string) =>
    [...view.container.querySelectorAll<HTMLElement>(".gi-drill__node")].find(
      (n) => n.dataset.nodeId === id,
    ) ?? null;
  return { view, box };
}

describe("Explorer's prototype design (M10.3a)", { timeout: 30_000 }, () => {
  it("names the bands above the system level, left to right, hidden from screen readers", async () => {
    const { bands, left } = await drawn("prototype");
    expect(bands.map((b) => b.textContent)).toEqual(["Frontend", "Backend", "Data", "Outside"]);
    expect(bands[0]?.parentElement?.getAttribute("aria-hidden")).toBe("true");
    const xs = bands.map((b) => Number.parseFloat(b.style.left));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(left("service:web/")).toBeLessThan(left("service:api/"));
    expect(left("service:api/")).toBeLessThan(left("datastore:infra/db"));
    expect(left("datastore:infra/db")).toBeLessThan(left("external:ext/api.stripe.com"));
    expect(xs[2]).toBe(left("datastore:infra/db"));
  });

  it("groups outside hosts and shared packages at the system level (M10.3b1)", async () => {
    const { view, box } = await drawnWith(grouped, "prototype");
    expect(box("group:hosts/ai")?.textContent).toContain("AI models · 3");
    expect(box("group:shared")?.textContent).toContain("Shared packages · 2");
    for (const member of ["external:ext/api.openai.com", "service:ui/", "service:tsconfig/"]) {
      expect(box(member)).toBeNull();
    }
    expect(box("external:ext/api.stripe.com")).not.toBeNull();
    // Broken down like a folder: its hosts inside.
    const tile = box("group:hosts/ai")?.querySelector<HTMLElement>(":scope > .gi-node");
    await act(() => fireEvent.keyDown(tile as HTMLElement, { key: "Enter" }));
    await waitFor(() => expect(box("external:ext/api.openai.com")).not.toBeNull(), {
      timeout: 10_000,
    });
    view.unmount();
  });

  it("draws every host and package as itself in the shipped design", async () => {
    const { box } = await drawnWith(grouped, "current");
    expect(box("group:hosts/ai")).toBeNull();
    expect(box("group:shared")).toBeNull();
    expect(box("external:ext/api.openai.com")).not.toBeNull();
    expect(box("service:ui/")).not.toBeNull();
  });

  it("draws no bands in the shipped design", async () => {
    for (const design of [undefined, "current"] as const) {
      const { bands, view } = await drawn(design);
      expect(bands).toHaveLength(0);
      view.unmount();
    }
  });
});
