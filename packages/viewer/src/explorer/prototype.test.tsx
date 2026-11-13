import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

  it("draws no bands in the shipped design", async () => {
    for (const design of [undefined, "current"] as const) {
      const { bands, view } = await drawn(design);
      expect(bands).toHaveLength(0);
      view.unmount();
    }
  });
});
