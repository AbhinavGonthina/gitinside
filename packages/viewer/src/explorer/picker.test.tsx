import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { filterChoices, pickerResults, traceChoices, TracePicker } from "./picker.js";
import { suggestTraces } from "./suggest.js";
import { canTraceFrom } from "./trace.js";

afterEach(cleanup);

const graph = shopDemo();
const index = buildHierarchy(graph);
const choices = traceChoices(index);
const labels = (results: { node: { label: string } }[]) => results.map((r) => r.node.label);

describe("traceChoices", () => {
  it("offers every page and route with a request path, pages first", () => {
    const traceable = graph.nodes.filter((n) => canTraceFrom(index, n)).map((n) => n.id);
    expect(traceable.length).toBeGreaterThan(2);
    expect(choices.map((c) => c.result.node.id).sort()).toEqual(traceable.sort());
    const kinds = choices.map((c) => c.result.node.kind);
    expect(kinds).toEqual([...kinds].sort());
    expect(new Set(kinds)).toEqual(new Set(["page", "route"]));
    expect(labels(choices.map((c) => c.result))).toContain("POST /api/orders");
    // Each says where it lives and which layer tints its icon.
    const post = choices.find((c) => c.result.node.label === "POST /api/orders")?.result;
    expect(post?.path).toBe("apps/api/src/routes/orders.ts");
    expect(post?.layer).toBe("backend");
  });

  it("leaves out pages and routes that go nowhere", () => {
    const route = graph.nodes.find((n) => n.id === "route:api/POST /api/orders");
    if (!route) throw new Error("no route");
    const alone = buildHierarchy({
      ...graph,
      edges: graph.edges.filter((e) => e.from !== route.id),
    });
    expect(traceChoices(alone).map((c) => c.result.node.id)).not.toContain(route.id);
  });
});

describe("filterChoices", () => {
  it("keeps everything for an empty query", () => {
    expect(filterChoices(choices, "  ")).toHaveLength(choices.length);
  });

  it("matches every word, in any case, in the name or the file", () => {
    expect(labels(filterChoices(choices, "post ORDERS"))).toEqual(["POST /api/orders"]);
    // "routes/" is only in the file path.
    const byFile = filterChoices(choices, "routes/orders");
    expect(labels(byFile).sort()).toEqual(["GET /api/orders", "POST /api/orders"]);
    expect(filterChoices(choices, "post nothing")).toEqual([]);
  });

  it("marks the first match of each word in the name", () => {
    const [post] = filterChoices(choices, "post orders");
    expect(post?.matches).toEqual([
      [0, 4],
      [10, 16],
    ]);
    // A word found only in the file marks nothing.
    const [byFile] = filterChoices(choices, "routes/");
    expect(byFile?.matches).toBeUndefined();
  });
});

describe("pickerResults", () => {
  it("puts the suggestions first while nothing is typed, keeping each one's file and layer", () => {
    const suggested = suggestTraces(index, 2);
    const { results, sections } = pickerResults(choices, "", suggested);
    expect(sections).toEqual([
      { label: "Suggested", start: 0 },
      { label: "All pages and routes", start: 2 },
    ]);
    expect(results).toHaveLength(choices.length + 2);
    const first = choices.find((c) => c.result.node.id === suggested[0]?.node.id)?.result;
    expect(results[0]).toEqual({ ...first, note: suggested[0]?.shape });
    // Spaces alone aren't a query; with no suggestions there are no sections.
    expect(pickerResults(choices, "  ", suggested).sections).toHaveLength(2);
    expect(pickerResults(choices, "", [])).toEqual({ results: filterChoices(choices, "") });
    expect(pickerResults(choices, "orders", suggested).sections).toBeUndefined();
  });
});

describe("TracePicker", () => {
  it("searches, moves with the arrows, and traces the active one with Enter", () => {
    const onPick = vi.fn();
    render(<TracePicker choices={choices} state="open" onPick={onPick} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Trace a request" })).toBeTruthy();
    const field = screen.getByRole("combobox", { name: "Trace from a page or route" });
    expect(document.activeElement).toBe(field);
    expect(screen.getAllByRole("option")).toHaveLength(choices.length);
    fireEvent.change(field, { target: { value: "orders" } });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-selected"))[0]).toBe("true");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(filterChoices(choices, "orders")[1]?.node.id);
    // Typing again starts from the first result.
    fireEvent.change(field, { target: { value: "order" } });
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("to trace")).toBeTruthy();
  });

  it("keeps Tab in the field and closes on Esc", () => {
    const onClose = vi.fn();
    render(<TracePicker choices={choices} state="open" onPick={vi.fn()} onClose={onClose} />);
    const field = screen.getByRole("combobox");
    expect(fireEvent.keyDown(field, { key: "Tab" })).toBe(false); // default prevented
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lists the suggestions under Suggested, with their shapes, until something is typed (M10.3d1)", () => {
    const suggested = suggestTraces(index);
    const onPick = vi.fn();
    render(
      <TracePicker
        choices={choices}
        suggested={suggested}
        state="open"
        onPick={onPick}
        onClose={vi.fn()}
      />,
    );
    const groups = screen.getAllByRole("group");
    expect(groups).toEqual([
      screen.getByRole("group", { name: "Suggested" }),
      screen.getByRole("group", { name: "All pages and routes" }),
    ]);
    const top = within(groups[0] as HTMLElement).getAllByRole("option");
    expect(top.map((o) => o.querySelector(".gi-palette__note")?.textContent)).toEqual(
      suggested.map((s) => s.shape),
    );
    // A suggestion shows its shape, not its file.
    expect(top[0]?.querySelector(".gi-palette__path")).toBeNull();
    expect(within(groups[1] as HTMLElement).getAllByRole("option")).toHaveLength(choices.length);
    // The arrows run through both groups as one list.
    const field = screen.getByRole("combobox");
    for (let i = 0; i < suggested.length; i++) fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[suggested.length]?.getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(field, { key: "ArrowUp" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(suggested[suggested.length - 1]?.node.id);
    // Typing searches every choice, without the suggestions.
    fireEvent.change(field, { target: { value: "orders" } });
    expect(screen.queryAllByRole("group")).toEqual([]);
    expect(screen.getAllByRole("option")).toHaveLength(filterChoices(choices, "orders").length);
  });

  it("says when nothing matches, and when the repo has nothing to trace", () => {
    render(<TracePicker choices={choices} state="open" onPick={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
    expect(screen.getByRole("status").textContent).toBe("No page or route matches “zzz”.");
    cleanup();
    render(<TracePicker choices={[]} state="open" onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe(
      "No page or route in this repo has a request path to trace.",
    );
  });
});
