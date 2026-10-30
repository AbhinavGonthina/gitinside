import { databaseSizeBytes, pruneRateLimits, type AnyDatabase } from "@gitinside/db";
import type { CompletedJobs, WorkerLog } from "./queue.js";
import { runRetention, type RetentionPolicy, type RetentionReport } from "./retention.js";
import type { ObjectStore } from "./storage.js";

/**
 * The worker's hourly maintenance (ADR-0078), keeping GitInside inside its free tiers
 * (SPEC §5, DESIGN.md §10 and §12):
 *
 * 1. **Retention** ({@link runRetention}): evict snapshots past the rules (and their
 *    completed jobs), delete orphans.
 * 2. **Rate-limit pruning** (`pruneRateLimits`): drop windows that ended over an hour ago.
 * 3. **Quota check** ({@link measureQuotas}): measure the bucket (a fresh listing, after
 *    retention deleted what it could) and the database, against {@link QUOTA_LIMITS}. Each
 *    resource at or past {@link QUOTA_ALARM_RATIO} logs a `quota_alarm` line, which is
 *    the signal to open a `needs-abhinav` issue (DESIGN.md §12). The worker can't open one
 *    itself: it holds no token that may write issues.
 *
 * Each step runs even if an earlier one failed; a failure is logged with the step's name
 * and never stops the worker. {@link scheduleMaintenance} runs it a minute after startup
 * (so a crash loop still runs it), then an hour after each run ends, never two at once.
 */

/** The free tiers' storage limits, in bytes. */
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
}

/** The limits {@link measureQuotas} checks by default. */
export const QUOTA_LIMITS: QuotaLimits = {
  bucketBytes: 20_000_000_000,
  databaseBytes: 1_000_000_000,
};

/** Usage at or past this share of a limit raises the alarm (SECURITY.md T9). */
export const QUOTA_ALARM_RATIO = 0.8;

/** One resource measured against its limit. */
export interface QuotaUsage {
  resource: "bucket" | "database";
  usedBytes: number;
  limitBytes: number;
  /** `usedBytes / limitBytes` as a percentage, rounded down to 0.1. */
  percent: number;
  /** At or past {@link QUOTA_ALARM_RATIO}. */
  alarm: boolean;
}

/** Compare measured bytes with the limits. Pure; bucket first, then database. */
export function checkQuotas(
  used: { bucketBytes: number; databaseBytes: number },
  limits: QuotaLimits = QUOTA_LIMITS,
): QuotaUsage[] {
  const usage = (
    resource: QuotaUsage["resource"],
    usedBytes: number,
    limitBytes: number,
  ): QuotaUsage => ({
    resource,
    usedBytes,
    limitBytes,
    percent: Math.floor((usedBytes / limitBytes) * 1000) / 10,
    alarm: usedBytes >= limitBytes * QUOTA_ALARM_RATIO,
  });
  return [
    usage("bucket", used.bucketBytes, limits.bucketBytes),
    usage("database", used.databaseBytes, limits.databaseBytes),
  ];
}

/** What {@link measureQuotas} reads. */
export interface QuotaDeps {
  db: AnyDatabase;
  store: Pick<ObjectStore, "list">;
  limits?: QuotaLimits;
}

/**
 * Measure the whole bucket (its listing, what the free tier counts) and the database, and check them.
 * Read-only. Rejects if either can't be measured.
 */
export async function measureQuotas(deps: QuotaDeps): Promise<QuotaUsage[]> {
  let bucketBytes = 0;
  for await (const object of deps.store.list()) bucketBytes += object.size;
  const databaseBytes = await databaseSizeBytes(deps.db);
  return checkQuotas({ bucketBytes, databaseBytes }, deps.limits);
}

/** Log one `quota` line with every resource, then a `quota_alarm` line per resource in alarm. */
export function logQuotas(log: WorkerLog, quotas: readonly QuotaUsage[]): void {
  log({ event: "quota", quotas });
  for (const quota of quotas) {
    if (quota.alarm) log({ event: "quota_alarm", ...quota });
  }
}

/** What {@link runMaintenance} needs. */
export interface MaintenanceDeps extends QuotaDeps {
  store: Pick<ObjectStore, "list" | "delete">;
  /** Retention removes deleted rows' completed jobs from it (ADR-0082). */
  jobs?: CompletedJobs;
  log: WorkerLog;
  /** Retention's clock and rules (tests fix them). */
  now?: () => Date;
  policy?: RetentionPolicy;
}

/** What a run did; a step that failed is missing and named in `failed`. */
export interface MaintenanceReport {
  retention?: RetentionReport;
  rateLimitsPruned?: number;
  quotas?: QuotaUsage[];
  failed: ("retention" | "rate_limits" | "quota")[];
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Run retention, rate-limit pruning, and the quota check once, logging each. Never rejects. */
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

  const retention = await step("retention", () =>
    runRetention({
      db,
      store,
      ...(deps.jobs === undefined ? {} : { jobs: deps.jobs }),
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

  const quotas = await step("quota", () =>
    measureQuotas({ db, store, ...(deps.limits === undefined ? {} : { limits: deps.limits }) }),
  );
  if (quotas !== undefined) {
    report.quotas = quotas;
    logQuotas(log, quotas);
  }
  return report;
}

/** Delay before the first run after startup. */
export const MAINTENANCE_FIRST_DELAY_MS = 60_000;
/** Delay between the end of one run and the start of the next. */
export const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

/** Options for {@link scheduleMaintenance}. */
export interface MaintenanceSchedule {
  /** One maintenance run; a rejection is logged and the schedule goes on. */
  run: () => Promise<unknown>;
  log: WorkerLog;
  /** Default {@link MAINTENANCE_FIRST_DELAY_MS}. */
  firstDelayMs?: number;
  /** Default {@link MAINTENANCE_INTERVAL_MS}. */
  intervalMs?: number;
}

/** A running schedule. */
export interface ScheduledMaintenance {
  /** Cancel the next run and wait for one in progress; repeated calls are safe. */
  stop(): Promise<void>;
}

/**
 * Run `run` after `firstDelayMs`, then `intervalMs` after each run ends, until stopped.
 * Timers are unref'd, so the schedule alone never keeps the process alive.
 */
export function scheduleMaintenance(schedule: MaintenanceSchedule): ScheduledMaintenance {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;

  const arm = (ms: number) => {
    timer = setTimeout(() => {
      timer = undefined;
      current = schedule
        .run()
        .then(
          () => undefined,
          (error: unknown) =>
            schedule.log({
              event: "maintenance_failed",
              step: "run",
              message: errorMessage(error),
            }),
        )
        .then(() => {
          current = undefined;
          if (!stopped) arm(schedule.intervalMs ?? MAINTENANCE_INTERVAL_MS);
        });
    }, ms);
    timer.unref();
  };
  arm(schedule.firstDelayMs ?? MAINTENANCE_FIRST_DELAY_MS);

  return {
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await current;
    },
  };
}
