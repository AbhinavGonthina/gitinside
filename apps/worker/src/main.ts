import type { AddressInfo } from "node:net";
import { ANALYZER_VERSION } from "@gitinside/analyzer";
import { createDb, failInterruptedAnalyses, type AnyDatabase } from "@gitinside/db";
import { createEnqueueServer } from "./api.js";
import { ConfigError, redisConnection, workerConfigFromEnv, type WorkerConfig } from "./config.js";
import type { DownloadOptions } from "./github.js";
import { sweepJobsRoot, type JobDeps } from "./job.js";
import { createJsonLog } from "./log.js";
import {
  WORKER_CONCURRENCY,
  createAnalysisWorker,
  createBullJobQueue,
  stopWorker,
  type WorkerLog,
} from "./queue.js";
import {
  createCountedStore,
  runMaintenance,
  scheduleMaintenance,
  type MaintenanceSchedule,
} from "./maintenance.js";
import { createAnalysisRecorder } from "./record.js";

/**
 * The worker process (ADR-0065): one container on the VM runs the BullMQ worker and the
 * enqueue API side by side, sharing the Redis queue.
 *
 * **Startup, in order** (any failure closes what was opened and exits 1, so Docker restarts it):
 * 1. Open Postgres.
 * 2. **Sweep:** delete leftover job folders (a SIGKILL skips a job's own cleanup), then mark
 *    analyses still `running` from before this start `failed` (`JOB_INTERRUPTED`). A job that
 *    BullMQ re-runs moves its row back to `running`.
 * 3. Connect to Redis and check it answers, so a bad `REDIS_URL` fails here, loudly.
 * 4. Start the worker (recorder + `publish` = bucket then Postgres; every bucket request
 *    counted in `store_requests`, ADR-0096), the hourly maintenance
 *    (retention, rate-limit pruning, quota check; maintenance.ts), then the enqueue API.
 *
 * **Shutdown** ({@link RunningWorker.stop}, on SIGTERM or SIGINT): stop accepting API
 * requests, stop the maintenance schedule (waiting for a run in progress), cancel running jobs (`CANCELLED` is retriable, so they run again after the
 * restart) and wait for the worker, then close the queue and the database. Each step runs
 * even if an earlier one failed.
 */

/** The worker as started by {@link startWorkerProcess}. */
export interface RunningWorker {
  /** Where the enqueue API listens. */
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
  /** GitHub endpoints (tests point them at a fake); the token comes from the config. */
  github?: Omit<DownloadOptions, "signal" | "token">;
  /** Redis key prefix (tests isolate themselves with it). */
  prefix?: string;
  /** Queue call timeout, incl. the startup check (default 5 s). */
  queueCallTimeoutMs?: number;
  /** The analysis runner and its limits (tests stub the child). */
  jobDeps?: Pick<JobDeps, "run" | "runOptions">;
  /** Maintenance timing (maintenance.ts defaults), or `false` for none. */
  maintenance?: Pick<MaintenanceSchedule, "firstDelayMs" | "intervalMs"> | false;
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

/** Start the worker and the enqueue API from a checked config. */
export async function startWorkerProcess(
  config: WorkerConfig,
  options: StartOptions = {},
): Promise<RunningWorker> {
  const log = options.log ?? (() => undefined);
  const analyzerVersion = options.analyzerVersion ?? ANALYZER_VERSION;
  const startedAt = new Date();
  log({
    event: "worker_starting",
    analyzerVersion,
    concurrency: WORKER_CONCURRENCY,
    jobsRoot: config.jobsRoot,
    githubToken: config.githubToken !== undefined,
  });

  // Undone in reverse if a later step fails.
  const cleanup: [string, () => Promise<void>][] = [];
  const undo = () => runAll([...cleanup].reverse(), log).catch(() => undefined);
  try {
    const { db, close: closeDb } = (options.openDb ?? createDb)(config.databaseUrl);
    cleanup.push(["database", closeDb]);

    const folders = await sweepJobsRoot(config.jobsRoot);
    const interrupted = await failInterruptedAnalyses(db, startedAt);
    log({ event: "startup_sweep", folders, interrupted });

    const connection = redisConnection(config);
    const prefix = options.prefix === undefined ? {} : { prefix: options.prefix };
    const queue = createBullJobQueue({
      connection,
      ...prefix,
      ...(options.queueCallTimeoutMs === undefined
        ? {}
        : { callTimeoutMs: options.queueCallTimeoutMs }),
    });
    cleanup.push(["queue", () => queue.close()]);
    await queue.ping();

    const github = {
      ...options.github,
      ...(config.githubToken === undefined ? {} : { token: config.githubToken }),
    };
    const store = createCountedStore(config.store, db, log);
    const recorder = createAnalysisRecorder({
      db,
      store,
      analyzerVersion,
      github,
    });
    // Registered before the worker, so shutdown cancels jobs first and only then waits
    // for a maintenance run (a long bucket listing must not keep jobs past the deadline).
    if (options.maintenance !== false) {
      const maintenance = scheduleMaintenance({
        run: () => runMaintenance({ db, store, jobs: queue, log }),
        log,
        ...options.maintenance,
      });
      cleanup.push(["maintenance", () => maintenance.stop()]);
    }

    const worker = createAnalysisWorker({
      connection,
      ...prefix,
      log,
      deps: {
        ...options.jobDeps,
        jobsRoot: config.jobsRoot,
        recorder,
        publish: recorder.publish,
        download: github,
      },
    });
    cleanup.push(["worker", () => stopWorker(worker)]);

    const server = createEnqueueServer({ queue, secrets: config.secrets, analyzerVersion });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeIdleConnections();
      });
    cleanup.push(["server", closeServer]);
    server.on("error", (error) => log({ event: "server_error", message: error.message }));

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
 * How long a shutdown may take before the process exits 1 anyway. Cancelled jobs end at
 * once (their child is killed), so this covers closing connections; the container's stop
 * grace period (M5.10) must be longer.
 */
export const SHUTDOWN_TIMEOUT_MS = 20_000;

/** Shutdown signals: Docker's stop sends SIGTERM, a terminal Ctrl+C SIGINT. */
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
    log({ event: "startup_failed", message: errorMessage(error) });
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
