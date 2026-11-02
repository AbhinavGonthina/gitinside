import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { analyze, openDiskCache } from "@gitinside/analyzer";
import { stringifyGraph } from "@gitinside/schema";
import { countGraph, type RunResult } from "./report.js";

// One measured `analyze` run. analysis.ts, stress.ts, and incremental.ts spawn this in a
// fresh process per run so peak RSS belongs to that run alone.
// Usage: node run-once.js <dir> <owner> <name> <sha> [--no-file-limit] [--cache <dir>]
// `--no-file-limit` lifts the analyzer's source-file and source-size limits (the stress
// benchmark only). `--cache <dir>` reuses and stores service facts in a disk cache there
// (opening it is timed too: a job pays for it).
// Prints one JSON RunResult line on stdout.

const [dir, owner, name, sha, ...rest] = process.argv.slice(2);
const cacheAt = rest.indexOf("--cache");
const cacheDir = cacheAt >= 0 ? rest[cacheAt + 1] : undefined;
if (!dir || !owner || !name || !sha || (cacheAt >= 0 && !cacheDir)) {
  process.stderr.write(
    "usage: run-once <dir> <owner> <name> <sha> [--no-file-limit] [--cache <dir>]\n",
  );
  process.exit(2);
}

const stages: Record<string, number> = {};
const start = performance.now();
const cache = cacheDir === undefined ? undefined : await openDiskCache(cacheDir);
const graph = await analyze(dir, {
  owner,
  name,
  sha,
  ...(rest.includes("--no-file-limit")
    ? { limits: { maxSourceFiles: Infinity, maxSourceBytes: Infinity } }
    : {}),
  ...(cache ? { cache } : {}),
  onStage: (stage, ms) => {
    stages[stage] = ms;
  },
});
const totalMs = performance.now() - start;

const result: RunResult = {
  totalMs,
  stages,
  ...(cache ? { cache: cache.stats() } : {}),
  // resourceUsage().maxRSS is in kilobytes.
  maxRssBytes: process.resourceUsage().maxRSS * 1024,
  // The heap V8 holds with the graph still alive: a floor for the run's peak heap.
  heapTotalBytes: process.memoryUsage().heapTotal,
  graphSha256: createHash("sha256").update(stringifyGraph(graph)).digest("hex"),
  counts: countGraph(graph),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
