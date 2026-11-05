import type { AddressInfo } from "node:net";
import { ANALYZER_VERSION } from "@gitinside/analyzer";
import {
  createDb,
  failInterruptedAnalyses,
  recentAnalysisStats,
  runMigrations,
  type AnyDatabase,
} from "@gitinside/db";
import type { WorkerLog } from "./attempt.js";
import { createUsageMeter, type UsageMeter } from "./compute.js";
import { ConfigError, workerConfigFromEnv, type WorkerConfig } from "./config.js";
import { SAMPLE_LIMIT } from "./estimate.js";
import type { DownloadOptions } from "./github.js";
import { sweepJobsRoot, type JobDeps } from "./job.js";
import { createJsonLog } from "./log.js";
import {
  INTERRUPTED_AFTER_SECONDS,
  createCountedStore,
  createMaintenanceTrigger,
  runMaintenance,
  type MaintenanceTriggerOptions,
} from "./maintenance.js";
import { createAnalysisRecorder } from "./record.js";
import { createRunServer } from "./run.js";

/**
 * The worker process (ADR-0114, ADR-0144): a Cloud Run container serving `POST /run` on
 * `PORT`. Cloud Tasks pushes each job there, and the request runs it (run.ts); Cloud Run
 * sends one request at a time and runs up to two instances.
 *
 * **Startup, in order** (any failure closes what was opened and exits 1, so Cloud Run
 * starts it again):
 * 0. **Migrate** (ADR-0192): apply pending migrations through `migrationUrl` (Neon's direct
 *    endpoint) under a Postgres advisory lock, so two instances take turns and a new
 *    revision never takes traffic (its startup probe waits for `listen`) on a schema older
 *    than its code. Nothing else touches the database first.
 * 1. Open Postgres.
 * 2. **Sweep:** delete leftover job folders (`/tmp` is the instance's own, so another
 *    instance's job is never in it), then mark analyses `running` for over
 *    {@link INTERRUPTED_AFTER_SECONDS} `failed` (`JOB_INTERRUPTED`). No attempt runs that
 *    long, so such a row belongs to an instance that died, while the other instance's live
 *    job is left alone. A retried push moves its row back to `running`.
 * 3. Build the recorder (`publish` = bucket then Postgres; every bucket request counted in
 *    `store_requests`, ADR-0096; time estimates from the latest finished analyses' stats,
 *    ADR-0136), the hourly maintenance (stale jobs, retention, rate-limit pruning, quota
 *    check; maintenance.ts) run after a job once its hourly claim in Postgres is won
 *    (ADR-0147), then listen.
 * 4. Count the instance's startup (and its shutdown, up front) in the month's compute
 *    (compute.ts, ADR-0156); every push answered is counted too.
 *
 * **Shutdown** ({@link RunningWorker.stop}, on SIGTERM or SIGINT): cancel the running job
 * (`CANCELLED` is retriable, so its push is answered `503` and Cloud Tasks delivers it
 * again) and wait for its answer while the server closes, stop maintenance (waiting for a
 * run in progress), then close the database. Each step runs even if an earlier one failed.
 */

/** The worker as started by {@link startWorkerProcess}. */
export interface RunningWorker {
  /** Where `POST /run` listens. */
  address: AddressInfo;
  /** Shut down in order; repeated calls return the same promise. */
  stop(): Promise<void>;
}

/** A database and how to close it. */
export interface DbConnection {
  db: AnyDatabase;
  close: () => Promise<void>;
}

/** Overrides for {@link startWorkerProcess}; production passes only `log`. */
export interface StartOptions {
  log?: WorkerLog;
  /** Default the analyzer's own version. */
  analyzerVersion?: string;
  /** Default {@link createDb} on `config.databaseUrl` (tests pass PGlite). */
  openDb?: (url: string) => DbConnection;
  /** Default {@link runMigrations} on `config.migrationUrl` (tests migrate their own database). */
  migrate?: (url: string) => Promise<void>;
  /** GitHub endpoints (tests point them at a fake); the token comes from the config. */
  github?: Omit<DownloadOptions, "signal" | "token">;
  /** The analysis runner and its limits (tests stub the child). */
  jobDeps?: Pick<JobDeps, "run" | "runOptions">;
  /** Maintenance timing (maintenance.ts defaults), or `false` for none. */
  maintenance?: Pick<MaintenanceTriggerOptions, "everySeconds" | "minTimeLeftMs"> | false;
  /** Default {@link createUsageMeter} on the database (the compute count, ADR-0156). */
  meter?: (options: { db: AnyDatabase; log: WorkerLog }) => UsageMeter;
  /** The process's age in ms once listening. Default `performance.now()`. */
  uptimeMs?: () => number;
}

/** Run `steps` in order, logging (not throwing) each failure; rejects at the end if any did. */
async function runAll(
  steps: readonly [string, () => Promise<void>][],
  log: WorkerLog,
): Promise<void> {
  let failed = false;
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (error) {
      failed = true;
      log({ event: "shutdown_step_failed", step, message: errorMessage(error) });
    }
  }
  if (failed) throw new Error("shutdown did not complete cleanly");
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** How many wrapped errors {@link errorCauses} reports. */
const MAX_CAUSES = 5;

/**
 * The errors `error` wraps (`cause`, innermost last): each message, with Postgres's
 * SQLSTATE `code` when it has one. Drizzle reports only "Failed query: …" and puts the
 * database's own reason (`relation "analyses" does not exist`, 42P01) on `cause`. Messages
 * and codes only, never a stack; neither postgres.js nor Postgres puts a password in one.
 */
export function errorCauses(error: unknown): { message: string; code?: string }[] {
  const causes: { message: string; code?: string }[] = [];
  let next = error instanceof Error ? error.cause : undefined;
  while (next !== undefined && next !== null && causes.length < MAX_CAUSES) {
    const code =
      typeof next === "object" && "code" in next && typeof next.code === "string"
        ? next.code
        : undefined;
    causes.push({ message: errorMessage(next), ...(code === undefined ? {} : { code }) });
    next = next instanceof Error ? next.cause : undefined;
  }
  return causes;
}

/** Start the worker's `POST /run` server from a checked config. */
export async function startWorkerProcess(
  config: WorkerConfig,
  options: StartOptions = {},
): Promise<RunningWorker> {
  const log = options.log ?? (() => undefined);
  const analyzerVersion = options.analyzerVersion ?? ANALYZER_VERSION;
  log({
    event: "worker_starting",
    analyzerVersion,
    jobsRoot: config.jobsRoot,
    cacheRoot: config.cacheRoot,
    githubToken: config.githubToken !== undefined,
  });

  // Undone in reverse if a later step fails.
  const cleanup: [string, () => Promise<void>][] = [];
  const undo = () => runAll([...cleanup].reverse(), log).catch(() => undefined);
  try {
    const migrateStart = performance.now();
    try {
      await (options.migrate ?? runMigrations)(config.migrationUrl);
    } catch (error) {
      throw new Error("migrations failed", { cause: error });
    }
    log({ event: "migrations_applied", ms: Math.round(performance.now() - migrateStart) });

    const { db, close: closeDb } = (options.openDb ?? createDb)(config.databaseUrl);
    cleanup.push(["database", closeDb]);
    // Cloud Run read the secrets before this process began; count them before anything
    // else can fail the start (a failed start is retried, reading them again).
    const meter = (options.meter ?? createUsageMeter)({ db, log });
    await meter.secretReads();

    const folders = await sweepJobsRoot(config.jobsRoot);
    const interrupted = await failInterruptedAnalyses(db, INTERRUPTED_AFTER_SECONDS);
    log({ event: "startup_sweep", folders, interrupted });

    const github = {
      ...options.github,
      ...(config.githubToken === undefined ? {} : { token: config.githubToken }),
    };
    const store = createCountedStore(config.store, db, log);
    const recorder = createAnalysisRecorder({ db, store, analyzerVersion, github });
    let afterJob:
      | ((end: { timeLeftMs: number; signal: AbortSignal }) => Promise<unknown>)
      | undefined;
    if (options.maintenance !== false) {
      const maintenance = createMaintenanceTrigger({
        db,
        run: () => runMaintenance({ db, store, log }),
        log,
        ...options.maintenance,
      });
      afterJob = (end) => maintenance.afterJob(end);
      cleanup.push(["maintenance", () => maintenance.stop()]);
    }

    // Registered last, so shutdown cancels the job first and only then waits for a
    // maintenance run (a long bucket listing must not keep the job past the deadline).
    const shutdown = new AbortController();
    const server = createRunServer({
      deps: {
        ...options.jobDeps,
        jobsRoot: config.jobsRoot,
        cacheRoot: config.cacheRoot,
        recorder,
        publish: recorder.publish,
        download: github,
      },
      secrets: config.secrets,
      analyzerVersion,
      log,
      estimates: { samples: () => recentAnalysisStats(db, SAMPLE_LIMIT) },
      signal: shutdown.signal,
      meter: (ms) => meter.push(ms),
      ...(afterJob === undefined ? {} : { afterJob }),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const closeServer = () =>
      new Promise<void>((resolve, reject) => {
        shutdown.abort();
        // Waits for the running job's answer; idle keep-alive connections go at once.
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeIdleConnections();
      });
    cleanup.push(["server", closeServer]);
    server.on("error", (error) => log({ event: "server_error", message: error.message }));

    // Startup is billed too: the process's age now, ms since it started (`timeOrigin`).
    await meter.startup((options.uptimeMs ?? (() => performance.now()))());
    const address = server.address() as AddressInfo;
    log({ event: "worker_ready", host: address.address, port: address.port });

    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        log({ event: "worker_stopping" });
        await runAll([...cleanup].reverse(), log);
        log({ event: "worker_stopped" });
      })();
      return stopping;
    };
    return { address, stop };
  } catch (error) {
    await undo();
    throw error;
  }
}

/** What {@link runMain} needs from the process (tests fake all of it). */
export interface MainIo {
  env: Readonly<Record<string, string | undefined>>;
  /** Writes one log line (stdout in production). */
  write: (line: string) => void;
  /** Calls `handler` on each of `signals`. */
  onSignal: (signals: readonly NodeJS.Signals[], handler: (signal: NodeJS.Signals) => void) => void;
  exit: (code: number) => void;
  /** Default {@link startWorkerProcess}. */
  start?: (config: WorkerConfig, options: StartOptions) => Promise<RunningWorker>;
  /** Default {@link SHUTDOWN_TIMEOUT_MS}. */
  shutdownTimeoutMs?: number;
}

/**
 * How long a shutdown may take before the process exits 1 anyway. A cancelled job ends at
 * once (its child is killed), so this covers recording it and closing connections. Cloud
 * Run sends SIGKILL 10 s after SIGTERM, so this must stay under that.
 */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

/** Shutdown signals: Cloud Run and Docker send SIGTERM, a terminal Ctrl+C SIGINT. */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/**
 * The `bin.js` entry: read the config, start, and stop cleanly on a shutdown signal.
 * Exits 1 on a bad config (listing each problem variable), a failed start, a failed or
 * slow shutdown; 0 after a clean shutdown. A second signal while stopping is ignored.
 */
export async function runMain(io: MainIo): Promise<RunningWorker | undefined> {
  const log = createJsonLog(io.write);
  let config: WorkerConfig;
  try {
    config = workerConfigFromEnv(io.env);
  } catch (error) {
    const problems = error instanceof ConfigError ? error.problems : [errorMessage(error)];
    log({ event: "config_invalid", problems });
    io.exit(1);
    return undefined;
  }

  let running: RunningWorker;
  try {
    running = await (io.start ?? startWorkerProcess)(config, { log });
  } catch (error) {
    const causes = errorCauses(error);
    log({
      event: "startup_failed",
      message: errorMessage(error),
      ...(causes.length === 0 ? {} : { causes }),
    });
    io.exit(1);
    return undefined;
  }

  let signalled = false;
  io.onSignal(SHUTDOWN_SIGNALS, (signal) => {
    if (signalled) return;
    signalled = true;
    log({ event: "signal", signal });
    const timer = setTimeout(() => {
      log({ event: "shutdown_timeout", ms: io.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS });
      io.exit(1);
    }, io.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    running.stop().then(
      () => {
        clearTimeout(timer);
        io.exit(0);
      },
      () => {
        clearTimeout(timer);
        io.exit(1);
      },
    );
  });
  return running;
}
