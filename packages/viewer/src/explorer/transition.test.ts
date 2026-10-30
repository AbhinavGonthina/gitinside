import { describe, expect, it } from "vitest";
import type { Rect } from "../chrome/describe.js";
import type { LayoutResult } from "../layout/elk.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { centeredOn, planTransition, type Shown } from "./transition.js";

const index = buildHierarchy(shopDemo());
const API = "service:api/";
const SRC = "module:api/src";
const ROUTES_FILE = "file:api/src/routes/orders.ts";
const POST = "route:api/POST /api/orders";

/**
 * A stand-in layout: each visible node in a row, 100px apart, 40px tall,
 * with open nodes 300px wide. Enough to tell where a box went.
 */
function shown(expanded: readonly string[]): Shown {
  const view = buildView(index, expanded);
  const boxes = view.nodes.map((n, i) => ({
    id: n.id,
    x: i * 100,
    y: n.level * 50,
    width: n.open ? 300 : 80,
    height: 40,
  }));
  const layout: LayoutResult = { boxes, edges: [], width: 2000, height: 400 };
  return { view, layout };
}

const rectOf = (s: Shown, id: string): Rect => {
  const box = s.layout.boxes.find((b) => b.id === id);
  if (!box) throw new Error(`no box ${id}`);
  return { x: box.x, y: box.y, width: box.width, height: box.height };
};

describe("centeredOn", () => {
  it("puts a size's center on a rect's center", () => {
    expect(centeredOn({ width: 20, height: 10 }, { x: 100, y: 50, width: 60, height: 30 })).toEqual(
      { x: 120, y: 60, width: 20, height: 10 },
    );
  });
});

describe("planTransition", () => {
  it("glides every box that stays, from its old place and size to its new one", () => {
    const prev = shown([]);
    const next = shown([API]);
    const plan = planTransition(index, prev, next);
    const api = plan.moves.find((m) => m.id === API);
    expect(api).toEqual({
      id: API,
      from: rectOf(prev, API),
      to: rectOf(next, API),
      emerging: false,
    });
  });

  it("brings a broken-down node's children out of its old center, transparent", () => {
    const prev = shown([]);
    const next = shown([API]);
    const plan = planTransition(index, prev, next);
    const old = rectOf(prev, API);
    const emerging = plan.moves.filter((m) => m.emerging);
    expect(emerging.map((m) => m.id).sort()).toEqual(next.view.childrenOf.get(API)?.slice().sort());
    for (const m of emerging) {
      expect(m.from).toEqual(centeredOn(m.to, old));
      expect(m.to).toEqual(rectOf(next, m.id));
    }
    expect(plan.exits).toEqual([]);
  });

  it("folds a closed node's children into its new center", () => {
    const prev = shown([API]);
    const next = shown([]);
    const plan = planTransition(index, prev, next);
    const closed = rectOf(next, API);
    const inside = prev.view.childrenOf.get(API) ?? [];
    expect(plan.exits.map((e) => e.node.id)).toEqual(inside);
    for (const e of plan.exits) {
      expect(e.from).toEqual(rectOf(prev, e.node.id));
      expect(e.to).toEqual(centeredOn(e.from, closed));
    }
    expect(plan.moves.some((m) => m.emerging)).toBe(false);
  });

  it("folds nested children into the outermost box still drawn", () => {
    const prev = shown([API, SRC]);
    const next = shown([]);
    const plan = planTransition(index, prev, next);
    const inSrc = plan.exits.find((e) => e.node.parent === SRC);
    expect(inSrc?.to).toEqual(centeredOn(inSrc?.from ?? rectOf(prev, SRC), rectOf(next, API)));
  });

  it("glides a route from its service's entries into its file when the file opens", () => {
    const prev = shown([API, SRC, "module:api/src/routes"]);
    const next = shown([API, SRC, "module:api/src/routes", ROUTES_FILE]);
    expect(prev.view.byId.get(POST)?.section).toBe("entries");
    expect(next.view.byId.get(POST)?.parent).toBe(ROUTES_FILE);
    const route = planTransition(index, prev, next).moves.find((m) => m.id === POST);
    expect(route).toEqual({
      id: POST,
      from: rectOf(prev, POST),
      to: rectOf(next, POST),
      emerging: false,
    });
  });

  it("starts from where a box is drawn now when given (an interrupted glide)", () => {
    const prev = shown([]);
    const next = shown([API]);
    const now = { x: 7, y: 8, width: 90, height: 41 };
    const plan = planTransition(index, prev, next, new Map([[API, now]]));
    expect(plan.moves.find((m) => m.id === API)?.from).toEqual(now);
    // Children emerge from where the box is drawn now, too.
    const child = plan.moves.find((m) => m.emerging);
    expect(child?.from).toEqual(centeredOn(child?.to ?? now, now));
  });

  it("leaves out boxes that don't move", () => {
    const same = shown([API]);
    expect(planTransition(index, same, shown([API]))).toEqual({ moves: [], exits: [] });
  });
});
