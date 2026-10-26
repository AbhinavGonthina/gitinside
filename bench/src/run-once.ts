import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { analyze } from "@gitinside/analyzer";
import { stringifyGraph } from "@gitinside/schema";
import { countGraph, type RunResult } from "./report.js";

// One measured `analyze` run. analysis.ts spawns this in a fresh process per run so peak
// RSS belongs to that run alone. Usage: node run-once.js <dir> <owner> <name> <sha>
// Prints one JSON RunResult line on stdout.

const [dir, owner, name, sha] = process.argv.slice(2);
if (!dir || !owner || !name || !sha) {
  process.stderr.write("usage: run-once <dir> <owner> <name> <sha>\n");
  process.exit(2);
}

const stages: Record<string, number> = {};
const start = performance.now();
const graph = await analyze(dir, {
  owner,
  name,
  sha,
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
  graphSha256: createHash("sha256").update(stringifyGraph(graph)).digest("hex"),
  counts: countGraph(graph),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
