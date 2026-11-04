// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { shopDemo } from "../shopDemo.testkit.js";
import type { Rect } from "../chrome/describe.js";
import { fitCamera, READABLE_ZOOM, type Camera } from "./camera.js";
import { FIT_INSET } from "./fit.js";
import { autoCamera, boxesRect, entriesRect, fitLevel, lastOpened } from "./framing.js";
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
    // Nothing to frame: the level's fit.
    expect(autoCamera(shown, small, undefined)).toEqual(fitLevel(shown.layout, small));
    expect(autoCamera(undefined, small, API)).toEqual(fitCamera({ width: 0, height: 0 }, small));
  });
});

describe("fitLevel", () => {
  const CANVAS = { width: 1000, height: 800 };
  /** Boxes 200 × 60 in a column at `x`, from `y`, 100 apart. */
  const column = (prefix: string, x: number, y: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${prefix}${i}`,
      x,
      y: y + i * 100,
      width: 200,
      height: 60,
    }));
  /** The boxes wholly in the canvas's room inside the inset at this camera. */
  const framed = (boxes: (Rect & { id: string })[], c: Camera) =>
    boxes
      .filter((b) => {
        const left = b.x * c.zoom + c.x;
        const top = b.y * c.zoom + c.y;
        return (
          left >= FIT_INSET.x &&
          top >= FIT_INSET.y &&
          left + b.width * c.zoom <= CANVAS.width - FIT_INSET.x &&
          top + b.height * c.zoom <= CANVAS.height - FIT_INSET.y
        );
      })
      .map((b) => b.id);

  it("is the fit when the level fits", () => {
    const layout = { width: 900, height: 600, edges: [], boxes: column("a", 40, 40, 5) };
    expect(fitLevel(layout, CANVAS)).toEqual(fitCamera(layout, CANVAS));
    expect(fitLevel(layout, { width: 0, height: 0 })).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it("frames the most boxes at the floor, not an empty top-left corner (M5.13b2)", () => {
    // Like cal.diy's 113 services: a sparse level far over the canvas, its
    // top-left corner crossed only by lines.
    const boxes = [
      ...column("lone", 40, 3000, 1),
      ...column("far", 9000, 200, 2),
      ...column("busy", 5000, 7000, 6),
    ];
    const layout = { width: 10_000, height: 10_000, edges: [], boxes };
    const fit = fitCamera(layout, CANVAS);
    expect(fit.zoom).toBe(0.4);
    expect(framed(boxes, fit)).toEqual([]);
    const c = fitLevel(layout, CANVAS);
    expect(c.zoom).toBe(fit.zoom);
    expect(framed(boxes, c)).toEqual(["busy0", "busy1", "busy2", "busy3", "busy4", "busy5"]);
  });

  it("picks the leftmost of windows holding as many, then the topmost", () => {
    const boxes = [
      ...column("right", 8000, 1000, 3),
      ...column("low", 2000, 8000, 3),
      ...column("high", 2000, 4000, 3),
    ];
    const layout = { width: 10_000, height: 10_000, edges: [], boxes };
    expect(framed(boxes, fitLevel(layout, CANVAS))).toEqual(["high0", "high1", "high2"]);
  });

  it("keeps the fit's place on an axis that fits", () => {
    const boxes = [...column("a", 40, 40, 1), ...column("b", 6000, 40, 2)];
    const layout = { width: 10_000, height: 300, edges: [], boxes };
    const fit = fitCamera(layout, CANVAS);
    const c = fitLevel(layout, CANVAS);
    expect(c.y).toBe(fit.y);
    expect(framed(boxes, c)).toEqual(["b0", "b1"]);
  });

  it("stays inside the level at its edges", () => {
    const boxes = column("edge", 9760, 9600, 3).map((b) => ({ ...b, y: b.y - 200 }));
    const layout = { width: 10_000, height: 10_000, edges: [], boxes };
    const c = fitLevel(layout, CANVAS);
    expect(framed(boxes, c)).toEqual(["edge0", "edge1", "edge2"]);
    // The level's far corner sits at the inset's corner, not past it.
    expect(layout.width * c.zoom + c.x).toBe(CANVAS.width - FIT_INSET.x);
    expect(layout.height * c.zoom + c.y).toBe(CANVAS.height - FIT_INSET.y);
  });

  it("finds the node opened last that the drawn view still has open", () => {
    const shown = shownWith([WEB, API]);
    expect(lastOpened([API, WEB], shown)).toBe(WEB);
    expect(lastOpened([WEB, API, "module:api/src"], shown)).toBe(API);
    expect(lastOpened([], shown)).toBeUndefined();
    expect(lastOpened([API], undefined)).toBeUndefined();
  });
});
