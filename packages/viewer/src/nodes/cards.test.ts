// @vitest-environment node
import type { ArchitectureGraph, GraphEdge, GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { brandForHost } from "../icons/brands.js";
import { textWidth } from "../image/markup.js";
import {
  CAPTION_ROW,
  closedSize,
  MAX_FRAME_WIDTH,
  MAX_WRAP_WIDTH,
  NAME_LINE,
  viewNodeCounts,
  viewNodeSize,
} from "../layout/size.js";
import { summarizeGraph } from "../model/groups.js";
import { groupedShop } from "../model/groups.testkit.js";
import { buildHierarchy } from "../model/hierarchy.js";
import { buildView } from "../model/view.js";
import {
  cardLook,
  groupLogos,
  nameLines,
  namePieces,
  serviceCounts,
  serviceRole,
  UNLINKED_CAPTION,
} from "./cards.js";

const ROOT: GraphNode = { id: "system:root", kind: "system", label: "repo", parentId: null };

function service(name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: `service:${name}/`,
    kind: "service",
    label: name,
    parentId: ROOT.id,
    root: name,
    ...extra,
  } as GraphNode;
}

function file(svc: string, name: string): GraphNode {
  return {
    id: `file:${svc}/${name}`,
    kind: "file",
    label: name,
    parentId: `service:${svc}/`,
    path: `${svc}/${name}`,
    hash: "0".repeat(64),
  } as GraphNode;
}

function edge(kind: GraphEdge["kind"], from: string, to: string): GraphEdge {
  return {
    id: `${kind}:${from}->${to}`,
    kind,
    from,
    to,
    confidence: "exact",
    sites: [{ file: "x.ts", line: 1, column: 1 }],
  };
}

function graphOf(nodes: GraphNode[], edges: GraphEdge[] = []): ArchitectureGraph {
  const base = groupedShop();
  return { ...base, nodes: [ROOT, ...nodes], edges };
}

const shop = buildHierarchy(summarizeGraph(groupedShop()));
const node = (id: string) => {
  const n = shop.byId.get(id);
  if (!n) throw new Error(`no ${id}`);
  return n;
};

describe("prototype cards (M10.3b3)", () => {
  it("gives every service a count row: pages, routes, models, outside APIs, unresolved calls", () => {
    expect(serviceCounts(shop, "service:web/")).toEqual([
      { value: 3, noun: "page" },
      { value: 1, noun: "unresolved call", unresolved: true },
    ]);
    // Three AI hosts and Stripe, each counted once however many calls reach it.
    expect(serviceCounts(shop, "service:api/")).toEqual([
      { value: 2, noun: "route" },
      { value: 1, noun: "model" },
      { value: 4, noun: "outside API" },
    ]);
  });

  it("counts an outside host once, however many calls from however many files reach it", () => {
    const host: GraphNode = {
      id: "external:api.stripe.com",
      kind: "external",
      label: "api.stripe.com",
      host: "api.stripe.com",
      parentId: ROOT.id,
    } as GraphNode;
    const g = graphOf(
      [service("srv"), file("srv", "a.ts"), file("srv", "b.ts"), host],
      [
        edge("external_call", "file:srv/a.ts", host.id),
        edge("external_call", "file:srv/b.ts", host.id),
      ],
    );
    expect(serviceCounts(buildHierarchy(g), "service:srv/")).toEqual([
      { value: 1, noun: "outside API" },
    ]);
  });

  it("counts files when a service has none of those", () => {
    const g = graphOf([service("lib"), file("lib", "a.ts"), file("lib", "b.ts"), service("cfg")]);
    const index = buildHierarchy(g);
    expect(serviceCounts(index, "service:lib/")).toEqual([{ value: 2, noun: "file" }]);
    expect(serviceCounts(index, "service:cfg/")).toEqual([{ value: 0, noun: "file" }]);
  });

  it("names a service's role from its framework and entries", () => {
    expect(serviceRole(shop, node("service:web/"))).toBe("Next.js app");
    expect(serviceRole(shop, node("service:api/"))).toBe("Express API");
    expect(serviceRole(shop, node("service:ui/"))).toBe("Package");
  });

  it("calls a service other services use a package, else goes by its layer", () => {
    const g = graphOf(
      [
        service("app", { layer: "frontend", framework: "react" } as Partial<GraphNode>),
        file("app", "main.ts"),
        service("lib", { layer: "frontend", framework: "react" } as Partial<GraphNode>),
        file("lib", "index.ts"),
        service("srv", { layer: "backend" } as Partial<GraphNode>),
        service("jobs", { layer: "infra" } as Partial<GraphNode>),
      ],
      [edge("imports", "file:app/main.ts", "file:lib/index.ts")],
    );
    const index = buildHierarchy(g);
    const role = (id: string) => serviceRole(index, index.byId.get(id) as GraphNode);
    expect(role("service:app/")).toBe("React app");
    expect(role("service:lib/")).toBe("React package");
    expect(role("service:srv/")).toBe("Server");
    expect(role("service:jobs/")).toBe("Worker");
  });

  it("shows two services with one name by their folders, the name as the subtitle", () => {
    const g = graphOf([
      service("anything-llm", { root: "" } as Partial<GraphNode>),
      { ...service("anything-llm"), id: "service:frontend/", root: "frontend" } as GraphNode,
      service("server"),
    ]);
    const index = buildHierarchy(g);
    const look = (id: string) => cardLook(index, index.byId.get(id) as GraphNode);
    expect(look("service:anything-llm/")).toMatchObject({
      name: "repo root",
      subtitle: { text: "Package", code: "anything-llm" },
    });
    expect(look("service:frontend/")).toMatchObject({
      name: "frontend",
      subtitle: { text: "Package", code: "anything-llm" },
    });
    expect(look("service:server/")?.name).toBeUndefined();
    expect(look("service:server/")?.subtitle).toEqual({ text: "Package", code: "server" });
  });

  it("draws a host group's tile with up to four logos, one per brand", () => {
    const hosts = [
      "api.openai.com",
      "api.anthropic.com",
      "api.cohere.ai",
      "api.cohere.com",
      "api.mistral.ai",
      "api.groq.com",
      "generativelanguage.googleapis.com",
      "nothing.example",
    ];
    const g = graphOf([
      service("srv"),
      file("srv", "a.ts"),
      ...hosts.map(
        (host): GraphNode =>
          ({
            id: `external:${host}`,
            kind: "external",
            label: host,
            host,
            parentId: ROOT.id,
          }) as GraphNode,
      ),
    ]);
    const index = buildHierarchy(summarizeGraph(g));
    const logos = groupLogos(index, "group:hosts/ai");
    expect(logos.length).toBeLessThanOrEqual(4);
    expect(logos.length).toBeGreaterThan(1);
    const brands = logos.map((l) => (l.kind === "external" ? brandForHost(l.host)?.slug : ""));
    expect(brands.every(Boolean)).toBe(true);
    expect(new Set(brands).size).toBe(brands.length);
    const look = cardLook(index, index.byId.get("group:hosts/ai") as GraphNode);
    expect(look).toMatchObject({ subtitle: { text: "Outside hosts" }, counts: [] });
    expect(look?.logos).toEqual(logos);
  });

  it("leaves other boxes as shipped", () => {
    expect(cardLook(shop, node("datastore:infra/db"))).toBeUndefined();
    expect(cardLook(shop, node("group:shared"))).toBeUndefined();
  });
});

describe("prototype names wrap, never cut (M10.3b3)", () => {
  it("breaks a name after slashes, dots, underscores, spaces, and hyphens", () => {
    expect(namePieces("@documenso/tailwind-config")).toEqual([
      "@documenso/",
      "tailwind-",
      "config",
    ]);
    expect(namePieces("api.example.com")).toEqual(["api.", "example.", "com"]);
  });

  it("counts lines greedily, breaking inside a piece wider than the line", () => {
    expect(nameLines("web", 14, 100)).toBe(1);
    const name = "anything-llm-document-collector";
    const w = textWidth(name, 14);
    expect(nameLines(name, 14, w + 0.01)).toBe(1);
    expect(nameLines(name, 14, w - 1)).toBe(2);
    // One piece three lines wide.
    const long = "x".repeat(30);
    expect(nameLines(long, 14, textWidth(long, 14) / 3 + 1)).toBe(3);
  });

  it("grows a service's card to its name up to 280px, then wraps it onto a second line", () => {
    const g = graphOf([
      service("web"),
      service("anything-llm-document-collector-and-friends"),
      service(`a${"-b".repeat(60)}`),
    ]);
    const index = buildHierarchy(g);
    const size = (id: string) => {
      const n = index.byId.get(id) as GraphNode;
      const card = cardLook(index, n);
      return closedSize(n, { wrap: true, card, counts: card?.counts });
    };
    const short = size("service:web/");
    const long = size("service:anything-llm-document-collector-and-friends/");
    expect(short.width).toBeLessThan(MAX_WRAP_WIDTH);
    expect(long.width).toBe(MAX_WRAP_WIDTH);
    expect(long.height).toBe(short.height + NAME_LINE.frame);
    // Too long for two lines at 280px: wider, up to the frame's widest.
    const huge = size(`service:a${"-b".repeat(60)}/`);
    expect(huge.width).toBeGreaterThan(MAX_WRAP_WIDTH);
    expect(huge.width).toBeLessThanOrEqual(MAX_FRAME_WIDTH + 8);
  });

  it("adds lines to an icon box's height instead of cutting its name", () => {
    const host = "stargrazer-live.onrender.com";
    const n = {
      id: `external:${host}`,
      kind: "external",
      label: host,
      host,
      parentId: ROOT.id,
    } as GraphNode;
    expect(closedSize(n).height).toBe(128);
    expect(closedSize(n, { wrap: true }).height).toBe(128 + NAME_LINE.icon);
  });

  it("sizes a closed host group as an icon box", () => {
    const view = buildView(shop, []);
    const group = view.nodes.find((n) => n.id === "group:hosts/ai");
    if (!group) throw new Error("no group");
    expect(viewNodeSize(shop, group, undefined, true).height).toBe(128);
    expect(viewNodeSize(shop, group).height).not.toBe(128);
  });

  it("sizes and counts services as shipped without cards", () => {
    const view = buildView(shop, []);
    const api = view.nodes.find((n) => n.id === "service:api/");
    if (!api) throw new Error("no api");
    expect(viewNodeCounts(shop, api).map((c) => c.noun)).toEqual(["route", "model"]);
    expect(viewNodeCounts(shop, api, undefined, true).map((c) => c.noun)).toEqual([
      "route",
      "model",
      "outside API",
    ]);
  });
});

describe("an unlinked datastore's caption (M10.3c2)", () => {
  const store = (name: string): GraphNode =>
    ({
      id: `datastore:infra/${name}`,
      kind: "datastore",
      label: name,
      engine: "redis",
      parentId: ROOT.id,
    }) as GraphNode;
  const srv = service("srv");
  const g = buildHierarchy(
    graphOf(
      [srv, file("srv", "a.ts"), store("cache"), store("db"), store("queue")],
      [
        edge("stores", srv.id, "datastore:infra/db"),
        edge("reads", "datastore:infra/queue", "file:srv/a.ts"),
      ],
    ),
  );
  const look = (id: string) => cardLook(g, g.byId.get(id) as GraphNode);

  it("says 'Not linked to code' when no connection reaches or leaves it", () => {
    expect(look("datastore:infra/cache")).toEqual({ caption: UNLINKED_CAPTION });
    expect(UNLINKED_CAPTION).toBe("Not linked to code");
    // A line either way is a link.
    expect(look("datastore:infra/db")).toBeUndefined();
    expect(look("datastore:infra/queue")).toBeUndefined();
  });

  it("gives the caption a row of its own, and room for its words", () => {
    const n = store("cache");
    const plain = closedSize(n, { wrap: true });
    const captioned = closedSize(n, { wrap: true, card: { caption: UNLINKED_CAPTION } });
    expect(captioned.height).toBe(plain.height + CAPTION_ROW);
    expect(captioned.width).toBeGreaterThanOrEqual(textWidth(UNLINKED_CAPTION, 12) + 18);
  });
});
