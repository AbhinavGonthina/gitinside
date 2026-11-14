import type { ArchitectureGraph } from "@gitinside/schema";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { codeShop } from "../model/codeLines.testkit.js";
import { withTestFiles } from "../model/filterSamples.js";
import { DEFAULT_FILTERS } from "../model/filters.js";
import { groupedShop } from "../model/groups.testkit.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { Explorer } from "./Explorer.js";
import { memoryOnboarding } from "./onboarding.js";
import { FactGrid } from "./overview.js";

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

const WARNING = { code: "SYNTAX_ERROR", message: "';' expected.", file: "apps/web/lib/cart.ts" };
const CACHE = "datastore:infra/cache";

/** shop-demo's one datastore, to copy as one nothing connects to. */
function dbNode() {
  const db = graph.nodes.find((n) => n.id === "datastore:infra/db");
  if (db?.kind !== "datastore") throw new Error("shop-demo has no datastore");
  return db;
}

async function layoutDone(container: HTMLElement) {
  await waitFor(
    () => expect(container.querySelector(".gi-drill")?.getAttribute("data-layout")).toBe("done"),
    { timeout: 10_000 },
  );
}

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

  it("keeps the canvas to three overlays: no default filter chip or warnings chip, one toolbar, one hint line (M10.3c2)", async () => {
    // Tests hidden by default and a warning: the shipped design draws a chip for each.
    const noisy = { ...withTestFiles(graph), warnings: [WARNING] };
    const shipped = render(<Explorer graph={noisy} onboarding={memoryOnboarding()} />);
    await layoutDone(shipped.container);
    expect(shipped.container.querySelectorAll(".gi-status")).toHaveLength(2);
    expect(shipped.container.querySelector(".gi-hint")).not.toBeNull();
    shipped.unmount();

    const { container } = render(
      <Explorer graph={noisy} design="prototype" onboarding={memoryOnboarding()} />,
    );
    await layoutDone(container);
    expect(container.querySelectorAll(".gi-status")).toHaveLength(0);
    expect(container.querySelector(".gi-hint")).toBeNull();
    expect(container.querySelector(".gi-hint-line")?.textContent).toBe(
      "Double-click a box to break it down · T to trace a request",
    );
    const pin = (place: string) =>
      container.querySelector<HTMLElement>(`.gi-explorer__pin[data-place="${place}"]`);
    expect(pin("top-right")?.children).toHaveLength(0);
    expect(pin("bottom-left")?.querySelector(".gi-hint-line")).not.toBeNull();
    const toolbar = pin("bottom-right")?.querySelector<HTMLElement>('[role="group"]');
    expect(toolbar?.getAttribute("aria-label")).toBe("View");
    const names = [...(toolbar?.querySelectorAll("button") ?? [])].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Zoom out", "Zoom in", "Fit to screen", "Minimap", "Legend"]);
    // Nothing is on, so no chips: the hint and the toolbar are the only overlays.
    const drawn = [...container.querySelectorAll<HTMLElement>(".gi-explorer__pin")].filter(
      (p) => p.children.length > 0,
    );
    expect(drawn.map((p) => p.dataset.place)).toEqual(["bottom-left", "bottom-right"]);
    // The minimap waits to be asked for; the legend opens from "?".
    expect(container.querySelector(".gi-minimap")).toBeNull();
    const button = (name: string) =>
      toolbar?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) as HTMLElement;
    fireEvent.click(button("Minimap"));
    expect(container.querySelector(".gi-minimap")).not.toBeNull();
    expect(button("Minimap").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("Legend"));
    await waitFor(() => expect(container.querySelector(".gi-legend")).not.toBeNull());
    expect(button("Legend").getAttribute("aria-expanded")).toBe("true");
    // Its close button puts focus back on "?".
    const close = container.querySelector<HTMLButtonElement>(
      '.gi-legend button[aria-label="Close legend"]',
    );
    close?.focus();
    fireEvent.click(close as HTMLButtonElement);
    expect(document.activeElement).toBe(button("Legend"));
    fireEvent.click(button("Minimap"));
    expect(container.querySelector(".gi-minimap")).toBeNull();
  });

  it("draws a filter chip for a filter the reader set (M10.3c2)", async () => {
    const { container } = render(
      <Explorer
        graph={withTestFiles(graph)}
        design="prototype"
        initialFilters={{ ...DEFAULT_FILTERS, layers: ["data"] }}
      />,
    );
    await layoutDone(container);
    const chips = container.querySelectorAll(".gi-status");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toMatch(/^1 filter · /);
  });

  it("ends the hint line for good at the first search or break-down, not a selection (M10.3c2)", async () => {
    for (const action of ["search", "break down"] as const) {
      const store = memoryOnboarding();
      const view = render(<Explorer graph={graph} design="prototype" onboarding={store} />);
      const { container } = view;
      await layoutDone(container);
      const web = [...container.querySelectorAll<HTMLElement>(".gi-drill__node")]
        .find((n) => n.dataset.nodeId === "service:web/")
        ?.querySelector<HTMLElement>(":scope > .gi-node") as HTMLElement;
      fireEvent.click(web);
      expect(container.querySelector('.gi-hint-line[data-state="open"]')).not.toBeNull();
      expect(store.done()).toBe(false);
      if (action === "search") fireEvent.keyDown(web, { key: "k", ctrlKey: true });
      else await act(() => fireEvent.keyDown(web, { key: "Enter" }));
      expect(store.done()).toBe(true);
      expect(container.querySelector('.gi-hint-line[data-state="open"]')).toBeNull();
      view.unmount();
    }
  });

  it("shows no hint line to a reader who's done with the hints", async () => {
    const { container } = render(
      <Explorer graph={graph} design="prototype" onboarding={memoryOnboarding(true)} />,
    );
    await layoutDone(container);
    expect(container.querySelector(".gi-hint-line")).toBeNull();
  });

  it("captions a datastore no connection reaches, in the prototype only (M10.3c2)", async () => {
    const withCache: ArchitectureGraph = {
      ...graph,
      nodes: [...graph.nodes, { ...dbNode(), id: CACHE, label: "cache", engine: "redis" }],
    };
    const caption = (container: HTMLElement, id: string) =>
      [...container.querySelectorAll<HTMLElement>(".gi-drill__node")]
        .find((n) => n.dataset.nodeId === id)
        ?.querySelector(".gi-node__caption")?.textContent;
    const proto = render(<Explorer graph={withCache} design="prototype" />);
    await layoutDone(proto.container);
    expect(caption(proto.container, CACHE)).toBe("Not linked to code");
    expect(caption(proto.container, "datastore:infra/db")).toBeUndefined();
    // Read with the box's description, as the subtitle is.
    const card = [...proto.container.querySelectorAll<HTMLElement>(".gi-drill__node")]
      .find((n) => n.dataset.nodeId === CACHE)
      ?.querySelector<HTMLElement>(":scope > .gi-node");
    const described = card?.getAttribute("aria-describedby") ?? "";
    expect(proto.container.ownerDocument.getElementById(described)?.textContent).toContain(
      "Not linked to code",
    );
    proto.unmount();
    const shipped = render(<Explorer graph={withCache} />);
    await layoutDone(shipped.container);
    expect(caption(shipped.container, CACHE)).toBeUndefined();
    shipped.unmount();
  });

  it("draws no bands in the shipped design", async () => {
    for (const design of [undefined, "current"] as const) {
      const { bands, view } = await drawn(design);
      expect(bands).toHaveLength(0);
      view.unmount();
    }
  });
});

describe("the prototype's panel (M10.3c3)", { timeout: 30_000 }, () => {
  const noted: ArchitectureGraph = { ...graph, warnings: [WARNING] };
  const panelOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".gi-inspector") as HTMLElement;
  const headings = (panel: HTMLElement) =>
    [...panel.querySelectorAll("h3")].map((h) => h.textContent);

  it("leads the overview with one sentence, its counts, and Try this; notes collapsed at the foot", async () => {
    const { container } = render(<Explorer graph={noted} design="prototype" />);
    await layoutDone(container);
    const panel = panelOf(container);
    expect(panel.querySelector(".gi-inspector__summary p")?.textContent).toBe(
      "An Express API and a Next.js app, with PostgreSQL and 1 outside API.",
    );
    expect(panel.querySelector(".gi-factrow")?.textContent).toBe(
      "2 services3 pages2 routes1 model1 datastore1 outside API",
    );
    expect(headings(panel)).toEqual(["Try this", "Services2", "Analysis notes1"]);
    // The suggested trace leads, named and with its shape (M10.3d1).
    expect([...panel.querySelectorAll(".gi-try__label")].map((t) => t.textContent)).toEqual([
      "Trace /orders",
      "Break down @shop/api",
      "Search the diagram",
    ]);
    expect(panel.querySelector(".gi-try__detail")?.textContent).toBe("page → API → db, 6 steps");
    // No warning text until the reader opens the notes, and no "Start here".
    expect(panel.textContent).not.toContain(WARNING.message);
    expect(panel.textContent).not.toContain("Start here");
    const toggle = panel.querySelector<HTMLButtonElement>(".gi-notes__toggle") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.textContent).toContain(WARNING.message);
  });

  it("lists each service with its role and counts, a click selecting it", async () => {
    const { container } = render(<Explorer graph={graph} design="prototype" />);
    await layoutDone(container);
    const rows = [...panelOf(container).querySelectorAll<HTMLElement>(".gi-connection")];
    expect(rows.map((r) => r.textContent)).toEqual([
      "@shop/apiExpress API · 2 routes · 1 model · 1 outside API",
      "@shop/webNext.js app · 3 pages · 1 unresolved call",
    ]);
    fireEvent.click(rows[1] as HTMLElement);
    await waitFor(() =>
      expect(panelOf(container).querySelector("h2")?.textContent).toBe("@shop/web"),
    );
  });

  it("does what each Try this action says", async () => {
    const { container } = render(<Explorer graph={graph} design="prototype" />);
    await layoutDone(container);
    const action = (label: string) =>
      [...panelOf(container).querySelectorAll<HTMLElement>(".gi-try__action")].find((a) =>
        a.textContent?.includes(label),
      ) as HTMLElement;
    fireEvent.click(action("Search the diagram"));
    const palette = () =>
      container.ownerDocument.querySelector('.gi-palette-scrim[data-state="open"]');
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(palette()).toBeNull());
    fireEvent.click(action("Break down"));
    await waitFor(
      () => {
        const api = [...container.querySelectorAll<HTMLElement>(".gi-drill__node")].find(
          (n) => n.dataset.nodeId === "service:api/",
        );
        expect(api?.hasAttribute("data-open")).toBe(true);
      },
      { timeout: 10_000 },
    );
  });

  it("traces the suggested request from Try this, and offers the suggestions in T's picker (M10.3d1)", async () => {
    const { container } = render(<Explorer graph={graph} design="prototype" />);
    await layoutDone(container);
    const doc = container.ownerDocument;
    // T with nothing selected opens the picker, the suggestions on top.
    fireEvent.keyDown(container.querySelector(".gi-drill") as HTMLElement, { key: "t" });
    const suggested = await waitFor(() => {
      const group = doc.querySelector<HTMLElement>(
        '.gi-palette-scrim[data-state="open"] [role="group"]',
      );
      expect(group).not.toBeNull();
      return group as HTMLElement;
    });
    expect([...suggested.querySelectorAll(".gi-palette__note")].map((n) => n.textContent)).toEqual([
      "page → API → db, 6 steps",
      "page → API → db, 8 steps",
      "route → db, 3 steps",
    ]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() =>
      expect(doc.querySelector('.gi-palette-scrim[data-state="open"]')).toBeNull(),
    );
    const trace = [...panelOf(container).querySelectorAll<HTMLElement>(".gi-try__action")].find(
      (a) => a.textContent?.startsWith("Trace"),
    ) as HTMLElement;
    fireEvent.click(trace);
    await waitFor(() =>
      expect(container.querySelector(".gi-explorer__step[aria-current]")).not.toBeNull(),
    );
    expect(container.querySelector(".gi-explorer__step[aria-current]")?.textContent).toContain(
      "/orders",
    );
  });

  it("opens a trace's path from the system level, only its boxes inside, and goes back on Esc (M10.3d2)", async () => {
    const { container } = render(<Explorer graph={graph} design="prototype" />);
    await layoutDone(container);
    const opened = () =>
      [...container.querySelectorAll<HTMLElement>(".gi-drill__node[data-open]")]
        .map((n) => n.dataset.nodeId)
        .sort();
    const mores = () => [...container.querySelectorAll<HTMLElement>(".gi-drill__more")];
    expect(opened()).toEqual([]);
    const trace = [...panelOf(container).querySelectorAll<HTMLElement>(".gi-try__action")].find(
      (a) => a.textContent?.startsWith("Trace"),
    ) as HTMLElement;
    fireEvent.click(trace);
    await waitFor(() => expect(mores().length).toBeGreaterThan(0), { timeout: 10_000 });
    await layoutDone(container);
    expect(opened()).toContain("service:web/");
    expect(opened()).toContain("service:api/");
    // The page's frame shows only the path's boxes: no other page is drawn.
    const box = (id: string) => container.querySelector(`.gi-drill__node[data-node-id="${id}"]`);
    expect(box("page:web//orders")).not.toBeNull();
    expect(box("page:web//checkout")).toBeNull();

    // "+ N more" shows that frame whole, focus on the frame.
    const [first] = mores();
    const label = first?.getAttribute("aria-label") ?? "";
    const count = mores().length;
    fireEvent.click(first as HTMLElement);
    await waitFor(() => expect(mores()).toHaveLength(count - 1), { timeout: 10_000 });
    expect(label).toMatch(/^Show \d+ more in /);
    expect(document.activeElement?.closest(".gi-drill__node")?.getAttribute("data-open")).toBe("");

    // "Show everything" in the trace chip: no frame leaves anything out; focus stays in the chip.
    const chip = container.querySelector('.gi-status[data-tone="trace"]') as HTMLElement;
    const everything = [...chip.querySelectorAll("button")].find(
      (b) => b.textContent === "Show everything",
    ) as HTMLElement;
    expect(mores().length).toBeGreaterThan(0);
    fireEvent.click(everything);
    await waitFor(() => expect(mores()).toHaveLength(0), { timeout: 10_000 });
    expect(chip.contains(document.activeElement)).toBe(true);
    expect(box("page:web//checkout")).not.toBeNull();
    expect(chip.textContent).not.toContain("Show everything");

    // Esc ends the trace and goes back to the level it started from.
    fireEvent.keyDown(container.querySelector(".gi-drill") as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(opened()).toEqual([]), { timeout: 10_000 });
    expect(container.querySelector('.gi-status[data-tone="trace"]')).toBeNull();
  });

  it("keeps a broken-down level as it is when a trace starts there, and the shipped design never opens a path", async () => {
    const page = "page:web//orders";
    const inside = render(
      <Explorer graph={graph} design="prototype" initialOpen={["service:api/"]} />,
    );
    await layoutDone(inside.container);
    const opened = (c: HTMLElement) =>
      [...c.querySelectorAll<HTMLElement>(".gi-drill__node[data-open]")].map(
        (n) => n.dataset.nodeId,
      );
    const trace = [
      ...panelOf(inside.container).querySelectorAll<HTMLElement>(".gi-try__action"),
    ].find((a) => a.textContent?.startsWith("Trace")) as HTMLElement;
    fireEvent.click(trace);
    await waitFor(() =>
      expect(inside.container.querySelector(".gi-explorer__step[aria-current]")).not.toBeNull(),
    );
    await layoutDone(inside.container);
    expect(opened(inside.container)).toEqual(["service:api/"]);
    expect(inside.container.querySelector(".gi-drill__more")).toBeNull();
    cleanup();

    const shipped = render(<Explorer graph={graph} initialSelected={page} />);
    await layoutDone(shipped.container);
    const before = opened(shipped.container);
    fireEvent.keyDown(shipped.container.querySelector(".gi-drill") as HTMLElement, { key: "t" });
    await waitFor(() =>
      expect(shipped.container.querySelector(".gi-explorer__step[aria-current]")).not.toBeNull(),
    );
    await layoutDone(shipped.container);
    expect(opened(shipped.container)).toEqual(before);
    expect(shipped.container.querySelector(".gi-drill__more")).toBeNull();
  });

  it("reopens a linked trace that starts in code, in the prototype only (M10.3d1)", async () => {
    const start = "symbol:web/lib/orders.ts#listOrders";
    const proto = render(<Explorer graph={graph} design="prototype" initialTrace={start} />);
    await layoutDone(proto.container);
    await waitFor(() =>
      expect(proto.container.querySelector(".gi-explorer__step[aria-current]")).not.toBeNull(),
    );
    cleanup();
    const shipped = render(<Explorer graph={graph} initialTrace={start} />);
    await layoutDone(shipped.container);
    expect(shipped.container.querySelector(".gi-explorer__step")).toBeNull();
  });

  it("keeps the shipped picker and its Start here as they were", async () => {
    const { container } = render(<Explorer graph={graph} />);
    await layoutDone(container);
    fireEvent.keyDown(container.querySelector(".gi-drill") as HTMLElement, { key: "t" });
    const doc = container.ownerDocument;
    await waitFor(() =>
      expect(doc.querySelector('.gi-palette-scrim[data-state="open"]')).not.toBeNull(),
    );
    expect(doc.querySelector('.gi-palette-scrim [role="group"]')).toBeNull();
    expect(doc.querySelector(".gi-palette__note")).toBeNull();
  });

  it('opens and focuses the Analysis notes from Ctrl K\'s "notes"', async () => {
    const { container } = render(
      <Explorer graph={noted} design="prototype" initialSelected="service:web/" />,
    );
    await layoutDone(container);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const field = await waitFor(() => {
      const input = container.ownerDocument.querySelector<HTMLInputElement>(
        '.gi-palette-scrim[data-state="open"] input',
      );
      expect(input).not.toBeNull();
      return input as HTMLInputElement;
    });
    fireEvent.change(field, { target: { value: "notes" } });
    const options = [...container.ownerDocument.querySelectorAll('[role="option"]')];
    expect(options[0]?.textContent).toContain("Analysis notes");
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => {
      const section = panelOf(container).querySelector('[data-section="warnings"]');
      expect(document.activeElement).toBe(section);
    });
    expect(panelOf(container).textContent).toContain(WARNING.message);
  });

  it("finds no Analysis notes in Ctrl K when there are none, or in the shipped design", async () => {
    for (const [g, design] of [
      [graph, "prototype"],
      [noted, "current"],
    ] as const) {
      const view = render(<Explorer graph={g} design={design} />);
      await layoutDone(view.container);
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
      const field = await waitFor(() => {
        const input = view.container.ownerDocument.querySelector<HTMLInputElement>(
          '.gi-palette-scrim[data-state="open"] input',
        );
        expect(input).not.toBeNull();
        return input as HTMLInputElement;
      });
      fireEvent.change(field, { target: { value: "notes" } });
      const options = [...view.container.ownerDocument.querySelectorAll('[role="option"]')];
      expect(options.some((o) => o.textContent?.includes("Analysis notes"))).toBe(false);
      view.unmount();
    }
  });

  it("briefs a node, lays out its facts, and groups its calls by target with their sites", async () => {
    const { container } = render(
      <Explorer
        graph={graph}
        design="prototype"
        initialSelected="file:api/src/orders/handlers.ts"
      />,
    );
    await layoutDone(container);
    const panel = panelOf(container);
    expect(panel.querySelector(".gi-inspector__summary p")?.textContent).toBe(
      "File defining createOrder and listOrders. It calls chargeOrder and uses Order.",
    );
    const grid = [...panel.querySelectorAll(".gi-factgrid > div")].map((r) => [
      r.querySelector("dt")?.textContent,
      r.querySelector("dd")?.textContent,
    ]);
    expect(grid).toContainEqual(["Data", "Order"]);
    const calls = [...panel.querySelectorAll("section")].find(
      (s) => s.querySelector("h3")?.textContent === "Calls2",
    ) as HTMLElement;
    const rows = [...calls.querySelectorAll(".gi-connection")].map((r) => r.textContent);
    expect(rows).toEqual(["chargeOrder1 call · Exact match", "Order1 read, 1 write · Exact match"]);
    const toggles = calls.querySelectorAll<HTMLButtonElement>(".gi-connection__sites-toggle");
    expect(toggles[1]?.getAttribute("aria-label")).toBe("Show 2 call sites for Order");
    fireEvent.click(toggles[1] as HTMLElement);
    const sites = [...calls.querySelectorAll(".gi-connection__sites li")].map((s) => s.textContent);
    expect(sites).toHaveLength(2);
    for (const s of sites) expect(s).toMatch(/^apps\/api\/src\/orders\/handlers\.ts:\d+$/);
    expect(toggles[1]?.getAttribute("aria-expanded")).toBe("true");
  });

  it("draws a service's missing imports as one dotted box, listing each in the panel (M10.3d4)", async () => {
    const API = "service:api/";
    const FROM = "file:api/src/orders/handlers.ts";
    const missing = ["./+types/root", "./+types/orders", "~/lib/gone"].map((expression, i) => ({
      node: {
        id: `unresolved:api/src/orders/handlers.ts:${i + 1}:1`,
        kind: "unresolved" as const,
        label: expression,
        parentId: API,
        reason: "UNKNOWN_SYMBOL" as const,
        expression,
        source: { file: "apps/api/src/orders/handlers.ts", line: i + 1, column: 1 },
      },
      edge: {
        id: `imports:${FROM}->${i}`,
        kind: "imports" as const,
        from: FROM,
        to: `unresolved:api/src/orders/handlers.ts:${i + 1}:1`,
        confidence: "unresolved" as const,
        sites: [{ file: "apps/api/src/orders/handlers.ts", line: i + 1, column: 1 }],
      },
    }));
    const g: ArchitectureGraph = {
      ...graph,
      nodes: [...graph.nodes, ...missing.map((m) => m.node)],
      edges: [...graph.edges, ...missing.map((m) => m.edge)],
    };
    const GROUP = `group:unresolved/${API}#imports/UNKNOWN_SYMBOL`;
    const picked: string[] = [];
    const { container } = render(
      <Explorer
        graph={g}
        design="prototype"
        initialOpen={[API]}
        initialSelected={GROUP}
        onStateChange={(s) => {
          if (s.selected) picked.push(s.selected);
        }}
      />,
    );
    await layoutDone(container);
    const box = container.querySelector<HTMLElement>(`[data-node-id="${GROUP}"] > .gi-node`);
    expect(box?.hasAttribute("data-dotted")).toBe(true);
    expect(box?.querySelector(".gi-node__label")?.textContent).toBe("Not in the repo · 3 imports");
    expect(box?.querySelector(".gi-node__subtitle")?.textContent).toBe(
      "React Router types./+types/*",
    );
    // Its members aren't drawn beside it.
    expect(container.querySelector(`[data-node-id="${missing[0]?.node.id}"]`)).toBeNull();
    const panel = panelOf(container);
    expect(panel.querySelector(".gi-inspector__summary p")?.textContent).toBe(
      "3 imports of files the analysis couldn't find in the repo. 2 point to ./+types/*: React Router types.",
    );
    const list = [...panel.querySelectorAll(".gi-imports li")].map((li) => li.textContent);
    expect(list).toEqual([
      "./+types/rootapps/api/src/orders/handlers.ts:1",
      "./+types/ordersapps/api/src/orders/handlers.ts:2",
      "~/lib/goneapps/api/src/orders/handlers.ts:3",
    ]);
    expect(headings(panel)).toContain("Imports3");
    // Imports aren't calls: no "Unresolved calls" count, no "Nothing … connects" line.
    expect(panel.textContent).not.toContain("Unresolved calls");
    fireEvent.click(panel.querySelector(".gi-imports button") as HTMLElement);
    await waitFor(() => expect(picked.at(-1)).toBe(missing[0]?.node.id), { timeout: 10_000 });
  });

  it("keeps the shipped panel in the shipped design", async () => {
    const { container } = render(<Explorer graph={noted} />);
    await layoutDone(container);
    const panel = panelOf(container);
    expect(headings(panel)).toEqual(["Start here", "Warnings1"]);
    expect(panel.querySelector(".gi-try, .gi-factrow, .gi-notes")).toBeNull();
  });
});

describe("the prototype's fact grid (M10.3c3)", () => {
  it("lists three names, then +N, which shows the rest in place; a name selects its node", () => {
    const picked: string[] = [];
    const items = ["a", "b", "c", "d", "e"].map((text) => ({ text, id: `n:${text}` }));
    const { container } = render(
      <FactGrid rows={[{ label: "Calls into", items }]} onSelect={(id) => picked.push(id)} />,
    );
    const links = () =>
      [...container.querySelectorAll(".gi-factgrid__link")].map((l) => l.textContent);
    expect(links()).toEqual(["a", "b", "c"]);
    const more = container.querySelector<HTMLButtonElement>(".gi-factgrid__more") as HTMLElement;
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("aria-label")).toBe("Show 2 more in Calls into");
    fireEvent.click(more);
    expect(links()).toEqual(["a", "b", "c", "d", "e"]);
    expect(container.querySelector(".gi-factgrid__more")).toBeNull();
    fireEvent.click(container.querySelectorAll(".gi-factgrid__link")[3] as HTMLElement);
    expect(picked).toEqual(["n:d"]);
  });
});
