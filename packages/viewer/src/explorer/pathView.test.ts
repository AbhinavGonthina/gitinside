import { describe, expect, it } from "vitest";
import { ancestry, buildHierarchy } from "../model/hierarchy.js";
import { buildView, onlyKey, pathKeep } from "../model/view.js";
import { layoutKey } from "../layout/engine.js";
import { layoutInput } from "../layout/elk.js";
import { MORE_FOOT } from "../layout/size.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { holderIn, openForPath } from "./pathView.js";
import { traceFrom, traceNodes } from "./trace.js";

const index = buildHierarchy(shopDemo());
const START = "page:web//orders";

describe("holderIn", () => {
  it("is the outermost closed node on the way down, as buildView draws it", () => {
    const view = buildView(index, ["service:web/"]);
    for (const n of index.graph.nodes) {
      if (n.id === index.root.id) continue;
      const drawn = holderIn(index, new Set(view.open), n.id);
      // buildView's own answer: the node itself, or its innermost visible ancestor.
      let expected: string | undefined = n.id;
      while (expected && !view.byId.has(expected))
        expected = index.byId.get(expected)?.parentId ?? undefined;
      expect([n.id, drawn]).toEqual([n.id, expected]);
    }
  });

  it("is the entry itself once its service is open, though its folder is closed", () => {
    expect(holderIn(index, new Set(), START)).toBe("service:web/");
    expect(holderIn(index, new Set(["service:web/"]), START)).toBe(START);
  });

  it("is undefined for the root and for a node the filters hide", () => {
    expect(holderIn(index, new Set(), index.root.id)).toBeUndefined();
    expect(holderIn(index, new Set(), START, new Set(["service:web/"]))).toBeUndefined();
  });
});

describe("openForPath (M10.3d2, M10-design B1)", () => {
  const trace = traceFrom(index, START);

  it("opens just far enough for each hop's two ends to be separate boxes", () => {
    const opens = openForPath(index, trace);
    const open = new Set(opens);
    // Two boxes for each hop, unless it happens inside one file or function, which stays a card.
    for (const step of trace.steps) {
      const from = holderIn(index, open, step.from.id);
      const to = holderIn(index, open, step.to.id);
      const kind = from === to && from ? index.byId.get(from)?.kind : "apart";
      expect(["apart", "file", "symbol"]).toContain(kind);
    }
    expect(opens.every((id) => !["file", "symbol"].includes(index.byId.get(id)?.kind ?? ""))).toBe(
      true,
    );
    // Each opened node held both ends of a hop, given what opened before it.
    opens.forEach((id, i) => {
      const before = new Set(opens.slice(0, i));
      const shared = trace.steps.some(
        (s) => holderIn(index, before, s.from.id) === id && holderIn(index, before, s.to.id) === id,
      );
      expect([id, shared]).toEqual([id, true]);
    });
    expect(opens).toEqual([...new Set(opens)]);
  });

  it("opens nothing for a path whose hops already join separate boxes", () => {
    const db = index.graph.edges.find((e) => e.kind === "reads" || e.kind === "writes");
    const from = db ? index.byId.get(db.from) : undefined;
    expect(from).toBeDefined();
    const oneHop = {
      ...trace,
      steps: trace.steps.filter((s) => s.edge.kind === "http").slice(0, 1),
    };
    expect(oneHop.steps).toHaveLength(1);
    expect(openForPath(index, oneHop)).toEqual([]);
  });

  it("keeps a file a card: a hop between two of its functions opens only the frames around it", () => {
    // A call between two functions of one file (shop-demo has none, so one is made up).
    const file = index.graph.nodes.find(
      (n) =>
        n.kind === "file" &&
        (index.children.get(n.id) ?? []).filter((c) => c.kind === "symbol").length >= 2,
    );
    const [from, to] = (index.children.get(file?.id ?? "") ?? []).filter(
      (c) => c.kind === "symbol",
    );
    const call = index.graph.edges.find((e) => e.kind === "calls");
    if (!from || !to || !call) throw new Error("shop-demo has no file with two functions");
    const edge = { ...call, id: `calls:${from.id}->${to.id}`, from: from.id, to: to.id };
    const opens = openForPath(index, {
      start: from,
      steps: [{ edge, from, to, title: "", site: undefined }],
      cutOff: [],
    });
    const card = from.parentId as string;
    expect(opens).not.toContain(card);
    expect(opens.length).toBeGreaterThan(0);
    // Everything around the file, down to it: the hop happens inside its card.
    expect(holderIn(index, new Set(opens), from.id)).toBe(card);
    expect(holderIn(index, new Set(opens), to.id)).toBe(card);
  });

  it("doesn't open what the filters hide", () => {
    expect(openForPath(index, trace, new Set(["service:web/", "service:api/"]))).toEqual([]);
  });
});

describe("a path-only view", () => {
  const trace = traceFrom(index, START);
  const opens = openForPath(index, trace);
  const path = traceNodes(trace);
  const keep = pathKeep(index, path, new Set(opens));

  it("keeps the path and the frames around it, and nothing else", () => {
    const around = new Set<string>();
    for (const id of path) {
      expect([id, keep.has(id)]).toEqual([id, true]);
      const service = index.service.get(id);
      if (service) for (const n of ancestry(index, service)) expect(keep.has(n.id)).toBe(true);
      for (const n of ancestry(index, id)) around.add(n.id);
    }
    for (const id of keep) expect([id, around.has(id)]).toEqual([id, true]);
  });

  it("doesn't keep the folders of a route drawn at its service's first level", () => {
    const route = "route:api/GET /api/orders";
    const folders = new Set(
      ancestry(index, route)
        .filter((n) => n.kind === "module" || n.kind === "file")
        .map((n) => n.id),
    );
    expect(folders.size).toBeGreaterThan(0);
    const kept = pathKeep(index, [route], new Set(["service:api/"]));
    expect([...kept].sort()).toEqual([index.root.id, "service:api/", route].sort());
    // With its file open it's drawn there, so its folders are kept.
    const file = index.byId.get(route)?.parentId as string;
    const inFile = pathKeep(index, [route], new Set(["service:api/", ...folders]));
    expect(inFile.has(file)).toBe(true);
    const view = buildView(index, ["service:api/"], { only: { path: new Set([route]) } });
    expect(view.childrenOf.get("service:api/")).toEqual([route]);
    expect(view.byId.get("service:api/")?.more).toBeGreaterThan(0);
    // Its folder is left out, but the route is drawn, so the request to it still is.
    expect(view.edges.filter((e) => e.to === route).map((e) => e.id)).toEqual(
      buildView(index, ["service:api/"])
        .edges.filter((e) => e.to === route)
        .map((e) => e.id),
    );
    expect(view.edges.some((e) => e.to === route && e.kind === "http")).toBe(true);
  });

  it("draws only the path's boxes inside the frames it opened, counting the rest", () => {
    const whole = buildView(index, opens);
    const only = buildView(index, opens, { only: { path } });
    // The top level stays whole.
    expect(only.childrenOf.get(index.root.id)).toEqual(whole.childrenOf.get(index.root.id));
    for (const n of only.nodes) {
      if (n.parent !== null) expect([n.id, keep.has(n.id)]).toEqual([n.id, true]);
    }
    let left = 0;
    for (const id of only.open) {
      const before = whole.childrenOf.get(id)?.length ?? 0;
      const after = only.childrenOf.get(id)?.length ?? 0;
      expect([id, only.byId.get(id)?.more ?? 0]).toEqual([id, before - after]);
      left += before - after;
    }
    expect(left).toBeGreaterThan(0);
    // A line to a left-out box goes rather than landing on its frame.
    for (const e of only.edges) {
      expect([e.id, only.byId.get(e.from)?.open, only.byId.get(e.to)?.open]).toEqual([
        e.id,
        false,
        false,
      ]);
    }
    // Every hop is still a line between the two boxes holding its ends.
    const open = new Set(only.open);
    for (const s of trace.steps) {
      const line = only.edges.find((e) => e.edges.includes(s.edge));
      expect([s.edge.id, line?.from, line?.to]).toEqual([
        s.edge.id,
        holderIn(index, open, s.edge.from),
        holderIn(index, open, s.edge.to),
      ]);
    }
  });

  it("shows a frame whole again once asked", () => {
    const [first] = buildView(index, opens, { only: { path } }).nodes.filter((n) => n.more);
    expect(first).toBeDefined();
    const id = first?.id as string;
    const shown = buildView(index, opens, { only: { path, whole: new Set([id]) } });
    expect(shown.byId.get(id)?.more).toBeUndefined();
    expect(shown.childrenOf.get(id)).toEqual(buildView(index, opens).childrenOf.get(id));
  });

  it("has its own layout key, and leaves room for '+ N more' at a frame's foot", () => {
    const plain = buildView(index, opens);
    const only = buildView(index, opens, { only: { path } });
    expect(plain.only).toBe("");
    expect(only.only).toBe(onlyKey({ path }));
    expect(layoutKey(only)).not.toBe(layoutKey(plain));
    // Other views keep the key they had.
    expect(layoutKey(plain)).toBe(JSON.stringify([plain.open, plain.hidden, plain.filtered]));
    const input = layoutInput(index, only);
    for (const n of input.nodes) {
      const more = only.byId.get(n.id)?.more;
      expect([n.id, n.foot]).toEqual([n.id, more ? MORE_FOOT : undefined]);
    }
  });
});
