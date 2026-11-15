import type { Machine } from "./report.js";

/**
 * The interactive budget (M11.1): a click on "What depends on this?" answers within RAIL's
 * 100 ms response window, the index's build included when it's the page's first question.
 */
export const IMPACT_BUDGET_MS = 100;

/** One target's measurement: the median of its runs, and what it found. */
export interface ImpactCase {
  target: string;
  kind: string;
  ms: number;
  dependents: number;
  maybe: number;
}

/** Everything the impact benchmark measured. */
export interface ImpactRun {
  date: string;
  repo: { name: string; url: string; sha: string };
  gitinsideSha: string;
  analyzerVersion: string;
  machine: Machine;
  graph: { nodes: number; edges: number };
  /** Building the index from the graph, each run from scratch, in ms (the first is cold). */
  indexMs: number[];
  /** Runs per target (the median is kept). */
  runsPerTarget: number;
  cases: ImpactCase[];
}

/** The `p`th percentile (0–100) of `values` by nearest rank; 0 for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

/** Median of `values` (the lower middle for an even count). */
export const median = (values: readonly number[]): number => percentile(values, 50);

/** The summary a report leads with, and whether it's within budget. */
export function summarize(run: ImpactRun) {
  const times = run.cases.map((c) => c.ms);
  const slowest = Math.max(0, ...times);
  const index = median(run.indexMs);
  return {
    targets: run.cases.length,
    indexMedianMs: index,
    indexMaxMs: Math.max(0, ...run.indexMs),
    queryMedianMs: median(times),
    queryP95Ms: percentile(times, 95),
    queryMaxMs: slowest,
    /** The worst first question: the median index build plus the slowest query. */
    worstFirstMs: index + slowest,
    withinBudget: index + slowest <= IMPACT_BUDGET_MS,
  };
}

const ms = (x: number) => `${x.toFixed(2)} ms`;

/** The report's Markdown: summary, budget verdict, the slowest targets, and per-kind numbers. */
export function renderImpactReport(run: ImpactRun): string {
  const s = summarize(run);
  const byKind = new Map<string, ImpactCase[]>();
  for (const c of run.cases) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
  const slow = [...run.cases]
    .sort((a, b) => b.ms - a.ms || (a.target < b.target ? -1 : 1))
    .slice(0, 10);
  const m = run.machine;
  return [
    `# Impact analysis benchmark: ${run.repo.name}`,
    "",
    `- Date: ${run.date}`,
    `- Repo: [${run.repo.name}](${run.repo.url}) at \`${run.repo.sha}\` (${run.graph.nodes.toLocaleString("en-US")} nodes, ${run.graph.edges.toLocaleString("en-US")} edges)`,
    `- GitInside: \`${run.gitinsideSha}\`, analyzer ${run.analyzerVersion}`,
    `- Machine: ${m.label}, ${m.cpu} (${m.cores} cores), ${m.ramGiB} GiB, ${m.os}, Node ${m.node}`,
    `- Method: \`impactIndex\` built ${run.indexMs.length} times; \`impactOf\` on ${s.targets.toLocaleString("en-US")} targets, ${run.runsPerTarget} runs each (median kept), after one warm-up pass. Node runs the same V8 engine as Chromium, but a visitor's machine may be slower than this one.`,
    "",
    "## Summary",
    "",
    "| | median | p95 | max |",
    "|---|---|---|---|",
    `| Index build | ${ms(s.indexMedianMs)} | | ${ms(s.indexMaxMs)} |`,
    `| One query | ${ms(s.queryMedianMs)} | ${ms(s.queryP95Ms)} | ${ms(s.queryMaxMs)} |`,
    "",
    `Budget: a first question (index build + query) within ${IMPACT_BUDGET_MS} ms. Worst case measured: ${ms(s.worstFirstMs)} (median build + slowest query), **${s.withinBudget ? "within" : "over"} budget**.`,
    "",
    "## Slowest targets",
    "",
    "| Target | Kind | Time | Dependents | May also reach |",
    "|---|---|---|---|---|",
    ...slow.map(
      (c) =>
        `| \`${c.target}\` | ${c.kind} | ${ms(c.ms)} | ${c.dependents.toLocaleString("en-US")} | ${c.maybe.toLocaleString("en-US")} |`,
    ),
    "",
    "## By kind",
    "",
    "| Kind | Targets | Median | Max | Most dependents |",
    "|---|---|---|---|---|",
    ...[...byKind]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([kind, cases]) =>
          `| ${kind} | ${cases.length} | ${ms(median(cases.map((c) => c.ms)))} | ${ms(Math.max(...cases.map((c) => c.ms)))} | ${Math.max(...cases.map((c) => c.dependents)).toLocaleString("en-US")} |`,
      ),
    "",
  ].join("\n");
}
