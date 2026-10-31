// @vitest-environment node
import type { ArchitectureGraph, GraphEdge, GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { shopDemo } from "../shopDemo.testkit.js";
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  filtersKey,
  hiddenNodes,
  isTestOrConfig,
  isUnder,
  NO_FILTERS,
  normalizeFilters,
  normalizeFolder,
  type Filters,
} from "./filters.js";
import { buildHierarchy } from "./hierarchy.js";
import { buildView, effectiveOpen, type GraphView } from "./view.js";

const HASH = "0".repeat(64);
const file = (id: string, parentId: string, path: string): GraphNode => ({
  id,
  kind: "file",
  label: path.split("/").pop() ?? path,
  parentId,
  path,
  hash: HASH,
});
const fn = (file: string, name: string): GraphNode => ({
  id: `symbol:${file.slice("file:".length)}#${name}`,
  kind: "symbol",
  label: name,
  parentId: file,
  symbolKind: "function",
  exported: true,
});
const calls = (from: string, to: string): GraphEdge => ({
  id: `calls:${from}->${to}`,
  kind: "calls",
  from,
  to,
  confidence: "exact",
  sites: [],
});

// The shop demo plus what real repos carry next to the app: a test folder,
// a spec beside its code, and a config file at a service's root.
const TESTS = "module:api/src/__tests__";
const ORDERS_TEST = "file:api/src/__tests__/orders.test.ts";
const SPEC = "file:api/src/orders/handlers.spec.ts";
const NEXT_CONFIG = "file:web/next.config.mjs";
const CREATE = "symbol:api/src/orders/handlers.ts#createOrder";

function withTests(): ArchitectureGraph {
  const g = shopDemo();
  return {
    ...g,
    nodes: [
      ...g.nodes,
      {
        id: TESTS,
        kind: "module",
        label: "__tests__",
        parentId: "module:api/src",
        path: "apps/api/src/__tests__",
      },
      file(ORDERS_TEST, TESTS, "apps/api/src/__tests__/orders.test.ts"),
      fn(ORDERS_TEST, "createsAnOrder"),
      file(SPEC, "module:api/src/orders", "apps/api/src/orders/handlers.spec.ts"),
      fn(SPEC, "listsOrders"),
      file(NEXT_CONFIG, "service:web/", "apps/web/next.config.mjs"),
    ],
    edges: [
      ...g.edges,
      calls("symbol:api/src/__tests__/orders.test.ts#createsAnOrder", CREATE),
      calls(
        "symbol:api/src/orders/handlers.spec.ts#listsOrders",
        "symbol:api/src/orders/handlers.ts#listOrders",
      ),
    ],
  };
}

const index = buildHierarchy(withTests());
const shop = buildHierarchy(shopDemo());
const ids = (view: GraphView) => view.nodes.map((n) => n.id);
const lifted = (view: GraphView) =>
  view.edges.map((e) => `${e.kind} ${e.from} -> ${e.to} ${e.confidence} ×${e.edges.length}`);
const ALL = index.graph.nodes.map((n) => n.id);
const filters = (f: Partial<Filters>): Filters => ({ ...NO_FILTERS, ...f });

describe("isTestOrConfig", () => {
  it.each([
    "apps/api/src/orders.test.ts",
    "apps/web/components/Button.spec.tsx",
    "e2e/login.e2e.ts",
    "apps/api/src/__tests__/helpers.ts",
    "apps/api/src/__mocks__/stripe.ts",
    "apps/api/test/setup.ts",
    "packages/ui/tests",
    "cypress/support/commands.js",
    "apps/web/next.config.mjs",
    "vite.config.ts",
    "prisma.config.ts",
    ".eslintrc.cjs",
    "jest.setup.ts",
    "src/setupTests.tsx",
  ])("treats %s as a test or config path", (path) => {
    expect(isTestOrConfig(path)).toBe(true);
  });

  it.each([
    "apps/api/src/orders.ts",
    "apps/web/app/testimonials/page.tsx",
    "apps/web/lib/contest.ts",
    "apps/web/middleware.ts",
    "apps/web/components/Button.stories.tsx",
    "fixtures/shop.ts",
    "src/types.d.ts",
    "src/config.ts",
    "src/config/index.ts",
    "",
  ])("keeps %s", (path) => {
    expect(isTestOrConfig(path)).toBe(false);
  });
});

describe("folders", () => {
  it("normalizes a typed folder", () => {
    expect(normalizeFolder("  ./apps/api/ ")).toBe("apps/api");
    expect(normalizeFolder("apps\\web\\lib")).toBe("apps/web/lib");
    expect(normalizeFolder("/")).toBe("");
  });

  it("matches whole path segments", () => {
    expect(isUnder("apps/api/src", "apps/api")).toBe(true);
    expect(isUnder("apps/api", "apps/api")).toBe(true);
    expect(isUnder("apps/apix", "apps/api")).toBe(false);
    expect(isUnder("anything", "")).toBe(true);
  });
});

describe("canonical filters", () => {
  it("sorts, deduplicates, and drops empty folders", () => {
    expect(
      normalizeFilters(
        filters({ kinds: ["route", "model", "route"], include: ["./apps/web/", "", "apps/api"] }),
      ),
    ).toEqual(filters({ kinds: ["model", "route"], include: ["apps/api", "apps/web"] }));
  });

  it("counts each toggle and folder once", () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(1);
    expect(
      activeFilterCount(
        filters({
          layers: ["data"],
          confidence: ["heuristic"],
          exclude: ["a", "./a/"],
          include: [" "],
        }),
      ),
    ).toBe(3);
  });

  it("keys by effect: none is empty, equal filters share a key", () => {
    expect(filtersKey(NO_FILTERS)).toBe("");
    expect(filtersKey(filters({ include: [" / "] }))).toBe("");
    expect(filtersKey(filters({ layers: ["data", "external"] }))).toBe(
      filtersKey(filters({ layers: ["external", "data", "external"] })),
    );
    expect(filtersKey(DEFAULT_FILTERS)).not.toBe(filtersKey(filters({ layers: ["data"] })));
  });
});

describe("hiddenNodes", () => {
  it("hides nothing without filters", () => {
    expect(hiddenNodes(index, NO_FILTERS).size).toBe(0);
  });

  it("hides test and config files and test folders, with what's inside them", () => {
    expect([...hiddenNodes(index, DEFAULT_FILTERS)].sort()).toEqual(
      [
        TESTS,
        ORDERS_TEST,
        "symbol:api/src/__tests__/orders.test.ts#createsAnOrder",
        SPEC,
        "symbol:api/src/orders/handlers.spec.ts#listsOrders",
        NEXT_CONFIG,
      ].sort(),
    );
    // The shop demo has none, so the default filters change nothing there.
    expect(hiddenNodes(shop, DEFAULT_FILTERS).size).toBe(0);
  });

  it("hides a layer with everything inside it", () => {
    const hidden = hiddenNodes(shop, filters({ layers: ["backend"] }));
    expect(hidden.has("service:api/")).toBe(true);
    expect(hidden.has(CREATE)).toBe(true);
    expect(hidden.has("model:api/Order")).toBe(true);
    expect(hidden.has("service:web/")).toBe(false);
    expect(hidden.has("datastore:infra/db")).toBe(false);
  });

  it("hides a kind, keeping the files it sat in", () => {
    const hidden = hiddenNodes(shop, filters({ kinds: ["model"] }));
    // The prisma folder held only the schema file, which stays: a file is
    // part of the structure even with nothing drawn inside it.
    expect(hidden.has("model:api/Order")).toBe(true);
    expect(hidden.has("file:api/prisma/schema.prisma")).toBe(false);
    expect(hidden.has("module:api/prisma")).toBe(false);
  });

  it("hides a folder whose files are all hidden, and its parent folder if that empties it", () => {
    const hidden = hiddenNodes(
      shop,
      filters({ exclude: ["apps/web/app/checkout/page.tsx", "apps/web/app/orders"] }),
    );
    expect(hidden.has("module:web/app/checkout")).toBe(true);
    expect(hidden.has("module:web/app/orders")).toBe(true);
    // web/app still has its own page.tsx.
    expect(hidden.has("module:web/app")).toBe(false);
    const all = hiddenNodes(
      shop,
      filters({
        exclude: ["apps/web/app/page.tsx", "apps/web/app/checkout", "apps/web/app/orders"],
      }),
    );
    expect(all.has("module:web/app")).toBe(true);
    expect(all.has("page:web//")).toBe(true);
  });

  it("excludes a folder by whole segments", () => {
    const hidden = hiddenNodes(shop, filters({ exclude: ["apps/api/src/order"] }));
    expect(hidden.size).toBe(0);
  });

  it("includes a folder: its contents, the folders and services above it, and nodes outside any folder", () => {
    const hidden = hiddenNodes(shop, filters({ include: ["apps/api/src/routes"] }));
    const kept = shop.graph.nodes.map((n) => n.id).filter((id) => !hidden.has(id));
    expect(kept.sort()).toEqual(
      [
        "datastore:infra/db",
        "external:ext/api.stripe.com",
        "file:api/src/routes/orders.ts",
        "module:api/src",
        "module:api/src/routes",
        "route:api/GET /api/orders",
        "route:api/POST /api/orders",
        "service:api/",
        "symbol:api/src/routes/orders.ts#orders",
        "system:root",
      ].sort(),
    );
  });

  it("keeps an unresolved call with the folder of the file it's in", () => {
    const cms = "unresolved:web/lib/cms.ts:3:21";
    expect(hiddenNodes(shop, filters({ include: ["apps/web/lib"] })).has(cms)).toBe(false);
    expect(hiddenNodes(shop, filters({ include: ["apps/web/app"] })).has(cms)).toBe(true);
    expect(hiddenNodes(shop, filters({ exclude: ["apps/web/lib/cms.ts"] })).has(cms)).toBe(true);
  });
});

describe("buildView with filters", () => {
  it("leaves hidden nodes off the canvas and their entries out of the service", () => {
    const view = buildView(index, ALL, {
      filters: filters({ kinds: ["route"], hideTestsAndConfig: true }),
    });
    for (const id of [TESTS, ORDERS_TEST, SPEC, NEXT_CONFIG, "route:api/GET /api/orders"]) {
      expect(view.byId.has(id)).toBe(false);
    }
    const service = buildView(index, ["service:api/"], { filters: filters({ kinds: ["route"] }) });
    expect(service.childrenOf.get("service:api/")).toEqual(["module:api/prisma", "module:api/src"]);
  });

  it("drops a hidden node's connections instead of drawing them from its parent", () => {
    const api = ["service:api/", "module:api/src"];
    const unfiltered = lifted(buildView(index, api));
    expect(unfiltered).toContain(
      "calls module:api/src/__tests__ -> module:api/src/orders exact ×1",
    );
    const view = lifted(buildView(index, api, { filters: DEFAULT_FILTERS }));
    expect(view.some((e) => e.includes("__tests__"))).toBe(false);
    // The spec's call sat inside api/src/orders; nothing else changes.
    expect(view).toEqual(unfiltered.filter((e) => !e.includes("__tests__")));
  });

  it("drops connections of a hidden confidence, and recounts what's left", () => {
    expect(
      lifted(buildView(shop, [], { filters: filters({ confidence: ["heuristic"] }) })),
    ).toEqual([
      "external_call service:api/ -> external:ext/api.stripe.com exact ×1",
      "stores service:api/ -> datastore:infra/db exact ×1",
    ]);
    const web = buildView(shop, ["service:web/"], {
      filters: filters({ confidence: ["unresolved"] }),
    });
    expect(lifted(web).some((e) => e.includes("unresolved:"))).toBe(false);
    // The unresolved node itself stays: hiding a confidence hides lines only.
    expect(web.byId.has("unresolved:web/lib/cms.ts:3:21")).toBe(true);
  });

  it("can't open a node with nothing left inside, and doesn't count it open", () => {
    const f = filters({ kinds: ["symbol", "route"] });
    const file = "file:api/src/db.ts";
    const view = buildView(shop, ["service:api/", "module:api/src", file], { filters: f });
    expect(view.byId.get(file)).toMatchObject({ canOpen: false, open: false });
    expect(view.open).toEqual(["module:api/src", "service:api/"]);
    expect([
      ...effectiveOpen(shop, [file, "service:api/", "module:api/src"], hiddenNodes(shop, f)),
    ]).not.toContain(file);
  });

  it("doesn't open a hidden node, and opens it again when the filter is cleared", () => {
    const asked = ["service:api/", "module:api/src", TESTS];
    expect(buildView(index, asked, { filters: DEFAULT_FILTERS }).open).toEqual([
      "module:api/src",
      "service:api/",
    ]);
    expect(buildView(index, asked).open).toContain(TESTS);
  });

  it("records the filters' key, and builds the same view without filters as before", () => {
    expect(buildView(shop, []).filtered).toBe("");
    expect(buildView(shop, [], { filters: DEFAULT_FILTERS }).filtered).toBe(
      filtersKey(DEFAULT_FILTERS),
    );
    const plain = buildView(shop, ALL);
    const none = buildView(shop, ALL, { filters: NO_FILTERS });
    expect(ids(none)).toEqual(ids(plain));
    expect(none.edges).toEqual(plain.edges);
  });
});
