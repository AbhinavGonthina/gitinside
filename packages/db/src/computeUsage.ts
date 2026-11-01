/**
 * Google compute GitInside uses per UTC calendar month, against the free allowance (#11,
 * ADR-0156). After its trial, Cloud Run bills what goes past the monthly free tier, so new
 * analyses pause at {@link COMPUTE_PAUSE_RATIO} of it until the next month; diagrams already
 * made keep working (they never touch Google).
 *
 * - **What's counted** (`compute_usage`, one row a month, added to in one statement, so
 *   concurrent processes never lose an increment): the worker's billed Cloud Run instance
 *   time in ms, its Cloud Run requests, and Cloud Tasks operations. Who counts what is in
 *   the worker's `compute.ts` and the website's `enqueue.ts`.
 * - **What it's worth:** each instance-second is {@link WORKER_VCPUS} vCPU-seconds and
 *   {@link WORKER_MEMORY_GB} GB-seconds, the worker's fixed size (infra/gcp).
 * - **Months** start on the database clock's UTC month, as for `store_requests`. Google's
 *   own month boundary may not be UTC midnight (Pacific time is believed, not verified), so
 *   a pause can end hours before Google's month does; the 20% margin covers that.
 */
import { sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { computeUsage } from "./schema.js";

/** Google's monthly free allowance for what the worker uses. */
export interface ComputeAllowance {
  /** Cloud Run, request-based billing: 180,000 vCPU-seconds a month. */
  vcpuSeconds: number;
  /** Cloud Run, request-based billing: 360,000 GB-seconds of memory a month. */
  memoryGbSeconds: number;
  /** Cloud Run, request-based billing: 2 million requests a month. */
  runRequests: number;
  /** Cloud Tasks: 1 million operations a month (ADR-0114). */
  taskOperations: number;
}

/**
 * The free allowance, from Google's free-tier page (Cloud Run's three figures, read
 * 2026-11-01) and ADR-0114 (Cloud Tasks; its pricing page didn't render to check again).
 */
export const COMPUTE_ALLOWANCE: ComputeAllowance = {
  vcpuSeconds: 180_000,
  memoryGbSeconds: 360_000,
  runRequests: 2_000_000,
  taskOperations: 1_000_000,
};

/** vCPUs per worker instance (infra/gcp/service.json). */
export const WORKER_VCPUS = 1;
/**
 * Memory per worker instance in GB: 4 GiB (infra/gcp/service.json) is 4.295 GB. Google's free
 * tier says "GB-seconds"; counting the larger figure pauses earlier, never later.
 */
export const WORKER_MEMORY_GB = 4 * 1.073_741_824;
/** New analyses pause at this share of any allowance (SECURITY.md T9). */
export const COMPUTE_PAUSE_RATIO = 0.8;

/** This month's counts by {@link computeUsageThisMonth}. */
export interface ComputeUsage {
  /** When the UTC month began, and when the next one begins. */
  monthStart: Date;
  nextMonthStart: Date;
  /** Billed Cloud Run instance time. */
  instanceMs: number;
  runRequests: number;
  taskOperations: number;
}

/** What to add with {@link countComputeUsage}; each a non-negative integer, at least one positive. */
export interface ComputeCount {
  instanceMs?: number;
  runRequests?: number;
  taskOperations?: number;
}

/** One allowance and what this month used of it. */
export interface ComputeMeter {
  resource: "cloud_run_vcpu" | "cloud_run_memory" | "cloud_run_requests" | "cloud_tasks";
  unit: "vcpu_seconds" | "gb_seconds" | "requests" | "operations";
  used: number;
  limit: number;
  /** `used / limit` as a percentage, rounded down to 0.1. */
  percent: number;
  /** At or past {@link COMPUTE_PAUSE_RATIO}: new analyses are paused. */
  alarm: boolean;
}

/** The current UTC month on the database clock. */
const MONTH = sql`date_trunc('month', now(), 'UTC')`;

/** Add to this month's counts. */
export async function countComputeUsage(db: AnyDatabase, count: ComputeCount): Promise<void> {
  const instanceMs = count.instanceMs ?? 0;
  const runRequests = count.runRequests ?? 0;
  const taskOperations = count.taskOperations ?? 0;
  const amounts = [instanceMs, runRequests, taskOperations];
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
    throw new Error("compute counts must be non-negative integers");
  }
  if (amounts.every((amount) => amount === 0)) throw new Error("nothing to count");
  await db
    .insert(computeUsage)
    .values({ monthStart: MONTH, instanceMs, runRequests, taskOperations })
    .onConflictDoUpdate({
      target: computeUsage.monthStart,
      set: {
        instanceMs: sql`${computeUsage.instanceMs} + ${instanceMs}`,
        runRequests: sql`${computeUsage.runRequests} + ${runRequests}`,
        taskOperations: sql`${computeUsage.taskOperations} + ${taskOperations}`,
      },
    });
}

/** This UTC month's counts (zero if none yet). */
export async function computeUsageThisMonth(db: AnyDatabase): Promise<ComputeUsage> {
  // One statement, so the month and its counts come from the same clock reading. An
  // aggregate without `group by` returns its row even when the month has none.
  const result: unknown = await db.execute(sql`
    select extract(epoch from ${MONTH})::text as month_start,
      coalesce(sum(${computeUsage.instanceMs}), 0)::text as instance_ms,
      coalesce(sum(${computeUsage.runRequests}), 0)::text as run_requests,
      coalesce(sum(${computeUsage.taskOperations}), 0)::text as task_operations
    from ${computeUsage}
    where ${computeUsage.monthStart} = ${MONTH}`);
  // postgres.js returns an array of rows, PGlite an object with `rows`.
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
    month_start: string;
    instance_ms: string;
    run_requests: string;
    task_operations: string;
  }[];
  const [row] = rows;
  if (row === undefined) throw new Error("the month's compute count returned no row");
  const monthStart = new Date(Number(row.month_start) * 1000);
  return {
    monthStart,
    nextMonthStart: new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1)),
    instanceMs: Number(row.instance_ms),
    runRequests: Number(row.run_requests),
    taskOperations: Number(row.task_operations),
  };
}

/** Each allowance against `usage`. Pure; vCPU, memory, Cloud Run requests, Cloud Tasks. */
export function computeMeters(
  usage: Pick<ComputeUsage, "instanceMs" | "runRequests" | "taskOperations">,
  allowance: ComputeAllowance = COMPUTE_ALLOWANCE,
): ComputeMeter[] {
  const meter = (
    resource: ComputeMeter["resource"],
    unit: ComputeMeter["unit"],
    used: number,
    limit: number,
  ): ComputeMeter => ({
    resource,
    unit,
    used,
    limit,
    percent: Math.floor((used / limit) * 1000) / 10,
    alarm: used >= limit * COMPUTE_PAUSE_RATIO,
  });
  const seconds = usage.instanceMs / 1000;
  return [
    meter("cloud_run_vcpu", "vcpu_seconds", seconds * WORKER_VCPUS, allowance.vcpuSeconds),
    meter("cloud_run_memory", "gb_seconds", seconds * WORKER_MEMORY_GB, allowance.memoryGbSeconds),
    meter("cloud_run_requests", "requests", usage.runRequests, allowance.runRequests),
    meter("cloud_tasks", "operations", usage.taskOperations, allowance.taskOperations),
  ];
}

/** Why new analyses are paused, by {@link findComputePause}. */
export interface ComputePause {
  /** When the pause ends: the next UTC month. */
  until: Date;
  /** The allowances at or past the pause ratio. */
  meters: ComputeMeter[];
}

/** Whether new analyses are paused this month; `undefined` when not. */
export async function findComputePause(
  db: AnyDatabase,
  allowance: ComputeAllowance = COMPUTE_ALLOWANCE,
): Promise<ComputePause | undefined> {
  const usage = await computeUsageThisMonth(db);
  const meters = computeMeters(usage, allowance).filter((meter) => meter.alarm);
  return meters.length === 0 ? undefined : { until: usage.nextMonthStart, meters };
}
