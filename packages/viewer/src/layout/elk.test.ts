// @vitest-environment node
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import type { Rect } from "../chrome/describe.js";
import type { Point } from "../edges/geometry.js";
import { codeShop } from "../model/codeLines.testkit.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView, type GraphView } from "../model/view.js";
import { shopDemo } from "../shopDemo.testkit.js";
import {
  bandOf,
  BANDS,
  BUS_GAP,
  busRoute,
  ELK_OPTIONS,
  elkGraph,
  LAYOUT_PAD,
  layoutInput,
  MODEL_ORDER_LIMIT,
  readLayout,
  runLayout,
  THOROUGHNESS_LIMIT,
  type LayoutInput,
  type LayoutResult,
} from "./elk.js";
import { FRAME_PAD, viewNodeSize } from "./size.js";

const index = buildHierarchy(shopDemo());
const elk = new ELK();

const API_OPEN = ["service:api/"];
const BOTH_OPEN = ["service:web/", "service:api/"];
const DEEP = [
  "service:web/",
  "service:api/",
  "module:api/src",
  "module:api/src/orders",
  "file:api/src/orders/handlers.ts",
  "module:api/src/routes",
  "file:api/src/routes/orders.ts",
];
const STATES = [[], API_OPEN, BOTH_OPEN, DEEP];

async function laidOut(expanded: readonly string[]) {
  const view = buildView(index, expanded);
  const input = layoutInput(index, view);
  return { view, input, result: await runLayout(elk, input) };
}

const boxOf = (result: LayoutResult, id: string): Rect => {
  const box = result.boxes.find((b) => b.id === id);
  if (!box) throw new Error(`no box for ${id}`);
  return box;
};

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Whether `p` lies on `r`'s outline, within a pixel. */
const onOutline = (p: Point, r: Rect) => {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const inX = p.x >= r.x - 1 && p.x <= r.x + r.width + 1;
  const inY = p.y >= r.y - 1 && p.y <= r.y + r.height + 1;
  return (
    (inY && (near(p.x, r.x) || near(p.x, r.x + r.width))) ||
    (inX && (near(p.y, r.y) || near(p.y, r.y + r.height)))
  );
};

/** Whether `p` lies on the polyline, within a pixel. */
const onLine = (p: Point, points: readonly Point[]) =>
  points.slice(1).some((b, i) => {
    const a = points[i] as Point;
    const within = (v: number, x: number, y: number) =>
      v >= Math.min(x, y) - 1 && v <= Math.max(x, y) + 1;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return within(p.x, a.x, b.x) && within(p.y, a.y, b.y) && Math.abs(cross / length) <= 1;
  });

describe("layoutInput", () => {
  it("lists the view's nodes in drawing order with measured sizes", () => {
    const view = buildView(index, API_OPEN);
    const input = layoutInput(index, view);
    expect(input.nodes.map((n) => n.id)).toEqual(view.nodes.map((n) => n.id));
    for (const n of view.nodes) {
      const laid = input.nodes.find((l) => l.id === n.id);
      expect(laid?.parent).toBe(n.parent);
      expect(laid?.width).toBe(viewNodeSize(index, n).width);
    }
  });

  it("marks entries, and gives open nodes their header as the least height", () => {
    const input = layoutInput(index, buildView(index, API_OPEN));
    const api = input.nodes.find((n) => n.id === "service:api/");
    expect(api).toMatchObject({ header: 60, height: 60 });
    expect(input.nodes.filter((n) => n.entry).map((n) => n.id)).toEqual([
      "route:api/GET /api/orders",
      "route:api/POST /api/orders",
    ]);
    expect(input.nodes.find((n) => n.id === "module:api/src")?.entry).toBeUndefined();
  });

  it("gives every view edge a label size, and survives a structured clone (worker input)", () => {
    const view = buildView(index, BOTH_OPEN);
    const input = layoutInput(index, view);
    expect(input.edges.map((e) => e.id)).toEqual(view.edges.map((e) => e.id));
    for (const e of input.edges) expect(e.label.width).toBeGreaterThan(0);
    expect(structuredClone(input)).toEqual(input);
  });
});

describe("bands (the M10.3 prototype, M10-design A1)", () => {
  it("gives each top-level node its layer's band only when asked, Backend without a layer", () => {
    const view = buildView(index, API_OPEN);
    expect(layoutInput(index, view).nodes.some((n) => n.band !== undefined)).toBe(false);
    const banded = layoutInput(index, view, undefined, { bands: true });
    const bandOfId = new Map(banded.nodes.map((n) => [n.id, n.band]));
    expect(bandOfId.get("service:web/")).toBe(0);
    expect(bandOfId.get("service:api/")).toBe(1);
    expect(bandOfId.get("datastore:infra/db")).toBe(3);
    expect(bandOfId.get("external:ext/api.stripe.com")).toBe(4);
    // Inside an open service, nothing is banded.
    expect(bandOfId.get("route:api/GET /api/orders")).toBeUndefined();
    expect(BANDS.map((b) => b.label)).toEqual([
      "Frontend",
      "Backend",
      "Queues and jobs",
      "Data",
      "Outside",
    ]);
    expect(bandOf(undefined)).toBe(1);
    expect(bandOf("infra")).toBe(2);
  });

  it("partitions the root only for a banded input", () => {
    const plain = elkGraph(layoutInput(index, buildView(index, [])));
    expect(plain.layoutOptions?.["elk.partitioning.activate"]).toBeUndefined();
    expect(plain.children?.some((c) => c.layoutOptions?.["elk.partitioning.partition"])).toBe(
      false,
    );
    const banded = elkGraph(layoutInput(index, buildView(index, []), undefined, { bands: true }));
    expect(banded.layoutOptions?.["elk.partitioning.activate"]).toBe("true");
    const db = banded.children?.find((c) => c.id === "datastore:infra/db");
    expect(db?.layoutOptions?.["elk.partitioning.partition"]).toBe("3");
  });

  it("puts unconnected nodes in band order left to right, where ELK alone stacks them", async () => {
    const node = (id: string, band: number) => ({ id, parent: null, width: 120, height: 48, band });
    const input: LayoutInput = {
      // Listed against band order, with no edges: ELK alone puts all three in one column.
      nodes: [node("outside", 4), node("data", 3), node("web", 0)],
      edges: [],
    };
    const unbanded = await runLayout(elk, {
      nodes: input.nodes.map(({ band: _, ...n }) => n),
      edges: [],
    });
    expect(new Set(unbanded.boxes.map((b) => b.x)).size).toBe(1);
    expect(unbanded.bands).toBeUndefined();

    const result = await runLayout(elk, input);
    const x = (id: string) => boxOf(result, id).x;
    expect(x("web")).toBeLessThan(x("data"));
    expect(x("data")).toBeLessThan(x("outside"));
    expect(result.bands).toEqual([
      { band: 0, x: x("web") },
      { band: 3, x: x("data") },
      { band: 4, x: x("outside") },
    ]);
  });

  it("keeps the bands in order with a service open, every datastore right of every service", async () => {
    for (const open of STATES) {
      const view = buildView(index, open);
      const result = await runLayout(elk, layoutInput(index, view, undefined, { bands: true }));
      const right = (id: string) => boxOf(result, id).x + boxOf(result, id).width;
      const left = (id: string) => boxOf(result, id).x;
      expect(right("service:web/")).toBeLessThanOrEqual(left("service:api/"));
      expect(right("service:api/")).toBeLessThanOrEqual(left("datastore:infra/db"));
      expect(right("datastore:infra/db")).toBeLessThanOrEqual(left("external:ext/api.stripe.com"));
      expect(result.bands?.map((b) => b.band)).toEqual([0, 1, 3, 4]);
    }
  });
});

describe("quiet code lines (the M10.3 prototype, M10-design A2)", () => {
  const code = buildHierarchy(codeShop());
  const quietIds = (input: LayoutInput) => input.edges.filter((e) => e.quiet).map((e) => e.id);
  const WEB_UI = "calls:service:web/->service:ui/";
  const WEB_API = "calls:service:web/->service:api/";
  const API_UI = "calls:service:api/->service:ui/";

  it("marks only top-level imports and calls lines quiet, and only when asked", () => {
    const view = buildView(code, []);
    expect(quietIds(layoutInput(code, view))).toEqual([]);
    expect(quietIds(layoutInput(code, view, undefined, { quietCode: true })).sort()).toEqual([
      API_UI,
      WEB_API,
      WEB_UI,
    ]);
    // web's requests to api stay ELK's.
    const http = layoutInput(code, view, undefined, { quietCode: true }).edges.find(
      (e) => e.id === "http:service:web/->service:api/",
    );
    expect(http?.quiet).toBeUndefined();
    // Shown imports are code too.
    const withImports = buildView(code, [], { hiddenKinds: new Set() });
    expect(quietIds(layoutInput(code, withImports, undefined, { quietCode: true }))).toContain(
      "imports:service:web/->service:ui/",
    );
    // From inside a broken-down service, a call to another service is an ordinary line; one
    // between two closed services stays quiet.
    const open = buildView(code, ["service:web/"]);
    expect(quietIds(layoutInput(code, open, undefined, { quietCode: true }))).toEqual([API_UI]);
    expect(open.edges.some((e) => e.kind === "calls" && e.to === "service:ui/")).toBe(true);
  });

  it("leaves quiet lines out of ELK and routes them from box to box", async () => {
    const input = layoutInput(code, buildView(code, []), undefined, {
      bands: true,
      quietCode: true,
    });
    expect(elkGraph(input).edges?.map((e) => e.id)).not.toContain(WEB_UI);
    const result = await runLayout(elk, input);
    expect(result.edges.map((e) => e.id)).toEqual(input.edges.map((e) => e.id));
    for (const id of [WEB_UI, WEB_API, API_UI]) {
      const placed = result.edges.find((e) => e.id === id);
      expect(placed?.quiet).toBe(true);
      const [from, to] = id.slice("calls:".length).split("->") as [string, string];
      expect(placed?.points).toEqual(busRoute(boxOf(result, from), boxOf(result, to)));
      expect(onLine(placed?.label as Point, placed?.points ?? [])).toBe(true);
    }
    expect(result.edges.find((e) => e.id === "http:service:web/->service:api/")?.quiet).toBe(
      undefined,
    );
  });

  it("spreads a level out less than the same lines laid out by ELK", async () => {
    const view = buildView(code, []);
    const routed = await runLayout(elk, layoutInput(code, view, undefined, { bands: true }));
    const quiet = await runLayout(
      elk,
      layoutInput(code, view, undefined, { bands: true, quietCode: true }),
    );
    // ui sits in Backend; with api's call laid out by ELK it takes a column after api's.
    const x = (r: LayoutResult, id: string) => boxOf(r, id).x;
    expect(x(routed, "service:ui/")).toBeGreaterThan(x(routed, "service:api/"));
    expect(x(quiet, "service:ui/")).toBe(x(quiet, "service:api/"));
    expect(quiet.width).toBeLessThan(routed.width);
  });
});

describe("busRoute", () => {
  const box = (x: number, y: number): Rect => ({ x, y, width: 100, height: 40 });

  it("leaves the side facing the target and turns BUS_GAP short of it", () => {
    expect(busRoute(box(0, 0), box(300, 100))).toEqual([
      { x: 100, y: 20 },
      { x: 300 - BUS_GAP, y: 20 },
      { x: 300 - BUS_GAP, y: 120 },
      { x: 300, y: 120 },
    ]);
    expect(busRoute(box(300, 100), box(0, 0))).toEqual([
      { x: 300, y: 120 },
      { x: 100 + BUS_GAP, y: 120 },
      { x: 100 + BUS_GAP, y: 20 },
      { x: 100, y: 20 },
    ]);
  });

  it("reaches a box in the same column around the column's right side", () => {
    expect(busRoute(box(0, 0), { x: 10, y: 200, width: 120, height: 40 })).toEqual([
      { x: 100, y: 20 },
      { x: 130 + BUS_GAP, y: 20 },
      { x: 130 + BUS_GAP, y: 220 },
      { x: 130, y: 220 },
    ]);
  });

  it("goes straight across to a target level with the source", () => {
    expect(busRoute(box(0, 0), box(300, 0))).toEqual([
      { x: 100, y: 20 },
      { x: 300, y: 20 },
    ]);
  });

  it("bundles: one box's lines leave at one point, a column's lines in at one turn", () => {
    const source = box(0, 200);
    const targets = [box(300, 0), box(300, 100), box(300, 300), box(600, 50)];
    const routes = targets.map((t) => busRoute(source, t));
    expect(new Set(routes.map((r) => JSON.stringify(r[0])))).toEqual(
      new Set([JSON.stringify({ x: 100, y: 220 })]),
    );
    // The three targets in one column share the run to it and its turn.
    expect(new Set(routes.slice(0, 3).map((r) => JSON.stringify(r[1])))).toEqual(
      new Set([JSON.stringify({ x: 300 - BUS_GAP, y: 220 })]),
    );
    // Lines from two boxes into one target meet at its side.
    const into = [box(0, 0), box(0, 300)].map((s) => busRoute(s, box(300, 150)).at(-1));
    expect(into[0]).toEqual(into[1]);
  });
});

describe("the banded system level's placement (M10.3b2: maxun's 40%)", () => {
  const node = (id: string, band: number, height = 128) => ({
    id,
    parent: null,
    width: 136,
    height,
    band,
  });
  // maxun's shape: one service calling six outside hosts, two datastores with no lines.
  const hosts = ["a", "b", "c", "d", "e", "f"].map((h) => `host-${h}`);
  const input: LayoutInput = {
    nodes: [
      node("service", 1, 94),
      node("minio", 3),
      node("postgres", 3),
      ...hosts.map((h) => node(h, 4)),
    ],
    edges: hosts.map((h) => ({
      id: `external_call:service->${h}`,
      from: "service",
      to: h,
      label: { width: 60, height: 20 },
    })),
  };

  it("keeps datastores with no lines within the tallest column, not below it", async () => {
    const result = await runLayout(elk, input);
    const column = hosts.map((h) => boxOf(result, h));
    const bottom = Math.max(...column.map((b) => b.y + b.height));
    for (const id of ["minio", "postgres"]) {
      const b = boxOf(result, id);
      expect(b.y + b.height).toBeLessThanOrEqual(bottom);
    }
    expect(result.height).toBe(bottom + LAYOUT_PAD);
  });

  it("places by network simplex only on a banded level with nothing open", () => {
    const strategy = (i: LayoutInput) =>
      elkGraph(i).layoutOptions?.["elk.layered.nodePlacement.strategy"];
    expect(strategy(input)).toBe("NETWORK_SIMPLEX");
    expect(
      strategy({ ...input, nodes: input.nodes.map(({ band: _, ...n }) => n) }),
    ).toBeUndefined();
    const open = layoutInput(index, buildView(index, API_OPEN), undefined, { bands: true });
    expect(strategy(open)).toBeUndefined();
  });
});

describe("elkGraph", () => {
  const input = layoutInput(index, buildView(index, API_OPEN));
  const graph = elkGraph(input);

  it("nests open nodes' children and keeps every edge on the root", () => {
    expect(graph.layoutOptions).toEqual(ELK_OPTIONS);
    const api = graph.children?.find((c) => c.id === "service:api/");
    expect(api?.children?.map((c) => c.id)).toEqual([
      "route:api/GET /api/orders",
      "route:api/POST /api/orders",
      "module:api/prisma",
      "module:api/src",
    ]);
    expect(api?.layoutOptions).toEqual({
      "elk.padding": `[top=60,left=${FRAME_PAD},bottom=${FRAME_PAD},right=${FRAME_PAD}]`,
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": `(${api?.width},60)`,
    });
    expect(api?.children?.[0]?.layoutOptions).toEqual({
      "elk.layered.layering.layerConstraint": "FIRST",
    });
    expect(graph.edges?.map((e) => e.id)).toEqual(input.edges.map((e) => e.id));
  });

  /** A flat input of `nodes` boxes and `edges` lines (each from one box to the next, cycling). */
  const flat = (nodes: number, edges: number): LayoutInput => ({
    nodes: Array.from({ length: nodes }, (_, i) => ({
      id: `n${i}`,
      parent: null,
      width: 100,
      height: 40,
    })),
    edges: Array.from({ length: edges }, (_, i) => ({
      id: `e${i}`,
      from: `n${i % nodes}`,
      to: `n${(i + 1) % nodes}`,
      label: { width: 20, height: 22 },
    })),
  });

  it("keeps model order and full thoroughness up to MODEL_ORDER_LIMIT nodes and edges", () => {
    const options = elkGraph(flat(100, MODEL_ORDER_LIMIT - 100)).layoutOptions;
    expect(options).toEqual(ELK_OPTIONS);
    // Every shop demo state (the stories' graph) is small, so its layouts don't change.
    for (const state of STATES) {
      const { nodes, edges } = layoutInput(index, buildView(index, state));
      expect(nodes.length + edges.length).toBeLessThanOrEqual(MODEL_ORDER_LIMIT);
    }
  });

  it("drops model order above MODEL_ORDER_LIMIT nodes and edges", () => {
    const options = elkGraph(flat(100, MODEL_ORDER_LIMIT - 99)).layoutOptions;
    expect(options).toEqual({
      ...ELK_OPTIONS,
      "elk.layered.considerModelOrder.strategy": "NONE",
    });
  });

  it("makes one crossing-minimization pass above THOROUGHNESS_LIMIT nodes and edges", () => {
    const at = elkGraph(flat(1000, THOROUGHNESS_LIMIT - 1000)).layoutOptions;
    expect(at?.["elk.layered.thoroughness"]).toBeUndefined();
    const over = elkGraph(flat(1000, THOROUGHNESS_LIMIT - 999)).layoutOptions;
    expect(over).toEqual({
      ...ELK_OPTIONS,
      "elk.layered.considerModelOrder.strategy": "NONE",
      "elk.layered.thoroughness": "1",
    });
  });

  it("rejects a node listed before its parent", () => {
    const [first, ...rest] = input.nodes;
    if (!first) throw new Error("empty input");
    const child = rest.find((n) => n.parent === "service:api/");
    if (!child) throw new Error("no child of api");
    expect(() => elkGraph({ nodes: [child], edges: [] })).toThrow(
      /lists route:api\/GET \/api\/orders before its parent service:api\//,
    );
  });
});

describe("runLayout", () => {
  it.each(STATES.map((s) => [s.length, s] as const))(
    "is deterministic (%i open)",
    async (_n, state) => {
      const a = (await laidOut(state)).result;
      const b = await runLayout(new ELK(), layoutInput(index, buildView(index, state)));
      expect(b).toEqual(a);
    },
  );

  it.each(STATES.map((s) => [s.length, s] as const))(
    "nests, separates, and connects every box (%i open)",
    async (_n, state) => {
      const { view, input, result } = await laidOut(state);
      expect(result.boxes.map((b) => b.id)).toEqual(input.nodes.map((n) => n.id));
      for (const n of input.nodes) {
        const box = boxOf(result, n.id);
        if (n.header === undefined) {
          // Closed nodes keep their measured size.
          expect([box.width, box.height]).toEqual([n.width, n.height]);
        } else {
          expect(box.width).toBeGreaterThanOrEqual(n.width);
          expect(box.height).toBeGreaterThan(n.header);
        }
        // Inside the diagram, and inside its frame, below the header.
        expect(box.x).toBeGreaterThanOrEqual(LAYOUT_PAD - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(result.width - LAYOUT_PAD + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(result.height - LAYOUT_PAD + 1);
        const parent = n.parent ? input.nodes.find((p) => p.id === n.parent) : undefined;
        if (parent) {
          const frame = boxOf(result, parent.id);
          expect(box.x).toBeGreaterThanOrEqual(frame.x + FRAME_PAD - 1);
          expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width - FRAME_PAD + 1);
          expect(box.y).toBeGreaterThanOrEqual(frame.y + (parent.header ?? 0) - 1);
          expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height - FRAME_PAD + 1);
        }
      }
      for (const [parent, ids] of view.childrenOf) {
        for (const [i, a] of ids.entries()) {
          for (const b of ids.slice(i + 1)) {
            expect(overlaps(boxOf(result, a), boxOf(result, b)), `${parent}: ${a} / ${b}`).toBe(
              false,
            );
          }
        }
      }
      expect(result.edges.map((e) => e.id)).toEqual(input.edges.map((e) => e.id));
      for (const [i, e] of result.edges.entries()) {
        const { from, to } = input.edges[i] ?? { from: "", to: "" };
        const first = e.points[0] as Point;
        const last = e.points.at(-1) as Point;
        expect(onOutline(first, boxOf(result, from)), `${e.id} starts on ${from}`).toBe(true);
        expect(onOutline(last, boxOf(result, to)), `${e.id} ends on ${to}`).toBe(true);
        // The pill sits on its line, and never on a closed box.
        expect(onLine(e.label, e.points), `${e.id}'s label is on its line`).toBe(true);
        for (const n of input.nodes.filter((m) => m.header === undefined)) {
          const box = boxOf(result, n.id);
          const inside =
            e.label.x > box.x + 1 &&
            e.label.x < box.x + box.width - 1 &&
            e.label.y > box.y + 1 &&
            e.label.y < box.y + box.height - 1;
          expect(inside, `${e.id}'s label on ${n.id}`).toBe(false);
        }
      }
    },
  );

  it.each(STATES.map((s) => [s.length, s] as const))(
    "keeps every label pill clear of the others (%i open)",
    async (_n, state) => {
      // Parallel edges run 14px apart; pills placed beside them and snapped
      // onto them covered each other (`reads` / `writes` from src to prisma).
      const { input, result } = await laidOut(state);
      const pills = result.edges.map((e, i) => {
        const { width, height } = input.edges[i]?.label ?? { width: 0, height: 0 };
        return { id: e.id, x: e.label.x - width / 2, y: e.label.y - height / 2, width, height };
      });
      for (const [i, a] of pills.entries()) {
        for (const b of pills.slice(i + 1)) {
          expect(overlaps(a, b), `${a.id} / ${b.id}`).toBe(false);
        }
      }
    },
  );

  it("keeps room for each label between the columns it crosses", async () => {
    const { input, result } = await laidOut([]);
    const http = input.edges.find((e) => e.id === "http:service:web/->service:api/");
    if (!http) throw new Error("no web → api edge");
    const gap =
      boxOf(result, "service:api/").x -
      (boxOf(result, "service:web/").x + boxOf(result, "service:web/").width);
    expect(gap).toBeGreaterThan(http.label.width);
  });

  it("reads a request left to right at the system level", async () => {
    const { result } = await laidOut([]);
    const x = (id: string) => boxOf(result, id).x;
    expect(x("service:web/")).toBeLessThan(x("service:api/"));
    expect(x("service:api/")).toBeLessThan(x("datastore:infra/db"));
    expect(x("service:api/")).toBeLessThan(x("external:ext/api.stripe.com"));
  });

  it("puts an open service's routes in its first column, ahead of its folders", async () => {
    const { view, result } = await laidOut(API_OPEN);
    const inside = view.childrenOf.get("service:api/") ?? [];
    const entries = inside.filter((id) => view.byId.get(id)?.section === "entries");
    const rest = inside.filter((id) => view.byId.get(id)?.section === "contents");
    expect(entries).toHaveLength(2);
    const entriesRight = Math.max(
      ...entries.map((id) => boxOf(result, id).x + boxOf(result, id).width),
    );
    for (const id of rest) expect(boxOf(result, id).x).toBeGreaterThan(entriesRight);
    // In route-table order, top to bottom.
    const [get, post] = entries.map((id) => boxOf(result, id).y);
    expect(get).toBeLessThan(post ?? 0);
  });

  it("keeps the order of untied siblings across runs of related views", async () => {
    const order = (result: LayoutResult, view: GraphView, parent: string) =>
      [...(view.childrenOf.get(parent) ?? [])].sort(
        (a, b) =>
          boxOf(result, a).y - boxOf(result, b).y || boxOf(result, a).x - boxOf(result, b).x,
      );
    const one = await laidOut(BOTH_OPEN);
    const two = await laidOut([...BOTH_OPEN, "module:api/src"]);
    expect(order(two.result, two.view, "service:web/")).toEqual(
      order(one.result, one.view, "service:web/"),
    );
  });
});

describe("readLayout", () => {
  const input: LayoutInput = {
    nodes: [
      { id: "a", parent: null, width: 10, height: 10 },
      { id: "b", parent: null, width: 10, height: 10 },
    ],
    edges: [{ id: "e", from: "a", to: "b", label: { width: 20, height: 22 } }],
  };
  const shape = (id: string, x: number) => ({ id, x, y: 0, width: 10, height: 10 });

  it("joins an edge's sections, drops repeated points, and rounds", () => {
    const result = readLayout(input, {
      id: "__root",
      width: 100.123,
      height: 50,
      children: [shape("a", 0), shape("b", 50)],
      edges: [
        {
          id: "e",
          sources: ["a"],
          targets: ["b"],
          sections: [
            { id: "s0", startPoint: { x: 10, y: 5 }, endPoint: { x: 30.004, y: 5 } },
            { id: "s1", startPoint: { x: 30.004, y: 5 }, endPoint: { x: 50, y: 5 } },
          ],
        },
      ],
    });
    expect(result.edges[0]?.points).toEqual([
      { x: 10, y: 5 },
      { x: 30, y: 5 },
      { x: 50, y: 5 },
    ]);
    // No label position from ELK: halfway along the line.
    expect(result.edges[0]?.label).toEqual({ x: 30, y: 5 });
    expect(result.width).toBe(100.12);
  });

  it("moves a label ELK put beside its line onto the line", () => {
    const result = readLayout(input, {
      id: "__root",
      children: [shape("a", 0), shape("b", 50)],
      edges: [
        {
          id: "e",
          sources: ["a"],
          targets: ["b"],
          labels: [{ id: "e#label", x: 20, y: 8, width: 20, height: 22 }],
          sections: [{ id: "s0", startPoint: { x: 10, y: 5 }, endPoint: { x: 50, y: 5 } }],
        },
      ],
    });
    expect(result.edges[0]?.label).toEqual({ x: 30, y: 5 });
  });

  it("gives every label text, which ELK needs before it keeps room for one", () => {
    const graph = elkGraph(input);
    expect(graph.edges?.[0]?.labels?.[0]).toMatchObject({ text: " ", width: 20, height: 22 });
  });

  it("fails loudly when ELK loses a node or an edge's route", () => {
    expect(() => readLayout(input, { id: "__root", children: [shape("a", 0)] })).toThrow(
      "layout lost node b",
    );
    expect(() =>
      readLayout(input, { id: "__root", children: [shape("a", 0), shape("b", 50)], edges: [] }),
    ).toThrow("layout gave edge e no route");
  });
});
