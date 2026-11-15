// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  edgeId,
  parseGraph,
  SYSTEM_ID,
  type ArchitectureGraph,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { parseRulesConfig, type RulesConfig } from "./config.js";
import {
  evaluateRules,
  evaluateRulesOnDiff,
  RULES_REPORT_FORMAT,
  type RulesReport,
} from "./evaluate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOP = parseGraph(
  JSON.parse(readFileSync(join(HERE, "../../../fixtures/shop-demo/expected.json"), "utf8")),
);
const config = (text: string): RulesConfig => {
  const result = parseRulesConfig(text);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
};
const SHOP_RULES = config(readFileSync(join(HERE, "../fixtures/shop-demo.gitinside.yml"), "utf8"));

const evaluate = (c: RulesConfig, graph: ArchitectureGraph): RulesReport => {
  const result = evaluateRules(c, graph);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.report;
};
const onDiff = (...args: Parameters<typeof evaluateRulesOnDiff>): RulesReport => {
  const result = evaluateRulesOnDiff(...args);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.report;
};

const edge = (
  kind: GraphEdge["kind"],
  from: string,
  to: string,
  file: string,
  line = 1,
): GraphEdge => ({
  id: edgeId(kind, from, to),
  kind,
  from,
  to,
  confidence: "exact",
  sites: [{ file, line, column: 1 }],
});

/** shop-demo with nodes and edges added (and nodes renamed), as a PR's head would be. */
function withChanges(
  graph: ArchitectureGraph,
  change: { nodes?: GraphNode[]; edges?: GraphEdge[]; rename?: Record<string, string> },
): ArchitectureGraph {
  const rename = (id: string): string => change.rename?.[id] ?? id;
  return parseGraph({
    ...graph,
    repo: { ...graph.repo, sha: "b".repeat(40) },
    nodes: [
      ...graph.nodes.map((n) => ({
        ...n,
        id: rename(n.id),
        parentId: n.parentId && rename(n.parentId),
      })),
      ...(change.nodes ?? []),
    ],
    edges: [
      ...graph.edges.map((e) => ({
        ...e,
        id: edgeId(e.kind, rename(e.from), rename(e.to)),
        from: rename(e.from),
        to: rename(e.to),
      })),
      ...(change.edges ?? []),
    ],
  });
}

const LIST = "symbol:web/lib/orders.ts#listOrders";
const PLACE = "symbol:web/lib/orders.ts#placeOrder";
const CREATE = "symbol:api/src/orders/handlers.ts#createOrder";
const ROUTES_FILE = "file:api/src/routes/orders.ts";
const CHARGE = "symbol:api/src/billing/stripe.ts#chargeOrder";

describe("evaluateRules on the shop-demo fixture", () => {
  it("finds the web app's two requests to the API, its unread CMS request, and nothing else", () => {
    const report = evaluate(SHOP_RULES, SHOP);
    expect(report.format).toBe(RULES_REPORT_FORMAT);
    expect(report.repo).toEqual({ owner: "fixtures", name: "shop-demo" });
    expect(report.base).toBeUndefined();
    expect(report.rules).toEqual([
      {
        id: "web-independent-of-api",
        type: "forbid-dependency",
        level: "error",
        violations: 2,
        uncertain: 1,
      },
      {
        id: "routes-skip-billing",
        type: "forbid-dependency",
        level: "error",
        violations: 0,
        uncertain: 0,
      },
      {
        id: "no-service-cycles-3",
        type: "no-service-cycles",
        level: "error",
        violations: 0,
        uncertain: 0,
      },
      {
        id: "only-api-touches-postgres",
        type: "datastore-access",
        level: "error",
        violations: 0,
        uncertain: 0,
      },
      { id: "known-hosts", type: "no-new-hosts", level: "warning", violations: 0, uncertain: 0 },
    ]);
    expect(report.violations).toEqual([
      {
        rule: "web-independent-of-api",
        type: "forbid-dependency",
        level: "error",
        message: "listOrders (web) depends on GET /api/orders (api) through http",
        key: `web-independent-of-api|http|${LIST}|route:api/GET /api/orders`,
        edges: [
          {
            id: edgeId("http", LIST, "route:api/GET /api/orders"),
            kind: "http",
            from: LIST,
            to: "route:api/GET /api/orders",
            confidence: "heuristic",
            sites: [{ file: "apps/web/lib/orders.ts", line: 13, column: 21 }],
          },
        ],
      },
      expect.objectContaining({
        key: `web-independent-of-api|http|${PLACE}|route:api/POST /api/orders`,
      }),
    ]);
    expect(report.uncertain).toEqual([
      expect.objectContaining({
        rule: "web-independent-of-api",
        message:
          "latestPosts (web) has a http edge GitInside couldn't resolve, so it may depend on api",
        edges: [expect.objectContaining({ to: "unresolved:web/lib/cms.ts:3:21" })],
      }),
    ]);
    expect(report.totals).toEqual({ errors: 2, warnings: 0, uncertain: 1 });
  });

  it("gives byte-identical JSON whatever order the graph lists nodes, edges, and sites in", () => {
    const reversed: ArchitectureGraph = {
      ...SHOP,
      nodes: [...SHOP.nodes].reverse(),
      edges: [...SHOP.edges].reverse().map((e) => ({ ...e, sites: [...e.sites].reverse() })),
    };
    const head = withChanges(SHOP, {
      edges: [
        edge("calls", CREATE, LIST, "apps/api/src/orders/handlers.ts", 9),
        edge("calls", LIST, CREATE, "apps/web/lib/orders.ts", 20),
      ],
    });
    const headReversed = {
      ...head,
      nodes: [...head.nodes].reverse(),
      edges: [...head.edges].reverse(),
    };
    expect(JSON.stringify(evaluate(SHOP_RULES, reversed))).toBe(
      JSON.stringify(evaluate(SHOP_RULES, SHOP)),
    );
    expect(JSON.stringify(evaluate(SHOP_RULES, headReversed))).toBe(
      JSON.stringify(evaluate(SHOP_RULES, head)),
    );
  });
});

describe("each rule type", () => {
  it("forbid-dependency: counts only the listed edge kinds, and paths match files' repo paths", () => {
    const head = withChanges(SHOP, {
      edges: [
        edge(
          "imports",
          ROUTES_FILE,
          "file:api/src/billing/stripe.ts",
          "apps/api/src/routes/orders.ts",
          2,
        ),
        // Into billing too, but `handles` isn't one of the rule's kinds (calls, imports).
        edge("handles", "route:api/GET /api/orders", CHARGE, "apps/api/src/routes/orders.ts", 7),
        edge("calls", "route:api/POST /api/orders", CHARGE, "apps/api/src/routes/orders.ts", 8),
      ],
    });
    const found = evaluate(SHOP_RULES, head).violations.filter(
      (v) => v.rule === "routes-skip-billing",
    );
    // Sorted by key: `calls|…` before `imports|…`.
    expect(found.map((v) => v.message)).toEqual([
      "POST /api/orders (routes) depends on chargeOrder (billing) through calls",
      "orders.ts (routes) depends on stripe.ts (billing) through imports",
    ]);
  });

  it("no-service-cycles: finds the two services once each calls the other, with one edge per direction", () => {
    const head = withChanges(SHOP, {
      edges: [edge("calls", CREATE, LIST, "apps/api/src/orders/handlers.ts", 9)],
    });
    const cycles = evaluate(SHOP_RULES, head).violations.filter(
      (v) => v.type === "no-service-cycles",
    );
    expect(cycles).toEqual([
      {
        rule: "no-service-cycles-3",
        type: "no-service-cycles",
        level: "error",
        message: "services @shop/api, @shop/web depend on each other in a cycle",
        key: "no-service-cycles-3|service:api/,service:web/",
        services: ["service:api/", "service:web/"],
        edges: [
          expect.objectContaining({ id: edgeId("calls", CREATE, LIST) }),
          // web → api has two http edges; the smaller ID stands for the pair.
          expect.objectContaining({ id: edgeId("http", LIST, "route:api/GET /api/orders") }),
        ],
      },
    ]);
  });

  it("no-service-cycles: finds a cycle of three, and none on a chain", () => {
    const service = (name: string): GraphNode => ({
      id: `service:${name}/`,
      kind: "service",
      label: name,
      parentId: SYSTEM_ID,
      root: `packages/${name}`,
    });
    const fn = (name: string): GraphNode => ({
      id: `symbol:${name}/x.ts#f`,
      kind: "symbol",
      symbolKind: "function",
      exported: true,
      label: "f",
      parentId: `service:${name}/`,
    });
    const nodes = ["a", "b", "c", "d"].flatMap((n) => [service(n), fn(n)]);
    const call = (a: string, b: string): GraphEdge =>
      edge("calls", `symbol:${a}/x.ts#f`, `symbol:${b}/x.ts#f`, `packages/${a}/x.ts`);
    const graph = (edges: GraphEdge[]): ArchitectureGraph =>
      parseGraph({
        ...SHOP,
        nodes: [SHOP.nodes.find((n) => n.kind === "system"), ...nodes],
        edges,
      });
    const rules = config("version: 1\nrules: [{ type: no-service-cycles }]\n");
    expect(
      evaluate(rules, graph([call("a", "b"), call("b", "c"), call("c", "d")])).violations,
    ).toEqual([]);
    const found = evaluate(
      rules,
      graph([call("a", "b"), call("b", "c"), call("c", "a"), call("c", "d")]),
    );
    expect(found.violations.map((v) => v.services)).toEqual([
      ["service:a/", "service:b/", "service:c/"],
    ]);
    expect(found.violations[0]?.edges.map((e) => e.id)).toEqual(
      [call("a", "b"), call("b", "c"), call("c", "a")].map((e) => e.id).sort(),
    );
  });

  it("datastore-access: a read through a model by code outside `only` is a violation", () => {
    const head = withChanges(SHOP, {
      edges: [edge("reads", LIST, "model:api/Order", "apps/web/lib/orders.ts", 30)],
    });
    expect(
      evaluate(SHOP_RULES, head).violations.filter((v) => v.type === "datastore-access"),
    ).toEqual([
      expect.objectContaining({
        rule: "only-api-touches-postgres",
        message: "listOrders reads db (through Order), which only api may touch",
        key: `only-api-touches-postgres|reads|${LIST}|model:api/Order`,
      }),
    ]);
  });

  it("datastore-access: matches a datastore by name as well as engine, and nothing else", () => {
    const head = withChanges(SHOP, {
      edges: [edge("reads", LIST, "model:api/Order", "apps/web/lib/orders.ts", 30)],
    });
    const rule = (datastore: string): RulesConfig =>
      config(
        `version: 1\nlayers: { api: { services: ["@shop/api"] } }\nrules: [{ type: datastore-access, datastore: "${datastore}", only: [api] }]\n`,
      );
    expect(evaluate(rule("db"), head).violations).toHaveLength(1);
    expect(evaluate(rule("redis"), head).violations).toHaveLength(0);
  });

  it("no-new-hosts: lists hosts off the allow list with the edges calling them", () => {
    const rules = config("version: 1\nrules: [{ type: no-new-hosts, allow: ['*.example.com'] }]\n");
    expect(evaluate(rules, SHOP).violations).toEqual([
      {
        rule: "no-new-hosts-1",
        type: "no-new-hosts",
        level: "error",
        message: "the code calls api.stripe.com, a host not on the rule's allow list",
        key: "no-new-hosts-1|api.stripe.com",
        host: "api.stripe.com",
        edges: [
          expect.objectContaining({
            kind: "external_call",
            from: CHARGE,
            to: "external:ext/api.stripe.com",
          }),
        ],
      },
    ]);
  });
});

describe("evaluateRulesOnDiff", () => {
  const evil: GraphNode = {
    id: "external:ext/evil.example.com",
    kind: "external",
    label: "evil.example.com",
    parentId: SYSTEM_ID,
    host: "evil.example.com",
  };
  const head = withChanges(SHOP, {
    nodes: [evil],
    edges: [
      edge("external_call", CREATE, evil.id, "apps/api/src/orders/handlers.ts", 12),
      edge("calls", CREATE, LIST, "apps/api/src/orders/handlers.ts", 9),
      edge("writes", PLACE, "model:api/Order", "apps/web/lib/orders.ts", 40),
    ],
  });

  it("lists only what the PR introduces, not the base's own violations", () => {
    const report = onDiff(SHOP_RULES, SHOP, head);
    expect(report.base).toEqual({ owner: "fixtures", name: "shop-demo" });
    expect(report.repo).toEqual({ owner: "fixtures", name: "shop-demo", sha: "b".repeat(40) });
    // The web app writing the API's model is also a new dependency of web on api.
    expect(report.violations.map((v) => v.key)).toEqual([
      `web-independent-of-api|writes|${PLACE}|model:api/Order`,
      "no-service-cycles-3|service:api/,service:web/",
      `only-api-touches-postgres|writes|${PLACE}|model:api/Order`,
      "known-hosts|evil.example.com",
    ]);
    expect(report.rules.map((r) => [r.id, r.violations])).toEqual([
      ["web-independent-of-api", 1],
      ["routes-skip-billing", 0],
      ["no-service-cycles-3", 1],
      ["only-api-touches-postgres", 1],
      ["known-hosts", 1],
    ]);
    expect(report.uncertain).toEqual([]);
    expect(report.totals).toEqual({ errors: 3, warnings: 1, uncertain: 0 });
  });

  it("lists nothing for a PR that changes nothing, uncertain edges included", () => {
    const report = onDiff(SHOP_RULES, SHOP, SHOP);
    expect(report.violations).toEqual([]);
    expect(report.uncertain).toEqual([]);
  });

  it("lists a request the PR adds that GitInside couldn't read as uncertain", () => {
    const unread: GraphNode = {
      id: "unresolved:web/lib/orders.ts:50:3",
      kind: "unresolved",
      label: "GET ?",
      parentId: "service:web/",
      reason: "DYNAMIC_URL",
      expression: "fetch(url)",
      source: { file: "apps/web/lib/orders.ts", line: 50, column: 3 },
    };
    const added = withChanges(SHOP, {
      nodes: [unread],
      edges: [
        {
          ...edge("http", PLACE, unread.id, "apps/web/lib/orders.ts", 50),
          confidence: "unresolved",
          reason: "DYNAMIC_URL",
        },
      ],
    });
    const report = onDiff(SHOP_RULES, SHOP, added);
    expect(report.violations).toEqual([]);
    expect(report.uncertain.map((v) => v.key)).toEqual([
      `web-independent-of-api|http|${PLACE}|${unread.id}`,
    ]);
    expect(report.totals.uncertain).toBe(1);
  });

  it("keys a renamed node under its head ID when given the diff, so a moved violation isn't new", () => {
    const moved = "symbol:web/lib/api.ts#listOrders";
    const renamed = withChanges(SHOP, { rename: { [LIST]: moved } });
    // Without the diff the moved request looks new; with it, it's the same violation.
    expect(onDiff(SHOP_RULES, SHOP, renamed).violations.map((v) => v.key)).toEqual([
      `web-independent-of-api|http|${moved}|route:api/GET /api/orders`,
    ]);
    const node = renamed.nodes.find((n) => n.id === moved) as GraphNode;
    expect(
      onDiff(SHOP_RULES, SHOP, renamed, {
        diff: {
          nodes: {
            added: [],
            removed: [],
            modified: [],
            updated: [],
            renamed: [{ from: LIST, node, changes: [] }],
          },
        },
      }).violations,
    ).toEqual([]);
  });

  it("stops at the time budget and says so as a config error, shared by both sides", () => {
    // 100 path globs per layer × shop-demo's nodes is thousands of steps, so the clock is read.
    const globs = Array.from({ length: 100 }, (_, i) => `'x${i}/**'`).join(", ");
    const slow = config(`version: 1\nlayers: { a: { paths: [${globs}] } }\nrules: []\n`);
    let t = 0;
    const now = (): number => (t += 50);
    const expected = {
      ok: false,
      issues: [
        {
          path: "",
          message:
            "the rules took longer than 100 ms to check; use fewer or simpler globs and rules",
        },
      ],
    };
    expect(evaluateRules(slow, SHOP, { budgetMs: 100, now })).toEqual(expected);
    t = 0;
    expect(evaluateRulesOnDiff(slow, SHOP, head, { budgetMs: 100, now })).toEqual(expected);
    // The same work with time to spare finishes.
    expect(evaluateRules(slow, SHOP, { budgetMs: 1_000_000, now }).ok).toBe(true);
  });
});
