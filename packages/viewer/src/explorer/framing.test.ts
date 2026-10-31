// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { fitCamera, READABLE_ZOOM } from "./camera.js";
import { FIT_INSET } from "./fit.js";
import { autoCamera, boxesRect, entriesRect, lastOpened } from "./framing.js";
import type { Shown } from "./transition.js";

const index = buildHierarchy(shopDemo());
const API = "service:api/";
const WEB = "service:web/";

/**
 * A made-up layout of a view: the system level in a row, then each open
 * node's children in one column inside it, entries first (as ELK places a
 * service's first level), 100 × 40 each, 20 apart.
 */
function shownWith(open: string[]): Shown {
  const view = buildView(index, open);
  const boxes = view.nodes.map((n, i) => ({
    id: n.id,
    x: 40 + i * 120,
    y: 40,
    width: 100,
    height: 40,
  }));
  for (const id of view.open) {
    const frame = boxes.find((b) => b.id === id);
    const children = view.childrenOf.get(id) ?? [];
    if (!frame) continue;
    Object.assign(frame, { width: 400, height: 80 + children.length * 60 });
    children.forEach((c, i) => {
      const box = boxes.find((b) => b.id === c);
      if (box) Object.assign(box, { x: frame.x + 20, y: frame.y + 60 + i * 60 });
    });
  }
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + 40;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 40;
  return { view, layout: { boxes, edges: [], width: right, height: bottom } };
}

describe("framing", () => {
  it("bounds boxes by ID, ignoring the rest, and none without a match", () => {
    const boxes = [
      { id: "a", x: 10, y: 20, width: 30, height: 40 },
      { id: "b", x: 100, y: 0, width: 10, height: 10 },
      { id: "c", x: 500, y: 500, width: 10, height: 10 },
    ];
    expect(boxesRect(boxes, ["a", "b"])).toEqual({ x: 10, y: 0, width: 100, height: 60 });
    expect(boxesRect(boxes, ["z"])).toBeUndefined();
  });

  it("frames a broken-down service from its name to its entries", () => {
    const shown = shownWith([API]);
    const entries = (shown.view.childrenOf.get(API) ?? []).filter(
      (c) => shown.view.byId.get(c)?.section === "entries",
    );
    expect(entries.length).toBeGreaterThan(0);
    const frame = shown.layout.boxes.find((b) => b.id === API);
    const last = boxesRect(shown.layout.boxes, entries);
    if (!frame || !last) throw new Error("not laid out");
    expect(entriesRect(shown, API)).toEqual({
      x: frame.x,
      y: frame.y,
      width: last.x + last.width - frame.x,
      height: last.y + last.height - frame.y,
    });
    // Its folders, after the entries, are left out.
    expect(last.y + last.height).toBeLessThan(frame.y + frame.height - 60);
    // Not open: nothing to frame.
    expect(entriesRect(shown, WEB)).toBeUndefined();
  });

  it("fits a level that reads whole, and frames the last broken-down node of one that doesn't", () => {
    const shown = shownWith([API]);
    const roomy = { width: shown.layout.width + 200, height: shown.layout.height + 200 };
    expect(autoCamera(shown, roomy, API)).toEqual(fitCamera(shown.layout, roomy));
    // A canvas a third of the level's size: the fit would be under the readable zoom.
    const small = { width: shown.layout.width / 3, height: shown.layout.height / 3 };
    expect(fitCamera(shown.layout, small).zoom).toBeLessThan(READABLE_ZOOM);
    const framed = autoCamera(shown, small, API);
    expect(framed.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
    // The frame's name corner at the inset.
    const frame = shown.layout.boxes.find((b) => b.id === API);
    expect(frame && frame.x * framed.zoom + framed.x).toBe(FIT_INSET.x);
    expect(frame && frame.y * framed.zoom + framed.y).toBe(FIT_INSET.y);
    // Nothing to frame: the fit.
    expect(autoCamera(shown, small, undefined)).toEqual(fitCamera(shown.layout, small));
    expect(autoCamera(undefined, small, API)).toEqual(fitCamera({ width: 0, height: 0 }, small));
  });

  it("finds the node opened last that the drawn view still has open", () => {
    const shown = shownWith([WEB, API]);
    expect(lastOpened([API, WEB], shown)).toBe(WEB);
    expect(lastOpened([WEB, API, "module:api/src"], shown)).toBe(API);
    expect(lastOpened([], shown)).toBeUndefined();
    expect(lastOpened([API], undefined)).toBeUndefined();
  });
});
