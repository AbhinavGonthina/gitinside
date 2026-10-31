import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_LIMITS, buildInventory } from "@gitinside/analyzer";
import { runAnalysis } from "@gitinside/worker/runner";
import { BENCH } from "./env.js";

// Capped runs (M5.16b): each folder goes through the worker's own sandboxed runner
// (`runAnalysis`: 3 GB heap, 5 minutes, no network, the analyzer's default limits), one after
// another, so each result is what a job's analysis step would get on this machine. Prints one
// JSON line per folder: its source files and size (the inventory, limits lifted), the
// outcome or failure code, how long it took, the last analyzer step
// the child reported and when, and the stage times of a finished run. Parse only.
//
// To measure folders over the source-size limit (calibrating it, ADR-0137), raise
// `MAX_SOURCE_MB` in packages/analyzer/src/inventory.ts and rebuild first; otherwise they stop
// at the inventory, which is what production does.
//
// Usage: pnpm bench:capped <folder>... (folders relative to bench/, e.g. .repos/calcom)

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm bench:capped <folder>...\n");
  process.exit(2);
}
const MIB = 1024 * 1024;
const outDir = join(BENCH, "dist", "capped");
await mkdir(outDir, { recursive: true });

for (const folder of folders) {
  process.stderr.write(`${folder}: running\n`);
  // What the limits count, measured with them lifted (the run below applies them).
  const inventory = await buildInventory(resolve(folder), {
    maxSourceFiles: Infinity,
    maxSourceBytes: Infinity,
  });
  const start = performance.now();
  let last: { step: string; atMs: number } | undefined;
  const result = await runAnalysis(
    {
      src: resolve(folder),
      out: join(outDir, `${basename(folder)}.json`),
      owner: "bench",
      name: basename(folder),
    },
    { onProgress: ({ step }) => (last = { step, atMs: Math.round(performance.now() - start) }) },
  );
  const line = {
    folder,
    maxSourceMb: DEFAULT_LIMITS.maxSourceBytes / MIB,
    sourceFiles: inventory.sourceFiles.length,
    sourceMib: Math.round((inventory.sourceBytes / MIB) * 10) / 10,
    ok: result.ok,
    ...(result.ok ? {} : { code: result.code }),
    ms: result.durationMs,
    lastStep: last?.step,
    lastStepAtMs: last?.atMs,
    ...(result.ok ? { stageMs: result.stats.stageMs } : {}),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
