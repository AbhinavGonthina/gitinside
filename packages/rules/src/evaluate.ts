import {
  compareStrings,
  type ArchitectureGraph,
  type Confidence,
  type GraphDiff,
  type GraphEdge,
  type GraphNode,
  type GraphRepo,
} from "@gitinside/schema";
import type { ConfigIssue, RuleLevel, RuleType, RulesConfig, RulesRule } from "./config.js";
import { matchGlob } from "./glob.js";

/**
 * Architecture rules evaluated on a graph, or on a PR's two graphs (M11.3, ADR-0300). Pure and
 * deterministic: the same config and graph give the same report, whatever order the graph lists
 * things in. Reads only the graph; nothing in the repo runs.
 *
 * Handles, per rule type (docs/RULES.md):
 * - `forbid-dependency`: every edge from a node in layer `from` to a node in layer `to`, of the
 *   rule's edge kinds (all by default). A node is in a layer when its service's name matches one
 *   of the layer's `services` globs or its file's repo path matches one of its `paths` globs;
 *   datastores, outside hosts, queues, and unresolved nodes are in no layer.
 * - `no-service-cycles`: services that depend on each other in a cycle (a strongly connected set
 *   of ≥ 2 services over every edge between two services), with one edge per pair as evidence.
 * - `datastore-access`: every read, write, or other edge into a matching datastore, or into a
 *   model it stores, from code outside the `only` layers.
 * - `no-new-hosts`: every outside host not matching `allow`. On a graph that's all of them; on a
 *   PR, only the hosts it adds.
 *
 * Doesn't handle: edges the analyzer couldn't resolve never count as violations; a
 * `forbid-dependency` rule lists the ones leaving its `from` layer as `uncertain` instead, so a
 * request whose URL wasn't read is shown, not judged. Nor do raw SQL queries (`RAW_QUERY`) count
 * against `datastore-access`: which datastore they reach isn't known.
 */

/** Bumped when the report's shape changes. */
export const RULES_REPORT_FORMAT = 1;
/** How long an evaluation may run, in ms, before it's stopped and reported as a config error. */
export const RULES_TIME_BUDGET_MS = 20_000;

/** One edge a violation rests on, with every call site that made it. */
export interface ViolationEdge {
  id: string;
  kind: GraphEdge["kind"];
  from: string;
  to: string;
  confidence: Confidence;
  /** Sorted by file, line, column. */
  sites: { file: string; line: number; column: number }[];
}

/** One broken rule. */
export interface RuleViolation {
  rule: string;
  type: RuleType;
  level: RuleLevel;
  /** One plain sentence saying what's wrong. */
  message: string;
  /** What makes it the same violation on both sides of a PR (see {@link evaluateRulesOnDiff}). */
  key: string;
  /** The edges it rests on, sorted by ID. */
  edges: ViolationEdge[];
  /** `no-service-cycles`: the services in the cycle, sorted. */
  services?: string[];
  /** `no-new-hosts`: the host. */
  host?: string;
}

/** A rule's counts in a report. */
export interface RuleSummary {
  id: string;
  type: RuleType;
  level: RuleLevel;
  violations: number;
  uncertain: number;
}

/** What {@link evaluateRules} and {@link evaluateRulesOnDiff} return. */
export interface RulesReport {
  format: typeof RULES_REPORT_FORMAT;
  /** The graph's repo (a PR's head). */
  repo: GraphRepo;
  /** A PR's base, when the report is of a PR. */
  base?: GraphRepo;
  analyzerVersion: string;
  /** In the config's order. */
  rules: RuleSummary[];
  /** Sorted by rule (config order), then key. On a PR, only those it introduces. */
  violations: RuleViolation[];
  /** Unresolved edges a rule can't judge, shaped like violations. Same order. */
  uncertain: RuleViolation[];
  totals: { errors: number; warnings: number; uncertain: number };
}

/** An evaluation's answer: the report, or why it couldn't finish. */
export type RulesResult = { ok: true; report: RulesReport } | { ok: false; issues: ConfigIssue[] };

/** Options for {@link evaluateRules} and {@link evaluateRulesOnDiff}. */
export interface EvaluateOptions {
  /** The time budget in ms (default {@link RULES_TIME_BUDGET_MS}); shared by a PR's two sides. */
  budgetMs?: number;
  /** The clock, in ms (default `Date.now`); tests pass a fake one. */
  now?: () => number;
}

class OutOfTime extends Error {}

/** Counts work and checks the clock every so often, so a huge config can't hold a job. */
class Clock {
  private steps = 0;
  private readonly deadline: number;
  constructor(
    private readonly now: () => number,
    budgetMs: number,
  ) {
    this.deadline = now() + budgetMs;
  }
  tick(steps = 1): void {
    this.steps += steps;
    if (this.steps < 1024) return;
    this.steps = 0;
    if (this.now() > this.deadline) throw new OutOfTime();
  }
}

/** The pieces of a graph every rule reads, built once. */
interface Indexed {
  graph: ArchitectureGraph;
  byId: Map<string, GraphNode>;
  serviceOf: (id: string) => string | null;
  /** Layer name → IDs of the nodes in it. */
  layers: Map<string, Set<string>>;
}

/** Kinds of node that belong to no layer: they're not code. */
const NOT_CODE = new Set<GraphNode["kind"]>([
  "system",
  "datastore",
  "external",
  "queue",
  "unresolved",
]);

function index(config: RulesConfig, graph: ArchitectureGraph, clock: Clock): Indexed {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const services = new Map<string, string | null>();
  const serviceOf = (id: string): string | null => {
    const chain: string[] = [];
    let at: string | null = id;
    let found: string | null = null;
    while (at !== null) {
      const known = services.get(at);
      if (known !== undefined) {
        found = known;
        break;
      }
      const node = byId.get(at);
      if (node === undefined) break;
      chain.push(at);
      if (node.kind === "service") {
        found = node.id;
        break;
      }
      at = node.parentId;
    }
    for (const c of chain) services.set(c, found);
    return found;
  };

  const layers = new Map<string, Set<string>>();
  for (const layer of config.layers) {
    const members = new Set<string>();
    for (const node of graph.nodes) {
      if (NOT_CODE.has(node.kind)) continue;
      clock.tick(layer.services.length + layer.paths.length);
      const service = serviceOf(node.id);
      const name = service === null ? undefined : byId.get(service)?.label;
      const path = node.kind === "file" || node.kind === "module" ? node.path : node.source?.file;
      if (
        (name !== undefined && layer.services.some((g) => matchGlob(g, name))) ||
        (path !== undefined && layer.paths.some((g) => matchGlob(g, path)))
      )
        members.add(node.id);
    }
    layers.set(layer.name, members);
  }
  return { graph, byId, serviceOf, layers };
}

const bySite = (
  a: { file: string; line: number; column: number },
  b: { file: string; line: number; column: number },
): number => compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;

function evidence(edge: GraphEdge): ViolationEdge {
  return {
    id: edge.id,
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    confidence: edge.confidence,
    sites: edge.sites.map((s) => ({ file: s.file, line: s.line, column: s.column })).sort(bySite),
  };
}

/** Maps a node ID to the ID used in keys (a PR base's renamed node → its head ID). */
type Rename = (id: string) => string;

/** Found violations and uncertain edges of one rule on one graph. */
interface Found {
  violations: RuleViolation[];
  uncertain: RuleViolation[];
}

function label(g: Indexed, id: string): string {
  return g.byId.get(id)?.label ?? id;
}

function forbidDependency(
  rule: Extract<RulesRule, { type: "forbid-dependency" }>,
  g: Indexed,
  rename: Rename,
  clock: Clock,
): Found {
  const from = g.layers.get(rule.from) ?? new Set<string>();
  const to = g.layers.get(rule.to) ?? new Set<string>();
  const kinds = rule.edges === undefined ? undefined : new Set(rule.edges);
  const out: Found = { violations: [], uncertain: [] };
  for (const edge of g.graph.edges) {
    clock.tick();
    if (kinds !== undefined && !kinds.has(edge.kind)) continue;
    if (!from.has(edge.from)) continue;
    const target = g.byId.get(edge.to);
    const base = {
      rule: rule.id,
      type: rule.type,
      level: rule.level,
      key: `${rule.id}|${edge.kind}|${rename(edge.from)}|${rename(edge.to)}`,
      edges: [evidence(edge)],
    };
    // An edge is `unresolved` exactly when its target is an unresolved node (the schema checks).
    if (target?.kind === "unresolved") {
      out.uncertain.push({
        ...base,
        message: `${label(g, edge.from)} (${rule.from}) has a ${edge.kind} edge GitInside couldn't resolve, so it may depend on ${rule.to}`,
      });
    } else if (to.has(edge.to)) {
      out.violations.push({
        ...base,
        message: `${label(g, edge.from)} (${rule.from}) depends on ${label(g, edge.to)} (${rule.to}) through ${edge.kind}`,
      });
    }
  }
  return out;
}

function datastoreAccess(
  rule: Extract<RulesRule, { type: "datastore-access" }>,
  g: Indexed,
  rename: Rename,
  clock: Clock,
): Found {
  const stores = new Set<string>();
  for (const node of g.graph.nodes)
    if (
      node.kind === "datastore" &&
      (matchGlob(rule.datastore, node.label) || matchGlob(rule.datastore, node.engine))
    )
      stores.add(node.id);
  // What reaching the datastore means: the datastore itself, or a model it stores.
  const reaches = new Map<string, string>([...stores].map((id) => [id, id]));
  for (const edge of g.graph.edges)
    if (edge.kind === "stores" && stores.has(edge.to) && edge.confidence !== "unresolved")
      reaches.set(edge.from, edge.to);
  const allowed = rule.only.map((name) => g.layers.get(name) ?? new Set<string>());
  const out: Found = { violations: [], uncertain: [] };
  for (const edge of g.graph.edges) {
    clock.tick();
    if (edge.kind === "stores" || edge.confidence === "unresolved") continue;
    const store = reaches.get(edge.to);
    if (store === undefined || allowed.some((layer) => layer.has(edge.from))) continue;
    const via = store === edge.to ? "" : ` (through ${label(g, edge.to)})`;
    out.violations.push({
      rule: rule.id,
      type: rule.type,
      level: rule.level,
      message: `${label(g, edge.from)} ${edge.kind} ${label(g, store)}${via}, which only ${rule.only.join(", ")} may touch`,
      key: `${rule.id}|${edge.kind}|${rename(edge.from)}|${rename(edge.to)}`,
      edges: [evidence(edge)],
    });
  }
  return out;
}

function noNewHosts(
  rule: Extract<RulesRule, { type: "no-new-hosts" }>,
  g: Indexed,
  clock: Clock,
): Found {
  const into = new Map<string, GraphEdge[]>();
  for (const edge of g.graph.edges) {
    if (edge.confidence === "unresolved") continue;
    const list = into.get(edge.to) ?? [];
    list.push(edge);
    into.set(edge.to, list);
  }
  const out: Found = { violations: [], uncertain: [] };
  const hosts = new Map<string, GraphEdge[]>();
  for (const node of g.graph.nodes) {
    clock.tick(rule.allow.length);
    if (node.kind !== "external" || rule.allow.some((glob) => matchGlob(glob, node.host))) continue;
    hosts.set(node.host, [...(hosts.get(node.host) ?? []), ...(into.get(node.id) ?? [])]);
  }
  for (const [host, edges] of hosts)
    out.violations.push({
      rule: rule.id,
      type: rule.type,
      level: rule.level,
      message: `the code calls ${host}, a host not on the rule's allow list`,
      key: `${rule.id}|${host}`,
      edges: edges.map(evidence),
      host,
    });
  return out;
}

/** Strongly connected sets of ≥ 2 services (Tarjan's algorithm, iterative), each sorted. */
function cycles(adjacency: Map<string, string[]>): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const start of [...adjacency.keys()].sort(compareStrings)) {
    if (order.has(start)) continue;
    const work: { node: string; next: number }[] = [{ node: start, next: 0 }];
    order.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; next: number };
      const targets = adjacency.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const to = targets[frame.next] as string;
        frame.next += 1;
        if (!order.has(to)) {
          order.set(to, counter);
          low.set(to, counter);
          counter += 1;
          stack.push(to);
          onStack.add(to);
          work.push({ node: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.node, Math.min(low.get(frame.node) as number, order.get(to) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined)
        low.set(
          parent.node,
          Math.min(low.get(parent.node) as number, low.get(frame.node) as number),
        );
      if (low.get(frame.node) === order.get(frame.node)) {
        const members: string[] = [];
        for (;;) {
          const top = stack.pop() as string;
          onStack.delete(top);
          members.push(top);
          if (top === frame.node) break;
        }
        if (members.length > 1) out.push(members.sort(compareStrings));
      }
    }
  }
  return out;
}

function noServiceCycles(
  rule: Extract<RulesRule, { type: "no-service-cycles" }>,
  g: Indexed,
  rename: Rename,
  clock: Clock,
): Found {
  // One edge per (service, service) pair as evidence: the smallest edge ID.
  const pairs = new Map<string, Map<string, GraphEdge>>();
  for (const edge of g.graph.edges) {
    clock.tick();
    if (edge.confidence === "unresolved") continue;
    const a = g.serviceOf(edge.from);
    const b = g.serviceOf(edge.to);
    if (a === null || b === null || a === b) continue;
    const row = pairs.get(a) ?? new Map<string, GraphEdge>();
    const known = row.get(b);
    if (known === undefined || compareStrings(edge.id, known.id) < 0) row.set(b, edge);
    pairs.set(a, row);
  }
  const adjacency = new Map<string, string[]>();
  for (const [a, row] of pairs) adjacency.set(a, [...row.keys()].sort(compareStrings));
  const out: Found = { violations: [], uncertain: [] };
  for (const members of cycles(adjacency)) {
    const inside = new Set(members);
    const edges: GraphEdge[] = [];
    for (const a of members)
      for (const [b, edge] of pairs.get(a) ?? []) if (inside.has(b)) edges.push(edge);
    out.violations.push({
      rule: rule.id,
      type: rule.type,
      level: rule.level,
      message: `services ${members.map((id) => label(g, id)).join(", ")} depend on each other in a cycle`,
      key: `${rule.id}|${members.map(rename).sort(compareStrings).join(",")}`,
      edges: edges.map(evidence),
      services: members,
    });
  }
  return out;
}

/** Every rule's findings on one graph, in config order. */
function findAll(
  config: RulesConfig,
  graph: ArchitectureGraph,
  clock: Clock,
  rename: Rename = (id) => id,
): Map<string, Found> {
  const g = index(config, graph, clock);
  const found = new Map<string, Found>();
  for (const rule of config.rules) {
    let result: Found;
    switch (rule.type) {
      case "forbid-dependency":
        result = forbidDependency(rule, g, rename, clock);
        break;
      case "datastore-access":
        result = datastoreAccess(rule, g, rename, clock);
        break;
      case "no-new-hosts":
        result = noNewHosts(rule, g, clock);
        break;
      case "no-service-cycles":
        result = noServiceCycles(rule, g, rename, clock);
        break;
    }
    // Two edges can't share a key within one rule (one edge per kind, from, to), except a host's.
    const byKey = (a: RuleViolation, b: RuleViolation): number => compareStrings(a.key, b.key);
    for (const v of [...result.violations, ...result.uncertain])
      v.edges.sort((a, b) => compareStrings(a.id, b.id));
    found.set(rule.id, {
      violations: result.violations.sort(byKey),
      uncertain: result.uncertain.sort(byKey),
    });
  }
  return found;
}

function report(
  config: RulesConfig,
  graph: ArchitectureGraph,
  found: Map<string, Found>,
  base?: GraphRepo,
): RulesReport {
  const violations: RuleViolation[] = [];
  const uncertain: RuleViolation[] = [];
  const rules: RuleSummary[] = config.rules.map((rule) => {
    const f = found.get(rule.id) ?? { violations: [], uncertain: [] };
    violations.push(...f.violations);
    uncertain.push(...f.uncertain);
    return {
      id: rule.id,
      type: rule.type,
      level: rule.level,
      violations: f.violations.length,
      uncertain: f.uncertain.length,
    };
  });
  return {
    format: RULES_REPORT_FORMAT,
    repo: repoOf(graph.repo),
    ...(base === undefined ? {} : { base: repoOf(base) }),
    analyzerVersion: graph.analyzerVersion,
    rules,
    violations,
    uncertain,
    totals: {
      errors: violations.filter((v) => v.level === "error").length,
      warnings: violations.filter((v) => v.level === "warning").length,
      uncertain: uncertain.length,
    },
  };
}

const repoOf = (repo: GraphRepo): GraphRepo => ({
  owner: repo.owner,
  name: repo.name,
  ...(repo.sha === undefined ? {} : { sha: repo.sha }),
});

function timedOut(budgetMs: number): RulesResult {
  return {
    ok: false,
    issues: [
      {
        path: "",
        message: `the rules took longer than ${budgetMs} ms to check; use fewer or simpler globs and rules`,
      },
    ],
  };
}

/** Evaluates a config's rules on one graph. */
export function evaluateRules(
  config: RulesConfig,
  graph: ArchitectureGraph,
  options: EvaluateOptions = {},
): RulesResult {
  const budgetMs = options.budgetMs ?? RULES_TIME_BUDGET_MS;
  try {
    const clock = new Clock(options.now ?? Date.now, budgetMs);
    return { ok: true, report: report(config, graph, findAll(config, graph, clock)) };
  } catch (error) {
    if (error instanceof OutOfTime) return timedOut(budgetMs);
    throw error;
  }
}

/**
 * The violations a PR introduces: those on `head` whose key isn't among `base`'s, with one config
 * (the caller picks which side's) applied to both. A violation's key is its rule plus what it's
 * about: an edge's kind and endpoints (`forbid-dependency`, `datastore-access`, and `uncertain`
 * edges), a cycle's services, or a host. Pass the PR's `diff` so a base node it renamed or moved
 * keys under its head ID, and a violation that only moved isn't counted as new. A new call site on
 * an edge that already broke the rule isn't new either.
 */
export function evaluateRulesOnDiff(
  config: RulesConfig,
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  options: EvaluateOptions & { diff?: Pick<GraphDiff, "nodes"> } = {},
): RulesResult {
  const budgetMs = options.budgetMs ?? RULES_TIME_BUDGET_MS;
  const renames = new Map((options.diff?.nodes.renamed ?? []).map((r) => [r.from, r.node.id]));
  try {
    const clock = new Clock(options.now ?? Date.now, budgetMs);
    const before = findAll(config, base, clock, (id) => renames.get(id) ?? id);
    const after = findAll(config, head, clock);
    const found = new Map<string, Found>();
    for (const [rule, f] of after) {
      const old = before.get(rule) ?? { violations: [], uncertain: [] };
      const known = new Set(old.violations.map((v) => v.key));
      const knownUncertain = new Set(old.uncertain.map((v) => v.key));
      found.set(rule, {
        violations: f.violations.filter((v) => !known.has(v.key)),
        uncertain: f.uncertain.filter((v) => !knownUncertain.has(v.key)),
      });
    }
    return { ok: true, report: report(config, head, found, base.repo) };
  } catch (error) {
    if (error instanceof OutOfTime) return timedOut(budgetMs);
    throw error;
  }
}
