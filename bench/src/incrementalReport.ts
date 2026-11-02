import { stat, type Machine, type RunResult, type Stat } from "./report.js";

/**
 * One case of the incremental benchmark: the same tree analyzed with no cache (`cold`) and
 * with a cache filled from the unedited tree (`warm`). Run `i` of each was made on the same
 * tree, so their graphs must be the same bytes.
 */
export interface IncrementalCase {
  /** What the case measures, e.g. "Nothing changed". */
  title: string;
  /** The file one line was appended to before each pair of runs, if any. */
  edit?: string;
  cold: RunResult[];
  warm: RunResult[];
}

/** Everything the report needs besides the cases. */
export interface IncrementalMeta {
  date: string;
  repo: { name: string; url: string; sha: string };
  gitinsideSha: string;
  analyzerVersion: string;
  warmupRuns: number;
  machine: Machine;
  /** The cold run that filled the cache from the unedited tree. */
  fill: RunResult;
}

/** One case's numbers. */
export interface CaseSummary {
  title: string;
  edit?: string;
  runs: number;
  cold: Stat;
  warm: Stat;
  /** Warm median over cold median: under 1 is faster. */
  ratio: number;
  coldRss: Stat;
  warmRss: Stat;
  /** Per warm run: entries the cache answered (services reused) and didn't (collected). */
  hits: Stat;
  misses: Stat;
  /** True when every warm run gave its cold run's graph bytes. */
  sameBytes: boolean;
  /** Median milliseconds per stage, in pipeline order (the first cold run's). */
  coldStages: [string, number][];
  warmStages: [string, number][];
}

/** Median ms per stage over `runs`, in the order of the first run's stages. */
function stageMedians(runs: readonly RunResult[]): [string, number][] {
  const first = runs[0];
  if (!first) return [];
  return Object.keys(first.stages).map((s) => [s, stat(runs.map((r) => r.stages[s] ?? 0)).median]);
}

/** Summarize one case. Throws when it has no runs or the cold and warm counts differ. */
export function summarizeCase(c: IncrementalCase): CaseSummary {
  if (c.cold.length === 0 || c.cold.length !== c.warm.length) {
    throw new Error(`"${c.title}": needs the same non-zero number of cold and warm runs`);
  }
  const cold = stat(c.cold.map((r) => r.totalMs));
  const warm = stat(c.warm.map((r) => r.totalMs));
  return {
    title: c.title,
    ...(c.edit === undefined ? {} : { edit: c.edit }),
    runs: c.cold.length,
    cold,
    warm,
    ratio: warm.median / cold.median,
    coldRss: stat(c.cold.map((r) => r.maxRssBytes)),
    warmRss: stat(c.warm.map((r) => r.maxRssBytes)),
    hits: stat(c.warm.map((r) => r.cache?.hits ?? 0)),
    misses: stat(c.warm.map((r) => r.cache?.misses ?? 0)),
    sameBytes: c.warm.every((r, i) => r.graphSha256 === c.cold[i]?.graphSha256),
    coldStages: stageMedians(c.cold),
    warmStages: stageMedians(c.warm),
  };
}

const ms = (n: number): string => `${Math.round(n).toLocaleString("en-US")} ms`;
const mib = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MiB`;
const spread = (s: Stat, f: (n: number) => string): string =>
  `${f(s.median)} (${f(s.min)} to ${f(s.max)})`;
/** A count's median, with its range when the runs differ. */
const count = (s: Stat): string =>
  s.min === s.max ? String(s.median) : `${s.median} (${s.min} to ${s.max})`;
const percent = (ratio: number): string => `${(ratio * 100).toFixed(0)}%`;

/** Render the committed Markdown report. Numbers are printed exactly as measured. */
export function renderIncrementalReport(meta: IncrementalMeta, cases: CaseSummary[]): string {
  const m = meta.machine;
  const runs = cases[0]?.runs ?? 0;
  const fillCache = meta.fill.cache;
  const stageNames = cases[0]?.coldStages.map(([s]) => s) ?? [];
  const lines = [
    `# Incremental analysis benchmark: ${meta.repo.name} (${meta.date})`,
    "",
    `- **Repo:** ${meta.repo.url} at \`${meta.repo.sha}\``,
    `- **Analyzer:** ${meta.analyzerVersion} (gitinside \`${meta.gitinsideSha}\`)`,
    `- **Method:** ${meta.warmupRuns} cold warm-up run, then one cold run filling a disk fact cache (\`openDiskCache\`) from the unedited tree. Each case then makes ${runs} pairs of runs on the same tree, each run a fresh Node process: one with no cache (cold) and one with the cache (warm), in alternating order. An edit case appends a line declaring a new exported constant, different in each pair, to one file before the pair and restores the file after it, so no warm run finds its own edit in the cache. Opening the cache is part of the warm time.`,
    `- **Machine:** ${m.label}: ${m.cpu} (${m.cores} logical cores), ${m.ramGiB} GiB RAM, ${m.os}, Node ${m.node}`,
    `- **Filling the cache:** ${ms(meta.fill.totalMs)}, ${fillCache ? `${fillCache.writes} entries written, ${mib(fillCache.bytes)} on disk` : "no cache counters"}.`,
    `- **Warm graphs identical to cold:** ${cases.every((c) => c.sameBytes) ? "yes, in every pair" : "**NO**"}`,
    "",
    "## Totals",
    "",
    "Median wall-clock `analyze` time, with the range over the runs.",
    "",
    "| Case | Edited file | Cold | Warm | Warm ÷ cold | Cache hits / misses | Same bytes |",
    "|---|---|---:|---:|---:|---:|---|",
    ...cases.map(
      (c) =>
        `| ${c.title} | ${c.edit === undefined ? "none" : `\`${c.edit}\``} | ${spread(c.cold, ms)} | ${spread(c.warm, ms)} | ${percent(c.ratio)} | ${count(c.hits)} / ${count(c.misses)} | ${c.sameBytes ? "yes" : "**NO**"} |`,
    ),
    "",
    "## Peak RSS",
    "",
    "| Case | Cold | Warm |",
    "|---|---:|---:|",
    ...cases.map((c) => `| ${c.title} | ${spread(c.coldRss, mib)} | ${spread(c.warmRss, mib)} |`),
    "",
    "## Per stage",
    "",
    "Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.",
    "",
    `| Stage | ${cases.flatMap((c) => [`${c.title}: cold`, `${c.title}: warm`]).join(" | ")} |`,
    `|---|${cases.map(() => "---:|---:|").join("")}`,
    ...stageNames.map((s) => {
      const cell = (stages: [string, number][]): string => {
        const found = stages.find(([n]) => n === s);
        return found ? ms(found[1]) : "not reported";
      };
      const cells = cases.flatMap((c) => [cell(c.coldStages), cell(c.warmStages)]);
      return `| ${s} | ${cells.join(" | ")} |`;
    }),
    "",
    "Raw per-run numbers are in the JSON file next to this report.",
    "",
  ];
  return lines.join("\n");
}
