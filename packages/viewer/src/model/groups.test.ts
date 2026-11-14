// @vitest-environment node
import type { ArchitectureGraph, GraphEdge, GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { kindName, nodeAccessibleName } from "../nodes/describe.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { filterOptions, hiddenNodes, NO_FILTERS } from "./filters.js";
import {
  groupLead,
  groupNote,
  isGroup,
  SHARED_GROUP,
  sharedServices,
  summarizeGraph,
} from "./groups.js";
import { buildHierarchy, layerOf } from "./hierarchy.js";
import { buildView } from "./view.js";

const ROOT = "system:root";

const service = (name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({
    id: `service:${name}/`,
    kind: "service",
    label: `@shop/${name}`,
    parentId: ROOT,
    root: `packages/${name}`,
    ...extra,
  }) as GraphNode;

const file = (service: string, name: string): GraphNode => ({
  id: `file:${service}/${name}`,
  kind: "file",
  label: name,
  parentId: `service:${service}/`,
  path: `packages/${service}/${name}`,
  hash: "0".repeat(64),
});

const external = (host: string): GraphNode => ({
  id: `external:ext/${host}`,
  kind: "external",
  label: host,
  host,
  layer: "external",
  parentId: ROOT,
});

const edge = (kind: GraphEdge["kind"], from: string, to: string, n = 1): GraphEdge => ({
  id: `${kind}:${from}->${to}#${n}`,
  kind,
  from,
  to,
  confidence: "exact",
  sites: [{ file: "x.ts", line: n, column: 1 }],
});

const WEB_FILE = "file:web/lib/orders.ts";
const API_FILE = "file:api/src/billing/stripe.ts";

/** shop-demo plus a ui package web calls, a config package, a bare repo root, and outside hosts. */
function monorepo(extra: { nodes?: GraphNode[]; edges?: GraphEdge[] } = {}): ArchitectureGraph {
  const g = shopDemo();
  return {
    ...g,
    nodes: [
      ...g.nodes,
      service("ui", { layer: "frontend" }),
      file("ui", "button.tsx"),
      service("tsconfig"),
      service("root", { root: "", label: "shop" }),
      external("api.openai.com"),
      external("api.anthropic.com"),
      external("api.groq.com"),
      external("github.com"),
      ...(extra.nodes ?? []),
    ],
    edges: [
      ...g.edges,
      edge("calls", WEB_FILE, "file:ui/button.tsx"),
      edge("imports", WEB_FILE, "file:ui/button.tsx"),
      edge("external_call", API_FILE, "external:ext/api.groq.com", 1),
      edge("external_call", API_FILE, "external:ext/api.groq.com", 2),
      edge("external_call", API_FILE, "external:ext/api.anthropic.com"),
      edge("external_call", API_FILE, "external:ext/api.openai.com"),
      edge("external_call", API_FILE, "external:ext/github.com"),
      ...(extra.edges ?? []),
    ],
  };
}

const top = (g: ArchitectureGraph) => g.nodes.filter((n) => n.parentId === ROOT).map((n) => n.id);
const inside = (g: ArchitectureGraph, id: string) =>
  g.nodes.filter((n) => n.parentId === id).map((n) => n.id);

describe("summarizeGraph", () => {
  it("groups services with no entries and no work of their own as shared packages", () => {
    const g = summarizeGraph(monorepo());
    expect(inside(g, SHARED_GROUP)).toEqual(["service:ui/", "service:tsconfig/", "service:root/"]);
    const group = g.nodes.find((n) => n.id === SHARED_GROUP);
    expect(group).toMatchObject({ kind: "module", label: "Shared packages · 3", path: "" });
    // Web, which uses them most, is a frontend.
    expect(group?.layer).toBe("frontend");
    expect(top(g)).toEqual([
      "datastore:infra/db",
      "external:ext/api.stripe.com",
      "service:api/",
      "service:web/",
      SHARED_GROUP,
      "group:hosts/ai",
      "external:ext/github.com",
    ]);
  });

  it("keeps a service with any request, data, queue, or outside call from inside it", () => {
    for (const kind of [
      "http",
      "reads",
      "writes",
      "stores",
      "publishes",
      "consumes",
      "external_call",
    ] as const) {
      const g = monorepo({ edges: [edge(kind, "file:ui/button.tsx", "datastore:infra/db")] });
      const shared = sharedServices(buildHierarchy(g)).map((n) => n.id);
      expect(shared, kind).not.toContain("service:ui/");
      expect(shared, kind).toContain("service:tsconfig/");
    }
    // Code lines alone don't count as work.
    const calls = monorepo({ edges: [edge("calls", "file:ui/button.tsx", API_FILE)] });
    expect(sharedServices(buildHierarchy(calls)).map((n) => n.id)).toContain("service:ui/");
  });

  it("keeps a service with routes or pages, and services never nested in a group", () => {
    const shared = sharedServices(buildHierarchy(monorepo())).map((n) => n.id);
    expect(shared).not.toContain("service:web/");
    expect(shared).not.toContain("service:api/");
  });

  it("makes no shared group for one package, but does for a lone repo root among services", () => {
    const one = shopDemo();
    const tsconfig = { ...one, nodes: [...one.nodes, service("tsconfig")] };
    expect(summarizeGraph(tsconfig)).toBe(tsconfig);

    const bare = { ...one, nodes: [...one.nodes, service("app", { root: "", label: "app" })] };
    const g = summarizeGraph(bare);
    expect(inside(g, SHARED_GROUP)).toEqual(["service:app/"]);
    expect(g.nodes.find((n) => n.id === SHARED_GROUP)?.label).toBe("Repo root");
    // Nothing uses it: Backend.
    expect(g.nodes.find((n) => n.id === SHARED_GROUP)?.layer).toBe("backend");

    // A single-service repo's root is the app itself.
    const root = one.nodes.find((n) => n.id === ROOT) as GraphNode;
    const solo = { ...one, nodes: [root, service("app", { root: "" })], edges: [] };
    expect(summarizeGraph(solo)).toBe(solo);
  });

  it("puts the shared group in Backend when two layers use it equally", () => {
    const g = summarizeGraph(
      monorepo({ edges: [edge("calls", API_FILE, "file:ui/button.tsx", 3)] }),
    );
    // web: calls + imports; api: one call. web leads.
    expect(g.nodes.find((n) => n.id === SHARED_GROUP)?.layer).toBe("frontend");
    const tied = summarizeGraph(
      monorepo({
        edges: [
          edge("calls", API_FILE, "file:ui/button.tsx", 3),
          edge("imports", API_FILE, "file:ui/button.tsx", 4),
        ],
      }),
    );
    expect(tied.nodes.find((n) => n.id === SHARED_GROUP)?.layer).toBe("backend");
  });

  it("groups three or more outside hosts of one purpose, most lines first; fewer stay", () => {
    const g = summarizeGraph(monorepo());
    expect(inside(g, "group:hosts/ai")).toEqual([
      "external:ext/api.groq.com",
      "external:ext/api.anthropic.com",
      "external:ext/api.openai.com",
    ]);
    expect(g.nodes.find((n) => n.id === "group:hosts/ai")).toMatchObject({
      kind: "module",
      label: "AI models · 3",
      layer: "external",
    });
    // Stripe (payments) and GitHub (code hosting) are alone in theirs.
    expect(top(g)).toContain("external:ext/api.stripe.com");
    expect(top(g)).toContain("external:ext/github.com");
  });

  it("changes nothing but parents: every edge, ID, and field stays the graph's", () => {
    const before = monorepo();
    const after = summarizeGraph(before);
    expect(after.edges).toBe(before.edges);
    const groups = after.nodes.filter(isGroup);
    expect(groups.map((n) => n.id)).toEqual([SHARED_GROUP, "group:hosts/ai"]);
    const moved = new Map(after.nodes.map((n) => [n.id, n]));
    const unparented = ({ parentId: _, ...rest }: GraphNode) => rest;
    for (const n of before.nodes) {
      expect(unparented(moved.get(n.id) as GraphNode)).toEqual(unparented(n));
    }
    expect(after.nodes).toHaveLength(before.nodes.length + 2);
    expect(summarizeGraph(before)).toEqual(after);
  });

  it("returns a graph with nothing to group as it is", () => {
    const g = shopDemo();
    expect(summarizeGraph(g)).toBe(g);
  });
});

describe("a summarized graph in the explorer's model", () => {
  const g = summarizeGraph(monorepo());
  const index = buildHierarchy(g);

  it("draws a group closed at the top level, its members inside when broken down, lines lifted", () => {
    const closed = buildView(index, []);
    expect(closed.byId.get(SHARED_GROUP)?.canOpen).toBe(true);
    expect(closed.byId.has("service:ui/")).toBe(false);
    expect(closed.edges.map((e) => e.id)).toContain(`calls:service:web/->${SHARED_GROUP}`);
    expect(closed.edges.map((e) => e.id)).toContain("external_call:service:api/->group:hosts/ai");
    const open = buildView(index, [SHARED_GROUP]);
    expect(open.childrenOf.get(SHARED_GROUP)).toEqual([
      "service:ui/",
      "service:tsconfig/",
      "service:root/",
    ]);
    expect(open.edges.map((e) => e.id)).toContain("calls:service:web/->service:ui/");
  });

  it("keeps each member's own layer: a service without one doesn't take the group's", () => {
    expect(layerOf(index, "service:ui/")).toBe("frontend");
    expect(layerOf(index, "service:tsconfig/")).toBeUndefined();
    expect(layerOf(index, "external:ext/api.groq.com")).toBe("external");
  });

  it("hides a group only with its members, and counts no group as a layer's node", () => {
    const frontendOff = hiddenNodes(index, { ...NO_FILTERS, layers: ["frontend"] });
    expect(frontendOff.has(SHARED_GROUP)).toBe(false);
    expect(frontendOff.has("service:ui/")).toBe(true);
    const externalOff = hiddenNodes(index, { ...NO_FILTERS, layers: ["external"] });
    expect(externalOff.has("group:hosts/ai")).toBe(true);
    expect(filterOptions(index).layers.find((l) => l.value === "external")?.count).toBe(5);
  });

  it("says what a group holds and why a member is in one", () => {
    const node = (id: string) => index.byId.get(id) as GraphNode;
    expect(groupLead(index, node(SHARED_GROUP))).toBe(
      "3 packages with no routes, pages, or requests of their own: @shop/ui, @shop/tsconfig and shop.",
    );
    expect(groupLead(index, node("group:hosts/ai"))).toBe(
      "3 outside hosts for AI models: api.groq.com, api.anthropic.com and api.openai.com.",
    );
    expect(groupLead(index, node("service:ui/"))).toBeUndefined();
    expect(groupNote(index, node("service:ui/"))).toBe(
      "Grouped with shared packages: no routes, pages, or requests of its own. Used by @shop/web.",
    );
    expect(groupNote(index, node("service:tsconfig/"))).toBe(
      "Grouped with shared packages: no routes, pages, or requests of its own.",
    );
    expect(groupNote(index, node("external:ext/api.groq.com"))).toBe("Grouped under AI models.");
    expect(groupNote(index, node("service:web/"))).toBeUndefined();
    expect(kindName(node(SHARED_GROUP))).toBe("Group");
    expect(nodeAccessibleName(node("group:hosts/ai"))).toBe("AI models · 3, group");
    expect(kindName(node("module:api/src"))).toBe("Module");
  });
});
