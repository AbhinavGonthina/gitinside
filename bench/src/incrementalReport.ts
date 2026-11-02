import { stat, type Machine, type RunResult, type Stat } from "./report.js";

/**
 * One case of the incremental benchmark: the same tree analyzed with no cache (`cold`) and
 * with a cache filled from the unedited tree, or carried from the previous commit (`warm`).
 * Run `i` of each was made on the same tree, so their graphs must be the same bytes.
 */
export interface IncrementalCase {
  /** What the case measures, e.g. "Nothing changed". */
  title: string;
  /** The file one line was appended to before each pair of runs, if any. */
  edit?: string;
  /** The commits checked out one per pair, oldest first, if the case replays history. */
  commits?: string[];
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
  /** Per commit replayed, oldest first: its cold and warm times and services collected. */
  commits?: { sha: string; coldMs: number; warmMs: number; collected: number }[];
  runs: number;
  cold: Stat;
  warm: Stat;
  /** Warm median over cold median: under 1 is faster. */
  ratio: number;
  /** Per pair, cold time over warm time: over 1 is faster. */
  speedup: Stat;
  coldRss: Stat;
  warmRss: Stat;
  /**
   * Per warm run: entries found under a service's key. A found entry is reused only if the
   * other inputs it recorded (e.g. another service's files it imports) still hold.
   */
  hits: Stat;
  /**
   * Per warm run: entries written, one per service collected rather than reused (bundles
   * with a failed collection are never stored, ADR-0175).
   */
  collected: Stat;
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
  if (c.commits && c.commits.length !== c.cold.length) {
    throw new Error(`"${c.title}": needs one pair of runs per commit`);
  }
  const cold = stat(c.cold.map((r) => r.totalMs));
  const warm = stat(c.warm.map((r) => r.totalMs));
  const pairs = c.cold.map((r, i) => ({ cold: r, warm: c.warm[i] ?? r }));
  return {
    title: c.title,
    ...(c.edit === undefined ? {} : { edit: c.edit }),
    ...(c.commits === undefined
      ? {}
      : {
          commits: c.commits.map((sha, i) => ({
            sha,
            coldMs: pairs[i]?.cold.totalMs ?? 0,
            warmMs: pairs[i]?.warm.totalMs ?? 0,
            collected: pairs[i]?.warm.cache?.writes ?? 0,
          })),
        }),
    runs: c.cold.length,
    cold,
    warm,
    ratio: warm.median / cold.median,
    speedup: stat(pairs.map((p) => p.cold.totalMs / p.warm.totalMs)),
    coldRss: stat(c.cold.map((r) => r.maxRssBytes)),
    warmRss: stat(c.warm.map((r) => r.maxRssBytes)),
    hits: stat(c.warm.map((r) => r.cache?.hits ?? 0)),
    collected: stat(c.warm.map((r) => r.cache?.writes ?? 0)),
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
/** What changed before each pair of a case. */
const changeOf = (c: CaseSummary): string =>
  c.edit !== undefined ? `\`${c.edit}\`` : c.commits ? "each commit's diff (below)" : "none";

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
    cases.some((c) => c.commits)
      ? `- **Method:** ${meta.warmupRuns} cold warm-up run at the pinned SHA, then one cold run there filling a disk fact cache (\`openDiskCache\`). Then each of the ${runs} first-parent commits that follow it on the default branch is checked out in turn (EVALUATION.md §2: the diff of consecutive real commits, applied one at a time) and analyzed twice, each run a fresh Node process: with no cache (cold) and with the cache (warm), in alternating order. The cache is never reset, so each warm run reuses what the previous commit's warm run stored. Opening the cache is part of the warm time.`
      : `- **Method:** ${meta.warmupRuns} cold warm-up run, then one cold run filling a disk fact cache (\`openDiskCache\`) from the unedited tree. Each case then makes ${runs} pairs of runs on the same tree, each run a fresh Node process: one with no cache (cold) and one with the cache (warm), in alternating order. An edit case appends a line declaring a new exported constant, different in each pair, to one file before the pair and restores the file after it, so no warm run finds its own edit in the cache. Opening the cache is part of the warm time.`,
    `- **Machine:** ${m.label}: ${m.cpu} (${m.cores} logical cores), ${m.ramGiB} GiB RAM, ${m.os}, Node ${m.node}`,
    `- **Filling the cache:** ${ms(meta.fill.totalMs)}, ${fillCache ? `${fillCache.writes} entries written, ${mib(fillCache.bytes)} on disk` : "no cache counters"}.`,
    `- **Warm graphs identical to cold:** ${cases.every((c) => c.sameBytes) ? "yes, in every pair" : "**NO**"}`,
    "",
    "## Totals",
    "",
    "Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.",
    "",
    "| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |",
    "|---|---|---:|---:|---:|---:|---:|---|",
    ...cases.map(
      (c) =>
        `| ${c.title} | ${changeOf(c)} | ${spread(c.cold, ms)} | ${spread(c.warm, ms)} | ${percent(c.ratio)} | ${count(c.hits)} | ${count(c.collected)} | ${c.sameBytes ? "yes" : "**NO**"} |`,
    ),
    "",
    ...cases.flatMap((c) =>
      c.commits
        ? [
            `## ${c.title}`,
            "",
            `Median speedup per commit (cold ÷ warm): **${c.speedup.median.toFixed(2)}×** (${c.speedup.min.toFixed(2)}× to ${c.speedup.max.toFixed(2)}×).`,
            "",
            "| Commit | Cold | Warm | Cold ÷ warm | Services collected |",
            "|---|---:|---:|---:|---:|",
            ...c.commits.map(
              (k) =>
                `| [\`${k.sha.slice(0, 10)}\`](${meta.repo.url}/commit/${k.sha}) | ${ms(k.coldMs)} | ${ms(k.warmMs)} | ${(k.coldMs / k.warmMs).toFixed(2)}× | ${k.collected} |`,
            ),
            "",
          ]
        : [],
    ),
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
