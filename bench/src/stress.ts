import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { ANALYZER_VERSION, DEFAULT_LIMITS, buildInventory } from "@gitinside/analyzer";
import { DEFAULT_EXTRACT_LIMITS, extractTarball } from "@gitinside/worker/extract";
import { openTarball } from "@gitinside/worker/github";
import { DEFAULT_RUNNER_LIMITS } from "@gitinside/worker/runner";
import {
  BENCH,
  flag,
  gitinsideCommit,
  machine,
  stressRepos,
  today,
  type BenchRepo,
} from "./env.js";
import type { RunResult } from "./report.js";
import {
  renderStressReport,
  type DownloadResult,
  type ExtractionResult,
  type InventoryResult,
  type ProductionLimits,
  type StressMeta,
  type StressRun,
} from "./stressReport.js";

// Stress benchmark (#10): for each repo in bench/repos.json `stress`, download its tarball the
// way the worker does (`openTarball`), extract it with the worker's `extractTarball` with the
// size and entry limits lifted, take the analyzer's inventory, and run `analyze` in a fresh
// process with the source-file and source-size limits lifted, a large heap, and no time limit.
// The report compares every measurement with the production limit it meets. Parse only: nothing in the
// repo is installed or run. The tarball and the extracted tree stay under bench/.repos/
// (gitignored) with the download and extraction numbers next to them, so a rerun skips both.
//
// Usage: pnpm bench:stress [--label "<machine label>"] [--runs 1] [--heap-mb 12288]

const RUN_ONCE = fileURLToPath(new URL("./run-once.js", import.meta.url));
/** No limit, for the extractor's counters. */
const UNLIMITED = Number.MAX_SAFE_INTEGER;

/** The production limits, from the code that enforces them. */
const LIMITS: ProductionLimits = {
  maxTarBytes: DEFAULT_EXTRACT_LIMITS.maxBytes,
  maxEntries: DEFAULT_EXTRACT_LIMITS.maxEntries,
  maxSourceFiles: DEFAULT_LIMITS.maxSourceFiles,
  maxSourceBytes: DEFAULT_LIMITS.maxSourceBytes,
  maxHeapMb: DEFAULT_RUNNER_LIMITS.maxHeapMb,
  timeoutMs: DEFAULT_RUNNER_LIMITS.timeoutMs,
};

interface Prepared {
  download: DownloadResult;
  extraction: ExtractionResult;
}

/** Download and extract `repo` once; later runs reuse the tree and its recorded numbers. */
async function prepare(repo: BenchRepo): Promise<{ dir: string } & Prepared> {
  const base = join(BENCH, ".repos", `${repo.name}-${repo.sha.slice(0, 7)}`);
  const dir = `${base}-tree`;
  const record = `${base}.json`;
  if (existsSync(record)) {
    return { dir, ...(JSON.parse(await readFile(record, "utf8")) as Prepared) };
  }
  await mkdir(join(BENCH, ".repos"), { recursive: true });

  process.stderr.write(`${repo.name}: downloading ${repo.sha}\n`);
  const archive = `${base}.tar.gz`;
  let compressedBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      compressedBytes += chunk.length;
      done(null, chunk);
    },
  });
  const downloadStart = performance.now();
  const body = await openTarball({ owner: repo.owner, repo: repo.repo, sha: repo.sha });
  // bench's tsconfig includes the DOM lib (render/), whose ReadableStream type isn't Node's.
  const source = Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>);
  await pipeline(source, counter, createWriteStream(archive));
  const download = { compressedBytes, ms: performance.now() - downloadStart };

  process.stderr.write(`${repo.name}: extracting\n`);
  await rm(dir, { recursive: true, force: true });
  const extractStart = performance.now();
  const result = await extractTarball(createReadStream(archive), dir, {
    limits: { maxBytes: UNLIMITED, maxEntries: UNLIMITED },
  });
  const extraction: ExtractionResult = {
    tarBytes: result.tarBytes,
    entries: result.files + result.directories + result.skipped.length,
    files: result.files,
    directories: result.directories,
    skipped: result.skipped.length,
    ms: performance.now() - extractStart,
  };
  const prepared = { download, extraction };
  await writeFile(record, `${JSON.stringify(prepared, null, 2)}\n`);
  return { dir, ...prepared };
}

/** The analyzer's inventory with its file and size limits lifted, so the counts are exact. */
async function inventory(dir: string): Promise<InventoryResult> {
  const start = performance.now();
  const inv = await buildInventory(dir, { maxSourceFiles: Infinity, maxSourceBytes: Infinity });
  return {
    files: inv.files.length,
    sourceFiles: inv.sourceFiles.length,
    sourceBytes: inv.sourceBytes,
    warnings: inv.warnings.length,
    ms: performance.now() - start,
  };
}

/** The last non-empty line of a failed run's stderr, cut to 300 characters. */
function lastLine(stderr: unknown): string {
  const lines = String(stderr ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  return (lines.at(-1) ?? "").slice(0, 300);
}

/** One uncapped analyze run in a fresh Node process. */
function runOnce(dir: string, repo: BenchRepo, heapMb: number): StressRun {
  const start = performance.now();
  try {
    const out = execFileSync(
      process.execPath,
      [
        `--max-old-space-size=${heapMb}`,
        RUN_ONCE,
        dir,
        repo.owner,
        repo.repo,
        repo.sha,
        "--no-file-limit",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, result: JSON.parse(out) as RunResult };
  } catch (error) {
    const e = error as { status?: number | null; signal?: string | null; stderr?: unknown };
    const how = e.signal ? `signal ${e.signal}` : `exit code ${e.status ?? "?"}`;
    return { ok: false, error: `${how}: ${lastLine(e.stderr)}`, wallMs: performance.now() - start };
  }
}

async function main(): Promise<void> {
  const label = flag("label", "dev machine");
  const runs = Number(flag("runs", "1"));
  const heapMb = Number(flag("heap-mb", "12288"));
  const gitinsideSha = gitinsideCommit();
  const date = today();
  await mkdir(join(BENCH, "results"), { recursive: true });

  for (const repo of await stressRepos()) {
    const { dir, download, extraction } = await prepare(repo);
    process.stderr.write(`${repo.name}: inventory\n`);
    const inv = await inventory(dir);
    const results: StressRun[] = [];
    for (let i = 0; i < runs; i++) {
      process.stderr.write(`${repo.name}: run ${i + 1} of ${runs}\n`);
      const run = runOnce(dir, repo, heapMb);
      process.stderr.write(
        `${repo.name}: run ${i + 1} ${run.ok ? `${Math.round(run.result.totalMs)} ms` : run.error}\n`,
      );
      results.push(run);
    }
    const meta: StressMeta = {
      date,
      repo: { name: repo.name, url: repo.url, sha: repo.sha },
      gitinsideSha,
      analyzerVersion: ANALYZER_VERSION,
      heapMb,
      machine: machine(label),
      limits: LIMITS,
    };
    const data = { download, extraction, inventory: inv, runs: results };
    const out = join(BENCH, "results", `${date}-stress-${repo.name}`);
    await writeFile(`${out}.json`, `${JSON.stringify({ meta, data }, null, 2)}\n`);
    await writeFile(`${out}.md`, renderStressReport(meta, data));
    process.stderr.write(`${repo.name}: wrote ${out}.md\n`);
  }
}

await main();
