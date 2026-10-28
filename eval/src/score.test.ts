import {
  edgeId,
  parseGraph,
  SCHEMA_VERSION,
  type ArchitectureGraph,
  type Confidence,
  type GraphEdge,
  type GraphNode,
  type HttpMethod,
  type SourceLocation,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import type { LabeledEdge, LabelFile } from "./format.js";
import {
  collectPredictions,
  describe as describePrediction,
  precision,
  ratio,
  recall,
  routeKey,
  scoreAll,
  scoreRepo,
  ScoreError,
  siteMatches,
} from "./score.js";

const SHA = "a".repeat(40);
const CALLER = "symbol:web/src/api.ts#load";

/** A route registered in `api/src/server.ts` at `line`. */
interface RouteSpec {
  method: HttpMethod;
  path: string;
  line: number;
  file?: string;
}

function routeId(r: RouteSpec): string {
  return `route:api/${r.method} ${r.path}`;
}

/** A schema-valid graph of a web service calling routes of an api service. */
function graph(opts: {
  routes?: RouteSpec[];
  edges?: GraphEdge[];
  extraNodes?: GraphNode[];
  sha?: string | null;
  repo?: string;
}): ArchitectureGraph {
  const [owner = "", name = ""] = (opts.repo ?? "acme/shop").split("/");
  const nodes: GraphNode[] = [
    { id: "system:root", kind: "system", label: "shop", parentId: null },
    { id: "service:web/", kind: "service", label: "web", parentId: "system:root", root: "web" },
    { id: "service:api/", kind: "service", label: "api", parentId: "system:root", root: "api" },
    {
      id: "file:web/src/api.ts",
      kind: "file",
      label: "api.ts",
      parentId: "service:web/",
      path: "web/src/api.ts",
      hash: "0".repeat(64),
    },
    {
      id: "file:api/src/server.ts",
      kind: "file",
      label: "server.ts",
      parentId: "service:api/",
      path: "api/src/server.ts",
      hash: "1".repeat(64),
    },
    {
      id: CALLER,
      kind: "symbol",
      label: "load",
      parentId: "file:web/src/api.ts",
      symbolKind: "function",
      exported: true,
    },
    ...(opts.routes ?? []).map(
      (r): GraphNode => ({
        id: routeId(r),
        kind: "route",
        label: `${r.method} ${r.path}`,
        parentId: "file:api/src/server.ts",
        method: r.method,
        path: r.path,
        source: { file: r.file ?? "api/src/server.ts", line: r.line, column: 5 },
      }),
    ),
    ...(opts.extraNodes ?? []),
  ];
  return parseGraph({
    schemaVersion: SCHEMA_VERSION,
    repo: { owner, name, ...(opts.sha === null ? {} : { sha: opts.sha ?? SHA }) },
    analyzerVersion: "0.1.0",
    nodes,
    edges: opts.edges ?? [],
    warnings: [],
  });
}

function at(line: number, column = 10, file = "web/src/api.ts"): SourceLocation {
  return { file, line, column };
}

function http(
  route: RouteSpec,
  sites: SourceLocation[],
  confidence: Confidence = "exact",
  reason?: "AMBIGUOUS",
): GraphEdge {
  const to = routeId(route);
  return {
    id: edgeId("http", CALLER, to),
    kind: "http",
    from: CALLER,
    to,
    confidence,
    ...(reason ? { reason } : {}),
    sites,
  };
}

function unresolvedAt(site: SourceLocation, reason: "DYNAMIC_URL" | "NO_MATCHING_ROUTE") {
  const id = `unresolved:web/${site.file}:${site.line}:${site.column}`;
  const node: GraphNode = {
    id,
    kind: "unresolved",
    label: "fetch(url)",
    parentId: "service:web/",
    reason,
    expression: "fetch(url)",
  };
  const edge: GraphEdge = {
    id: edgeId("http", CALLER, id),
    kind: "http",
    from: CALLER,
    to: id,
    confidence: "unresolved",
    reason,
    sites: [site],
  };
  return { node, edge };
}

function externalAt(sites: SourceLocation[], host = "api.github.com") {
  const id = `external:ext/${host}`;
  const node: GraphNode = { id, kind: "external", label: host, parentId: "system:root", host };
  const edge: GraphEdge = {
    id: edgeId("external_call", CALLER, id),
    kind: "external_call",
    from: CALLER,
    to: id,
    confidence: "exact",
    sites,
  };
  return { node, edge };
}

function label(
  line: number,
  target: RouteSpec | null,
  extra: Partial<LabeledEdge["callSite"]> = {},
): LabeledEdge {
  return {
    callSite: { file: "web/src/api.ts", line, ...extra },
    method: target && target.method !== "ALL" ? target.method : "GET",
    target: target
      ? {
          file: target.file ?? "api/src/server.ts",
          line: target.line + 1,
          route: `${target.method} ${target.path}`,
        }
      : null,
  };
}

function labels(edges: LabeledEdge[], scope = ["."], repo = "acme/shop"): LabelFile {
  return { repo, sha: SHA, labeler: "claude-draft", reviewedBy: null, scope, edges };
}

const users: RouteSpec = { method: "GET", path: "/api/users", line: 3 };
const user: RouteSpec = { method: "GET", path: "/api/users/:id", line: 4 };
const me: RouteSpec = { method: "GET", path: "/api/users/me", line: 5 };
const create: RouteSpec = { method: "POST", path: "/api/users", line: 6 };

describe("helpers", () => {
  it("ratio is null for an empty denominator", () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
    expect(precision({ truePositives: 0, falsePositives: 0 })).toBeNull();
  });

  it("routeKey ignores parameter names but not methods, literals, or files", () => {
    expect(routeKey("a.ts", "GET /x/:id")).toBe(routeKey("a.ts", "GET /x/:postId"));
    expect(routeKey("a.ts", "GET /x/*slug")).toBe(routeKey("a.ts", "GET /x/*path"));
    expect(routeKey("a.ts", "GET /x/:id")).not.toBe(routeKey("a.ts", "GET /x/*id"));
    expect(routeKey("a.ts", "GET /x/:id")).not.toBe(routeKey("a.ts", "POST /x/:id"));
    expect(routeKey("a.ts", "GET /x/me")).not.toBe(routeKey("a.ts", "GET /x/:id"));
    expect(routeKey("a.ts", "GET /x")).not.toBe(routeKey("b.ts", "GET /x"));
  });

  it("siteMatches compares the column only when the label has one", () => {
    const site = at(7, 12);
    expect(siteMatches({ file: "web/src/api.ts", line: 7 }, site)).toBe(true);
    expect(siteMatches({ file: "web/src/api.ts", line: 7, column: 12 }, site)).toBe(true);
    expect(siteMatches({ file: "web/src/api.ts", line: 7, column: 3 }, site)).toBe(false);
    expect(siteMatches({ file: "web/src/api.ts", line: 8 }, site)).toBe(false);
    expect(siteMatches({ file: "web/src/x.ts", line: 7 }, site)).toBe(false);
  });
});

describe("collectPredictions", () => {
  it("reads routes, unresolved nodes, and external hosts per site, ignoring other edges", () => {
    const u = unresolvedAt(at(9), "DYNAMIC_URL");
    const x = externalAt([at(2)]);
    const g = graph({
      routes: [users, user],
      extraNodes: [u.node, x.node],
      edges: [
        http(users, [at(1), at(8)]),
        http(user, [at(1, 30)], "pattern", "AMBIGUOUS"),
        u.edge,
        x.edge,
        {
          id: edgeId("handles", routeId(users), CALLER),
          kind: "handles",
          from: routeId(users),
          to: CALLER,
          confidence: "exact",
          sites: [at(3, 1, "api/src/server.ts")],
        },
      ],
    });
    expect(collectPredictions(g).map(describePrediction)).toEqual([
      "route GET /api/users in api/src/server.ts:3 (exact)",
      "route GET /api/users/:id in api/src/server.ts:4 (pattern, AMBIGUOUS)",
      "external api.github.com",
      "route GET /api/users in api/src/server.ts:3 (exact)",
      "unresolved DYNAMIC_URL",
    ]);
  });

  it("refuses a route edge marked unresolved (only reachable without parseGraph)", () => {
    const g = graph({ routes: [users], edges: [http(users, [at(1)])] });
    const broken = {
      ...g,
      edges: g.edges.map((e) => ({ ...e, confidence: "unresolved" as const })),
    };
    expect(() => collectPredictions(broken)).toThrow(ScoreError);
  });
});

describe("scoreRepo", () => {
  it("counts a matching route as a true positive at its confidence", () => {
    const g = graph({ routes: [users, user], edges: [http(user, [at(1)], "pattern")] });
    // The label spells the parameter differently and gives the statement's line, not the call's.
    const score = scoreRepo(labels([label(1, { ...user, path: "/api/users/:userId" })]), g);
    expect(score.counts).toMatchObject({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      labels: 1,
      positiveLabels: 1,
    });
    expect(score.counts.byConfidence.pattern).toEqual({ truePositives: 1, falsePositives: 0 });
    expect(precision(score.counts)).toBe(1);
    expect(recall(score.counts)).toBe(1);
    expect(score.falsePositives).toEqual([]);
    expect(score.falseNegatives).toEqual([]);
  });

  it("classifies false positives: wrong route, route for a null label, unlabeled site", () => {
    const g = graph({
      routes: [users, user, me],
      edges: [http(user, [at(1), at(2), at(3)], "heuristic"), http(me, [at(1)], "exact")],
    });
    const score = scoreRepo(labels([label(1, me), label(2, null)]), g);
    expect(score.counts).toMatchObject({
      truePositives: 1,
      falsePositives: 3,
      falseNegatives: 0,
      nullLabels: 1,
      abstentions: 0,
    });
    expect(score.counts.byConfidence).toEqual({
      exact: { truePositives: 1, falsePositives: 0 },
      pattern: { truePositives: 0, falsePositives: 0 },
      heuristic: { truePositives: 0, falsePositives: 3 },
    });
    expect(score.falsePositives.map((f) => [f.kind, f.site.line, f.expected.length])).toEqual([
      ["wrong-route", 1, 1],
      ["route-for-null-label", 2, 1],
      ["unlabeled-site", 3, 0],
    ]);
    expect(score.falsePositives[1]?.expected).toEqual([null]);
    expect(precision(score.counts)).toBe(0.25);
  });

  it("lists what was predicted instead for each false negative", () => {
    const u = unresolvedAt(at(2), "NO_MATCHING_ROUTE");
    const x = externalAt([at(3)]);
    const g = graph({
      routes: [users, user, me],
      extraNodes: [u.node, x.node],
      edges: [http(user, [at(1)]), u.edge, x.edge],
    });
    const score = scoreRepo(labels([label(1, me), label(2, users), label(3, users)]), g);
    expect(score.counts).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 3 });
    expect(recall(score.counts)).toBe(0);
    expect(
      score.falseNegatives.map((f) => [f.callSite.line, f.expected.route, f.predicted]),
    ).toEqual([
      [1, "GET /api/users/me", ["route GET /api/users/:id in api/src/server.ts:4 (exact)"]],
      [2, "GET /api/users", ["unresolved NO_MATCHING_ROUTE"]],
      [3, "GET /api/users", ["external api.github.com"]],
    ]);
  });

  it("counts null labels with only non-route predictions as abstentions", () => {
    const u = unresolvedAt(at(1), "DYNAMIC_URL");
    const x = externalAt([at(2)]);
    const g = graph({ extraNodes: [u.node, x.node], edges: [u.edge, x.edge] });
    const score = scoreRepo(labels([label(1, null), label(2, null)]), g);
    expect(score.counts).toMatchObject({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      nullLabels: 2,
      abstentions: 2,
      missing: 0,
    });
    expect(precision(score.counts)).toBeNull();
    expect(recall(score.counts)).toBeNull();
  });

  it("reports labels with no prediction at their site as missing", () => {
    const g = graph({ routes: [users] });
    const score = scoreRepo(labels([label(1, users), label(2, null)]), g);
    expect(score.counts).toMatchObject({ falseNegatives: 1, missing: 2, abstentions: 0 });
    expect(score.missing.map((l) => l.callSite.line)).toEqual([1, 2]);
    expect(score.falseNegatives[0]?.predicted).toEqual([]);
  });

  it("scores each label of a multi-route call site on its own (ADR-0041)", () => {
    const g = graph({ routes: [users, me], edges: [http(users, [at(1)])] });
    const score = scoreRepo(labels([label(1, users), label(1, me)]), g);
    expect(score.counts).toMatchObject({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 1,
      labels: 2,
      positiveLabels: 2,
    });
    expect(recall(score.counts)).toBe(0.5);
  });

  it("uses label columns to tell apart calls on one line", () => {
    const g = graph({
      routes: [users, create],
      edges: [http(users, [at(1, 5)]), http(create, [at(1, 40)])],
    });
    const score = scoreRepo(
      labels([label(1, users, { column: 5 }), label(1, create, { column: 40 })]),
      g,
    );
    expect(score.counts).toMatchObject({ truePositives: 2, falsePositives: 0 });
    const swapped = scoreRepo(
      labels([label(1, create, { column: 5 }), label(1, users, { column: 40 })]),
      g,
    );
    expect(swapped.counts).toMatchObject({
      truePositives: 0,
      falsePositives: 2,
      falseNegatives: 2,
    });
  });

  it("counts the same route predicted twice for one label once, right or wrong (M3 review)", () => {
    const g = graph({ routes: [users, user], edges: [http(users, [at(1, 5), at(1, 40)])] });
    const hit = scoreRepo(labels([label(1, users)]), g);
    expect(hit.counts).toMatchObject({ truePositives: 1, falsePositives: 0 });
    // The label names the line only, so both sites are the same labeled call: one wrong answer.
    const g2 = graph({ routes: [users, user], edges: [http(user, [at(1, 5), at(1, 40)])] });
    const miss = scoreRepo(labels([label(1, users)]), g2);
    expect(miss.counts).toMatchObject({ falsePositives: 1, falseNegatives: 1 });
    // With columns, or with no label at all, the two sites are two calls: two wrong answers.
    const columns = scoreRepo(
      labels([label(1, users, { column: 5 }), label(1, users, { column: 40 })]),
      g2,
    );
    expect(columns.counts.falsePositives).toBe(2);
    const unlabeled = scoreRepo(labels([label(2, users)]), g2);
    expect(unlabeled.counts.falsePositives).toBe(2);
  });

  it("compares the registering file", () => {
    const other: RouteSpec = { ...users, file: "api/src/legacy.ts" };
    const g = graph({ routes: [other], edges: [http(other, [at(1)])] });
    const score = scoreRepo(labels([label(1, users)]), g);
    expect(score.counts).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1 });
  });

  it("ignores predictions outside the scope", () => {
    const g = graph({
      routes: [users],
      edges: [http(users, [at(1), at(4, 10, "scripts/seed.ts")])],
    });
    const score = scoreRepo(labels([label(1, users)], ["web"]), g);
    expect(score.counts).toMatchObject({ truePositives: 1, falsePositives: 0 });
  });

  it("sorts false positives and false negatives", () => {
    const g = graph({
      routes: [users, user, me, create],
      edges: [http(me, [at(5), at(2)]), http(user, [at(5)])],
    });
    const score = scoreRepo(labels([label(2, create), label(5, users), label(5, create)]), g);
    expect(score.falsePositives.map((f) => `${f.site.line} ${f.predicted.route}`)).toEqual([
      "2 GET /api/users/me",
      "5 GET /api/users/:id",
      "5 GET /api/users/me",
    ]);
    expect(score.falseNegatives.map((f) => `${f.callSite.line} ${f.expected.route}`)).toEqual([
      "2 POST /api/users",
      "5 GET /api/users",
      "5 POST /api/users",
    ]);
  });

  it("refuses a graph of another repo or commit", () => {
    expect(() => scoreRepo(labels([]), graph({ repo: "acme/other" }))).toThrow(
      /graph is for acme\/other/,
    );
    expect(() => scoreRepo(labels([]), graph({ sha: "b".repeat(40) }))).toThrow(ScoreError);
    expect(() => scoreRepo(labels([]), graph({ repo: "Acme/Shop", sha: null }))).not.toThrow();
  });
});

describe("scoreAll", () => {
  it("totals counts across repos and sorts repos case-insensitively", () => {
    const a = graph({ repo: "zeta/app", routes: [users], edges: [http(users, [at(1)])] });
    const b = graph({
      repo: "Beta/app",
      routes: [users, me],
      edges: [http(me, [at(1)], "heuristic")],
    });
    const result = scoreAll([
      { labels: labels([label(1, users)], ["."], "zeta/app"), graph: a },
      { labels: labels([label(1, users), label(2, null)], ["."], "Beta/app"), graph: b },
    ]);
    expect(result.repos.map((r) => r.repo)).toEqual(["Beta/app", "zeta/app"]);
    expect(result.overall).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      labels: 3,
      positiveLabels: 2,
      nullLabels: 1,
      missing: 1,
    });
    expect(result.overall.byConfidence.exact).toEqual({ truePositives: 1, falsePositives: 0 });
    expect(result.overall.byConfidence.heuristic).toEqual({ truePositives: 0, falsePositives: 1 });
    expect(precision(result.overall)).toBe(0.5);
    expect(recall(result.overall)).toBe(0.5);
  });

  it("is deterministic: the same inputs give identical output", () => {
    const g = graph({ routes: [users, me], edges: [http(me, [at(1), at(3)])] });
    const run = () => JSON.stringify(scoreAll([{ labels: labels([label(1, users)]), graph: g }]));
    expect(run()).toBe(run());
  });
});
