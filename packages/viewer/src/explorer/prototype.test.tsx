import type { ArchitectureGraph } from "@gitinside/schema";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { codeShop } from "../model/codeLines.testkit.js";
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

  it("draws the system level's code lines quietly, behind the boxes, without pills (M10.3b2)", async () => {
    const { view } = await drawnWith(codeShop(), "prototype");
    const quiet = view.container.querySelector<SVGSVGElement>(".gi-drill__lines[data-quiet]");
    expect(quiet?.getAttribute("aria-label")).toBe("Code dependencies");
    // Before the boxes in the stage, so they paint over it.
    const boxes = view.container.querySelector(".gi-drill__boxes");
    expect(quiet?.compareDocumentPosition(boxes as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const kinds = (root: Element | null) =>
      [...(root?.querySelectorAll<SVGGElement>(".gi-edge") ?? [])].map((g) => g.dataset.kind);
    expect(kinds(quiet)).toEqual(["calls", "calls", "calls"]);
    const above = view.container.querySelector(".gi-drill__lines:not([data-quiet])");
    expect(kinds(above)).not.toContain("calls");
    expect(kinds(above)).toContain("http");
    // Pills: one per line above the boxes, none for the quiet ones.
    const pills = view.container.querySelectorAll(".gi-drill__labels .gi-edge-label");
    expect(pills).toHaveLength(kinds(above).length);
    // Still named for screen readers, with the count.
    const names = [...(quiet?.querySelectorAll(".gi-edge") ?? [])].map((g) =>
      g.getAttribute("aria-label"),
    );
    expect(names.some((n) => n?.includes("@shop/ui"))).toBe(true);
    view.unmount();
  });

  it("draws code lines like any other in the shipped design", async () => {
    const { view } = await drawnWith(codeShop(), "current");
    expect(view.container.querySelector(".gi-drill__lines[data-quiet]")).toBeNull();
    const lines = [...view.container.querySelectorAll<SVGGElement>(".gi-drill__lines .gi-edge")];
    expect(lines.filter((g) => g.dataset.kind === "calls")).toHaveLength(3);
    expect(view.container.querySelectorAll(".gi-drill__labels .gi-edge-label")).toHaveLength(
      lines.length,
    );
    view.unmount();
  });

  it("draws cards with a count row and role on every service, names that wrap (M10.3b3)", async () => {
    const { view, box } = await drawnWith(grouped, "prototype");
    const card = (id: string) => box(id)?.querySelector<HTMLElement>(":scope > .gi-node");
    const services = [
      ...view.container.querySelectorAll<HTMLElement>('.gi-node[data-kind="service"]'),
    ];
    expect(services.length).toBeGreaterThan(1);
    for (const s of services) {
      expect(s.querySelector(".gi-node__badges")).not.toBeNull();
      expect(s.hasAttribute("data-wrap")).toBe(true);
    }
    expect(card("service:web/")?.querySelector(".gi-node__subtitle")?.textContent).toBe(
      "Next.js appapps/web",
    );
    expect(card("service:api/")?.querySelector(".gi-node__badges")?.textContent).toContain(
      "4 outside APIs",
    );
    // The shared scope stays in the name, in its own (muted) span, and the name reads whole.
    expect(card("service:web/")?.querySelector(".gi-node__scope")?.textContent).toBe("@shop/");
    expect(card("service:web/")?.querySelector(".gi-node__label")?.textContent).toBe("@shop/web");
    // A host group is a circle tile with its logos, not a folder.
    const group = card("group:hosts/ai");
    expect(group?.dataset.tier).toBe("icon");
    expect(group?.dataset.shape).toBe("circle");
    expect(group?.querySelector('.gi-icon-tile[data-shape="circle"]')).not.toBeNull();
    expect(group?.querySelectorAll(".gi-brand").length).toBeGreaterThan(0);
    view.unmount();
  });

  it("draws the shipped cards in the shipped design", async () => {
    const { view, box } = await drawnWith(grouped, "current");
    const web = box("service:web/")?.querySelector<HTMLElement>(":scope > .gi-node");
    expect(web?.hasAttribute("data-wrap")).toBe(false);
    expect(web?.querySelector(".gi-node__subtitle")?.textContent).toBe("Next.jsapps/web");
    expect(box("service:api/")?.querySelector(".gi-node__badges")?.textContent).not.toContain(
      "outside",
    );
    view.unmount();
  });

  it("draws one page bar with the path, the commit's status, and the page's items (M10.3c1)", async () => {
    const view = render(
      <Explorer
        graph={{
          ...graph,
          repo: { ...graph.repo, sha: "a1b2c3f4d5e6f708192a3b4c5d6e7f8091a2b3c4" },
        }}
        design="prototype"
        home="/"
        commitStatus={{ state: "current", text: "Analyzed at this commit" }}
        topBarEnd={<button type="button">Sign in</button>}
      />,
    );
    const { container } = view;
    await waitFor(
      () => expect(container.querySelector(".gi-drill")?.getAttribute("data-layout")).toBe("done"),
      { timeout: 10_000 },
    );
    const bar = container.querySelector<HTMLElement>(".gi-topbar");
    expect(bar?.dataset.variant).toBe("page");
    expect(container.querySelectorAll(".gi-topbar")).toHaveLength(1);
    expect(bar?.querySelector('a[aria-label="GitInside home"]')?.getAttribute("href")).toBe("/");
    expect(bar?.querySelector(".gi-commit")?.getAttribute("data-status")).toBe("current");
    expect(bar?.querySelector(".gi-topbar__end")?.lastElementChild?.textContent).toBe("Sign in");
    // No count for the default hiding of tests and config: only what the reader sets.
    expect(bar?.querySelector(".gi-topbar__filters")?.textContent).toBe("Filters");
    // The path is in the bar, not on the canvas.
    const crumbs = () => bar?.querySelector('nav[aria-label="Drill-down path"]');
    expect(
      container.querySelector('.gi-explorer__canvas nav[aria-label="Drill-down path"]'),
    ).toBeNull();
    expect(crumbs()?.querySelector('[aria-current="location"]')).not.toBeNull();
    const web = [...container.querySelectorAll<HTMLElement>(".gi-drill__node")]
      .find((n) => n.dataset.nodeId === "service:web/")
      ?.querySelector<HTMLElement>(":scope > .gi-node");
    await act(() => fireEvent.keyDown(web as HTMLElement, { key: "Enter" }));
    await waitFor(
      () =>
        expect(crumbs()?.querySelector('[aria-current="location"]')?.textContent).toBe("@shop/web"),
      { timeout: 10_000 },
    );
    // A level above goes back up to it.
    const up = crumbs()?.querySelector<HTMLButtonElement>(".gi-breadcrumbs__link");
    await act(() => fireEvent.click(up as HTMLButtonElement));
    await waitFor(() => expect(crumbs()?.querySelectorAll("li")).toHaveLength(1), {
      timeout: 10_000,
    });
    view.unmount();
  });

  it("keeps the shipped bar, and the path on the canvas, in the shipped design", async () => {
    const view = render(
      <Explorer graph={graph} home="/" topBarEnd={<button type="button">Sign in</button>} />,
    );
    const { container } = view;
    await waitFor(
      () => expect(container.querySelector(".gi-drill")?.getAttribute("data-layout")).toBe("done"),
      { timeout: 10_000 },
    );
    const bar = container.querySelector<HTMLElement>(".gi-topbar");
    expect(bar?.dataset.variant).toBeUndefined();
    expect(bar?.querySelector(".gi-wordmark")).not.toBeNull();
    expect(bar?.textContent).not.toContain("Sign in");
    expect(bar?.querySelector("nav")).toBeNull();
    expect(bar?.querySelector(".gi-topbar__filters")?.textContent).toBe("Filters1");
    expect(
      container.querySelector('.gi-explorer__canvas nav[aria-label="Drill-down path"]'),
    ).not.toBeNull();
    view.unmount();
  });

  it("draws no bands in the shipped design", async () => {
    for (const design of [undefined, "current"] as const) {
      const { bands, view } = await drawn(design);
      expect(bands).toHaveLength(0);
      view.unmount();
    }
  });
});
