import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { shopDemo } from "../prototype/shopDemo.testkit.js";
import { closeIn, collapseTo, openIn, upFrom, useDrill } from "./drill.js";

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

describe("useDrill", () => {
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
