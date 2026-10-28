import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StepProgress } from "./progress.js";
import {
  parseChildJob,
  parseChildReport,
  parseProgressLine,
  type AnalysisStats,
  type ChildJob,
} from "./protocol.js";

/**
 * Runs one analysis in a sandboxed child process (docs/SECURITY.md T1, T3, T4; ADR-0059).
 *
 * The child is `node child.js` (the analyzer behind a line-based JSON protocol, protocol.ts:
 * progress lines, passed to `onProgress` as they arrive, then one report):
 * - **Memory:** `--max-old-space-size` (3 GB). V8 aborts past it; the runner reports
 *   `LIMIT_MEMORY`.
 * - **Time:** a 5-minute wall-clock timer, then `SIGKILL` (works even while the analyzer is
 *   stuck in synchronous code); `LIMIT_TIME`. CPU share is capped by the container (M5.10),
 *   and the queue runs at most 2 jobs at once.
 * - **Filesystem and processes:** the Node permission model (`--permission`). The child may
 *   read only the installed app (`readRoots`: its own code, the analyzer, TypeScript's libs)
 *   and the job's `src`, write only `out`, and can't start processes, worker threads, or
 *   native addons. So it can't read `/etc/gitinside/worker.env` or run anything from the repo.
 * - **Environment:** empty (on Windows, libuv adds its fixed list of system variables), so
 *   no secret reaches the child and no `NODE_OPTIONS` can change its flags.
 * - **Network:** none; `netguard.ts` is preloaded and fails every socket, DNS, and fetch call.
 *
 * Outcomes: success with stats, an analyzer error code (`LIMIT_FILES`, `INVALID_GRAPH`),
 * `LIMIT_TIME`, `LIMIT_MEMORY`, `CANCELLED` (the signal fired), or `ANALYZER_CRASHED`
 * (any other exit, a missing or malformed report, output after the report, or a graph file
 * that doesn't match it).
 * The runner never throws for the child's behavior; it throws only if `src` or the folder of
 * `out` doesn't exist. Deleting the job folder is the caller's job (SECURITY.md §3).
 */

/** Resource limits for one analysis. Defaults come from docs/SECURITY.md (T3). */
export interface RunnerLimits {
  /** Wall-clock budget before `SIGKILL`. Default 5 minutes. */
  timeoutMs: number;
  /** V8 old-space cap in MiB (`--max-old-space-size`). Default 3,072. */
  maxHeapMb: number;
}

/** Default analysis limits. */
export const DEFAULT_RUNNER_LIMITS: RunnerLimits = {
  timeoutMs: 5 * 60 * 1000,
  maxHeapMb: 3072,
};

/** Options for {@link runAnalysis}. */
export interface RunOptions {
  limits?: Partial<RunnerLimits>;
  /** Kills the child when aborted (worker shutdown, a cancelled job); the result is `CANCELLED`. */
  signal?: AbortSignal;
  /**
   * Folders the child may read besides `src`. Default: the installed app root (three levels
   * up from this file: the monorepo root, or the image's `/app`). Must hold no secrets.
   */
  readRoots?: string[];
  /** Folder holding the built `child.js` and `netguard.js`. Default: this file's folder. */
  scriptsDir?: string;
  /** Run this script in place of `child.js`, in the same sandbox (tests use probe scripts). */
  childScript?: string;
  /**
   * Gets each progress line from the child as it arrives, already validated. Must not
   * throw. A run whose output breaks the protocol still ends `ANALYZER_CRASHED`, so steps
   * seen before that are hints only.
   */
  onProgress?: (progress: StepProgress) => void;
}

/** The outcome of {@link runAnalysis}. `durationMs` is wall clock from spawn to exit. */
export type RunResult =
  | { ok: true; stats: AnalysisStats; durationMs: number }
  | {
      ok: false;
      /** `LIMIT_TIME`, `LIMIT_MEMORY`, `CANCELLED`, `ANALYZER_CRASHED`, or the analyzer's code. */
      code: string;
      /** Safe to show users: fixed text, or the analyzer's own message for its codes. */
      message: string;
      /** The end of the child's stderr, for logs only (may hold machine paths). */
      stderrTail: string;
      durationMs: number;
    };

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_ROOT = resolve(HERE, "../../..");
const STDOUT_MAX_BYTES = 64 * 1024;
const STDERR_TAIL_CHARS = 8 * 1024;
/** What V8 prints when it hits `--max-old-space-size`. */
const OUT_OF_MEMORY = /JavaScript heap out of memory|Reached heap limit|near heap limit/;

/** `300000` ⇒ "5 minutes", `1000` ⇒ "1 second", `500` ⇒ "0.5 seconds". */
export function formatDuration(ms: number): string {
  const [amount, unit] =
    ms >= 60_000 && ms % 60_000 === 0 ? [ms / 60_000, "minute"] : [ms / 1000, "second"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

/** The resolved, symlink-free form of `path`, as the permission model compares paths. */
async function canonical(path: string): Promise<string> {
  return realpath(resolve(path));
}

/**
 * The child's command line: limits and permission flags first, then the preloaded guard,
 * the script, and the job as one JSON argument. Exported for tests.
 */
export function childArgs(
  job: ChildJob,
  limits: RunnerLimits,
  files: { script: string; guard: string },
  readRoots: readonly string[],
): string[] {
  return [
    `--max-old-space-size=${limits.maxHeapMb}`,
    "--permission",
    ...[...readRoots, job.src].map((path) => `--allow-fs-read=${path}`),
    `--allow-fs-write=${job.out}`,
    `--import=${pathToFileURL(files.guard).href}`,
    files.script,
    JSON.stringify(job),
  ];
}

interface Exit {
  code: number | null;
  spawnError?: Error;
}

/**
 * Analyze `job.src` in a sandboxed child process and write the graph to `job.out`. See the
 * module comment for the limits and outcomes.
 */
export async function runAnalysis(job: ChildJob, options: RunOptions = {}): Promise<RunResult> {
  const limits = { ...DEFAULT_RUNNER_LIMITS, ...options.limits };
  const out = join(await canonical(dirname(job.out)), basename(job.out));
  const sandboxed = parseChildJob(JSON.stringify({ ...job, src: await canonical(job.src), out }));
  const readRoots = await Promise.all((options.readRoots ?? [DEFAULT_APP_ROOT]).map(canonical));
  const scriptsDir = options.scriptsDir ?? HERE;
  const args = childArgs(
    sandboxed,
    limits,
    {
      script: options.childScript ?? join(scriptsDir, "child.js"),
      guard: join(scriptsDir, "netguard.js"),
    },
    readRoots,
  );

  const start = performance.now();
  let stderrTail = "";
  const fail = (code: string, message: string): RunResult => ({
    ok: false,
    code,
    message,
    stderrTail,
    durationMs: Math.round(performance.now() - start),
  });
  if (options.signal?.aborted) return fail("CANCELLED", "the analysis was cancelled");

  const child = spawn(process.execPath, args, {
    cwd: dirname(out),
    // Nothing inherited. (On Windows, libuv itself adds a fixed set of system variables
    // such as SystemRoot and TEMP, which Windows processes need to start.)
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  // stdout is progress lines, then the report line. Anything after the report, or past the
  // byte cap, breaks the protocol.
  let pending = "";
  let stdoutBytes = 0;
  let reportLine: string | undefined;
  let broken = false;
  const onLine = (line: string): void => {
    if (reportLine !== undefined) {
      broken = true;
      return;
    }
    const progress = parseProgressLine(line);
    if (progress === undefined) reportLine = line;
    else options.onProgress?.(progress);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (broken || stdoutBytes > STDOUT_MAX_BYTES) {
      broken = true;
      return;
    }
    pending += chunk;
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      onLine(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });

  let killedFor: "time" | "cancel" | undefined;
  const kill = (why: "time" | "cancel"): void => {
    if (killedFor !== undefined) return;
    killedFor = why;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => kill("time"), limits.timeoutMs);
  const onAbort = (): void => kill("cancel");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const exit = await new Promise<Exit>((resolveExit) => {
    child.once("error", (spawnError) => resolveExit({ code: null, spawnError }));
    child.once("close", (code) => resolveExit({ code }));
  });
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", onAbort);

  if (exit.spawnError !== undefined) {
    return fail("ANALYZER_CRASHED", "the analysis process could not start");
  }
  if (killedFor === "cancel") return fail("CANCELLED", "the analysis was cancelled");
  if (killedFor === "time") {
    return fail(
      "LIMIT_TIME",
      `LIMIT_TIME: analysis took longer than ${formatDuration(limits.timeoutMs)}. Try analyzing a subfolder.`,
    );
  }
  if (OUT_OF_MEMORY.test(stderrTail)) {
    return fail(
      "LIMIT_MEMORY",
      `LIMIT_MEMORY: analysis needed more than ${limits.maxHeapMb} MB of memory. Try analyzing a subfolder.`,
    );
  }

  const crashed = (): RunResult => fail("ANALYZER_CRASHED", "the analyzer stopped unexpectedly");
  const report =
    exit.code === 0 && !broken && pending === "" && reportLine !== undefined
      ? parseChildReport(reportLine)
      : undefined;
  if (report === undefined) return crashed();
  if (!report.ok) return fail(report.code, report.message);

  const written = await stat(out).catch(() => undefined);
  if (written?.isFile() !== true || written.size !== report.stats.graphBytes) return crashed();
  return { ok: true, stats: report.stats, durationMs: Math.round(performance.now() - start) };
}
