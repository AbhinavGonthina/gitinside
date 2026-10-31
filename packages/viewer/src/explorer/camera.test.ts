// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  centerOn,
  clampZoom,
  ensureVisible,
  fitCamera,
  frameHop,
  holdInPlace,
  HOP_MARGIN,
  keepInView,
  KEEP_IN_VIEW,
  panBy,
  placeRect,
  READABLE_ZOOM,
  sameCamera,
  stepZoom,
  visibleRect,
  wheelZoomFactor,
  ZOOM,
  zoomAt,
  zoomToBox,
} from "./camera.js";
import { FIT_INSET } from "./fit.js";

const canvas = { width: 1000, height: 800 };
/** Where a diagram point lands on the canvas. */
const onCanvas = (c: { zoom: number; x: number; y: number }, p: { x: number; y: number }) => ({
  x: p.x * c.zoom + c.x,
  y: p.y * c.zoom + c.y,
});

describe("camera", () => {
  it("fits a small diagram at 100%, centered", () => {
    expect(fitCamera({ width: 400, height: 200 }, canvas)).toEqual({ zoom: 1, x: 300, y: 300 });
  });

  it("fits a wide diagram by scaling it down, still centered", () => {
    const c = fitCamera({ width: 1904, height: 400 }, canvas);
    expect(c.zoom).toBe(0.5);
    expect(c.x).toBe(24);
    expect(c.y).toBe(300);
  });

  it("starts a diagram too big even at 40% at the inset, so its first column shows", () => {
    const c = fitCamera({ width: 10_000, height: 4000 }, canvas);
    expect(c).toEqual({ zoom: 0.4, x: FIT_INSET.x, y: FIT_INSET.y });
  });

  it("fits an unmeasured canvas at 100% from the origin", () => {
    expect(fitCamera({ width: 400, height: 200 }, { width: 0, height: 0 })).toEqual({
      zoom: 1,
      x: 0,
      y: 0,
    });
  });

  it("places a rect too big at a zoom with its top-left corner at the inset, centered where it fits (M4b.15f)", () => {
    // A tall column at 80%: its top at the inset, centered across.
    const column = { x: 600, y: 300, width: 300, height: 1800 };
    const c = placeRect(column, canvas, READABLE_ZOOM);
    expect(c.zoom).toBe(READABLE_ZOOM);
    expect(onCanvas(c, { x: 600, y: 300 }).y).toBe(FIT_INSET.y);
    expect(onCanvas(c, { x: 750, y: 0 }).x).toBe(canvas.width / 2);
    // Wider than the canvas too: the left edge at the inset.
    const wide = placeRect({ x: 100, y: 0, width: 5000, height: 5000 }, canvas, READABLE_ZOOM);
    expect(onCanvas(wide, { x: 100, y: 0 })).toEqual({ x: FIT_INSET.x, y: FIT_INSET.y });
    // A small rect is centered both ways; an unmeasured canvas gets 100% at the origin.
    const small = placeRect({ x: 1000, y: 1000, width: 200, height: 100 }, canvas, 0.9);
    expect(onCanvas(small, { x: 1100, y: 1050 })).toEqual({ x: 500, y: 400 });
    expect(placeRect(column, { width: 0, height: 0 }, 0.5)).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it("leaves a trace hop's camera alone when both ends are on the canvas at a readable zoom", () => {
    const camera = { zoom: 1, x: 0, y: 0 };
    const rect = { x: 100, y: 200, width: 400, height: 200 };
    expect(frameHop(camera, rect, canvas)).toBe(camera);
    // Zoomed in further by hand, and they still fit: kept.
    const closer = { zoom: 1.2, x: 0, y: -50 };
    expect(frameHop(closer, rect, canvas)).toBe(closer);
  });

  it("keeps a hop's ends clear of the overlays in the canvas's corners", () => {
    const camera = { zoom: 1, x: 0, y: 0 };
    // On the canvas, but its bottom where the minimap is: moved up to the center.
    const low = { x: 100, y: 500, width: 400, height: 200 };
    expect(700).toBeGreaterThan(canvas.height - HOP_MARGIN.y);
    const c = frameHop(camera, low, canvas);
    expect(c).not.toBe(camera);
    expect(onCanvas(c, { x: 300, y: 600 })).toEqual({ x: 500, y: 400 });
  });

  it("zooms a hop's ends in to the readable zoom, centered, when they fit at it", () => {
    const far = { zoom: 0.4, x: 24, y: 64 };
    const rect = { x: 100, y: 100, width: 400, height: 200 };
    const c = frameHop(far, rect, canvas);
    expect(c.zoom).toBe(READABLE_ZOOM);
    expect(onCanvas(c, { x: 300, y: 200 })).toEqual({ x: 500, y: 400 });
  });

  it("zooms out as far as it takes to show both ends of a long hop, and pans to an end off the canvas", () => {
    const camera = { zoom: 1, x: 0, y: 0 };
    const long = { x: 0, y: 0, width: 3000, height: 200 };
    const c = frameHop(camera, long, canvas);
    expect(c.zoom).toBe(clampZoom((canvas.width - 96) / 3000));
    expect(onCanvas(c, { x: 1500, y: 100 })).toEqual({ x: 500, y: 400 });
    // Same zoom, but one end off the canvas: centered on the two.
    const off = frameHop(camera, { x: 1200, y: 100, width: 300, height: 100 }, canvas);
    expect(off.zoom).toBe(1);
    expect(onCanvas(off, { x: 1350, y: 150 })).toEqual({ x: 500, y: 400 });
  });

  it("shrinks a hop's margins on a short canvas instead of zooming out to the minimum", () => {
    // 320px tall: the full margins would leave no room at all (M4b.15h review).
    const short = { width: 1000, height: 320 };
    const camera = { zoom: 1, x: 0, y: 0 };
    // Its bottom under the bottom quarter: moved to the center, at the same zoom.
    const rect = { x: 100, y: 200, width: 300, height: 100 };
    const c = frameHop(camera, rect, short);
    expect(c.zoom).toBe(1);
    expect(onCanvas(c, { x: 250, y: 250 })).toEqual({ x: 500, y: 160 });
    // Already in the middle half of the short canvas: left alone.
    expect(frameHop(c, rect, short)).toBe(c);
  });

  it("zooms around a point, keeping the diagram point under it", () => {
    const start = { zoom: 0.8, x: 40, y: -12 };
    const at = { x: 610, y: 333 };
    const before = { x: (at.x - start.x) / start.zoom, y: (at.y - start.y) / start.zoom };
    const next = zoomAt(start, 1.6, at);
    expect(next.zoom).toBe(1.6);
    const after = onCanvas(next, before);
    expect(after.x).toBeCloseTo(at.x, 1);
    expect(after.y).toBeCloseTo(at.y, 1);
  });

  it("clamps zoom to its limits", () => {
    expect(clampZoom(0.01)).toBe(ZOOM.min);
    expect(clampZoom(9)).toBe(ZOOM.max);
    expect(clampZoom(0.123456)).toBe(ZOOM.min);
    expect(clampZoom(1.23456)).toBe(1.23);
    expect(zoomAt({ zoom: 1, x: 0, y: 0 }, 50, { x: 0, y: 0 }).zoom).toBe(ZOOM.max);
  });

  it("steps in and out around the canvas center, and back", () => {
    const start = { zoom: 1, x: 100, y: 50 };
    const center = { x: 500, y: 400 };
    const inward = stepZoom(start, 1, canvas);
    expect(inward.zoom).toBe(1.25);
    const mid = { x: (center.x - start.x) / start.zoom, y: (center.y - start.y) / start.zoom };
    expect(onCanvas(inward, mid).x).toBeCloseTo(center.x, 1);
    expect(stepZoom(inward, -1, canvas)).toEqual(start);
    let c = start;
    for (let i = 0; i < 20; i++) c = stepZoom(c, -1, canvas);
    expect(c.zoom).toBe(ZOOM.min);
  });

  it("turns a wheel's delta into a zoom factor: up zooms in, down out, symmetric", () => {
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1, 10);
    expect(wheelZoomFactor(-250)).toBe(2);
  });

  it("pans by canvas pixels at any zoom", () => {
    expect(panBy({ zoom: 0.5, x: 10, y: 20 }, -30, 5.25)).toEqual({ zoom: 0.5, x: -20, y: 25.25 });
  });

  it("keeps part of the diagram on the canvas however far it's panned", () => {
    const diagram = { width: 2000, height: 1000 };
    const far = keepInView({ zoom: 1, x: 5000, y: -9000 }, diagram, canvas);
    expect(far).toEqual({ zoom: 1, x: canvas.width - KEEP_IN_VIEW, y: KEEP_IN_VIEW - 1000 });
    // In range: unchanged.
    expect(keepInView({ zoom: 1, x: -300, y: 100 }, diagram, canvas)).toEqual({
      zoom: 1,
      x: -300,
      y: 100,
    });
    // A diagram smaller than the margin stays wholly on the canvas.
    const tiny = keepInView({ zoom: 1, x: -50, y: 900 }, { width: 20, height: 10 }, canvas);
    expect(tiny).toEqual({ zoom: 1, x: 0, y: canvas.height - 10 });
    expect(keepInView({ zoom: 1, x: 5, y: 5 }, diagram, { width: 0, height: 0 })).toEqual({
      zoom: 1,
      x: 5,
      y: 5,
    });
  });

  it("reports the visible part of the diagram", () => {
    expect(visibleRect({ zoom: 0.5, x: -100, y: 50 }, canvas)).toEqual({
      x: 200,
      y: -100,
      width: 2000,
      height: 1600,
    });
  });

  it("centers on a point, and flies to a box only when it's out of view", () => {
    const c = centerOn({ zoom: 2, x: 0, y: 0 }, { x: 100, y: 50 }, canvas);
    expect(onCanvas(c, { x: 100, y: 50 })).toEqual({ x: 500, y: 400 });

    const start = { zoom: 1, x: 0, y: 0 };
    const seen = { x: 100, y: 100, width: 200, height: 100 };
    expect(ensureVisible(start, seen, canvas)).toBe(start);
    const away = { x: 1500, y: 100, width: 200, height: 100 };
    const flown = ensureVisible(start, away, canvas);
    expect(onCanvas(flown, { x: 1600, y: 150 })).toEqual({ x: 500, y: 400 });
    // Half in view counts as out.
    const edge = { x: 900, y: 100, width: 200, height: 100 };
    expect(ensureVisible(start, edge, canvas)).not.toBe(start);
    expect(ensureVisible(start, away, { width: 0, height: 0 })).toBe(start);
  });

  it("brings a box too big for the canvas into view by its top-left corner (M4b.11)", () => {
    const start = { zoom: 1, x: 0, y: 0 };
    // Twice the canvas each way, far to the right: its corner lands at the margin.
    const big = { x: 3000, y: 500, width: 2000, height: 1600 };
    const flown = ensureVisible(start, big, canvas);
    expect(onCanvas(flown, { x: big.x, y: big.y })).toEqual({ x: 24, y: 24 });
    // With its corner already in view, the camera stays, though most of it is off the canvas.
    expect(ensureVisible(flown, big, canvas)).toBe(flown);
    // Too wide but not too tall: its left end, centered top to bottom.
    const wide = { x: 3000, y: 500, width: 2000, height: 100 };
    expect(onCanvas(ensureVisible(start, wide, canvas), { x: wide.x, y: wide.y + 50 })).toEqual({
      x: 24,
      y: 400,
    });
  });

  it("zooms in on a palette pick to 100%, less for a box that wouldn't fit, never out", () => {
    const small = { x: 300, y: 200, width: 200, height: 100 };
    const fitted = { zoom: 0.4, x: 0, y: 0 };
    const flown = zoomToBox(fitted, small, canvas);
    expect(flown.zoom).toBe(1);
    expect(onCanvas(flown, { x: 400, y: 250 })).toEqual({ x: 500, y: 400 });
    // A frame twice the canvas's width: as close as fits with the margin.
    const wide = { x: 0, y: 0, width: 1904, height: 400 };
    expect(zoomToBox(fitted, wide, canvas).zoom).toBe(0.5);
    // Already zoomed in: only pans if it must, like ensureVisible.
    const close = { zoom: 1.5, x: -300, y: -200 };
    expect(zoomToBox(close, small, canvas)).toBe(close);
    expect(zoomToBox(close, { ...small, x: 2000 }, canvas).zoom).toBe(1.5);
    expect(zoomToBox(fitted, small, { width: 0, height: 0 })).toBe(fitted);
  });

  it("holds a moved box's corner in place on the canvas", () => {
    const start = { zoom: 0.5, x: 10, y: 10 };
    const before = { x: 400, y: 200 };
    const after = { x: 300, y: 260 };
    const held = holdInPlace(start, before, after);
    expect(onCanvas(held, after)).toEqual(onCanvas(start, before));
  });

  it("compares cameras by value", () => {
    expect(sameCamera({ zoom: 1, x: 2, y: 3 }, { zoom: 1, x: 2, y: 3 })).toBe(true);
    expect(sameCamera({ zoom: 1, x: 2, y: 3 }, { zoom: 1, x: 2, y: 4 })).toBe(false);
  });
});
