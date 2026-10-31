import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../shopDemo.testkit.js";
import {
  SEARCH_LIMIT,
  SearchPalette,
  searchEntries,
  searchNodes,
  type SearchEntry,
} from "./search.js";

afterEach(cleanup);

const graph = shopDemo();
const index = buildHierarchy(graph);
const entries = searchEntries(index);
const ids = (query: string) => searchNodes(entries, query).map((r) => r.node.id);
const find = (id: string) => entries.find((e) => e.result.node.id === id)?.result;

describe("searchEntries", () => {
  it("offers every node but the system, each with where it lives", () => {
    expect(entries.map((e) => e.result.node.id)).toEqual(
      graph.nodes.filter((n) => n.kind !== "system").map((n) => n.id),
    );
    expect(find("service:api/")?.path).toBe("apps/api");
    expect(find("module:api/src/routes")?.path).toBe("apps/api/src/routes");
    expect(find("file:api/src/routes/orders.ts")?.path).toBe("apps/api/src/routes/orders.ts");
    expect(find("route:api/POST /api/orders")?.path).toBe("apps/api/src/routes/orders.ts");
    // An outside API named by its host doesn't repeat it.
    expect(find("external:ext/api.stripe.com")?.path).not.toBe("api.stripe.com");
    // The layer tints the icon, inherited from the service.
    expect(find("symbol:web/lib/orders.ts#placeOrder")?.layer).toBe("frontend");
  });
});

describe("searchNodes", () => {
  it("lists nothing for an empty query", () => {
    expect(searchNodes(entries, "   ")).toEqual([]);
  });

  it("ranks whole names, then name starts, then word starts, kinds breaking ties", () => {
    expect(ids("orders").slice(0, 7)).toEqual([
      // Whole names in any case: folders before functions, then by name and ID.
      "module:api/src/orders",
      "module:web/app/orders",
      "symbol:web/app/orders/page.tsx#Orders",
      "symbol:api/src/routes/orders.ts#orders",
      // Names that start with it.
      "file:api/src/routes/orders.ts",
      "file:web/lib/orders.ts",
      // At a word start: the page before routes and functions.
      "page:web//orders",
    ]);
    // Inside a camelCase name, at its word start.
    const [list] = searchNodes(entries, "orders").filter((r) => r.node.label === "listOrders");
    expect(list?.matches).toEqual([[4, 10]]);
  });

  it("matches every word, in the name or where it lives, and marks the name", () => {
    const [post] = searchNodes(entries, "post ORDERS");
    expect(post?.node.id).toBe("route:api/POST /api/orders");
    expect(post?.matches).toEqual([
      [0, 4],
      [10, 16],
    ]);
    // "billing" is only in the path: still found, nothing marked for it.
    const billing = searchNodes(entries, "billing charge");
    expect(billing.map((r) => r.node.id)).toEqual(["symbol:api/src/billing/stripe.ts#chargeOrder"]);
    expect(billing[0]?.matches).toEqual([[0, 6]]);
    expect(ids("orders nothing")).toEqual([]);
  });

  it("finds letters in order with gaps, below any closer match", () => {
    const [place] = searchNodes(entries, "plord");
    expect(place?.node.id).toBe("symbol:web/lib/orders.ts#placeOrder");
    expect(place?.matches).toEqual([
      [0, 2],
      [5, 8],
    ]);
    // A single letter only matches as a substring, never scattered.
    expect(ids("q")).toEqual([]);
  });

  it("is the same for the same entries in any order, and keeps to the limit", () => {
    const reversed = [...entries].reverse();
    for (const q of ["orders", "a", "api", "ord"]) {
      expect(searchNodes(reversed, q)).toEqual(searchNodes(entries, q));
    }
    const first = entries[0] as SearchEntry;
    const many = Array.from({ length: SEARCH_LIMIT + 10 }, (_, i) => ({
      ...first,
      result: { ...first.result, node: { ...first.result.node, id: `copy-${String(i)}` } },
    }));
    expect(searchNodes(many, first.name)).toHaveLength(SEARCH_LIMIT);
  });
});

describe("SearchPalette", () => {
  it("takes focus, searches, and opens the active result with Enter", () => {
    const onPick = vi.fn();
    render(<SearchPalette entries={entries} state="open" onPick={onPick} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Search the diagram" })).toBeTruthy();
    const field = screen.getByRole("combobox", { name: "Search services, files, routes" });
    expect(document.activeElement).toBe(field);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toMatch(/^Type to search/);
    fireEvent.change(field, { target: { value: "place" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("symbol:web/lib/orders.ts#placeOrder");
    fireEvent.change(field, { target: { value: "zzz" } });
    expect(screen.getByRole("status").textContent).toMatch(/^Nothing matches “zzz”/);
  });

  it("keeps focus in the field when the dialog is pressed elsewhere", () => {
    render(<SearchPalette entries={entries} state="open" onPick={vi.fn()} onClose={vi.fn()} />);
    const field = screen.getByRole("combobox");
    fireEvent.change(field, { target: { value: "orders" } });
    // A press on a result or the footer keeps focus (default prevented); one on the field doesn't.
    expect(fireEvent.mouseDown(screen.getAllByRole("option")[1] as HTMLElement)).toBe(false);
    expect(fireEvent.mouseDown(document.querySelector(".gi-palette__footer") as HTMLElement)).toBe(
      false,
    );
    expect(fireEvent.mouseDown(field)).toBe(true);
  });
});
