// The 1-vCPU benchmark (M5.13a3): one cold analysis per fresh container of the worker image,
// started as Cloud Run starts an instance (1 vCPU, 4 GiB with no swap, `/tmp` in memory, the
// image's own user), the repo's tarball piped in and extracted and analyzed by the image's own
// `extractTarball` and sandboxed `runAnalysis` with production's limits and no fact cache (a
// first analysis). This module holds what the driver (cloudrun-bench.ts) and its tests share:
// the `docker run` arguments, the script run inside the container, its output's parser, and
// the report.

/** The repo and commit a benchmark analyzes. */
export interface CloudRunTarget {
  owner: string;
  repo: string;
  sha: string;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * Check a target from the command line (the workflow passes its inputs through): GitHub-style
 * owner and repo names and a full 40-character commit SHA. Throws on anything else.
 */
export function checkTarget(target: CloudRunTarget): CloudRunTarget {
  for (const [what, value] of [
    ["owner", target.owner],
    ["repo", target.repo],
  ] as const) {
    if (!NAME.test(value) || value === "." || value === "..") {
      throw new Error(`bad ${what}: ${JSON.stringify(value)}`);
    }
  }
  if (!SHA.test(target.sha))
    throw new Error(`bad sha (need 40 hex): ${JSON.stringify(target.sha)}`);
  return target;
}

/** Cloud Run's instance (infra/gcp/service.json): 1 vCPU, 4 GiB, no swap, `/tmp` in memory. */
export const INSTANCE = { cpus: "1", memory: "4g" } as const;

/**
 * Parse `--semi-space`: comma-separated semi-space caps in MiB, `default` for V8's own
 * (M5.13a5). Runs cycle through them in order, so each is measured on the same runner.
 * Returns `undefined` for `default`. Throws on anything but `default` or 1–256.
 */
export function parseSemiSpaces(text: string): (number | undefined)[] {
  return text.split(",").map((part) => {
    const value = part.trim();
    if (value === "default") return undefined;
    const mb = Number(value);
    if (!/^\d+$/.test(value) || mb < 1 || mb > 256) {
      throw new Error(`bad --semi-space value: ${JSON.stringify(value)}`);
    }
    return mb;
  });
}

/**
 * The `docker run` arguments for one run: a fresh container (removed on exit) reading the
 * tarball on stdin, Cloud Run's resources, the variables it sets, and `node` running
 * {@link CONTAINER_SCRIPT} as the image's own user in its own working directory. With
 * `semiSpaceMb`, the analysis child gets that semi-space cap; production's other limits stay.
 */
export function dockerRunArgs(
  image: string,
  target: CloudRunTarget,
  semiSpaceMb?: number,
): string[] {
  return [
    "run",
    "--rm",
    "--interactive",
    "--cpus",
    INSTANCE.cpus,
    "--memory",
    INSTANCE.memory,
    "--memory-swap",
    INSTANCE.memory,
    "--mount",
    "type=tmpfs,destination=/tmp,tmpfs-mode=1777",
    "--env",
    "PORT=8080",
    "--env",
    "K_SERVICE=gitinside-worker",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    CONTAINER_SCRIPT,
    JSON.stringify(checkTarget(target)),
    ...(semiSpaceMb === undefined ? [] : [String(semiSpaceMb)]),
  ];
}

/**
 * Runs inside the container: extract stdin into a job folder under `/tmp/jobs` as job.ts does
 * (top folder stripped, production's limits), analyze it with the sandboxed child (production's
 * heap and time caps, no cache; a semi-space cap when the second argument gives one), hash the
 * graph, and print one JSON line with the timings, the
 * child's stats, the analyzer steps as they arrived, and the container's cgroup readings
 * (`memory.peak` counts the in-memory `/tmp` too, as Cloud Run's instance limit does).
 */
export const CONTAINER_SCRIPT = `
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { extractTarball } from "./dist/extract.js";
import { runAnalysis } from "./dist/runner.js";
const target = JSON.parse(process.argv[1]);
const semiSpaceMb = process.argv[2] === undefined ? undefined : Number(process.argv[2]);
const cgroup = async (name) => {
  try { return (await readFile("/sys/fs/cgroup/" + name, "utf8")).trim(); } catch { return null; }
};
await mkdir("/tmp/jobs", { recursive: true });
const dir = await mkdtemp("/tmp/jobs/bench-");
try {
  const src = dir + "/src";
  const out = dir + "/architecture.json";
  let start = performance.now();
  const extracted = await extractTarball(process.stdin, src);
  const extractMs = Math.round(performance.now() - start);
  const steps = [];
  start = performance.now();
  const result = await runAnalysis(
    { src, out, owner: target.owner, name: target.repo, sha: target.sha },
    {
      ...(semiSpaceMb === undefined ? {} : { limits: { semiSpaceMb } }),
      onProgress: ({ step }) => steps.push({ step, atMs: Math.round(performance.now() - start) }),
    },
  );
  const graphSha256 = result.ok
    ? createHash("sha256").update(await readFile(out)).digest("hex")
    : null;
  console.log(JSON.stringify({
    node: process.version,
    semiSpaceMb: semiSpaceMb ?? null,
    cpu: cpus()[0]?.model.trim() ?? "unknown",
    hostCores: cpus().length,
    extract: {
      files: extracted.files,
      directories: extracted.directories,
      tarBytes: extracted.tarBytes,
      skipped: extracted.skipped.length,
      ms: extractMs,
    },
    result,
    graphSha256,
    steps,
    cgroup: {
      cpuMax: await cgroup("cpu.max"),
      cpuStat: await cgroup("cpu.stat"),
      memoryMax: await cgroup("memory.max"),
      memoryPeak: await cgroup("memory.peak"),
    },
  }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
`;

/** The child's stats, as the worker's runner returns them (protocol.ts `AnalysisStats`). */
export interface RunStats {
  files: number;
  nodes: number;
  edges: number;
  unresolved: number;
  warnings: number;
  graphBytes: number;
  stageMs: Record<string, number>;
  peakRssBytes?: number;
  heapBytes?: number;
  /** Main-thread collector pauses in ms by kind (M5.13a5); absent before it. */
  gcMs?: Record<string, number>;
}

/** What one container printed, plus the driver's own wall clock around `docker run`. */
export interface ContainerRun {
  node: string;
  /** The child's semi-space cap in MiB; null (or absent, before M5.13a5) for V8's own. */
  semiSpaceMb?: number | null;
  cpu: string;
  hostCores: number;
  extract: { files: number; directories: number; tarBytes: number; skipped: number; ms: number };
  result:
    | { ok: true; durationMs: number; stats: RunStats }
    | { ok: false; code: string; message: string; durationMs: number; stderrTail: string };
  graphSha256: string | null;
  steps: { step: string; atMs: number }[];
  cgroup: {
    cpuMax: string | null;
    cpuStat: string | null;
    memoryMax: string | null;
    memoryPeak: string | null;
  };
  /** From `docker run` to the container's exit, measured outside it (container start included). */
  containerMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * Parse a container's stdout: its last non-empty line must be {@link CONTAINER_SCRIPT}'s JSON
 * (anything printed before it is ignored). Throws with the output's end when it isn't.
 */
export function parseContainerRun(stdout: string, containerMs: number): ContainerRun {
  const line = stdout
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .at(-1);
  const fail = (why: string): never => {
    throw new Error(`container output ${why}: ${stdout.slice(-500)}`);
  };
  let value: unknown;
  try {
    value = JSON.parse(line ?? "");
  } catch {
    return fail("isn't JSON");
  }
  if (!isRecord(value)) return fail("isn't an object");
  const { node, cpu, hostCores, extract, result, graphSha256, steps, cgroup, semiSpaceMb } = value;
  if (typeof node !== "string" || typeof cpu !== "string" || !isCount(hostCores)) {
    return fail("has no machine");
  }
  if (semiSpaceMb !== undefined && semiSpaceMb !== null && !isCount(semiSpaceMb)) {
    return fail("has a bad semi-space");
  }
  if (
    !isRecord(extract) ||
    !["files", "directories", "tarBytes", "skipped", "ms"].every((k) => isCount(extract[k]))
  ) {
    return fail("has no extraction");
  }
  if (!isRecord(result) || typeof result.ok !== "boolean" || !isCount(result.durationMs)) {
    return fail("has no result");
  }
  if (result.ok) {
    const stats = result.stats;
    if (
      !isRecord(stats) ||
      !isRecord(stats.stageMs) ||
      !Object.values(stats.stageMs).every(isCount)
    ) {
      return fail("has no stage times");
    }
    if (
      stats.gcMs !== undefined &&
      (!isRecord(stats.gcMs) || !Object.values(stats.gcMs).every(isCount))
    ) {
      return fail("has bad collector pauses");
    }
  } else if (typeof result.code !== "string") {
    return fail("has a failure without a code");
  }
  if (!isText(graphSha256)) return fail("has a bad graph hash");
  if (
    !Array.isArray(steps) ||
    !steps.every((s) => isRecord(s) && typeof s.step === "string" && isCount(s.atMs))
  ) {
    return fail("has bad steps");
  }
  if (
    !isRecord(cgroup) ||
    !["cpuMax", "cpuStat", "memoryMax", "memoryPeak"].every((k) => isText(cgroup[k]))
  ) {
    return fail("has no cgroup readings");
  }
  return { ...(value as unknown as Omit<ContainerRun, "containerMs">), containerMs };
}

/** cgroup v2's `cpu.stat` (`usage_usec 123` per line) as numbers by key. */
export function parseCpuStat(text: string | null): Record<string, number> {
  const stat: Record<string, number> = {};
  for (const line of (text ?? "").split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key !== undefined && value !== undefined && /^\d+$/.test(value)) stat[key] = Number(value);
  }
  return stat;
}

/** cgroup v2's `cpu.max` (`quota period`, or `max period`) as vCPUs; null when unlimited or unread. */
export function cpuLimit(text: string | null): number | null {
  const [quota, period] = (text ?? "").trim().split(/\s+/);
  if (
    quota === undefined ||
    period === undefined ||
    !/^\d+$/.test(quota) ||
    !/^\d+$/.test(period)
  ) {
    return null;
  }
  return Number(quota) / Number(period);
}

/** The middle value (the mean of the two middle ones for an even count); null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Everything a report needs besides the runs. */
export interface CloudRunMeta {
  date: string;
  target: CloudRunTarget;
  gitinsideSha: string;
  analyzerVersion: string;
  /** Where the driver ran, e.g. "GitHub Actions ubuntu-latest". */
  host: string;
  image: { compressedBytes: number };
  download: { compressedBytes: number; ms: number };
  /** The time budget the report compares with (DESIGN.md §9), in ms. */
  budgetMs: number;
}

const MIB = 1024 * 1024;
const count = (n: number): string => Math.round(n).toLocaleString("en-US");
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const mib = (bytes: number | undefined): string =>
  bytes === undefined ? "n/a" : `${count(bytes / MIB)} MiB`;
const cgroupBytes = (text: string | null): number | undefined =>
  text !== null && /^\d+$/.test(text) ? Number(text) : undefined;
const semiSpace = (run: ContainerRun): string =>
  run.semiSpaceMb == null ? "default" : `${run.semiSpaceMb} MiB`;
/** All collector pauses and the minor ones, in ms; undefined before M5.13a5. */
const pauses = (stats: RunStats | undefined): { total: number; minor: number } | undefined =>
  stats?.gcMs === undefined
    ? undefined
    : {
        total: Object.values(stats.gcMs).reduce((sum, ms) => sum + ms, 0),
        minor: stats.gcMs.minor ?? 0,
      };
const pausesText = (gc: { total: number; minor: number } | undefined): string =>
  gc === undefined ? "n/a" : `${seconds(gc.total)} (${seconds(gc.minor)})`;

/** Render the Markdown report. Numbers are printed exactly as measured. */
export function renderCloudRunReport(meta: CloudRunMeta, runs: readonly ContainerRun[]): string {
  const { owner, repo, sha } = meta.target;
  const first = runs[0];
  const ok = runs.flatMap((r) =>
    r.result.ok ? [{ run: r, stats: r.result.stats, ms: r.result.durationMs }] : [],
  );
  const hashes = new Set(ok.map((r) => r.run.graphSha256));
  const stages = [...new Set(ok.flatMap((r) => Object.keys(r.stats.stageMs)))];
  const medianAnalysis = median(ok.map((r) => r.ms));
  const configs = [...new Set(runs.map(semiSpace))];
  const limits = [...new Set(runs.map((r) => cpuLimit(r.cgroup.cpuMax)))];

  const lines: string[] = [
    `# 1-vCPU analysis benchmark: ${owner}/${repo} (${meta.date})`,
    "",
    `- **Repo:** https://github.com/${owner}/${repo} at \`${sha}\``,
    `- **Analyzer:** ${meta.analyzerVersion} (gitinside \`${meta.gitinsideSha}\`)`,
    `- **Method:** the worker image (\`apps/worker/Dockerfile\`, ${(meta.image.compressedBytes / 1e6).toFixed(1)} MB gzipped) started ${runs.length === 1 ? "once" : `${runs.length} times`}, a fresh container per run, as Cloud Run starts an instance: \`docker run --cpus ${INSTANCE.cpus} --memory ${INSTANCE.memory} --memory-swap ${INSTANCE.memory}\`, \`/tmp\` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's \`extractTarball\` under \`/tmp/jobs\`, then the image's sandboxed \`runAnalysis\` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.`,
    `- **Host:** ${meta.host}: ${first?.cpu ?? "unknown"} (${first?.hostCores ?? "?"} host cores; the container's cgroup allows ${limits.map((l) => (l === null ? "unlimited" : `${l} vCPU`)).join(" / ")}), Node ${first?.node ?? "?"} in the image`,
    `- **Tarball:** ${mib(meta.download.compressedBytes)} gzipped (${(meta.download.compressedBytes / 1e6).toFixed(1)} MB), downloaded in ${seconds(meta.download.ms)}; ${first === undefined ? "" : `${mib(first.extract.tarBytes)} unpacked, ${count(first.extract.files)} files`}`,
    ...(ok.length < 2
      ? []
      : [`- **Graphs identical across runs:** ${hashes.size === 1 ? "yes" : "**NO**"}`]),
    "",
    "## Runs",
    "",
    "| Run | Semi-space | Container | Extraction | Analysis | GC pauses (minor) | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...runs.map((r, i) => {
      const cpu = parseCpuStat(r.cgroup.cpuStat);
      const used = cpu.usage_usec === undefined ? "n/a" : seconds(cpu.usage_usec / 1000);
      const throttled =
        cpu.throttled_usec === undefined ? "n/a" : seconds(cpu.throttled_usec / 1000);
      const analysis = r.result.ok
        ? seconds(r.result.durationMs)
        : `**${r.result.code}** after ${seconds(r.result.durationMs)}`;
      const stats = r.result.ok ? r.result.stats : undefined;
      return `| ${i + 1} | ${semiSpace(r)} | ${seconds(r.containerMs)} | ${seconds(r.extract.ms)} | ${analysis} | ${pausesText(pauses(stats))} | ${mib(stats?.peakRssBytes)} | ${mib(stats?.heapBytes)} | ${mib(cgroupBytes(r.cgroup.memoryPeak))} | ${used} | ${throttled} |`;
    }),
    "",
  ];
  const against = (ms: number): string =>
    ms <= meta.budgetMs ? "within" : `**${seconds(ms - meta.budgetMs)} over**`;
  if (configs.length > 1) {
    // Several semi-space caps on one runner (M5.13a5): a median per cap, never one over all.
    lines.push(
      `## By semi-space cap (runs alternate between them; DESIGN.md §9's budget is ≤ ${seconds(meta.budgetMs)})`,
      "",
      "| Semi-space | Finished runs | Median analysis | Against the budget | Median GC pauses (minor) | Median final heap (child) | Median container memory peak |",
      "|---|---:|---:|---|---:|---:|---:|",
      ...configs.map((config) => {
        const mine = ok.filter((r) => semiSpace(r.run) === config);
        const analysis = median(mine.map((r) => r.ms));
        const gc = mine.flatMap((r) => pauses(r.stats) ?? []);
        const middle = (values: number[]): number | undefined => median(values) ?? undefined;
        const total = middle(gc.map((g) => g.total));
        const minor = middle(gc.map((g) => g.minor));
        const heap = middle(mine.flatMap((r) => r.stats.heapBytes ?? []));
        const peak = middle(mine.flatMap((r) => cgroupBytes(r.run.cgroup.memoryPeak) ?? []));
        return `| ${config} | ${mine.length} | ${analysis === null ? "n/a" : seconds(analysis)} | ${analysis === null ? "n/a" : against(analysis)} | ${total === undefined || minor === undefined ? "n/a" : pausesText({ total, minor })} | ${mib(heap)} | ${mib(peak)} |`;
      }),
      "",
    );
  } else {
    lines.push(
      medianAnalysis === null
        ? "No run finished, so there is no median."
        : `**Median analysis: ${seconds(medianAnalysis)}** over ${ok.length} finished run${ok.length === 1 ? "" : "s"}, against DESIGN.md §9's ≤ ${seconds(meta.budgetMs)} for a 5k-file repo: ${against(medianAnalysis)}.`,
      "",
    );
  }
  if (ok.length > 0) {
    lines.push(
      "## Stages",
      "",
      `| Stage | ${ok.map((r) => `Run ${runs.indexOf(r.run) + 1}${configs.length > 1 ? ` (${semiSpace(r.run)})` : ""}`).join(" | ")} | Median |`,
      `|---|${ok.map(() => "---:|").join("")}---:|`,
      ...stages.map((stage) => {
        const values = ok.map((r) => r.stats.stageMs[stage]);
        const known = values.filter((v): v is number => v !== undefined);
        return `| ${stage} | ${values.map((v) => (v === undefined ? "n/a" : seconds(v))).join(" | ")} | ${seconds(median(known) ?? 0)} |`;
      }),
      "",
    );
    const stats = ok[0]?.stats;
    if (stats !== undefined) {
      lines.push(
        `Graph (run 1): ${count(stats.files)} files, ${count(stats.nodes)} nodes, ${count(stats.edges)} edges, ${count(stats.unresolved)} unresolved, ${count(stats.warnings)} warnings, ${mib(stats.graphBytes)} serialized.`,
        "",
      );
    }
  }
  lines.push("Raw numbers are in the JSON file next to this report.", "");
  return lines.join("\n");
}
