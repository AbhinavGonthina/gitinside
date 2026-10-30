import { describe, expect, it } from "vitest";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { ZOOM } from "./camera.js";
import {
  DETAIL_ZOOM,
  detailAt,
  insideOneService,
  SERVICE_NAME_PX,
  serviceNameScale,
} from "./detail.js";

const index = buildHierarchy(shopDemo());

describe("detailAt", () => {
  it("draws everything from 65%, names from 40%, and an outline below", () => {
    expect(detailAt(ZOOM.max)).toBe("full");
    expect(detailAt(1)).toBe("full");
    expect(detailAt(DETAIL_ZOOM.full)).toBe("full");
    expect(detailAt(0.64)).toBe("names");
    expect(detailAt(DETAIL_ZOOM.names)).toBe("names");
    expect(detailAt(0.39)).toBe("outline");
    expect(detailAt(ZOOM.min)).toBe("outline");
  });

  it("keeps a fitted level out of the outline: the fit never goes below 40%", () => {
    expect(DETAIL_ZOOM.names).toBe(0.4);
    expect(ZOOM.min).toBeLessThan(DETAIL_ZOOM.names);
  });
});

describe("serviceNameScale", () => {
  it("leaves names alone at full detail, even where they're drawn small", () => {
    expect(serviceNameScale(2)).toBe(1);
    expect(serviceNameScale(DETAIL_ZOOM.full)).toBe(1);
  });

  it("below it, keeps a service's 14px name at 12 screen px, up to 3×", () => {
    for (const zoom of [0.64, 0.5, 0.4, 0.3]) {
      const scale = serviceNameScale(zoom);
      expect(14 * zoom * scale).toBeCloseTo(SERVICE_NAME_PX, 1);
    }
    expect(serviceNameScale(0.3)).toBe(2.86);
    expect(serviceNameScale(ZOOM.min)).toBe(3);
  });
});

describe("insideOneService", () => {
  it("is false for every line at the system level: each joins two services or a service and data", () => {
    const view = buildView(index, []);
    expect(view.edges.length).toBeGreaterThan(0);
    for (const e of view.edges) expect(insideOneService(index, e)).toBe(false);
  });

  it("marks the lines between a broken-down service's own boxes, and keeps those that leave it", () => {
    const view = buildView(index, ["service:api/", "module:api/src"]);
    const inner = view.edges.filter((e) => insideOneService(index, e));
    const outer = view.edges.filter((e) => !insideOneService(index, e));
    expect(inner.length).toBeGreaterThan(0);
    expect(outer.length).toBeGreaterThan(0);
    for (const e of inner) {
      expect(index.service.get(e.from)).toBe("service:api/");
      expect(index.service.get(e.to)).toBe("service:api/");
    }
    for (const e of outer) {
      const ends = [index.service.get(e.from), index.service.get(e.to)];
      expect(ends[0] === undefined || ends[0] !== ends[1]).toBe(true);
    }
  });
});
