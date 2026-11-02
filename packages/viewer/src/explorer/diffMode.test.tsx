import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { diffGraphs } from "@gitinside/diff";
import { compareStrings, type ArchitectureGraph } from "@gitinside/schema";
import { afterEach, describe, expect, it } from "vitest";
import { diffPair } from "../diffPair.testkit.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { Explorer } from "./Explorer.js";
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
  });
});
