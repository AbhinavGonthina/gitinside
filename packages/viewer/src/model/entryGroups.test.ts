// @vitest-environment node
import type { ArchitectureGraph, GraphEdge, GraphNode, UnresolvedReason } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { asServiceEntry, isShown, revealIn } from "../explorer/drill.js";
import { holderIn, openForPath } from "../explorer/pathView.js";
import { traceFrom } from "../explorer/trace.js";
import { layoutInput } from "../layout/elk.js";
import { closedSize, MAX_FRAME_WIDTH, viewNodeSize } from "../layout/size.js";
import { cardLook } from "../nodes/cards.js";
import { kindName } from "../nodes/describe.js";
import { shopDemo } from "../shopDemo.testkit.js";
import { hiddenNodes, NO_FILTERS } from "./filters.js";
import {
  groupLead,
  groupNote,
  importsIn,
  isEntryGroup,
  isGroup,
  isImportsGroup,
  isUnresolvedGroup,
  MAX_ENTRY_BOXES,
  summarizeGraph,
} from "./groups.js";
import { buildHierarchy } from "./hierarchy.js";
import { buildView, pathKeep } from "./view.js";

const API = "service:api/";
const WEB = "service:web/";
const ROUTES_FILE = "file:api/src/routes/orders.ts";
const HANDLER = "symbol:api/src/orders/handlers.ts#listOrders";
const group = (prefix: string) => `group:routes/${API}#${prefix}`;

const route = (method: string, path: string): GraphNode => ({
  id: `route:api/${method} ${path}`,
  kind: "route",
  label: `${method} ${path}`,
  layer: "backend",
  method: method as "GET",
  path,
  parentId: ROUTES_FILE,
  source: { file: "apps/api/src/routes/orders.ts", line: 1, column: 1 },
});

const page = (path: string): GraphNode => ({
  id: `page:web/${path}`,
  kind: "page",
  label: path,
  layer: "frontend",
  path,
  parentId: "file:web/app/page.tsx",
  source: { file: "apps/web/app/page.tsx", line: 1, column: 1 },
});

const unresolved = (n: number, reason: UnresolvedReason): GraphNode => ({
  id: `unresolved:api/src/db.ts:${n}:1`,
  kind: "unresolved",
  label: `GET /x${n}`,
  parentId: API,
  reason,
  expression: `fetch(x${n})`,
  source: { file: "apps/api/src/db.ts", line: n, column: 1 },
});

const handles = (from: string): GraphEdge => ({
  id: `handles:${from}->${HANDLER}`,
  kind: "handles",
  from,
  to: HANDLER,
  confidence: "exact",
  sites: [{ file: "apps/api/src/routes/orders.ts", line: 1, column: 1 }],
});

/** shop-demo (GET and POST /api/orders) plus `extra` nodes, each new route handled by listOrders. */
function shop(extra: GraphNode[]): ArchitectureGraph {
  const g = shopDemo();
  const edges = extra.filter((n) => n.kind === "route").map((n) => handles(n.id));
  return { ...g, nodes: [...g.nodes, ...extra], edges: [...g.edges, ...edges] };
}

/** The API's routes: /api/auth (3), /api/posts (3, one a parameter's), and three of their own. */
const ROUTES = [
  route("POST", "/api/auth/login"),
  route("POST", "/api/auth/logout"),
  route("GET", "/api/auth/me"),
  route("GET", "/api/posts"),
  route("GET", "/api/posts/:id"),
  route("POST", "/api/posts/:id/like"),
  route("GET", "/api/user/:id"),
  route("GET", "/health"),
  route("ALL", "/*"),
  route("GET", "/"),
  route("GET", "/robots.txt"),
];

const inside = (g: ArchitectureGraph, id: string) =>
  g.nodes.filter((n) => n.parentId === id).map((n) => n.id);
const label = (g: ArchitectureGraph, id: string) => g.nodes.find((n) => n.id === id)?.label;

describe("route and page groups (summarizeGraph)", () => {
  it("leaves a service with at most 12 entries as it is", () => {
    const g = shop(ROUTES.slice(0, MAX_ENTRY_BOXES - 2));
    expect(g.nodes.filter((n) => n.kind === "route")).toHaveLength(MAX_ENTRY_BOXES);
    expect(summarizeGraph(g)).toBe(g);
  });

  it("groups past 12 by the first segment, looking past an /api every longer route shares", () => {
    const g = summarizeGraph(shop(ROUTES));
    // The groups lead the service, sorted by prefix; one-route prefixes stay in their file.
    expect(inside(g, API).filter((id) => isGroup({ id }))).toEqual([
      group("/api/auth"),
      group("/api/orders"),
      group("/api/posts"),
    ]);
    expect(label(g, group("/api/auth"))).toBe("/api/auth · 3 routes");
    expect(label(g, group("/api/orders"))).toBe("/api/orders · 2 routes");
    expect(inside(g, group("/api/posts"))).toEqual([
      "route:api/GET /api/posts",
      "route:api/GET /api/posts/:id",
      "route:api/POST /api/posts/:id/like",
    ]);
    for (const id of ["GET /api/user/:id", "GET /health", "ALL /*", "GET /", "GET /robots.txt"]) {
      expect(g.nodes.find((n) => n.id === `route:api/${id}`)?.parentId).toBe(ROUTES_FILE);
    }
  });

  it("groups by /api itself when a longer route doesn't start with it", () => {
    const g = summarizeGraph(
      shop([...ROUTES, route("GET", "/auth/google"), route("GET", "/auth/github")]),
    );
    expect(inside(g, API).filter((id) => isGroup({ id }))).toEqual([group("/api"), group("/auth")]);
    expect(label(g, group("/api"))).toBe("/api · 9 routes");
  });

  it("breaks a group of more than 12 down by its next literal segment, past parameters", () => {
    const threads = ["new", "fork", "a/chats", "a/update"].map((p) =>
      route("POST", `/api/workspace/:slug/thread/${p}`),
    );
    const own = ["chats", "upload", "update", "embed", "parse", "pin", "search", "tts"].map((p) =>
      route("POST", `/api/workspace/:slug/${p}`),
    );
    const extra = [...threads, ...own, route("GET", "/api/workspace/:slug")];
    expect(extra.length).toBeGreaterThan(MAX_ENTRY_BOXES);
    const g = summarizeGraph(shop(extra));
    const ws = group("/api/workspace");
    expect(label(g, ws)).toBe(`/api/workspace · ${extra.length} routes`);
    // The parameter is passed over to `thread`; the rest are single prefixes and stay.
    const sub = group("/api/workspace/:slug/thread");
    expect(inside(g, ws)[0]).toBe(sub);
    expect(label(g, sub)).toBe("/api/workspace/:slug/thread · 4 routes");
    expect(inside(g, ws)).toHaveLength(1 + own.length + 1);
    expect(inside(g, ws).at(-1)).toBe("route:api/POST /api/workspace/:slug/upload");
  });

  it("draws at most 12 boxes a level: the largest groups, then Other with the rest", () => {
    // 14 prefixes: sizes 2..15, so the 11 largest (5..15) stay and 2, 3, 4 go in Other.
    const extra = Array.from({ length: 14 }, (_, i) =>
      Array.from({ length: i + 2 }, (_, j) =>
        route("GET", `/api/p${String(i).padStart(2, "0")}/${j}`),
      ),
    ).flat();
    const g = summarizeGraph(shop(extra));
    const level = inside(g, API).filter((id) => isGroup({ id }));
    expect(level).toHaveLength(MAX_ENTRY_BOXES);
    expect(level.at(-1)).toBe(`group:routes/${API}#other`);
    expect(level).toContain(group("/api/p13"));
    expect(level).toContain(group("/api/p03"));
    expect(level).not.toContain(group("/api/p02"));
    const other = `group:routes/${API}#other`;
    // GET and POST /api/orders (2) and /api/p00..p02 (2 + 3 + 4).
    expect(label(g, other)).toBe("Other routes · 11");
    expect(inside(g, other)).toEqual([
      group("/api/orders"),
      group("/api/p00"),
      group("/api/p01"),
      group("/api/p02"),
    ]);
    const index = buildHierarchy(g);
    expect(groupLead(index, index.byId.get(other) as GraphNode)).toBe(
      "11 routes from smaller groups, kept together so this level draws at most 12 boxes.",
    );
  });

  it("groups pages the same way, apart from routes", () => {
    const pages = ["/blog", "/blog/:slug", "/docs/a", "/docs/b", "/login", "/pricing"].map(page);
    const g = summarizeGraph(
      // With shop-demo's 3 pages: 14 pages, 12 boxes.
      shop([...pages, ...["/a", "/b", "/c", "/d", "/e"].map(page)]),
    );
    const pageGroup = (p: string) => `group:pages/${WEB}#${p}`;
    expect(inside(g, WEB).filter((id) => isGroup({ id }))).toEqual([
      pageGroup("/blog"),
      pageGroup("/docs"),
    ]);
    expect(label(g, pageGroup("/docs"))).toBe("/docs · 2 pages");
    // The API has 2 routes: not grouped.
    expect(inside(g, API).some((id) => isGroup({ id }))).toBe(false);
  });

  it("changes nothing but parents, and is deterministic", () => {
    const before = shop(ROUTES);
    const after = summarizeGraph(before);
    expect(after.edges).toBe(before.edges);
    const byId = new Map(after.nodes.map((n) => [n.id, n]));
    const unparented = ({ parentId: _, ...rest }: GraphNode) => rest;
    for (const n of before.nodes) {
      expect(unparented(byId.get(n.id) as GraphNode)).toEqual(unparented(n));
    }
    expect(after.nodes).toHaveLength(before.nodes.length + 3);
    expect(summarizeGraph(before)).toEqual(after);
    // Each group comes right after the service, then its members.
    const ids = after.nodes.map((n) => n.id);
    expect(ids.indexOf(group("/api/auth"))).toBe(ids.indexOf(API) + 1);
    expect(ids.indexOf("route:api/POST /api/auth/login")).toBe(ids.indexOf(API) + 2);
  });
});

describe("unresolved calls grouped by reason (summarizeGraph)", () => {
  const calls = [
    ...Array.from({ length: 10 }, (_, i) => unresolved(i + 1, "DYNAMIC_URL")),
    unresolved(20, "NO_MATCHING_ROUTE"),
    unresolved(21, "NO_MATCHING_ROUTE"),
    unresolved(22, "UNKNOWN_SYMBOL"),
  ];
  const id = (reason: string) => `group:unresolved/${API}#${reason}`;

  it("groups a service's more than 12 by reason; a reason with one stays", () => {
    const g = summarizeGraph(shop(calls));
    expect(inside(g, API).filter((n) => isGroup({ id: n }))).toEqual([
      id("DYNAMIC_URL"),
      id("NO_MATCHING_ROUTE"),
    ]);
    expect(label(g, id("DYNAMIC_URL"))).toBe("URL built at runtime · 10");
    expect(inside(g, id("NO_MATCHING_ROUTE"))).toEqual([
      "unresolved:api/src/db.ts:20:1",
      "unresolved:api/src/db.ts:21:1",
    ]);
    expect(inside(g, API)).toContain("unresolved:api/src/db.ts:22:1");
    const index = buildHierarchy(g);
    const node = (n: string) => index.byId.get(n) as GraphNode;
    expect(groupLead(index, node(id("DYNAMIC_URL")))).toBe(
      "10 calls the analysis couldn't link, all for one reason: url built at runtime.",
    );
    expect(groupNote(index, node("unresolved:api/src/db.ts:1:1"))).toBe(
      "Grouped with the service's other calls for this reason.",
    );
    expect(isUnresolvedGroup(node(id("DYNAMIC_URL")))).toBe(true);
    expect(cardLook(index, node(id("DYNAMIC_URL")))).toEqual({
      subtitle: { text: "Unresolved calls" },
      counts: [],
      glyph: "unresolved",
      dotted: true,
    });
    expect(isImportsGroup(node(id("DYNAMIC_URL")))).toBe(false);
  });

  it("leaves 12 as they are", () => {
    const g = shop(calls.slice(0, 11));
    expect(summarizeGraph(g)).toBe(g);
  });

  it("keeps them in the broken-down service's last column", () => {
    const index = buildHierarchy(summarizeGraph(shop(calls)));
    const view = buildView(index, [API]);
    const input = layoutInput(index, view, undefined, { bands: true });
    const exits = input.nodes.filter((n) => n.exit).map((n) => n.id);
    expect(exits).toEqual([
      id("DYNAMIC_URL"),
      id("NO_MATCHING_ROUTE"),
      "unresolved:api/src/db.ts:22:1",
    ]);
    // Outside the prototype's bands, ELK places them as before.
    expect(layoutInput(index, view).nodes.some((n) => n.exit)).toBe(false);
    // An open group stays in that column; the calls inside it are laid out within it.
    const open = buildView(index, [API, id("DYNAMIC_URL")]);
    const inGroup = layoutInput(index, open, undefined, { bands: true }).nodes.filter(
      (n) => n.exit,
    );
    expect(inGroup.map((n) => n.id)).toEqual(exits);
  });
});

describe("imports not in the repo (summarizeGraph)", () => {
  const FROM = "file:api/src/routes/orders.ts";
  /** An unresolved import of `expression` from line `n` of the routes file. */
  const missing = (n: number, expression: string, reason: UnresolvedReason = "UNKNOWN_SYMBOL") => {
    const node: GraphNode = {
      id: `unresolved:api/src/routes/orders.ts:${n}:1`,
      kind: "unresolved",
      label: expression,
      parentId: API,
      reason,
      expression,
      source: { file: "apps/api/src/routes/orders.ts", line: n, column: 1 },
    };
    const edge: GraphEdge = {
      id: `imports:${FROM}->${node.id}`,
      kind: "imports",
      from: FROM,
      to: node.id,
      confidence: "unresolved",
      reason,
      sites: [{ file: "apps/api/src/routes/orders.ts", line: n, column: 1 }],
    };
    return { node, edge };
  };
  /** shop-demo plus `items`' nodes and edges. */
  const withImports = (items: { node: GraphNode; edge: GraphEdge }[], extra: GraphNode[] = []) => {
    const g = shop(extra);
    return {
      ...g,
      nodes: [...g.nodes, ...items.map((i) => i.node)],
      edges: [...g.edges, ...items.map((i) => i.edge)],
    };
  };
  const imports = (reason = "UNKNOWN_SYMBOL") => `group:unresolved/${API}#imports/${reason}`;
  // Three React Router types (one listed out of line order) and a missing alias.
  const items = [
    missing(9, "./+types/orders"),
    missing(3, "./+types/root"),
    missing(4, "./+types/home"),
    missing(5, "~/lib/missing"),
  ];

  it("groups a service's 2 or more by reason at any count, named for most of them", () => {
    const g = summarizeGraph(withImports(items));
    expect(inside(g, API).filter((n) => isGroup({ id: n }))).toEqual([imports()]);
    expect(label(g, imports())).toBe("Not in the repo · 4 imports");
    const index = buildHierarchy(g);
    const node = (n: string) => index.byId.get(n) as GraphNode;
    expect(isImportsGroup(node(imports()))).toBe(true);
    expect(isUnresolvedGroup(node(imports()))).toBe(true);
    // The panel lists them all, by file and line.
    expect(importsIn(index, imports()).map((n) => n.source?.line)).toEqual([3, 4, 5, 9]);
    expect(importsIn(index, API)).toEqual([]);
    expect(groupLead(index, node(imports()))).toBe(
      "4 imports of files the analysis couldn't find in the repo. 3 point to ./+types/*: React Router types.",
    );
    expect(groupNote(index, node(items[0]?.node.id ?? ""))).toBe(
      "Grouped with the service's other imports not found in the repo.",
    );
    expect(cardLook(index, node(imports()))).toEqual({
      subtitle: { text: "React Router types", code: "./+types/*" },
      counts: [],
      glyph: "unresolved",
      dotted: true,
    });
  });

  it("says all when every import points there, and names nothing under half", () => {
    const all = buildHierarchy(summarizeGraph(withImports(items.slice(0, 3))));
    expect(groupLead(all, all.byId.get(imports()) as GraphNode)).toBe(
      "3 imports of files the analysis couldn't find in the repo. All point to ./+types/*: React Router types.",
    );
    const few = [items[0], missing(6, "./a"), missing(7, "./b")].filter((i) => i !== undefined);
    const index = buildHierarchy(summarizeGraph(withImports(few)));
    const node = index.byId.get(imports()) as GraphNode;
    expect(groupLead(index, node)).toBe(
      "3 imports of files the analysis couldn't find in the repo.",
    );
    expect(cardLook(index, node)?.subtitle).toEqual({ text: "Unresolved imports" });
  });

  it("leaves one import itself, and keeps another reason's imports apart", () => {
    const one = withImports(items.slice(3));
    expect(summarizeGraph(one)).toBe(one);
    const dynamic = [missing(11, "./a", "DYNAMIC_NAME"), missing(12, "./b", "DYNAMIC_NAME")];
    const g = summarizeGraph(withImports([...items, ...dynamic]));
    expect(inside(g, API).filter((n) => isGroup({ id: n }))).toEqual([
      imports(),
      imports("DYNAMIC_NAME"),
    ]);
    expect(label(g, imports("DYNAMIC_NAME"))).toBe("Name chosen at runtime · 2 imports");
    const index = buildHierarchy(g);
    expect(groupLead(index, index.byId.get(imports("DYNAMIC_NAME")) as GraphNode)).toBe(
      "2 imports the analysis couldn't link: name chosen at runtime.",
    );
    expect(groupNote(index, index.byId.get(dynamic[0]?.node.id ?? "") as GraphNode)).toBe(
      "Grouped with the service's other imports for this reason.",
    );
  });

  it("doesn't count imports as calls, nor group a node a call also reaches", () => {
    // 12 unresolved calls stay ungrouped beside the imports' box: imports don't push them past 12.
    const calls = Array.from({ length: MAX_ENTRY_BOXES }, (_, i) =>
      unresolved(i + 1, "DYNAMIC_URL"),
    );
    const g = summarizeGraph(withImports(items, calls));
    expect(inside(g, API).filter((n) => isGroup({ id: n }))).toEqual([imports()]);
    // A target reached by a call as well as an import is a call, not an import.
    const both = items[1];
    if (!both) throw new Error("no item");
    const call: GraphEdge = { ...both.edge, id: `calls:${FROM}->${both.node.id}`, kind: "calls" };
    const mixed = withImports(items);
    const h = summarizeGraph({ ...mixed, edges: [...mixed.edges, call] });
    expect(label(h, imports())).toBe("Not in the repo · 3 imports");
    expect(h.nodes.find((n) => n.id === both.node.id)?.parentId).toBe(API);
  });

  it("sizes the closed box to fit its subtitle as well as its name", () => {
    const prisma = [missing(1, "@x/prisma/generated/a"), missing(2, "@x/prisma/generated/b")];
    const index = buildHierarchy(summarizeGraph(withImports(prisma)));
    const box = buildView(index, [API]).byId.get(imports());
    if (!box) throw new Error("no imports box");
    const look = cardLook(index, box.node);
    expect(look?.subtitle).toEqual({ text: "Prisma's generated code", code: "prisma/generated/*" });
    // The shipped size measures the name alone; the card's subtitle is wider.
    const named = closedSize(box.node, { layer: "backend" }).width;
    const sized = viewNodeSize(index, box, undefined, true).width;
    expect(sized).toBeGreaterThan(named);
    expect(sized).toBeLessThanOrEqual(MAX_FRAME_WIDTH);
  });

  it("keeps the box in the broken-down service's last column", () => {
    const index = buildHierarchy(summarizeGraph(withImports(items)));
    const input = layoutInput(index, buildView(index, [API]), undefined, { bands: true });
    expect(input.nodes.filter((n) => n.exit).map((n) => n.id)).toEqual([imports()]);
  });
});

describe("route groups in the explorer's model", () => {
  const g = summarizeGraph(shop(ROUTES));
  const index = buildHierarchy(g);
  const auth = group("/api/auth");

  it("leads an open service with its groups, then its own routes; grouped routes stay inside", () => {
    const view = buildView(index, [API]);
    const entries = view.nodes.filter((n) => n.parent === API && n.section === "entries");
    expect(entries.map((n) => n.id)).toEqual([
      auth,
      group("/api/orders"),
      group("/api/posts"),
      "route:api/GET /",
      "route:api/ALL /*",
      "route:api/GET /api/user/:id",
      "route:api/GET /health",
      "route:api/GET /robots.txt",
    ]);
    expect(view.byId.has("route:api/POST /api/auth/login")).toBe(false);
    // Lines lift to the closed group.
    expect(view.edges.map((e) => e.id)).toContain(`handles:${auth}->module:api/src`);
    // Opening the routes' file doesn't draw a grouped route twice.
    const withFile = buildView(index, [
      API,
      "module:api/src",
      "module:api/src/routes",
      ROUTES_FILE,
    ]);
    expect(withFile.byId.get("route:api/POST /api/auth/login")).toBeUndefined();
    expect(withFile.byId.get("route:api/GET /health")?.parent).toBe(ROUTES_FILE);
  });

  it("draws a broken-down group's routes inside it, lines from each", () => {
    const view = buildView(index, [API, auth]);
    expect(view.childrenOf.get(auth)).toEqual([
      "route:api/POST /api/auth/login",
      "route:api/POST /api/auth/logout",
      "route:api/GET /api/auth/me",
    ]);
    expect(view.edges.map((e) => e.id)).toContain(
      "handles:route:api/GET /api/auth/me->module:api/src",
    );
  });

  it("reveals a grouped route by opening its group", () => {
    const id = "route:api/GET /api/auth/me";
    const node = index.byId.get(id) as GraphNode;
    expect(asServiceEntry(index, new Set([API]), node)).toBe(false);
    expect(isShown(index, new Set([API]), id)).toBe(false);
    expect(revealIn(index, [], id)).toEqual([API, auth]);
    // An ungrouped route still shows at its service's level.
    expect(revealIn(index, [], "route:api/GET /health")).toEqual([API]);
  });

  it("opens a route's group when a trace starts there, and keeps the group in a path view", () => {
    const id = "route:api/GET /api/auth/me";
    expect(holderIn(index, new Set([API]), id)).toBe(auth);
    const trace = traceFrom(index, id);
    expect(trace.steps[0]?.from.id).toBe(id);
    const opened = openForPath(index, trace);
    expect(opened.slice(0, 2)).toEqual([API, auth]);
    const keep = pathKeep(index, [id], new Set(opened));
    expect(keep.has(auth)).toBe(true);
    const view = buildView(index, opened, { only: { path: new Set([id, HANDLER]) } });
    expect(view.byId.get(id)?.parent).toBe(auth);
  });

  it("hides a group with its routes, says what it holds, and draws it as a capsule", () => {
    const off = hiddenNodes(index, { ...NO_FILTERS, kinds: ["route"] });
    expect(off.has(auth)).toBe(true);
    const node = (n: string) => index.byId.get(n) as GraphNode;
    expect(isEntryGroup(node(auth))).toBe(true);
    expect(kindName(node(auth))).toBe("Group");
    expect(groupLead(index, node(auth))).toBe("3 routes whose path starts with /api/auth.");
    expect(groupNote(index, node("route:api/GET /api/auth/me"))).toBe(
      "Grouped with the routes under /api/auth.",
    );
    expect(groupNote(index, node("route:api/GET /health"))).toBeUndefined();
    expect(cardLook(index, node(auth))).toEqual({ counts: [], shape: "capsule", glyph: "route" });
  });
});
