import { compareStrings } from "@gitinside/schema";

/** What one `analyze` run in a fresh process measured (printed by run-once.ts). */
export interface RunResult {
  /** Wall-clock milliseconds for the whole `analyze` call. */
  totalMs: number;
  /** Wall-clock milliseconds per pipeline stage. */
  stages: Record<string, number>;
  /** Peak resident set size of the run's process, in bytes. */
  maxRssBytes: number;
  /** SHA-256 of the canonical graph bytes, to check runs agree. */
  graphSha256: string;
  /** Node counts by kind, plus edge and warning totals. */
  counts: Record<string, number>;
}

/** The machine a benchmark ran on (EVALUATION.md §2 asks for CPU, RAM, OS, Node). */
export interface Machine {
  label: string;
  cpu: string;
  cores: number;
  ramGiB: number;
  os: string;
  node: string;
}

/** Everything a report needs besides the runs themselves. */
export interface ReportMeta {
  date: string;
  repo: { name: string; url: string; sha: string };
  gitinsideSha: string;
  analyzerVersion: string;
  warmupRuns: number;
  machine: Machine;
}

/** Median and spread of one measurement across runs. */
export interface Stat {
  median: number;
  min: number;
  max: number;
}

/** Aggregated numbers across the measured runs. */
export interface Summary {
  runs: number;
  totalMs: Stat;
  maxRssBytes: Stat;
  /** Per-stage stats, in pipeline order (the order of the first run's stages). */
  stages: [string, Stat][];
  /** True when every run produced the same graph bytes. */
  identicalGraphs: boolean;
  counts: Record<string, number>;
}

/** Median of a non-empty list (mean of the two middle values for even lengths). */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  // Odd length: both indexes are the middle. Even length: the two middle values.
  const lo = sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
  const hi = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return (lo + hi) / 2;
}

/** Median, min, and max of a non-empty list. */
export function stat(values: readonly number[]): Stat {
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

/** Aggregate measured runs. Throws on an empty list. */
export function summarize(runs: readonly RunResult[]): Summary {
  const first = runs[0];
  if (!first) throw new Error("no runs to summarize");
  return {
    runs: runs.length,
    totalMs: stat(runs.map((r) => r.totalMs)),
    maxRssBytes: stat(runs.map((r) => r.maxRssBytes)),
    stages: Object.keys(first.stages).map((s) => [s, stat(runs.map((r) => r.stages[s] ?? 0))]),
    identicalGraphs: runs.every((r) => r.graphSha256 === first.graphSha256),
    counts: first.counts,
  };
}

const ms = (n: number): string => `${Math.round(n).toLocaleString("en-US")} ms`;
const mib = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MiB`;

/** Render the committed Markdown report. Numbers are printed exactly as measured. */
export function renderReport(meta: ReportMeta, summary: Summary): string {
  const m = meta.machine;
  const lines = [
    `# Analysis benchmark: ${meta.repo.name} (${meta.date})`,
    "",
    `- **Repo:** ${meta.repo.url} at \`${meta.repo.sha}\``,
    `- **Analyzer:** ${meta.analyzerVersion} (gitinside \`${meta.gitinsideSha}\`)`,
    `- **Method:** ${meta.warmupRuns} warm-up run, then ${summary.runs} measured runs, each in a fresh Node process (EVALUATION.md §2).`,
    `- **Machine:** ${m.label}: ${m.cpu} (${m.cores} logical cores), ${m.ramGiB} GiB RAM, ${m.os}, Node ${m.node}`,
    `- **Graphs identical across runs:** ${summary.identicalGraphs ? "yes" : "**NO**"}`,
    "",
    "## Totals",
    "",
    "| Measure | Median | Min | Max |",
    "|---|---:|---:|---:|",
    `| Wall-clock \`analyze\` | ${ms(summary.totalMs.median)} | ${ms(summary.totalMs.min)} | ${ms(summary.totalMs.max)} |`,
    `| Peak RSS | ${mib(summary.maxRssBytes.median)} | ${mib(summary.maxRssBytes.min)} | ${mib(summary.maxRssBytes.max)} |`,
    "",
    "## Per stage",
    "",
    "| Stage | Median | Min | Max |",
    "|---|---:|---:|---:|",
    ...summary.stages.map(([s, v]) => `| ${s} | ${ms(v.median)} | ${ms(v.min)} | ${ms(v.max)} |`),
    "",
    "## Graph size",
    "",
    "| Count | Value |",
    "|---|---:|",
    ...Object.entries(summary.counts)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([k, v]) => `| ${k} | ${v.toLocaleString("en-US")} |`),
    "",
    "Raw per-run numbers are in the JSON file next to this report.",
    "",
  ];
  return lines.join("\n");
}

/** Count nodes and edges by kind (`nodes.<kind>`, `edges.<kind>`), plus a `warnings` total. */
export function countGraph(graph: {
  nodes: readonly { kind: string }[];
  edges: readonly { kind: string }[];
  warnings: readonly unknown[];
}): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  for (const n of graph.nodes) add(`nodes.${n.kind}`);
  for (const e of graph.edges) add(`edges.${e.kind}`);
  counts.warnings = graph.warnings.length;
  return counts;
}
