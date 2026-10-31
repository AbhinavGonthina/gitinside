import { compareStrings } from "@gitinside/schema";
import type { Machine, RunResult } from "./report.js";

/** Downloading the repo's tarball the way the worker does (`openTarball`). */
export interface DownloadResult {
  /** Bytes of the gzipped tarball as GitHub sent it. */
  compressedBytes: number;
  ms: number;
}

/** Extracting it with the worker's `extractTarball`, its size and entry limits lifted. */
export interface ExtractionResult {
  /** Length of the decompressed tar stream, the number `LIMIT_SIZE` checks. */
  tarBytes: number;
  /** Entries counted against `LIMIT_ENTRIES`: files, folders, and skipped entries. */
  entries: number;
  files: number;
  directories: number;
  skipped: number;
  ms: number;
}

/** The analyzer's inventory of the extracted tree, its file limit lifted. */
export interface InventoryResult {
  /** Files kept for analysis (any extension). */
  files: number;
  /** Kept source files, the number `LIMIT_FILES` checks. */
  sourceFiles: number;
  warnings: number;
  ms: number;
}

/** One uncapped `analyze` run in a fresh process: its result, or how it failed. */
export type StressRun =
  | { ok: true; result: RunResult }
  | { ok: false; error: string; wallMs: number };

/** The production limits a repo meets in pipeline order, read from the worker and analyzer. */
export interface ProductionLimits {
  /** Extraction's `maxBytes` (`LIMIT_SIZE`). */
  maxTarBytes: number;
  /** Extraction's `maxEntries` (`LIMIT_ENTRIES`). */
  maxEntries: number;
  /** The analyzer's `maxSourceFiles` (`LIMIT_FILES`). */
  maxSourceFiles: number;
  /** The analysis child's `--max-old-space-size` in MB (`LIMIT_MEMORY`). */
  maxHeapMb: number;
  /** The analysis child's time limit (`LIMIT_TIME`). */
  timeoutMs: number;
}

/** Everything a stress report needs besides the measurements. */
export interface StressMeta {
  date: string;
  repo: { name: string; url: string; sha: string };
  gitinsideSha: string;
  analyzerVersion: string;
  /** The `--max-old-space-size` the uncapped runs got, in MB. */
  heapMb: number;
  machine: Machine;
  limits: ProductionLimits;
}

/** What the stress benchmark measured. */
export interface StressData {
  download: DownloadResult;
  extraction: ExtractionResult;
  inventory: InventoryResult;
  runs: StressRun[];
}

/** One production limit against what was measured. `over` is null when it can't be told. */
export interface LimitCheck {
  code: string;
  where: string;
  limit: string;
  measured: string;
  over: boolean | null;
}

const MIB = 1024 * 1024;
const count = (n: number): string => Math.round(n).toLocaleString("en-US");
const ms = (n: number): string => `${count(n)} ms`;
const mib = (n: number): string => `${count(n / MIB)} MiB`;
const megabytes = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

/** Seconds or minutes, for durations the reader compares with a 5-minute limit. */
export function duration(n: number): string {
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  return seconds === 60 ? `${minutes + 1} min 0 s` : `${minutes} min ${seconds} s`;
}

/** Each stage with the time since `analyze` started when it ended, in pipeline order. */
export function stageTimeline(stages: Record<string, number>): [string, number, number][] {
  let end = 0;
  return Object.entries(stages).map(([name, took]) => {
    end += took;
    return [name, took, end];
  });
}

/** The stage that would still be running at `atMs`, or null if every stage ended before it. */
export function stageAt(stages: Record<string, number>, atMs: number): string | null {
  return stageTimeline(stages).find(([, , end]) => end > atMs)?.[0] ?? null;
}

/** The first successful run, the one the limit checks use. */
function firstOk(runs: readonly StressRun[]): RunResult | null {
  for (const run of runs) if (run.ok) return run.result;
  return null;
}

/**
 * Check each production limit against the measurements, in the order a job meets them:
 * extraction (size, entries), the inventory (files), then the analysis child (memory, time).
 *
 * Memory is checked against peak RSS and the heap left when `analyze` returned: RSS at or
 * under the cap means the heap stayed under it, a final heap over it means the peak passed
 * it, and anything between can't be told from these numbers (`over: null`).
 */
export function checkLimits(limits: ProductionLimits, data: StressData): LimitCheck[] {
  const run = firstOk(data.runs);
  const heapCap = limits.maxHeapMb * MIB;
  const checks: LimitCheck[] = [
    {
      code: "LIMIT_SIZE",
      where: "extraction",
      limit: mib(limits.maxTarBytes),
      measured: mib(data.extraction.tarBytes),
      over: data.extraction.tarBytes > limits.maxTarBytes,
    },
    {
      code: "LIMIT_ENTRIES",
      where: "extraction",
      limit: count(limits.maxEntries),
      measured: count(data.extraction.entries),
      over: data.extraction.entries > limits.maxEntries,
    },
    {
      code: "LIMIT_FILES",
      where: "inventory",
      limit: `${count(limits.maxSourceFiles)} source files`,
      measured: `${count(data.inventory.sourceFiles)} source files`,
      over: data.inventory.sourceFiles > limits.maxSourceFiles,
    },
  ];
  if (run === null) {
    checks.push(
      {
        code: "LIMIT_MEMORY",
        where: "analysis",
        limit: `${count(limits.maxHeapMb)} MB heap`,
        measured: "no run finished",
        over: null,
      },
      {
        code: "LIMIT_TIME",
        where: "analysis",
        limit: duration(limits.timeoutMs),
        measured: "no run finished",
        over: null,
      },
    );
    return checks;
  }
  const heap = run.heapTotalBytes ?? 0;
  checks.push(
    {
      code: "LIMIT_MEMORY",
      where: "analysis",
      limit: `${count(limits.maxHeapMb)} MB heap`,
      measured: `peak RSS ${mib(run.maxRssBytes)}, final heap ${mib(heap)}`,
      over: heap > heapCap ? true : run.maxRssBytes <= heapCap ? false : null,
    },
    {
      code: "LIMIT_TIME",
      where: "analysis",
      limit: duration(limits.timeoutMs),
      measured: duration(run.totalMs),
      over: run.totalMs > limits.timeoutMs,
    },
  );
  return checks;
}

const verdict = (over: boolean | null): string =>
  over === null ? "can't tell" : over ? "**over**" : "within";

/**
 * The report's "first limit hit" line. Steps run one after another, so the earliest step with
 * a limit passed is known; within a step (size and entries while extracting, memory and time
 * while analyzing) the limits are checked together and the benchmark doesn't measure which
 * one a capped job would reach first, so all of that step's are named.
 */
function firstHit(checks: readonly LimitCheck[]): string {
  const first = checks.find((c) => c.over === true);
  if (first === undefined) return "**First limit hit in production:** none of the limits above.";
  const codes = checks
    .filter((c) => c.where === first.where && c.over === true)
    .map((c) => `\`${c.code}\``);
  return codes.length === 1
    ? `**First limit hit in production:** ${codes.join("")}, during ${first.where}.`
    : `**First limit hit in production:** ${codes.join(" or ")}, during ${first.where}, whichever the job reaches first (these numbers don't say which).`;
}

/** Render the committed Markdown report. Numbers are printed exactly as measured. */
export function renderStressReport(meta: StressMeta, data: StressData): string {
  const m = meta.machine;
  const checks = checkLimits(meta.limits, data);
  const run = firstOk(data.runs);
  const okRuns = data.runs.filter((r) => r.ok);
  const identical =
    okRuns.length < 2
      ? null
      : okRuns.every((r) => r.result.graphSha256 === okRuns[0]?.result.graphSha256);
  const { download: d, extraction: x, inventory: inv } = data;

  const lines = [
    `# Stress benchmark: ${meta.repo.name} (${meta.date})`,
    "",
    `- **Repo:** ${meta.repo.url} at \`${meta.repo.sha}\``,
    `- **Analyzer:** ${meta.analyzerVersion} (gitinside \`${meta.gitinsideSha}\`)`,
    `- **Method:** the repo's tarball downloaded like the worker does, extracted with the worker's extractor, then analyzed ${data.runs.length === 1 ? "once" : `${data.runs.length} times`} in a fresh Node process per run, with production's limits lifted (size, entries, source files; heap ${count(meta.heapMb)} MB instead of ${count(meta.limits.maxHeapMb)} MB; no time limit). Parse only: nothing in the repo is installed or run.`,
    `- **Machine:** ${m.label}: ${m.cpu} (${m.cores} logical cores), ${m.ramGiB} GiB RAM, ${m.os}, Node ${m.node}`,
    ...(identical === null
      ? []
      : [`- **Graphs identical across runs:** ${identical ? "yes" : "**NO**"}`]),
    "",
    "## Production limits",
    "",
    "| Limit | Checked during | Production limit | Measured | Verdict |",
    "|---|---|---:|---:|---|",
    ...checks.map(
      (c) => `| \`${c.code}\` | ${c.where} | ${c.limit} | ${c.measured} | ${verdict(c.over)} |`,
    ),
    "",
    firstHit(checks),
    "",
    "## Download and extraction",
    "",
    "| Measure | Value |",
    "|---|---:|",
    `| Tarball (gzipped) | ${mib(d.compressedBytes)} (${megabytes(d.compressedBytes)}) |`,
    `| Download time | ${ms(d.ms)} |`,
    `| Decompressed tar stream | ${mib(x.tarBytes)} (${megabytes(x.tarBytes)}) |`,
    `| Entries (files + folders + skipped) | ${count(x.entries)} |`,
    `| Files written | ${count(x.files)} |`,
    `| Folders | ${count(x.directories)} |`,
    `| Skipped (links, special, unsupported names) | ${count(x.skipped)} |`,
    `| Extraction time | ${ms(x.ms)} |`,
    "",
    "## Inventory",
    "",
    "| Measure | Value |",
    "|---|---:|",
    `| Files kept | ${count(inv.files)} |`,
    `| Source files (\`LIMIT_FILES\` counts these) | ${count(inv.sourceFiles)} |`,
    `| Skip warnings | ${count(inv.warnings)} |`,
    `| Time | ${ms(inv.ms)} |`,
    "",
    "## Analysis",
    "",
    ...data.runs.map((r, i) =>
      r.ok
        ? `- Run ${i + 1}: ${ms(r.result.totalMs)} (${duration(r.result.totalMs)}), peak RSS ${mib(r.result.maxRssBytes)}, final heap ${mib(r.result.heapTotalBytes ?? 0)}`
        : `- Run ${i + 1}: **failed** after ${ms(r.wallMs)}: ${r.error}`,
    ),
    "",
  ];

  if (run !== null) {
    const atLimit = stageAt(run.stages, meta.limits.timeoutMs);
    lines.push(
      `Per stage (run ${data.runs.findIndex((r) => r.ok) + 1}); "Ended at" is the time since \`analyze\` started:`,
      "",
      "| Stage | Took | Ended at |",
      "|---|---:|---:|",
      ...stageTimeline(run.stages).map(
        ([s, took, end]) => `| ${s} | ${ms(took)} | ${duration(end)} |`,
      ),
      "",
      atLimit === null
        ? `Every stage ended within the ${duration(meta.limits.timeoutMs)} limit.`
        : `At the ${duration(meta.limits.timeoutMs)} limit the \`${atLimit}\` stage was running.`,
      "",
      "## Graph size",
      "",
      "| Count | Value |",
      "|---|---:|",
      ...Object.entries(run.counts)
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([k, v]) => `| ${k} | ${count(v)} |`),
      "",
    );
  }
  lines.push("Raw numbers are in the JSON file next to this report.", "");
  return lines.join("\n");
}
