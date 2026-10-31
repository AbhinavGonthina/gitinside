import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { analyze } from "@gitinside/analyzer";
import { stringifyGraph } from "@gitinside/schema";
import { countGraph, type RunResult } from "./report.js";

// One measured `analyze` run. analysis.ts and stress.ts spawn this in a fresh process per run
// so peak RSS belongs to that run alone.
// Usage: node run-once.js <dir> <owner> <name> <sha> [--no-file-limit]
// `--no-file-limit` lifts the analyzer's 20,000 source-file limit (the stress benchmark only).
// Prints one JSON RunResult line on stdout.

const [dir, owner, name, sha, ...rest] = process.argv.slice(2);
if (!dir || !owner || !name || !sha) {
  process.stderr.write("usage: run-once <dir> <owner> <name> <sha> [--no-file-limit]\n");
  process.exit(2);
}

const stages: Record<string, number> = {};
const start = performance.now();
const graph = await analyze(dir, {
  owner,
  name,
  sha,
  ...(rest.includes("--no-file-limit") ? { limits: { maxSourceFiles: Infinity } } : {}),
  onStage: (stage, ms) => {
    stages[stage] = ms;
  },
});
const totalMs = performance.now() - start;

const result: RunResult = {
  totalMs,
  stages,
  // resourceUsage().maxRSS is in kilobytes.
  maxRssBytes: process.resourceUsage().maxRSS * 1024,
  // The heap V8 holds with the graph still alive: a floor for the run's peak heap.
  heapTotalBytes: process.memoryUsage().heapTotal,
  graphSha256: createHash("sha256").update(stringifyGraph(graph)).digest("hex"),
  counts: countGraph(graph),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
