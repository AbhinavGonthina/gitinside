import { execFileSync, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { ANALYZER_VERSION } from "@gitinside/analyzer";
import { openTarball } from "@gitinside/worker/github";
import {
  checkTarget,
  dockerRunArgs,
  parseContainerRun,
  parseSemiSpaces,
  renderCloudRunReport,
  type CloudRunMeta,
  type ContainerRun,
} from "./cloudRun.js";
import { BENCH, flag, gitinsideCommit, today } from "./env.js";

// The 1-vCPU benchmark (M5.13a3, cloudRun.ts): build the worker image, download the repo's
// tarball once, then analyze it `--runs` times, each in a fresh container started as Cloud Run
// starts an instance. Writes `<out>/<date>-cloudrun-<repo>.json` (every run's raw readings) and
// `.md` (the report). Needs Linux and Docker; CI's "Benchmark (1 vCPU)" workflow runs it.
// Parse only: the repo is extracted and analyzed by the image's sandboxed child, never run.
//
// Usage: pnpm bench:cloudrun [--owner calcom] [--repo cal.diy] [--sha <40 hex>] [--runs 3]
//   [--semi-space default,32,64] [--out dist/cloudrun] [--host "<where this runs>"]
// `--semi-space` lists the child's semi-space caps in MiB (`default`: the runner's); runs cycle
// through them, so each cap is measured on the same runner (M5.13a5).

const IMAGE = "gitinside-worker:bench";
const ROOT = resolve(BENCH, "..");
/** DESIGN.md §9: a 5k-file repo analyzed in ≤ 60 s. */
const BUDGET_MS = 60_000;

/** `docker …` with its output shown. */
function docker(args: string[]): void {
  execFileSync("docker", args, { cwd: ROOT, stdio: "inherit" });
}

/** The image's size gzipped, about what the registry stores (as infra/gcp/check.mjs counts it). */
async function compressedImageBytes(): Promise<number> {
  const save = spawn("docker", ["image", "save", IMAGE], { stdio: ["ignore", "pipe", "inherit"] });
  let bytes = 0;
  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  const exited = new Promise<number | null>((done, fail) => {
    save.on("error", fail);
    save.on("close", done);
  });
  await pipeline(save.stdout, gzip);
  if ((await exited) !== 0) throw new Error("docker image save failed");
  return bytes;
}

/** One run: a fresh container with the tarball on stdin; its JSON line parsed. */
async function runContainer(tarball: string, args: string[]): Promise<ContainerRun> {
  const start = performance.now();
  const child = spawn("docker", args, { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exited = new Promise<number | null>((done, fail) => {
    child.on("error", fail);
    child.on("close", done);
  });
  await pipeline(createReadStream(tarball), child.stdin);
  const code = await exited;
  const containerMs = Math.round(performance.now() - start);
  if (code !== 0) throw new Error(`docker run exited ${code}: ${stdout.slice(-500)}`);
  return parseContainerRun(stdout, containerMs);
}

async function main(): Promise<void> {
  const target = checkTarget({
    owner: flag("owner", "calcom"),
    repo: flag("repo", "cal.diy"),
    sha: flag("sha", "2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee"),
  });
  const runs = Number(flag("runs", "3"));
  if (!Number.isInteger(runs) || runs < 1 || runs > 12) throw new Error(`bad --runs: ${runs}`);
  const semiSpaces = parseSemiSpaces(flag("semi-space", "default"));
  const outDir = resolve(BENCH, flag("out", "dist/cloudrun"));
  const host = flag("host", "this machine");
  const gitinsideSha = gitinsideCommit();
  const date = today();
  await mkdir(outDir, { recursive: true });

  docker(["build", "--file", "apps/worker/Dockerfile", "--tag", IMAGE, "."]);
  const imageBytes = await compressedImageBytes();

  process.stderr.write(`${target.owner}/${target.repo}: downloading ${target.sha}\n`);
  const tarball = join(outDir, `${target.repo}-${target.sha.slice(0, 7)}.tar.gz`);
  let compressedBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      compressedBytes += chunk.length;
      done(null, chunk);
    },
  });
  const downloadStart = performance.now();
  const body = await openTarball(target);
  // bench's tsconfig includes the DOM lib (render/), whose ReadableStream type isn't Node's.
  const source = Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>);
  await pipeline(source, counter, createWriteStream(tarball));
  const download = { compressedBytes, ms: Math.round(performance.now() - downloadStart) };

  const results: ContainerRun[] = [];
  for (let i = 0; i < runs; i++) {
    const semiSpaceMb = semiSpaces[i % semiSpaces.length];
    process.stderr.write(
      `${target.repo}: run ${i + 1} of ${runs}, semi-space ${semiSpaceMb ?? "default"}\n`,
    );
    const run = await runContainer(tarball, dockerRunArgs(IMAGE, target, semiSpaceMb));
    process.stderr.write(
      `${target.repo}: run ${i + 1}: ${run.result.ok ? `${run.result.durationMs} ms` : run.result.code}\n`,
    );
    results.push(run);
  }

  const meta: CloudRunMeta = {
    date,
    target,
    gitinsideSha,
    analyzerVersion: ANALYZER_VERSION,
    host,
    image: { compressedBytes: imageBytes },
    download,
    budgetMs: BUDGET_MS,
  };
  const out = join(outDir, `${date}-cloudrun-${target.repo}`);
  await writeFile(`${out}.json`, `${JSON.stringify({ meta, runs: results }, null, 2)}\n`);
  await writeFile(`${out}.md`, renderCloudRunReport(meta, results));
  process.stderr.write(`wrote ${out}.md\n`);
}

await main();
