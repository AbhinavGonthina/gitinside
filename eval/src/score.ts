/**
 * Scores an analyzer graph against a ground-truth label file (docs/EVALUATION.md §1 "Scoring").
 *
 * What counts as a prediction, per call site (`sites` of the graph's edges):
 * - an `http` edge to a `route` node predicts that route;
 * - an `http` edge to an `unresolved` node, or an `external_call` edge to an `external` node,
 *   predicts "no route in the repo" (an abstention).
 * Other edge kinds (imports, calls, Prisma, queues) are not HTTP predictions and are ignored.
 *
 * Matching: a prediction matches a label when the call site agrees (file + line, plus column
 * when the label has one) and the route agrees (registering file + method + path, parameter
 * names ignored, so `:id` and `:postId` are the same segment). Route lines are not compared:
 * the analyzer anchors a route at its method call, the label at the registering statement.
 *
 * Counting:
 * - **True positive:** a route prediction that matches a label's target.
 * - **False positive:** a route prediction at an in-scope site that matches no label: the wrong
 *   route, a route where the label says `null`, or a site with no label at all.
 * - **False negative:** a label with a real target that no prediction matched, whatever was
 *   predicted instead (another route, an unresolved node, an external host, or nothing).
 * - **Abstention:** a `null` label with a non-route prediction and no route prediction at its
 *   site. Counted on its own, never inside precision.
 * - **Missing:** a label with no prediction of any kind at its site (the analyzer dropped the
 *   call), listed so it can't hide inside the false negatives.
 *
 * Predictions outside the label file's `scope` are not scored. Precision and recall are given
 * overall, per repo, and per confidence level; per-level recall is that level's true positives
 * over all positive labels, so the levels add up to the overall recall.
 */
import {
  compareStrings,
  type ArchitectureGraph,
  type Confidence,
  type SourceLocation,
} from "@gitinside/schema";
import {
  compareLocations,
  compareTargets,
  inScope,
  routeKey,
  type LabeledEdge,
  type LabelFile,
  type SourcePoint,
} from "./format.js";

export { routeKey };

/** The confidence levels a route prediction can carry, strongest first. */
export const SCORED_LEVELS = ["exact", "pattern", "heuristic"] as const;
export type ScoredLevel = (typeof SCORED_LEVELS)[number];

/** A route the analyzer predicted: its registering file, line, and `"<METHOD> <path>"`. */
export interface PredictedRoute {
  file: string;
  line: number;
  route: string;
}

/** One prediction at one call site. */
export type Prediction =
  | {
      kind: "route";
      site: SourceLocation;
      confidence: ScoredLevel;
      target: PredictedRoute;
      /** Set when the route is one of several equally good matches (`AMBIGUOUS`). */
      reason?: string;
    }
  | { kind: "unresolved"; site: SourceLocation; reason: string }
  | { kind: "external"; site: SourceLocation; host: string };

/** True and false positives at one confidence level. */
export interface LevelCounts {
  truePositives: number;
  falsePositives: number;
}

/** The raw counts behind one precision/recall pair. */
export interface Counts extends LevelCounts {
  falseNegatives: number;
  /** Labels scored (each label on its own, ADR-0041). */
  labels: number;
  /** Labels with a real target: the recall denominator. */
  positiveLabels: number;
  /** Labels with `target: null`. */
  nullLabels: number;
  /** `null` labels the analyzer correctly left without a route. */
  abstentions: number;
  /** Labels with no prediction at all at their site. */
  missing: number;
  byConfidence: Record<ScoredLevel, LevelCounts>;
}

/** Why a route prediction is a false positive. */
export type FalsePositiveKind = "wrong-route" | "route-for-null-label" | "unlabeled-site";

/** A route prediction that matches no label. */
export interface FalsePositive {
  kind: FalsePositiveKind;
  site: SourceLocation;
  predicted: PredictedRoute;
  confidence: ScoredLevel;
  reason?: string;
  /** The labeled targets at the site (`null` for a `null` label); empty for an unlabeled site. */
  expected: (LabeledEdge["target"] | null)[];
}

/** A labeled real target that no prediction matched. */
export interface FalseNegative {
  callSite: SourcePoint;
  method: LabeledEdge["method"];
  expected: NonNullable<LabeledEdge["target"]>;
  /** What the analyzer predicted at the site instead, in words, sorted; empty for nothing. */
  predicted: string[];
}

/** The score for one repo. */
export interface RepoScore {
  repo: string;
  sha: string;
  counts: Counts;
  /** Sorted by site, then predicted route. */
  falsePositives: FalsePositive[];
  /** Sorted by call site, then expected target. */
  falseNegatives: FalseNegative[];
  /** Labels with no prediction at their site, sorted. */
  missing: LabeledEdge[];
}

/** The score for the whole eval set. */
export interface EvalScore {
  overall: Counts;
  /** Sorted by repo. */
  repos: RepoScore[];
}

/** Thrown when a graph can't be scored against a label file (wrong repo or commit). */
export class ScoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoreError";
  }
}

/** `n / d`, or `null` when nothing was counted (an undefined ratio, never shown as 0 or 100%). */
export function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

/** Precision: true positives over all route predictions. */
export function precision(c: LevelCounts): number | null {
  return ratio(c.truePositives, c.truePositives + c.falsePositives);
}

/** Recall: true positives over all labels with a real target. */
export function recall(c: Counts): number | null {
  return ratio(c.truePositives, c.positiveLabels);
}

/** Whether a predicted site is the labeled call site (column only when the label has one). */
export function siteMatches(label: SourcePoint, site: SourceLocation): boolean {
  return (
    label.file === site.file &&
    label.line === site.line &&
    (label.column === undefined || label.column === site.column)
  );
}

/** Every HTTP prediction in `graph`, one per edge site, sorted by site and then description. */
export function collectPredictions(graph: ArchitectureGraph): Prediction[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Prediction[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "http" && edge.kind !== "external_call") continue;
    const to = nodes.get(edge.to);
    for (const site of edge.sites) {
      if (edge.kind === "http" && to?.kind === "route") {
        out.push({
          kind: "route",
          site,
          confidence: level(edge.confidence),
          target: {
            file: to.source?.file ?? "",
            line: to.source?.line ?? 0,
            route: `${to.method} ${to.path}`,
          },
          ...(edge.reason ? { reason: edge.reason } : {}),
        });
      } else if (to?.kind === "unresolved") {
        out.push({ kind: "unresolved", site, reason: to.reason });
      } else if (edge.kind === "external_call" && to?.kind === "external") {
        out.push({ kind: "external", site, host: to.host });
      }
    }
  }
  return out.sort(
    (a, b) => compareSites(a.site, b.site) || compareStrings(describe(a), describe(b)),
  );
}

/** A route edge's confidence; `parseGraph` guarantees it isn't `unresolved` for a route. */
function level(confidence: Confidence): ScoredLevel {
  if (confidence === "unresolved") {
    throw new ScoreError("an http edge to a route node has confidence 'unresolved'");
  }
  return confidence;
}

function compareSites(a: SourceLocation, b: SourceLocation): number {
  return compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;
}

/** A prediction in words, as listed in reports: `route GET /x (exact)`, `unresolved DYNAMIC_URL`. */
export function describe(p: Prediction): string {
  if (p.kind === "route") {
    const why = p.reason ? `, ${p.reason}` : "";
    return `route ${p.target.route} in ${p.target.file}:${p.target.line} (${p.confidence}${why})`;
  }
  return p.kind === "unresolved" ? `unresolved ${p.reason}` : `external ${p.host}`;
}

function emptyCounts(): Counts {
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    labels: 0,
    positiveLabels: 0,
    nullLabels: 0,
    abstentions: 0,
    missing: 0,
    byConfidence: {
      exact: { truePositives: 0, falsePositives: 0 },
      pattern: { truePositives: 0, falsePositives: 0 },
      heuristic: { truePositives: 0, falsePositives: 0 },
    },
  };
}

/**
 * Score one repo's graph against its label file. Throws `ScoreError` when the graph is for
 * another repo or (when it records one) another commit.
 */
export function scoreRepo(labels: LabelFile, graph: ArchitectureGraph): RepoScore {
  const graphRepo = `${graph.repo.owner}/${graph.repo.name}`;
  if (graphRepo.toLowerCase() !== labels.repo.toLowerCase()) {
    throw new ScoreError(`graph is for ${graphRepo}, labels are for ${labels.repo}`);
  }
  if (graph.repo.sha !== undefined && graph.repo.sha !== labels.sha) {
    throw new ScoreError(
      `graph of ${labels.repo} is at ${graph.repo.sha}, labels are at ${labels.sha}`,
    );
  }

  const counts = emptyCounts();
  const predictions = collectPredictions(graph).filter((p) => inScope(labels.scope, p.site.file));
  const found = new Set<LabeledEdge>();
  const falsePositives: FalsePositive[] = [];
  // Several sites or edges can predict the same route for the same label (two calls on a line
  // the label gives no column for): that is one prediction, counted once, right or wrong.
  const seen = new Set<string>();

  for (const p of predictions) {
    if (p.kind !== "route") continue;
    const atSite = labels.edges.filter((l) => siteMatches(l.callSite, p.site));
    const key = routeKey(p.target.file, p.target.route);
    const hit = atSite.find((l) => l.target && routeKey(l.target.file, l.target.route) === key);
    const column = atSite.some((l) => l.callSite.column === undefined) ? "" : p.site.column;
    const dedupe = hit
      ? `label ${labels.edges.indexOf(hit)}\u0000${key}`
      : `site ${p.site.file}:${p.site.line}:${column}\u0000${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (hit) {
      found.add(hit);
      counts.truePositives++;
      counts.byConfidence[p.confidence].truePositives++;
      continue;
    }
    counts.falsePositives++;
    counts.byConfidence[p.confidence].falsePositives++;
    falsePositives.push({
      kind:
        atSite.length === 0
          ? "unlabeled-site"
          : atSite.some((l) => l.target)
            ? "wrong-route"
            : "route-for-null-label",
      site: p.site,
      predicted: p.target,
      confidence: p.confidence,
      ...(p.reason ? { reason: p.reason } : {}),
      expected: atSite.map((l) => l.target),
    });
  }

  const falseNegatives: FalseNegative[] = [];
  const missing: LabeledEdge[] = [];
  for (const label of labels.edges) {
    counts.labels++;
    const atSite = predictions.filter((p) => siteMatches(label.callSite, p.site));
    if (atSite.length === 0) {
      counts.missing++;
      missing.push(label);
    }
    if (label.target === null) {
      counts.nullLabels++;
      if (atSite.length > 0 && atSite.every((p) => p.kind !== "route")) counts.abstentions++;
      continue;
    }
    counts.positiveLabels++;
    if (found.has(label)) continue;
    counts.falseNegatives++;
    falseNegatives.push({
      callSite: label.callSite,
      method: label.method,
      expected: label.target,
      predicted: [...new Set(atSite.map(describe))].sort(compareStrings),
    });
  }

  falsePositives.sort(
    (a, b) =>
      compareSites(a.site, b.site) ||
      compareStrings(a.predicted.route, b.predicted.route) ||
      compareStrings(a.predicted.file, b.predicted.file),
  );
  falseNegatives.sort(
    (a, b) => compareLocations(a.callSite, b.callSite) || compareTargets(a.expected, b.expected),
  );
  return { repo: labels.repo, sha: labels.sha, counts, falsePositives, falseNegatives, missing };
}

/** Add `b`'s counts into `a`. */
function addCounts(a: Counts, b: Counts): void {
  a.truePositives += b.truePositives;
  a.falsePositives += b.falsePositives;
  a.falseNegatives += b.falseNegatives;
  a.labels += b.labels;
  a.positiveLabels += b.positiveLabels;
  a.nullLabels += b.nullLabels;
  a.abstentions += b.abstentions;
  a.missing += b.missing;
  for (const l of SCORED_LEVELS) {
    a.byConfidence[l].truePositives += b.byConfidence[l].truePositives;
    a.byConfidence[l].falsePositives += b.byConfidence[l].falsePositives;
  }
}

/**
 * Score every repo and total the counts. `runs` pairs each label file with the graph the
 * analyzer produced for it; repos are sorted by name (case-insensitive, like `repos.json`).
 */
export function scoreAll(
  runs: readonly { labels: LabelFile; graph: ArchitectureGraph }[],
): EvalScore {
  const repos = runs
    .map(({ labels, graph }) => scoreRepo(labels, graph))
    .sort((a, b) => compareStrings(a.repo.toLowerCase(), b.repo.toLowerCase()));
  const overall = emptyCounts();
  for (const r of repos) addCounts(overall, r.counts);
  return { overall, repos };
}
