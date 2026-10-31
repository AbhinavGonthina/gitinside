import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AnalysisError, analyze, serializeGraph } from "@gitinside/analyzer";
import type { ArchitectureGraph } from "@gitinside/schema";
import { foundFacts, type FoundFacts, type StepProgress } from "./progress.js";
import {
  foundLine,
  parseChildJob,
  progressLine,
  type ChildJob,
  type ChildReport,
} from "./protocol.js";

/**
 * The analysis child process: started by `runAnalysis` (runner.ts) with a heap cap, the
 * Node permission model, an empty environment, and the network guard. It analyzes
 * `job.src`, writes the serialized graph to `job.out`, prints a progress line as each
 * analyzer stage starts and a found line after each stage that finds something, and ends
 * with one {@link ChildReport}.
 *
 * Known analyzer failures ({@link AnalysisError}, e.g. `LIMIT_FILES`) become a report with
 * their code. Anything else is a bug: it propagates, Node prints the stack to stderr and
 * exits non-zero, and the runner reports `ANALYZER_CRASHED`.
 */

/** The analyzer entry points the child uses, injectable for in-process tests. */
export interface ChildDeps {
  analyze: typeof analyze;
}

/**
 * Run one job and describe the outcome. Throws only on unexpected errors. `onProgress` gets
 * each analyzer stage as it starts, with the analyzer's counts; `onFound` what the analysis
 * has found so far, capped for storage ({@link foundFacts}).
 */
export async function runChildJob(
  job: ChildJob,
  deps: ChildDeps = { analyze },
  onProgress?: (progress: StepProgress) => void,
  onFound?: (found: FoundFacts) => void,
): Promise<ChildReport> {
  const stageMs: Record<string, number> = {};
  let graph: ArchitectureGraph;
  let text: string;
  try {
    graph = await deps.analyze(job.src, {
      owner: job.owner,
      name: job.name,
      ...(job.sha === undefined ? {} : { sha: job.sha }),
      onStage: (stage, ms) => {
        stageMs[stage] = Math.round(ms);
      },
      ...(onProgress === undefined
        ? {}
        : {
            onProgress: ({ stage, count }) =>
              onProgress(count === undefined ? { step: stage } : { step: stage, count }),
          }),
      ...(onFound === undefined ? {} : { onFound: (found) => onFound(foundFacts(found)) }),
    });
    text = serializeGraph(graph);
  } catch (error) {
    if (error instanceof AnalysisError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
  await writeFile(job.out, text);
  return {
    ok: true,
    stats: {
      files: graph.nodes.filter((node) => node.kind === "file").length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      unresolved: graph.nodes.filter((node) => node.kind === "unresolved").length,
      warnings: graph.warnings.length,
      graphBytes: Buffer.byteLength(text),
      stageMs,
    },
  };
}

/* v8 ignore start -- process entry point, run as a child by runner.test.ts */
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  const report = await runChildJob(
    parseChildJob(process.argv[2] ?? ""),
    undefined,
    (progress) => process.stdout.write(progressLine(progress)),
    (found) => process.stdout.write(foundLine(found)),
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
/* v8 ignore stop */
