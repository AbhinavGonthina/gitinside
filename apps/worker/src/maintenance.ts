import {
  claimMaintenance,
  computeMeters,
  computeUsageThisMonth,
  countStoreRequests,
  databaseSizeBytes,
  deleteExpiredSessions,
  failInterruptedAnalyses,
  failStaleQueuedAnalyses,
  pruneRateLimits,
  storeRequestsThisMonth,
  type AnyDatabase,
  type ComputeAllowance,
  type ComputeMeter,
} from "@gitinside/db";
import type { WorkerLog } from "./attempt.js";
import { runRetention, type RetentionPolicy, type RetentionReport } from "./retention.js";
import { MAX_TASK_AGE_SECONDS } from "./run.js";
import {
  countingFetch,
  createObjectStore,
  type ObjectStore,
  type ObjectStoreOptions,
  type StoreConfig,
} from "./storage.js";

/**
 * The worker's hourly maintenance (ADR-0078, ADR-0147), keeping GitInside inside its free
 * tiers (SPEC §5, DESIGN.md §10 and §12) and its job rows honest:
 *
 * 1. **Stale jobs** (`failInterruptedAnalyses`, `failStaleQueuedAnalyses`): rows `running`
 *    for {@link INTERRUPTED_AFTER_SECONDS} (their instance died: no request lives that
 *    long) fail with `JOB_INTERRUPTED`; rows `queued` for {@link STALE_QUEUED_AFTER_SECONDS}
 *    (no task can still be accepted for them) fail with the retryable `QUEUE_UNAVAILABLE`.
 * 2. **Retention** ({@link runRetention}): evict snapshots past the rules, delete orphans.
 * 3. **Rate-limit pruning** (`pruneRateLimits`): drop windows that ended over an hour ago.
 * 4. **Session sweep** (`deleteExpiredSessions`, M8.2b): delete sign-in sessions that have
 *    ended, with their sealed GitHub tokens. Nothing reads them any more; this keeps tokens
 *    from lingering in the database.
 * 5. **Quota check** ({@link measureQuotas}): measure the bucket (a fresh listing, after
 *    retention deleted what it could), the database, and the month's bucket requests
 *    (`store_requests`, ADR-0096), against {@link QUOTA_LIMITS}, and the month's Google
 *    compute (`compute_usage`, ADR-0156) against its free allowance. Each
 *    resource at or past {@link QUOTA_ALARM_RATIO} logs a `quota_alarm` line, which is
 *    the signal to open a `needs-abhinav` issue (DESIGN.md §12). The worker can't open one
 *    itself: it holds no token that may write issues.
 *
 * Each step runs even if an earlier one failed; a failure is logged with the step's name
 * and never stops the worker.
 *
 * **When it runs** ({@link createMaintenanceTrigger}): Cloud Run gives an instance CPU only
 * while it serves a request, and scales to zero, so there is no always-on process for a
 * timer. Instead, at the end of each job (before its push is answered), the instance claims
 * the run in Postgres (`claimMaintenance`): only when the last one started an hour or more
 * ago, by the database's clock, and only one of two instances asking at once wins. With no
 * jobs nothing runs: snapshots only grow with jobs, and rate-limit windows or stranded rows
 * left meanwhile wait for the next job's run.
 */

/**
 * How long a row must have been `running` to be called interrupted: Cloud Run's 300 s
 * request timeout ends every attempt sooner, plus a minute's margin. Used by the startup
 * sweep and by maintenance; a younger row may be another instance's live job.
 */
export const INTERRUPTED_AFTER_SECONDS = 360;

/**
 * How long a row must have been `queued` (since it last entered the queue) to be called
 * stranded: a task's signature is accepted for {@link MAX_TASK_AGE_SECONDS} from its
 * creation, which comes right after the row's entry (or before it, for a retry's re-queue),
 * plus 10 minutes' margin. No task made for that entry can run any more.
 */
export const STALE_QUEUED_AFTER_SECONDS = MAX_TASK_AGE_SECONDS + 10 * 60;

/** The free tiers' limits: storage in bytes, bucket requests per month. */
export interface QuotaLimits {
  /**
   * Oracle Object Storage's Always Free 20 GB (ADR-0095), counted as 20 × 10⁹ bytes (the
   * smaller reading).
   */
  bucketBytes: number;
  /**
   * Neon's free plan storage: SPEC §5 assumes 1 GB, counted as 10⁹ bytes. Planning issue #4
   * asks for the figure Neon shows; replace this when it's reported.
   */
  databaseBytes: number;
  /**
   * Oracle Object Storage's Always Free 50,000 API requests a month (SPEC §5, ADR-0096),
   * worker and web together, as `store_requests` counts them.
   */
  monthlyRequests: number;
}

/** The limits {@link measureQuotas} checks by default. */
export const QUOTA_LIMITS: QuotaLimits = {
  bucketBytes: 20_000_000_000,
  databaseBytes: 1_000_000_000,
  monthlyRequests: 50_000,
};

/** Usage at or past this share of a limit raises the alarm (SECURITY.md T9). */
export const QUOTA_ALARM_RATIO = 0.8;

/** One resource measured against its limit. */
export interface QuotaUsage {
  resource: "bucket" | "database" | "requests";
  /** What `used` and `limit` count: stored bytes, or bucket requests this UTC month. */
  unit: "bytes" | "requests";
  used: number;
  limit: number;
  /** `used / limit` as a percentage, rounded down to 0.1. */
  percent: number;
  /** At or past {@link QUOTA_ALARM_RATIO}. */
  alarm: boolean;
  /** For `requests`: who made them. */
  bySource?: { worker: number; web: number };
}

/** What {@link checkQuotas} compares with the limits. */
export interface MeasuredUsage {
  bucketBytes: number;
  databaseBytes: number;
  /** Bucket requests this UTC month, per source. */
  requests: { worker: number; web: number };
}

/** Compare measured usage with the limits. Pure; bucket, then database, then requests. */
export function checkQuotas(used: MeasuredUsage, limits: QuotaLimits = QUOTA_LIMITS): QuotaUsage[] {
  const usage = (
    resource: QuotaUsage["resource"],
    unit: QuotaUsage["unit"],
    amount: number,
    limit: number,
  ): QuotaUsage => ({
    resource,
    unit,
    used: amount,
    limit,
    percent: Math.floor((amount / limit) * 1000) / 10,
    alarm: amount >= limit * QUOTA_ALARM_RATIO,
  });
  const { worker, web } = used.requests;
  return [
    usage("bucket", "bytes", used.bucketBytes, limits.bucketBytes),
    usage("database", "bytes", used.databaseBytes, limits.databaseBytes),
    {
      ...usage("requests", "requests", worker + web, limits.monthlyRequests),
      bySource: { worker, web },
    },
  ];
}

/**
 * The worker's bucket client, counting each request as `worker` in `store_requests`
 * (ADR-0096). A count that fails is logged as `store_request_count_failed`, and the
 * request goes on.
 */
export function createCountedStore(
  config: StoreConfig,
  db: AnyDatabase,
  log: WorkerLog,
  /** `fetch` is the one requests go out through once counted (tests fake it). */
  options: ObjectStoreOptions = {},
): ObjectStore {
  const { fetch: base, ...rest } = options;
  return createObjectStore(config, {
    ...rest,
    fetch: countingFetch({
      count: () => countStoreRequests(db, "worker"),
      onCountError: (error) =>
        log({ event: "store_request_count_failed", message: errorMessage(error) }),
      ...(base === undefined ? {} : { fetch: base }),
    }),
  });
}

/**
 * One measured resource: a free-tier store's ({@link QuotaUsage}) or Google compute's
 * (`ComputeMeter`, from `compute_usage`, ADR-0156: new analyses are paused while one is in
 * alarm).
 */
export type QuotaReading = QuotaUsage | ComputeMeter;

/** What {@link measureQuotas} reads. */
export interface QuotaDeps {
  db: AnyDatabase;
  store: Pick<ObjectStore, "list">;
  limits?: QuotaLimits;
  /** Default `COMPUTE_ALLOWANCE`. */
  compute?: ComputeAllowance;
}

/**
 * Measure the whole bucket (its listing, what the free tier counts), the database, and the
 * month's bucket requests (read after the listing, so its own requests are in it), and check
 * them; then the month's Google compute against its free allowance. Deletes nothing. Rejects
 * if any can't be measured.
 */
export async function measureQuotas(deps: QuotaDeps): Promise<QuotaReading[]> {
  let bucketBytes = 0;
  for await (const object of deps.store.list()) bucketBytes += object.size;
  const databaseBytes = await databaseSizeBytes(deps.db);
  const { worker, web } = await storeRequestsThisMonth(deps.db);
  const compute = await computeUsageThisMonth(deps.db);
  return [
    ...checkQuotas({ bucketBytes, databaseBytes, requests: { worker, web } }, deps.limits),
    ...computeMeters(compute, deps.compute),
  ];
}

/** Log one `quota` line with every resource, then a `quota_alarm` line per resource in alarm. */
export function logQuotas(log: WorkerLog, quotas: readonly QuotaReading[]): void {
  log({ event: "quota", quotas });
  for (const quota of quotas) {
    if (quota.alarm) log({ event: "quota_alarm", ...quota });
  }
}

/** What {@link runMaintenance} needs. */
export interface MaintenanceDeps extends QuotaDeps {
  store: Pick<ObjectStore, "list" | "delete">;
  log: WorkerLog;
  /** Retention's clock and rules (tests fix them). */
  now?: () => Date;
  policy?: RetentionPolicy;
}

/** What a run did; a step that failed is missing and named in `failed`. */
export interface MaintenanceReport {
  /** Rows failed as `running` too long (`interrupted`) and `queued` too long (`stranded`). */
  staleJobs?: { interrupted: number; stranded: number };
  retention?: RetentionReport;
  rateLimitsPruned?: number;
  /** Ended sign-in sessions deleted. */
  sessionsSwept?: number;
  quotas?: QuotaReading[];
  failed: ("stale_jobs" | "retention" | "rate_limits" | "sessions" | "quota")[];
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Run the stale-job sweep, retention, rate-limit pruning, the session sweep, and the quota
 * check once, logging each. Never rejects.
 */
export async function runMaintenance(deps: MaintenanceDeps): Promise<MaintenanceReport> {
  const { db, store, log } = deps;
  const report: MaintenanceReport = { failed: [] };
  const step = async <T>(
    name: MaintenanceReport["failed"][number],
    run: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      report.failed.push(name);
      log({ event: "maintenance_failed", step: name, message: errorMessage(error) });
      return undefined;
    }
  };

  const stale = await step("stale_jobs", async () => ({
    interrupted: await failInterruptedAnalyses(db, INTERRUPTED_AFTER_SECONDS),
    stranded: await failStaleQueuedAnalyses(db, STALE_QUEUED_AFTER_SECONDS),
  }));
  if (stale !== undefined) {
    report.staleJobs = stale;
    log({ event: "stale_jobs_failed", ...stale });
  }

  const retention = await step("retention", () =>
    runRetention({
      db,
      store,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.policy === undefined ? {} : { policy: deps.policy }),
    }),
  );
  if (retention !== undefined) {
    report.retention = retention;
    log({ event: "retention_run", ...retention });
  }

  const pruned = await step("rate_limits", () => pruneRateLimits(db));
  if (pruned !== undefined) {
    report.rateLimitsPruned = pruned;
    log({ event: "rate_limits_pruned", rows: pruned });
  }

  const swept = await step("sessions", () => deleteExpiredSessions(db));
  if (swept !== undefined) {
    report.sessionsSwept = swept;
    log({ event: "sessions_swept", rows: swept });
  }

  const quotas = await step("quota", () =>
    measureQuotas({ db, store, ...(deps.limits === undefined ? {} : { limits: deps.limits }) }),
  );
  if (quotas !== undefined) {
    report.quotas = quotas;
    logQuotas(log, quotas);
  }
  return report;
}

/** The maintenance task's name in `maintenance_runs`. */
export const MAINTENANCE_TASK = "hourly";
/** The least time between two runs' starts, by the database's clock. */
export const MAINTENANCE_EVERY_SECONDS = 60 * 60;
/**
 * The least time a job's budget must have left for maintenance to start after it: a run is
 * a few database statements and two bucket listings, seconds at the bucket's size.
 */
export const MAINTENANCE_MIN_TIME_LEFT_MS = 60_000;

/** Options for {@link createMaintenanceTrigger}. */
export interface MaintenanceTriggerOptions {
  /** Where the claim is recorded. */
  db: AnyDatabase;
  /** One maintenance run; a rejection is logged. */
  run: () => Promise<unknown>;
  log: WorkerLog;
  /** Default {@link MAINTENANCE_EVERY_SECONDS}. */
  everySeconds?: number;
  /** Default {@link MAINTENANCE_MIN_TIME_LEFT_MS}. */
  minTimeLeftMs?: number;
}

/** What a finished job tells {@link MaintenanceTrigger.afterJob}. */
export interface JobEnd {
  /** What's left of the job's budget, in ms: the push must still be answered in time. */
  timeLeftMs: number;
  /** Aborted on shutdown or when the caller hangs up: stop waiting at once. */
  signal?: AbortSignal;
}

/** Maintenance run at the end of jobs. */
export interface MaintenanceTrigger {
  /**
   * After a job, before its push is answered: if there's time, no run in progress here, and
   * this instance wins the hourly claim, start a run and wait for it, but no longer than the
   * job's time left (or until `signal` aborts). A run still going then carries on unawaited
   * (on Cloud Run with little CPU until the next request). Never rejects; returns whether a
   * run started.
   */
  afterJob(end: JobEnd): Promise<boolean>;
  /** Start nothing more, and wait for a run in progress; repeated calls are safe. */
  stop(): Promise<void>;
}

/** Build the trigger the run server calls after each job (ADR-0147). */
export function createMaintenanceTrigger(options: MaintenanceTriggerOptions): MaintenanceTrigger {
  const { db, log } = options;
  const everySeconds = options.everySeconds ?? MAINTENANCE_EVERY_SECONDS;
  const minTimeLeftMs = options.minTimeLeftMs ?? MAINTENANCE_MIN_TIME_LEFT_MS;
  let stopped = false;
  let current: Promise<void> | undefined;

  async function afterJob({ timeLeftMs, signal }: JobEnd): Promise<boolean> {
    if (stopped || current !== undefined || signal?.aborted === true) return false;
    if (timeLeftMs < minTimeLeftMs) return false;
    let claimed: boolean;
    try {
      claimed = await claimMaintenance(db, MAINTENANCE_TASK, everySeconds);
    } catch (error) {
      log({ event: "maintenance_failed", step: "claim", message: errorMessage(error) });
      return false;
    }
    if (!claimed || stopped) return false;

    log({ event: "maintenance_started" });
    const run = options.run().then(
      () => undefined,
      (error: unknown) =>
        log({ event: "maintenance_failed", step: "run", message: errorMessage(error) }),
    );
    current = run.then(() => {
      current = undefined;
    });

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const enough = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeLeftMs));
      timer.unref();
      if (signal !== undefined) {
        onAbort = resolve;
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    await Promise.race([current, enough]);
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    if (current !== undefined) log({ event: "maintenance_unawaited", timeLeftMs });
    return true;
  }

  return {
    afterJob,
    stop: async () => {
      stopped = true;
      await current;
    },
  };
}
