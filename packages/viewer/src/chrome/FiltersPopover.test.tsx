import { EdgeKind, type Confidence } from "@gitinside/schema";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILTER_KINDS, NO_FILTERS, type FilterOptions, type Filters } from "../model/filters.js";
import { CONNECTION_NAMES, FiltersPopover, KIND_PLURALS } from "./FiltersPopover.js";

afterEach(cleanup);

const OPTIONS: FilterOptions = {
  layers: [
    { value: "frontend", count: 1 },
    { value: "backend", count: 1 },
  ],
  kinds: [
    { value: "route", count: 12 },
    { value: "symbol", count: 1_204 },
  ],
  edgeKinds: [
    { value: "calls", count: 30 },
    { value: "imports", count: 41 },
  ],
  confidence: [
    { value: "exact", count: 60 },
    { value: "heuristic", count: 11 } satisfies { value: Confidence; count: number },
  ],
  folders: ["apps/api", "apps/api/src", "apps/web"],
};

function setup(filters: Filters = NO_FILTERS, hiddenKinds = new Set<EdgeKind>(["imports"])) {
  const onFiltersChange = vi.fn();
  const onHiddenKindsChange = vi.fn();
  const onClose = vi.fn();
  const onClear = vi.fn();
  render(
    <FiltersPopover
      autoFocus
      options={OPTIONS}
      filters={filters}
      hiddenKinds={hiddenKinds}
      onFiltersChange={onFiltersChange}
      onHiddenKindsChange={onHiddenKindsChange}
      onClear={onClear}
      onClose={onClose}
    />,
  );
  /** A choice in a group, by its text (its name includes the count). */
  const choice = (group: string, name: RegExp): HTMLButtonElement => {
    const button = within(screen.getByRole("group", { name: group }))
      .getAllByRole("button")
      .find((b) => name.test(b.textContent ?? ""));
    if (!(button instanceof HTMLButtonElement)) throw new Error(`no ${String(name)} in ${group}`);
    return button;
  };
  return { onFiltersChange, onHiddenKindsChange, onClose, onClear, choice };
}

describe("FiltersPopover", () => {
  it("names every connection kind and every filterable node kind", () => {
    expect(Object.keys(CONNECTION_NAMES)).toEqual(EdgeKind.options);
    for (const kind of FILTER_KINDS) expect(KIND_PLURALS[kind]).toBeTruthy();
  });

  it("offers what the graph has, with counts, pressed while shown", () => {
    const { choice } = setup({ ...NO_FILTERS, layers: ["backend"] });
    expect(choice("Layers", /Frontend/).getAttribute("aria-pressed")).toBe("true");
    expect(choice("Layers", /Backend/).getAttribute("aria-pressed")).toBe("false");
    expect(choice("Kinds", /Functions and classes/).textContent).toBe("Functions and classes1,204");
    // Imports are off by default; the others are on.
    expect(choice("Connections", /Imports/).getAttribute("aria-pressed")).toBe("false");
    expect(choice("Connections", /Calls/).getAttribute("aria-pressed")).toBe("true");
    // Pages aren't in this graph, so they aren't offered.
    expect(screen.queryByText("Pages")).toBeNull();
  });

  it("moves focus to the tests switch on open", () => {
    setup();
    expect(document.activeElement).toBe(
      screen.getByRole("switch", { name: "Hide tests and config" }),
    );
  });

  it("reports each change as the whole new filters", () => {
    const { choice, onFiltersChange, onHiddenKindsChange } = setup({
      ...NO_FILTERS,
      kinds: ["route"],
    });
    fireEvent.click(choice("Layers", /Backend/));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      ...NO_FILTERS,
      kinds: ["route"],
      layers: ["backend"],
    });
    fireEvent.click(choice("Kinds", /Routes/));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, kinds: [] });
    fireEvent.click(choice("Confidence", /Heuristic/));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      ...NO_FILTERS,
      kinds: ["route"],
      confidence: ["heuristic"],
    });
    fireEvent.click(screen.getByRole("switch", { name: "Hide tests and config" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      ...NO_FILTERS,
      kinds: ["route"],
      hideTestsAndConfig: true,
    });
    fireEvent.click(choice("Connections", /Imports/));
    expect([...(onHiddenKindsChange.mock.lastCall?.[0] as Set<EdgeKind>)]).toEqual([]);
    fireEvent.click(choice("Connections", /Calls/));
    expect([...(onHiddenKindsChange.mock.lastCall?.[0] as Set<EdgeKind>)]).toEqual([
      "imports",
      "calls",
    ]);
  });

  it("shows a folder alone or hides it, as typed, and refuses one the repo doesn't have", () => {
    const { onFiltersChange } = setup();
    const field = screen.getByRole("combobox", { name: "Folders" });
    fireEvent.change(field, { target: { value: "apps/nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(onFiltersChange).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("No folder apps/nope in this repo.");
    expect(field.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(field, { target: { value: " ./apps/api/ " } });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show only" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, include: ["apps/api"] });
    expect((field as HTMLInputElement).value).toBe("");

    // Enter hides it.
    fireEvent.change(field, { target: { value: "apps/web" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, exclude: ["apps/web"] });
  });

  it("lists the folders in use, each with a way to take it off", () => {
    const { onFiltersChange } = setup({
      ...NO_FILTERS,
      include: ["apps/api"],
      exclude: ["apps/web"],
    });
    expect(screen.getByText("apps/api").parentElement?.textContent).toBe("Only apps/api");
    fireEvent.click(screen.getByRole("button", { name: "Stop showing only apps/api" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      ...NO_FILTERS,
      exclude: ["apps/web"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Show apps/web again" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, include: ["apps/api"] });
  });

  it("closes with Esc (once: the key is marked handled) and clears with Clear", () => {
    const { onClose, onClear } = setup();
    const outer = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(screen.getByRole("switch", { name: "Hide tests and config" }), {
      key: "Escape",
    });
    document.removeEventListener("keydown", outer);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer.mock.results[0]?.value).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  /** The popover over filters it keeps itself, Clear on only while something is filtered (like the explorer's). */
  function Stateful({ initial }: { initial: Filters }) {
    const [filters, setFilters] = useState(initial);
    const filtered = filters.include.length + filters.exclude.length + filters.layers.length > 0;
    return (
      <FiltersPopover
        options={OPTIONS}
        filters={filters}
        hiddenKinds={new Set()}
        onFiltersChange={setFilters}
        onClear={filtered ? () => setFilters(NO_FILTERS) : undefined}
        onClose={() => {}}
      />
    );
  }

  it("keeps focus in the popover when Clear turns itself off", () => {
    render(<Stateful initial={{ ...NO_FILTERS, layers: ["backend"] }} />);
    const clear = screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement;
    clear.focus();
    fireEvent.click(clear);
    expect(clear.disabled).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("switch", { name: "Hide tests and config" }),
    );
  });

  it("moves focus to the next folder chip when one is taken off, then to the field", () => {
    render(<Stateful initial={{ ...NO_FILTERS, include: ["apps/api"], exclude: ["apps/web"] }} />);
    const first = screen.getByRole("button", { name: "Stop showing only apps/api" });
    first.focus();
    fireEvent.click(first);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Show apps/web again" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show apps/web again" }));
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Folders" }));
  });

  it("moves focus to the chip before when the last one is taken off", () => {
    render(<Stateful initial={{ ...NO_FILTERS, include: ["apps/api"], exclude: ["apps/web"] }} />);
    const last = screen.getByRole("button", { name: "Show apps/web again" });
    last.focus();
    fireEvent.click(last);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Stop showing only apps/api" }),
    );
  });

  it("disables Clear with nothing to clear, and is inert while closing", () => {
    const { container } = render(
      <FiltersPopover
        state="closing"
        options={OPTIONS}
        filters={NO_FILTERS}
        hiddenKinds={new Set()}
      />,
    );
    const popover = container.querySelector(".gi-filters");
    expect(popover?.hasAttribute("inert")).toBe(true);
    expect(popover?.getAttribute("data-state")).toBe("closing");
    expect(
      (popover?.querySelector(".gi-popover__header button") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
