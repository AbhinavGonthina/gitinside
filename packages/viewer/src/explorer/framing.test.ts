// @vitest-environment node
import { describe, expect, it } from "vitest";
import { codeShop } from "../model/codeLines.testkit.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView, type GraphView } from "../model/view.js";
import { shopDemo } from "../shopDemo.testkit.js";
import type { Rect } from "../chrome/describe.js";
import { fitCamera, READABLE_ZOOM, type Camera, type Size } from "./camera.js";
import { FIRST_VIEW, FIT_INSET } from "./fit.js";
import {
  autoCamera,
  belowBand,
  boxesRect,
  clearOfOverlays,
  entriesRect,
  firstView,
  fitLevel,
  hubOf,
  lastOpened,
} from "./framing.js";
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

describe("the prototype's first view (M10.3b2, M10-design A2 and A5)", () => {
  const code = buildHierarchy(codeShop());

  /** The system level of `codeShop` in a row, 100 × 40 each, `gap` apart. */
  function level(gap: number): Shown {
    const view = buildView(code, []);
    const boxes = view.nodes.map((n, i) => ({
      id: n.id,
      x: 40 + i * (100 + gap),
      y: 40,
      width: 100,
      height: 40,
    }));
    const width = Math.max(...boxes.map((b) => b.x + b.width)) + 40;
    return { view, layout: { boxes, edges: [], width, height: 120 } };
  }

  it("picks the service with the most lines that aren't code as the hub", () => {
    const view = buildView(code, []);
    // api: web's requests, the Stripe call, and the database; web: its requests and code lines only.
    expect(hubOf(view)).toBe(API);
    // Code lines alone don't make a hub.
    const onlyCode = {
      ...view,
      edges: view.edges.filter((e) => e.kind === "calls"),
    };
    expect(onlyCode.edges.length).toBeGreaterThan(0);
    expect(hubOf(onlyCode)).toBeUndefined();
  });

  it("breaks a tie between hubs by ID, and counts only services", () => {
    const service = (id: string) => ({ id, parent: null, node: { kind: "service" } });
    const store = { id: "datastore:db", parent: null, node: { kind: "datastore" } };
    const view = {
      byId: new Map([service("service:b/"), service("service:a/"), store].map((n) => [n.id, n])),
      edges: [
        { kind: "reads", from: "service:b/", to: "datastore:db" },
        { kind: "writes", from: "service:a/", to: "datastore:db" },
      ],
    } as unknown as GraphView;
    expect(hubOf(view)).toBe("service:a/");
  });

  it("fits a level that reads at 70% or more, as the shipped explorer does", () => {
    const shown = level(40);
    const canvas = { width: shown.layout.width * 0.8 + 2 * FIT_INSET.x, height: 600 };
    const fit = fitLevel(shown.layout, canvas);
    expect(fit.zoom).toBeGreaterThanOrEqual(FIRST_VIEW.least);
    expect(fit.zoom).toBeLessThan(1);
    expect(firstView(shown, canvas)).toEqual(fit);
    expect(autoCamera(shown, canvas, undefined, { firstView: true })).toEqual(fit);
  });

  it("opens a level that doesn't on its hub at 80%, keeping the canvas full", () => {
    const shown = level(600);
    const canvas = { width: 1000, height: 700 };
    expect(fitLevel(shown.layout, canvas).zoom).toBeLessThan(FIRST_VIEW.least);
    const camera = firstView(shown, canvas);
    expect(camera.zoom).toBe(FIRST_VIEW.hub);
    const hub = shown.layout.boxes.find((b) => b.id === API);
    if (!hub) throw new Error("no hub box");
    const left = hub.x * camera.zoom + camera.x;
    const right = (hub.x + hub.width) * camera.zoom + camera.x;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(canvas.width);
    // The hub is in the row's middle, so it's centered across; the row is short, so it's centered down.
    expect(Math.abs((left + right) / 2 - canvas.width / 2)).toBeLessThanOrEqual(1);
    expect(camera.y).toBe(Math.round((canvas.height - shown.layout.height * camera.zoom) / 2));
    // The fit button's overview keeps the 40% floor; a focus keeps its own frame.
    expect(autoCamera(shown, canvas, undefined)).toEqual(fitLevel(shown.layout, canvas));
    expect(autoCamera(shown, canvas, undefined, { firstView: true })).toEqual(camera);
  });

  it("stops at the diagram's edge rather than center a hub near it", () => {
    const shown = level(600);
    const canvas = { width: 1000, height: 700 };
    // api moved to the row's start, where centering it would leave the canvas's left part empty.
    const start: Shown = {
      ...shown,
      layout: {
        ...shown.layout,
        boxes: shown.layout.boxes.map((b) => (b.id === API ? { ...b, x: 0 } : b)),
      },
    };
    const camera = firstView(start, canvas);
    expect(camera.zoom).toBe(FIRST_VIEW.hub);
    expect(camera.x).toBe(FIT_INSET.x);
    // Moved to the row's end: its right edge at the inset from the canvas's.
    const end: Shown = {
      ...shown,
      layout: {
        ...shown.layout,
        boxes: shown.layout.boxes.map((b) =>
          b.id === API ? { ...b, x: shown.layout.width - b.width } : b,
        ),
      },
    };
    const last = firstView(end, canvas);
    expect(shown.layout.width * last.zoom + last.x).toBe(canvas.width - FIT_INSET.x);
  });

  it("fits a level with no hub", () => {
    const shown = level(600);
    const canvas = { width: 1000, height: 700 };
    const none: Shown = { ...shown, view: { ...shown.view, edges: [] } };
    expect(firstView(none, canvas)).toEqual(fitLevel(shown.layout, canvas));
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

  it("fits below a band over the canvas's top, and as before when the band is within the inset (M9.2g)", () => {
    const layout = { width: 900, height: 1200, edges: [], boxes: column("a", 40, 40, 11) };
    const fit = fitLevel(layout, CANVAS);
    // The level fills the canvas's height: its top is at the inset.
    expect(layout.height * fit.zoom).toBeGreaterThan(CANVAS.height - 2 * FIT_INSET.y - 1);
    const pick = (room: Size) => fitLevel(layout, room);
    expect(belowBand(CANVAS, 0, pick)).toEqual(fit);
    expect(belowBand(CANVAS, FIT_INSET.y, pick)).toEqual(fit);
    // A 220px band (a hint card): the level starts below it and ends at the bottom inset.
    const c = belowBand(CANVAS, 220, pick);
    expect(c.zoom).toBeLessThan(fit.zoom);
    expect(Math.min(...layout.boxes.map((b) => b.y * c.zoom + c.y))).toBeGreaterThanOrEqual(220);
    expect(layout.height * c.zoom + c.y).toBeLessThanOrEqual(CANVAS.height - FIT_INSET.y);
    // A level the fit already starts below the band: left where it is.
    const low = { width: 900, height: 300, edges: [], boxes: column("b", 40, 40, 2) };
    const lowFit = fitLevel(low, CANVAS);
    expect(lowFit.y).toBeGreaterThanOrEqual(220);
    expect(belowBand(CANVAS, 220, (room) => fitLevel(low, room))).toEqual(lowFit);
    // A canvas too short to keep the insets below the band: as if there were none.
    const short = { width: 1000, height: 280 };
    expect(belowBand(short, 220, pick)).toEqual(fitLevel(layout, short));
    expect(belowBand({ width: 0, height: 0 }, 220, pick)).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it("finds the node opened last that the drawn view still has open", () => {
    const shown = shownWith([WEB, API]);
    expect(lastOpened([API, WEB], shown)).toBe(WEB);
    expect(lastOpened([WEB, API, "module:api/src"], shown)).toBe(API);
    expect(lastOpened([], shown)).toBeUndefined();
    expect(lastOpened([API], undefined)).toBeUndefined();
  });
});

describe("clearOfOverlays (M10.3c2)", () => {
  const canvas = { width: 1000, height: 800 };
  // A toolbar at the bottom right and a hint at the bottom left, as the prototype draws them.
  const toolbar = { x: 740, y: 748, width: 244, height: 36 };
  const hint = { x: 16, y: 748, width: 380, height: 36 };
  // A tall level: columns of 100px boxes 60px apart, 2,000px tall.
  const boxes = [0, 1, 2].flatMap((col) =>
    Array.from({ length: 12 }, (_, row) => ({
      x: col * 400,
      y: row * 160 + 20,
      width: 240,
      height: 100,
    })),
  );
  const tall = { width: 1040, height: 1940, boxes };
  const under = (c: Camera, o: Rect) =>
    boxes.some((b) => {
      const l = b.x * c.zoom + c.x;
      const t = b.y * c.zoom + c.y;
      const r = l + b.width * c.zoom;
      const bottom = t + b.height * c.zoom;
      return l < o.x + o.width && r > o.x && t < o.y + o.height && bottom > o.y;
    });

  it("moves a camera that puts a box under an overlay to the nearest clear place", () => {
    const camera = { zoom: 0.8, x: 0, y: -600 };
    expect(under(camera, toolbar)).toBe(true);
    const clear = clearOfOverlays(camera, tall, canvas, [toolbar, hint]);
    expect(clear.zoom).toBe(0.8);
    expect(clear.x).toBe(0);
    expect(under(clear, toolbar) || under(clear, hint)).toBe(false);
    expect(Math.abs(clear.y - camera.y)).toBeLessThanOrEqual(canvas.height / 4);
    // The nearest: one px closer is blocked.
    const closer = { ...clear, y: clear.y + Math.sign(camera.y - clear.y) };
    expect(under(closer, toolbar) || under(closer, hint)).toBe(true);
  });

  it("leaves a camera alone when nothing is under an overlay, a level that fits, or no overlays", () => {
    const clear = clearOfOverlays({ zoom: 0.8, x: 0, y: -600 }, tall, canvas, [toolbar]);
    expect(clearOfOverlays(clear, tall, canvas, [toolbar])).toEqual(clear);
    const short = { width: 1040, height: 500, boxes: boxes.slice(0, 3) };
    const fit = { zoom: 0.8, x: 0, y: 600 };
    expect(clearOfOverlays(fit, short, canvas, [toolbar])).toBe(fit);
    const camera = { zoom: 0.8, x: 0, y: -600 };
    expect(clearOfOverlays(camera, tall, canvas, [])).toBe(camera);
    // Unmeasured overlays (jsdom's 0 × 0) count as none.
    expect(clearOfOverlays(camera, tall, canvas, [{ ...toolbar, width: 0, height: 0 }])).toBe(
      camera,
    );
  });

  it("with a box to keep, goes as far as that box stays inside the insets", () => {
    // Only the left column, rows 120px apart: the hint's row is clear only between rows.
    const left = boxes.filter((b) => b.x === 0);
    const level = { ...tall, boxes: left.map((b) => ({ ...b, height: 116 })) };
    const camera = { zoom: 1, x: 0, y: -400 };
    const hub = level.boxes[5] as Rect;
    const kept = clearOfOverlays(camera, level, canvas, [hint], hub);
    const onScreen = (c: Camera) =>
      hub.y * c.zoom + c.y >= FIT_INSET.y &&
      (hub.y + hub.height) * c.zoom + c.y <= canvas.height - FIT_INSET.y;
    expect(onScreen(kept)).toBe(true);
    const blocked = (c: Camera) =>
      level.boxes.some((b) => {
        const t = b.y * c.zoom + c.y;
        return t < hint.y + hint.height && t + b.height * c.zoom > hint.y;
      });
    expect(blocked(camera)).toBe(true);
    expect(blocked(kept)).toBe(false);
    // A box to keep that can't stay inside anywhere clear: as given.
    const huge = { x: 0, y: 0, width: 10, height: 1900 };
    expect(clearOfOverlays(camera, level, canvas, [hint], huge)).toBe(camera);
  });

  it("moves sideways when the level is wider than the canvas and no height is clear", () => {
    // A column as tall as the level under the toolbar, in a level wider than the canvas.
    const wide = {
      width: 2000,
      height: 1940,
      boxes: [{ x: 1000, y: 0, width: 200, height: 1940 }],
    };
    const camera = { zoom: 1, x: -300, y: -600 };
    const moved = clearOfOverlays(camera, wide, canvas, [toolbar]);
    expect(moved.y).toBe(camera.y);
    expect(moved.x).not.toBe(camera.x);
    const left = 1000 + moved.x;
    expect(left + 200 <= toolbar.x || left >= toolbar.x + toolbar.width).toBe(true);
  });

  it("stays inside the diagram, and as given when no place within reach is clear", () => {
    // A wall: one box as tall as the level under the toolbar's columns.
    const wall = { width: 1040, height: 1940, boxes: [{ x: 800, y: 0, width: 240, height: 1940 }] };
    const camera = { zoom: 0.8, x: 0, y: -600 };
    expect(clearOfOverlays(camera, wall, canvas, [toolbar])).toBe(camera);
    // At the diagram's bottom the camera can't move further up.
    const bottom = { zoom: 0.8, x: 0, y: canvas.height - FIT_INSET.y - tall.height * 0.8 };
    const moved = clearOfOverlays(bottom, tall, canvas, [toolbar]);
    expect(moved.y).toBeGreaterThanOrEqual(bottom.y);
  });
});
