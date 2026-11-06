// @vitest-environment node
import { describe, expect, it } from "vitest";
import { diffPair } from "../diffPair.testkit.js";
import { buildDiffOverlay, versionGraph } from "./diff.js";
import { buildHierarchy } from "./hierarchy.js";
import { buildView, versionView } from "./view.js";

// A view as Base or Head draws it, for export (M6.11e).

describe.each(["diff-broken", "diff-rename"])("versionView on the %s pair", (name) => {
  const { base, head, diff } = diffPair(name);
  const overlay = buildDiffOverlay(base, head, diff);
  const index = buildHierarchy(overlay.graph);
  const everything = overlay.graph.nodes.map((n) => n.id);

  it.each(["base", "head"] as const)(
    "with everything open, is %s's own view on the overlay's IDs",
    (version) => {
      const shown = buildHierarchy(versionGraph(overlay, version));
      const drawn = versionView(buildView(index, everything), shown);
      expect(drawn).toEqual(buildView(shown, everything));
    },
  );

  it("keeps only what the version has, in the view's frames and order", () => {
    const view = buildView(index, [...index.children.keys()].slice(0, 3));
    for (const version of ["base", "head"] as const) {
      const drawn = versionView(view, buildHierarchy(versionGraph(overlay, version)));
      const has = overlay.nodesIn[version];
      expect(drawn.nodes.map((n) => n.id)).toEqual(
        view.nodes.filter((n) => has.has(n.id)).map((n) => n.id),
      );
      for (const kids of drawn.childrenOf.values()) for (const k of kids) expect(has).toContain(k);
      for (const e of drawn.edges) {
        expect(e.edges.length).toBeGreaterThan(0);
        for (const g of e.edges) expect(overlay.edgesIn[version]).toContain(g.id);
      }
    }
  });
});

describe("versionView on the diff-broken pair's service", () => {
  const P = "diff-broken";
  const { base, head, diff } = diffPair(P);
  const overlay = buildDiffOverlay(base, head, diff);
  const view = buildView(buildHierarchy(overlay.graph), [`service:${P}/`, `module:${P}/src`]);
  const removed = `route:${P}/DELETE /api/orders/:id`;

  it("leaves a removed route out of Head and keeps it in Base", () => {
    expect(view.byId.has(removed)).toBe(true);
    const inHead = versionView(view, buildHierarchy(versionGraph(overlay, "head")));
    const inBase = versionView(view, buildHierarchy(versionGraph(overlay, "base")));
    expect(inHead.byId.has(removed)).toBe(false);
    expect(inHead.edges.some((e) => e.to === removed || e.from === removed)).toBe(false);
    expect(inBase.byId.has(removed)).toBe(true);
    // Lines keep their places in the layout: same IDs as the view's.
    const ids = new Set(view.edges.map((e) => e.id));
    for (const e of [...inHead.edges, ...inBase.edges]) expect(ids).toContain(e.id);
  });
});

describe("versionView on the diff-rename pair", () => {
  const { base, head, diff } = diffPair("diff-rename");
  const overlay = buildDiffOverlay(base, head, diff);
  const index = buildHierarchy(overlay.graph);
  const everything = overlay.graph.nodes.map((n) => n.id);

  it("draws a renamed node with base's record in Base", () => {
    const [renamed] = diff.nodes.renamed;
    expect(renamed).toBeDefined();
    if (!renamed) return;
    const drawn = versionView(
      buildView(index, everything),
      buildHierarchy(versionGraph(overlay, "base")),
    );
    const node = drawn.byId.get(renamed.node.id)?.node;
    expect(node?.label).toBe(base.nodes.find((n) => n.id === renamed.from)?.label);
    expect(node?.label).not.toBe(renamed.node.label);
  });
});
