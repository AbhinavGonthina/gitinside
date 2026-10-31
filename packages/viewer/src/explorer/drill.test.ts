import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { hiddenNodes, NO_FILTERS } from "../model/filters.js";
import { effectiveOpen } from "../model/view.js";
import { closeIn, collapseTo, isShown, openIn, revealIn, upFrom, useDrill } from "./drill.js";

const index = buildHierarchy(shopDemo());
const API = "service:api/";
const WEB = "service:web/";
const SRC = "module:api/src";
const ORDERS = "module:api/src/orders";

describe("openIn", () => {
  it("appends a node, moving one opened before to the end (most recent last)", () => {
    expect(openIn(index, [], API)).toEqual([API]);
    expect(openIn(index, [API, WEB], API)).toEqual([WEB, API]);
  });

  it("ignores a node with nothing inside, keeping the same array", () => {
    const expansion = [API];
    expect(openIn(index, expansion, "datastore:infra/db")).toBe(expansion);
    expect(openIn(index, expansion, "unknown")).toBe(expansion);
  });
});

describe("closeIn", () => {
  it("removes the node and keeps what was opened inside it, to restore on reopening", () => {
    expect(closeIn([API, SRC], API)).toEqual([SRC]);
  });

  it("keeps the same array when the node isn't open", () => {
    const expansion = [API];
    expect(closeIn(expansion, WEB)).toBe(expansion);
  });
});

describe("upFrom", () => {
  it("closes the most recently opened node that is open now", () => {
    expect(upFrom(index, [API, SRC, WEB])).toEqual({ expansion: [API, SRC], closed: WEB });
    expect(upFrom(index, [API, SRC])).toEqual({ expansion: [API], closed: SRC });
  });

  it("skips nodes remembered inside a closed one", () => {
    // SRC was opened last, but api is closed, so SRC isn't on the canvas.
    expect(upFrom(index, [WEB, SRC])).toEqual({ expansion: [SRC], closed: WEB });
  });

  it("skips nodes the filters hide, which stay broken down for when they're shown", () => {
    const noWeb = hiddenNodes(index, { ...NO_FILTERS, layers: ["frontend"] });
    expect(upFrom(index, [API, WEB], noWeb)).toEqual({ expansion: [WEB], closed: API });
    expect(upFrom(index, [WEB], noWeb)).toEqual({ expansion: [WEB] });
  });

  it("has nothing to close at the system level", () => {
    const expansion = [SRC];
    expect(upFrom(index, expansion)).toEqual({ expansion });
    expect(upFrom(index, [])).toEqual({ expansion: [] });
  });
});

describe("collapseTo", () => {
  it("closes everything inside a frame and keeps the frame open", () => {
    expect(collapseTo(index, [WEB, API, SRC, ORDERS], API)).toEqual([WEB, API]);
  });

  it("closes everything at the root", () => {
    expect(collapseTo(index, [WEB, API, SRC], index.root.id)).toEqual([]);
  });
});

describe("isShown and revealIn", () => {
  const ROUTE = "route:api/POST /api/orders";
  const PLACE_ORDER = "symbol:web/lib/orders.ts#placeOrder";
  const shown = (expansion: readonly string[], id: string) =>
    isShown(index, effectiveOpen(index, expansion), id);

  it("knows which nodes are their own box", () => {
    expect(shown([], API)).toBe(true);
    expect(shown([], index.root.id)).toBe(false);
    expect(shown([], SRC)).toBe(false);
    expect(shown([API], SRC)).toBe(true);
    // A route is an entry at its service's first level, wherever its file is.
    expect(shown([API], ROUTE)).toBe(true);
    expect(shown([], ROUTE)).toBe(false);
    expect(shown([API], "unknown")).toBe(false);
  });

  it("opens a node's closed ancestors, outermost first, until it's drawn", () => {
    expect(revealIn(index, [], PLACE_ORDER)).toEqual([
      WEB,
      "module:web/lib",
      "file:web/lib/orders.ts",
    ]);
    // A route only needs its service.
    expect(revealIn(index, [], ROUTE)).toEqual([API]);
  });

  it("keeps open nodes where they are, and changes nothing for a shown node", () => {
    expect(revealIn(index, [WEB, API], ORDERS)).toEqual([WEB, API, SRC]);
    const expansion = [API];
    expect(revealIn(index, expansion, SRC)).toBe(expansion);
    expect(revealIn(index, expansion, index.root.id)).toBe(expansion);
  });
});

describe("useDrill", () => {
  it("reveals a node deep inside", () => {
    const { result } = renderHook(() => useDrill(index));
    act(() => result.current.reveal(ORDERS));
    expect(result.current.view.byId.has(ORDERS)).toBe(true);
  });

  it("goes up and reveals on the canvas the filters leave", () => {
    const noWeb = { ...NO_FILTERS, layers: ["frontend" as const] };
    const { result } = renderHook(() => useDrill(index, [API, WEB], { filters: noWeb }));
    let closed: string | undefined;
    act(() => {
      closed = result.current.up();
    });
    expect(closed).toBe(API);
    expect(result.current.expansion).toEqual([WEB]);

    // Shown again by the filters it's revealed under, web keeps its place.
    act(() => result.current.open(API));
    act(() => result.current.reveal("symbol:web/lib/orders.ts#placeOrder", NO_FILTERS));
    expect(result.current.expansion).toEqual([
      WEB,
      API,
      "module:web/lib",
      "file:web/lib/orders.ts",
    ]);
  });

  it("builds the view for its expansion and moves through it", () => {
    const { result } = renderHook(() => useDrill(index));
    expect(result.current.view.open).toEqual([]);

    act(() => result.current.open(API));
    act(() => result.current.open(SRC));
    expect(result.current.expansion).toEqual([API, SRC]);
    expect(result.current.view.open).toEqual([SRC, API]); // sorted

    let closed: string | undefined;
    act(() => {
      closed = result.current.up();
    });
    expect(closed).toBe(SRC);
    expect(result.current.view.open).toEqual([API]);

    act(() => result.current.collapseTo(index.root.id));
    expect(result.current.expansion).toEqual([]);
    act(() => {
      closed = result.current.up();
    });
    expect(closed).toBeUndefined();
  });

  it("starts from an initial expansion and keeps the view while nothing changes", () => {
    const { result, rerender } = renderHook(() => useDrill(index, [API]));
    const view = result.current.view;
    rerender();
    expect(result.current.view).toBe(view);
    act(() => result.current.open("datastore:infra/db"));
    expect(result.current.view).toBe(view);
    act(() => result.current.close(API));
    expect(result.current.view.open).toEqual([]);
  });
});
