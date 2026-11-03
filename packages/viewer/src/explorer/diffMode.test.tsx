import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { diffGraphs } from "@gitinside/diff";
import { compareStrings, type ArchitectureGraph } from "@gitinside/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diffPair } from "../diffPair.testkit.js";
import { EDGE_WORDS } from "../edges/describe.js";
import { frameCounts } from "../layout/size.js";
import { buildDiffOverlay, versionGraph } from "../model/diff.js";
import { buildHierarchy, isWithin, nodeOf } from "../model/hierarchy.js";
import { countText } from "../nodes/describe.js";
import { Explorer } from "./Explorer.js";
import { summaryOf } from "./summary.js";
import { traceFrom } from "./trace.js";

// Diff mode on the explorer (M6.9b): the fixtures/diff-broken pair, whose
// head removes routes, a file, and a model, changes a route's method, and
// adds a required parameter, breaking six connections.

afterEach(cleanup);

const { base, head, diff } = diffPair("diff-broken");
const P = "diff-broken";
const SERVICE = `service:${P}/`;
const SRC = `module:${P}/src`;
const DELETE_ROUTE = `route:${P}/DELETE /api/orders/:id`;
const PUT_ROUTE = `route:${P}/PUT /api/orders`;
const GET_ROUTE = `route:${P}/GET /api/orders`;
const CLIENT = `file:${P}/src/client.ts`;
const LEGACY = `file:${P}/src/legacy.ts`;

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

async function setup(props: Partial<Parameters<typeof Explorer>[0]> = {}) {
  const view = render(<Explorer graph={head} diff={{ base, diff }} {...props} />);
  await settle();
  /** A box's wrapper on the canvas by node ID. */
  const wrapper = (id: string) =>
    [...view.container.querySelectorAll<HTMLElement>(".gi-drill__node:not([data-leaving])")].find(
      (el) => el.dataset.nodeId === id,
    ) ?? null;
  const box = (id: string) => wrapper(id)?.querySelector<HTMLElement>(":scope > .gi-node") ?? null;
  return { ...view, wrapper, box };
}

describe("Explorer diff mode", { timeout: 30_000 }, () => {
  it("draws the overlay by default, says what it compares, and offers Base, Head, Overlay", async () => {
    const { container } = await setup();
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    const checked = within(views)
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.textContent)).toEqual(["Overlay"]);
    const chip = container.querySelector('.gi-status[data-tone="diff"]');
    expect(chip?.textContent).toBe("Comparing diff-broken-base → diff-broken-head");
  });

  it("says a closed frame holds changes, in badges and in its name", async () => {
    const { box } = await setup();
    const service = box(SERVICE);
    const badges = [...(service?.querySelectorAll(".gi-badge[data-diff]") ?? [])];
    expect(badges.map((b) => [b.getAttribute("data-diff"), b.textContent])).toEqual([
      ["added", "5 added"],
      ["changed", "7 changed"],
      ["removed", "9 removed"],
      ["broken", "6 broken"],
    ]);
    expect(service?.getAttribute("aria-label")).toMatch(
      /Changes inside: 5 added, 7 changed, 9 removed, 6 broken$/,
    );
    // The service itself didn't change: no tag of its own.
    expect(service?.hasAttribute("data-diff")).toBe(false);
  });

  it("marks each box with its state, removed ones too, and drops the badges once a frame opens", async () => {
    const { box } = await setup({ initialOpen: [SERVICE, SRC] });
    expect(box(DELETE_ROUTE)?.getAttribute("data-diff")).toBe("removed");
    expect(box(PUT_ROUTE)?.getAttribute("data-diff")).toBe("added");
    expect(box(LEGACY)?.getAttribute("data-diff")).toBe("removed");
    expect(box(CLIENT)?.getAttribute("data-diff")).toBe("changed");
    expect(box(LEGACY)?.getAttribute("aria-label")).toMatch(/Removed in this change/);
    expect(box(SERVICE)?.querySelector(".gi-badge[data-diff]")).toBeNull();
    // A closed file holding a changed symbol says so.
    expect(box(`file:${P}/src/pricing.ts`)?.getAttribute("aria-label")).toMatch(
      /Changes inside: 1 changed, 1 broken$/,
    );
  });

  it("draws broken connections dashed red with the diff's words, and many as a count", async () => {
    const { container } = await setup({ initialOpen: [SERVICE, SRC] });
    const broken = [...container.querySelectorAll(".gi-edge[data-broken]")].map(
      (e) => e.getAttribute("aria-label") ?? "",
    );
    expect(broken.some((name) => name.endsWith("Broken: DELETE /api/orders/:id was removed"))).toBe(
      true,
    );
    expect(
      broken.some((name) => name.endsWith("Broken: POST /api/orders is now PUT /api/orders")),
    ).toBe(true);
    // handlers.ts reads two models in prisma/, and both reads broke.
    expect(broken.some((name) => name.endsWith("Broken: 2 connections broken"))).toBe(true);
    const pills = [...container.querySelectorAll(".gi-edge-label[data-broken]")].map(
      (p) => p.textContent,
    );
    expect(pills).toContain("DELETE /api/orders/:id was removed");
  });

  it("sizes the layout for what diff mode draws", async () => {
    const { container } = await setup({ initialOpen: [SERVICE, SRC] });
    const plain = render(<Explorer graph={head} initialOpen={[SERVICE, SRC]} />);
    await waitFor(
      () => expect(plain.container.querySelector(".gi-drill[data-layout='done']")).not.toBeNull(),
      { timeout: 10_000 },
    );
    const width = (root: Element, id: string) =>
      [...root.querySelectorAll<HTMLElement>(".gi-drill__node")].find(
        (el) => el.dataset.nodeId === id,
      )?.style.width;
    // A closed file's change badges widen it; a pill makes room for its words.
    const pricing = `file:${P}/src/pricing.ts`;
    expect(parseFloat(width(container, pricing) ?? "0")).toBeGreaterThan(
      parseFloat(width(plain.container, pricing) ?? "0"),
    );
    const pill = [...container.querySelectorAll<HTMLElement>(".gi-edge-label[data-broken]")].find(
      (p) => p.textContent === "DELETE /api/orders/:id was removed",
    );
    expect(Number(pill?.dataset.measuredWidth)).toBeGreaterThan(200);
  });

  it("shows Head or Base alone on the overlay's layout, leaving the other's boxes and lines out in place", async () => {
    const { container, wrapper, box } = await setup({ initialOpen: [SERVICE, SRC] });
    const place = (id: string) => {
      const el = wrapper(id);
      return el ? `${el.style.left},${el.style.top}` : undefined;
    };
    const before = [DELETE_ROUTE, PUT_ROUTE, CLIENT, LEGACY].map(place);
    const views = screen.getByRole("radiogroup", { name: "Diff view" });

    fireEvent.click(within(views).getByRole("radio", { name: "Head" }));
    await settle();
    expect(wrapper(DELETE_ROUTE)?.hasAttribute("data-absent")).toBe(true);
    expect(wrapper(LEGACY)?.hasAttribute("data-absent")).toBe(true);
    expect(box(LEGACY)?.getAttribute("role")).not.toBe("treeitem");
    expect(wrapper(LEGACY)?.getAttribute("aria-hidden")).toBe("true");
    expect(box(LEGACY)?.tabIndex).toBe(-1);
    expect(wrapper(PUT_ROUTE)?.hasAttribute("data-absent")).toBe(false);
    // No diff marks outside the overlay, and the lines to removed routes are out.
    expect(container.querySelector(".gi-node[data-diff], .gi-edge[data-diff]")).toBeNull();
    const hidden = [...container.querySelectorAll(".gi-edge[data-absent]")];
    expect(hidden.length).toBeGreaterThan(0);
    expect(container.querySelector(".gi-edge[data-broken]")).toBeNull();
    // Siblings count only what's in the tree.
    const src = box(SRC);
    const files = [...container.querySelectorAll<HTMLElement>(".gi-drill__node")]
      .filter((el) => el.dataset.nodeId?.startsWith(`file:${P}/src/`))
      .map((el) => el.querySelector(":scope > .gi-node"));
    const inTree = files.filter((f) => f?.getAttribute("role") === "treeitem");
    expect(inTree.map((f) => f?.getAttribute("aria-setsize"))).toEqual(
      inTree.map(() => String(inTree.length)),
    );
    expect(src).not.toBeNull();
    expect(screen.getByText("Showing the head version")).toBeTruthy();

    fireEvent.click(within(views).getByRole("radio", { name: "Base" }));
    await settle();
    expect(wrapper(PUT_ROUTE)?.hasAttribute("data-absent")).toBe(true);
    expect(wrapper(DELETE_ROUTE)?.hasAttribute("data-absent")).toBe(false);
    expect(wrapper(LEGACY)?.hasAttribute("data-absent")).toBe(false);

    fireEvent.click(within(views).getByRole("radio", { name: "Overlay" }));
    await settle();
    expect(container.querySelector("[data-absent]")).toBeNull();
    // Nothing moved.
    expect([DELETE_ROUTE, PUT_ROUTE, CLIENT, LEGACY].map(place)).toEqual(before);
  });

  it("keeps the selection in a version that has it, and lets it go in one that doesn't", async () => {
    await setup({ initialOpen: [SERVICE, SRC], initialSelected: GET_ROUTE });
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    const selectedItems = () =>
      screen
        .getAllByRole("treeitem")
        .filter((t) => t.getAttribute("aria-selected") === "true")
        .map((t) => t.closest<HTMLElement>(".gi-drill__node")?.dataset.nodeId);

    // GET /api/orders is in both versions.
    fireEvent.click(within(views).getByRole("radio", { name: "Base" }));
    await settle();
    expect(selectedItems()).toEqual([GET_ROUTE]);
    fireEvent.click(within(views).getByRole("radio", { name: "Head" }));
    await settle();
    expect(selectedItems()).toEqual([GET_ROUTE]);
    expect(screen.getByText("Showing the head version")).toBeTruthy();

    // The removed DELETE route isn't in Head.
    fireEvent.click(within(views).getByRole("radio", { name: "Overlay" }));
    await settle();
    fireEvent.click(document.querySelector(`[data-node-id="${DELETE_ROUTE}"] > .gi-node`)!);
    expect(selectedItems()).toEqual([DELETE_ROUTE]);
    fireEvent.click(within(views).getByRole("radio", { name: "Head" }));
    await settle();
    expect(selectedItems()).toEqual([]);
    expect(
      screen.getByText(
        "Showing the head version. DELETE /api/orders/:id isn't in it, so it's no longer selected",
      ),
    ).toBeTruthy();
    // Back on the overlay, it stays let go.
    fireEvent.click(within(views).getByRole("radio", { name: "Overlay" }));
    await settle();
    expect(selectedItems()).toEqual([]);
  });

  it("follows a trace through the version shown", async () => {
    // Neither pair changes a request path, so this head's listOrders also calls quote.
    const quote = head.edges.find(
      (e) => e.kind === "calls" && e.from === `symbol:${P}/src/pricing.ts#quote`,
    )!;
    const listOrders = `symbol:${P}/src/handlers.ts#listOrders`;
    const added = {
      ...quote,
      from: listOrders,
      id: `calls:${listOrders}->${quote.from}`,
      to: quote.from,
    };
    const longer: ArchitectureGraph = {
      ...head,
      edges: [...head.edges, added].sort((a, b) => compareStrings(a.id, b.id)),
    };
    const { container } = await setup({
      graph: longer,
      diff: { base, diff: diffGraphs(base, longer) },
      initialTrace: GET_ROUTE,
      initialStep: 0,
    });
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    const stepCount = () => container.querySelectorAll(".gi-explorer__step").length;
    const steps = (graph: ArchitectureGraph) =>
      traceFrom(buildHierarchy(graph), GET_ROUTE).steps.length;
    expect(steps(longer)).toBeGreaterThan(steps(base));
    expect(stepCount()).toBe(steps(longer));

    fireEvent.click(within(views).getByRole("radio", { name: "Base" }));
    await settle();
    expect(container.querySelector('.gi-status[data-tone="trace"]')).not.toBeNull();
    expect(stepCount()).toBe(steps(base));
    fireEvent.click(within(views).getByRole("radio", { name: "Head" }));
    await settle();
    expect(stepCount()).toBe(steps(longer));
  });

  it("ends a trace from a route the version shown doesn't have", async () => {
    const { container } = await setup({ initialTrace: DELETE_ROUTE, initialStep: 0 });
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    expect(container.querySelector('.gi-status[data-tone="trace"]')).not.toBeNull();
    fireEvent.click(within(views).getByRole("radio", { name: "Head" }));
    await settle();
    expect(container.querySelector('.gi-status[data-tone="trace"]')).toBeNull();
    expect(
      screen.getByText(
        "Showing the head version. The trace from DELETE /api/orders/:id ended: it isn't in this version",
      ),
    ).toBeTruthy();
    // The picker offers only what Head can trace.
    fireEvent.click(screen.getByRole("button", { name: /^Trace/ }));
    const choices = await screen.findAllByRole("option");
    const names = choices.map((c) => c.textContent ?? "");
    expect(names.some((n) => n.includes("DELETE"))).toBe(false);
    expect(names.some((n) => n.includes("GET"))).toBe(true);
  });

  it("counts only the version shown: a frame's badges, a line's connections, the inspector", async () => {
    const { box, container } = await setup({ initialSelected: SERVICE });
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    const overlay = buildDiffOverlay(base, head, diff);
    const badges = () =>
      [...(box(SERVICE)?.querySelectorAll(".gi-badge:not([data-diff])") ?? [])].map(
        (b) => b.textContent,
      );
    const summary = () =>
      container.querySelector(".gi-inspector__summary p")?.textContent ?? "missing";
    // The service's line to the database stands for two connections; head keeps one.
    const DB = `datastore:infra/${P}/prisma/schema.prisma#db`;
    const ends = `${nodeOf(buildHierarchy(head), SERVICE).label} ${EDGE_WORDS.stores.verb} ${
      nodeOf(buildHierarchy(head), DB).label
    }. `;
    const dbLine = () =>
      [...container.querySelectorAll<SVGElement>(".gi-edge:not([data-absent])")].find((l) =>
        l.getAttribute("aria-label")?.startsWith(ends),
      );
    const expected = (version: "base" | "head") => {
      const index = buildHierarchy(versionGraph(overlay, version));
      const text = render(<p>{summaryOf(index, nodeOf(index, SERVICE))}</p>);
      const words = text.container.textContent;
      text.unmount();
      return { badges: frameCounts(index, SERVICE).map(countText), summary: words };
    };
    expect(badges()).toEqual(["5 routes", "2 models", "4 unresolved calls"]);
    const overlayLine = dbLine()?.getAttribute("aria-label");
    expect(overlayLine).toMatch(/2 /);

    fireEvent.click(within(views).getByRole("radio", { name: "Head" }));
    await settle();
    expect(badges()).toEqual(["2 routes", "1 model", "4 unresolved calls"]);
    expect(badges()).toEqual(expected("head").badges);
    expect(summary()).toBe(expected("head").summary);
    const headLine = head.edges.find((e) => e.kind === "stores" && e.to === DB);
    expect(dbLine()?.getAttribute("aria-label")).not.toBe(overlayLine);
    expect(dbLine()?.getAttribute("aria-label")).not.toMatch(/2 /);
    expect(headLine).toBeDefined();

    fireEvent.click(within(views).getByRole("radio", { name: "Base" }));
    await settle();
    expect(badges()).toEqual(["4 routes", "2 models"]);
    expect(summary()).toBe(expected("base").summary);
    expect(summary()).not.toBe(expected("head").summary);
  });

  it("names a renamed node as base had it in Base, sized for both names", async () => {
    const pair = diffPair("diff-rename");
    const R = "diff-rename";
    const file = `file:${R}/src/orders/routes.ts`;
    const { box, wrapper } = await setup({
      graph: pair.head,
      diff: { base: pair.base, diff: pair.diff },
      initialOpen: [`service:${R}/`, `module:${R}/src`, `module:${R}/src/orders`],
      initialSelected: file,
    });
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    const name = () => box(file)?.querySelector(".gi-node__label")?.textContent;
    const header = () => document.querySelector(".gi-inspector__header")?.textContent ?? "";
    expect(name()).toBe("routes.ts");
    expect(header()).toContain("src/orders");
    const width = wrapper(file)?.style.width;

    fireEvent.click(within(views).getByRole("radio", { name: "Base" }));
    await settle();
    expect(wrapper(file)?.hasAttribute("data-absent")).toBe(false);
    expect(name()).toBe("orders.ts");
    expect(box(file)?.getAttribute("aria-label")).toMatch(/^orders\.ts/);
    expect(header()).toContain("orders.ts");
    expect(header()).toContain("src/routes");
    expect(wrapper(file)?.style.width).toBe(width);

    fireEvent.click(within(views).getByRole("radio", { name: "Head" }));
    await settle();
    expect(name()).toBe("routes.ts");
  });

  it("names a diff of other graphs on an error card instead of drawing it", () => {
    const { container } = render(
      <Explorer graph={head} diff={{ base, diff: { ...diff, analyzerVersion: "0.0.0-other" } }} />,
    );
    expect(
      screen.getByRole("heading", { name: "This comparison doesn't match these commits" }),
    ).toBeTruthy();
    expect(container.querySelector(".gi-empty")?.getAttribute("data-tone")).toBe("error");
    expect(screen.getByText(/different analyzer versions/)).toBeTruthy();
    expect(container.querySelector(".gi-drill")).toBeNull();
  });

  it("uses the names it's given in the chip", async () => {
    const { container } = await setup({
      diff: { base, diff, baseName: "main", headName: "PR #12" },
    });
    expect(container.querySelector('.gi-status[data-tone="diff"]')?.textContent).toBe(
      "Comparing main → PR #12",
    );
  });

  it("has no diff chrome without a diff", async () => {
    render(<Explorer graph={head} />);
    await settle();
    expect(screen.queryByRole("radiogroup", { name: "Diff view" })).toBeNull();
    expect(document.querySelector('.gi-status[data-tone="diff"]')).toBeNull();
    expect(document.querySelector(".gi-badge[data-diff]")).toBeNull();
    expect(document.querySelector(".gi-changes")).toBeNull();
  });
});

describe("Explorer diff mode's code (M6.9e1)", { timeout: 30_000 }, () => {
  const BASE_SHA = "b".repeat(40);
  const HEAD_SHA = "c".repeat(40);
  const shas = { base: BASE_SHA, head: HEAD_SHA };
  /** A loader whose file text says which commit it came from. */
  const loader = (commit: string) => vi.fn(async (path: string) => `// ${commit} ${path}`);
  const github = () =>
    screen.queryByRole("link", { name: /Open on GitHub/ })?.getAttribute("href") ?? undefined;
  const code = async (text: string) =>
    waitFor(() => expect(document.querySelector(".gi-inspector")?.textContent).toContain(text), {
      timeout: 10_000,
    });
  const showVersion = async (name: "Base" | "Head" | "Overlay") => {
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    fireEvent.click(within(views).getByRole("radio", { name }));
    await settle();
  };

  it("reads Base's nodes at the base commit, where base had them, and Head's at head's", async () => {
    const R = "diff-rename";
    const pair = diffPair(R, shas);
    const atHead = loader("head");
    const atBase = loader("base");
    await setup({
      graph: pair.head,
      loadSource: atHead,
      diff: { base: pair.base, diff: pair.diff, loadSource: atBase },
      initialSelected: `route:${R}/GET /api/orders`,
    });
    const repo = "https://github.com/fixtures";
    expect(github()).toBe(`${repo}/diff-rename-head/blob/${HEAD_SHA}/src/orders/routes.ts#L20`);
    await code("// head src/orders/routes.ts");

    await showVersion("Base");
    expect(github()).toBe(`${repo}/diff-rename-base/blob/${BASE_SHA}/src/routes/orders.ts#L19`);
    await code("// base src/routes/orders.ts");
    expect(document.querySelector(".gi-inspector__header")?.textContent).toContain(
      "src/routes/orders.ts:19",
    );
    expect(atBase).toHaveBeenCalledWith("src/routes/orders.ts");
    expect(atHead).not.toHaveBeenCalledWith("src/routes/orders.ts");

    await showVersion("Head");
    expect(github()).toBe(`${repo}/diff-rename-head/blob/${HEAD_SHA}/src/orders/routes.ts#L20`);
  });

  it("steps a trace in Base along base's call sites, at the base commit", async () => {
    const R = "diff-rename";
    const pair = diffPair(R, shas);
    const atBase = loader("base");
    await setup({
      graph: pair.head,
      loadSource: loader("head"),
      diff: { base: pair.base, diff: pair.diff, loadSource: atBase },
      initialTrace: `route:${R}/GET /api/orders`,
      initialStep: 0,
    });
    const location = () => document.querySelector(".gi-explorer__hop-header code")?.textContent;
    expect(location()).toBe("src/orders/routes.ts:20");
    await showVersion("Base");
    expect(location()).toBe("src/routes/orders.ts:19");
    await code("// base src/routes/orders.ts");
  });

  it("reads what the Overlay draws from base alone, a removed route and its hop, at the base commit", async () => {
    const pair = diffPair("diff-broken", shas);
    const atBase = loader("base");
    await setup({
      graph: pair.head,
      loadSource: loader("head"),
      diff: { base: pair.base, diff: pair.diff, loadSource: atBase },
      initialSelected: DELETE_ROUTE,
    });
    expect(github()).toContain(`/diff-broken-base/blob/${BASE_SHA}/src/server.ts#L`);
    await code("// base src/server.ts");
    cleanup();

    await setup({
      graph: pair.head,
      loadSource: loader("head"),
      diff: { base: pair.base, diff: pair.diff, loadSource: atBase },
      initialTrace: DELETE_ROUTE,
      initialStep: 0,
    });
    await code("// base src/server.ts");
  });

  it("shows Base no code without a base loader, rather than head's", async () => {
    const R = "diff-rename";
    const pair = diffPair(R, shas);
    await setup({
      graph: pair.head,
      loadSource: loader("head"),
      diff: { base: pair.base, diff: pair.diff },
      initialSelected: `route:${R}/GET /api/orders`,
    });
    await code("// head src/orders/routes.ts");
    await showVersion("Base");
    expect(github()).toContain(`/blob/${BASE_SHA}/src/routes/orders.ts#L19`);
    expect(document.querySelector(".gi-inspector")?.textContent).not.toContain("// head");
    expect(screen.queryByRole("heading", { name: "Code" })).toBeNull();
  });
});

describe("Explorer diff mode's changes list", { timeout: 30_000 }, () => {
  const overlay = buildDiffOverlay(base, head, diff);
  const changes = () => document.querySelector<HTMLElement>(".gi-inspector .gi-changes");
  /** Each group's heading and count, as shown. */
  const groups = () =>
    [...(changes()?.querySelectorAll(".gi-changes__group") ?? [])].map((h) => h.textContent);
  /** A row by the start of its accessible name ("Removed: DELETE /api/orders/:id"). */
  const row = (name: string) =>
    within(changes()!)
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-label")?.startsWith(name));

  it("lists Added, Changed, Removed, and Broken in the overview, counted as the frames count them", async () => {
    await setup();
    const all = overlay.inside.get(buildHierarchy(overlay.graph).root.id)!;
    expect(groups()).toEqual([
      `Added${all.added}`,
      `Changed${all.changed}`,
      `Removed${all.removed}`,
      `Broken${all.broken}`,
    ]);
    // One button per row, each named by its state, node, and change in words.
    const rows = within(changes()!).getAllByRole("button");
    const listed = Object.values(overlay.changes).reduce((n, g) => n + g.length, 0);
    expect(rows).toHaveLength(listed);
    expect(row("Removed: DELETE /api/orders/:id, route.")).toBeDefined();
    expect(row("Removed: legacy.ts, file. File · src/legacy.ts · 1 more inside")).toBeDefined();
    expect(
      row("Broken: placeOrder, function. POST /api/orders is now PUT /api/orders"),
    ).toBeDefined();
    expect(row("Changed: client.ts, file. Code changed")).toBeDefined();
  });

  it("flies to a row's node, opening its ancestors, selecting and focusing it", async () => {
    const { box, wrapper } = await setup();
    expect(wrapper(DELETE_ROUTE)).toBeNull();
    fireEvent.click(row("Removed: DELETE /api/orders/:id")!);
    await settle();
    await waitFor(() => expect(document.activeElement).toBe(box(DELETE_ROUTE)));
    expect(box(DELETE_ROUTE)?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".gi-inspector__header h2")?.textContent).toBe(
      "DELETE/api/orders/:id",
    );
    // The selection's inspector lists only its own changes.
    expect(changes()?.querySelector("h3")?.textContent).toBe("Changes here");
    expect(within(changes()!).getAllByRole("button")).toHaveLength(1);
  });

  it("lists a selected frame's changes inside it, and none for an unchanged node", async () => {
    await setup({ initialOpen: [SERVICE, SRC], initialSelected: SRC });
    const index = buildHierarchy(overlay.graph);
    const inSrc = Object.values(overlay.changes)
      .flat()
      .filter((r) => isWithin(index, r.id, SRC));
    const names = within(changes()!)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? "");
    expect(names).toHaveLength(inSrc.length);
    expect(names.some((n) => n.startsWith("Removed: legacy.ts"))).toBe(true);
    // The models removed from prisma/ aren't in src/.
    const all = Object.values(overlay.changes).flat();
    expect(inSrc.length).toBeLessThan(all.length);
    expect(names.some((n) => n.includes(", model."))).toBe(false);
    expect(all.some((r) => r.kind === "model")).toBe(true);

    cleanup();
    const db = `file:${P}/src/db.ts`;
    expect(overlay.nodes.has(db)).toBe(false);
    await setup({ initialOpen: [SERVICE, SRC], initialSelected: db });
    expect(changes()).toBeNull();
  });

  it("shows a row Head doesn't have on the overlay, and says so", async () => {
    const { box } = await setup();
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    fireEvent.click(within(views).getByRole("radio", { name: "Head" }));
    await settle();
    // The list is the diff's, so Head lists what it removed too.
    fireEvent.click(row("Removed: DELETE /api/orders/:id")!);
    await settle();
    const checked = within(views)
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.textContent)).toEqual(["Overlay"]);
    await waitFor(() => expect(document.activeElement).toBe(box(DELETE_ROUTE)));
    expect(
      screen.getByText(
        /^Showing the changes between base and head: DELETE \/api\/orders\/:id isn't in the head version\./,
      ),
    ).toBeTruthy();
  });

  it("stays on Head for a row Head has", async () => {
    const { box } = await setup();
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    fireEvent.click(within(views).getByRole("radio", { name: "Head" }));
    await settle();
    fireEvent.click(row(`Added: PUT /api/orders`)!);
    await settle();
    await waitFor(() => expect(document.activeElement).toBe(box(PUT_ROUTE)));
    const checked = within(views)
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.textContent)).toEqual(["Head"]);
  });

  it("says where a renamed or moved node came from", async () => {
    const pair = diffPair("diff-rename");
    await setup({ graph: pair.head, diff: { base: pair.base, diff: pair.diff } });
    expect(row("Changed: routes.ts, file. Moved from src/routes/orders.ts")).toBeDefined();
  });
});
