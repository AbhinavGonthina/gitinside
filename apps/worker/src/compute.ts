import { countComputeUsage, type AnyDatabase, type ComputeCount } from "@gitinside/db";
import type { WorkerLog } from "./attempt.js";

/**
 * The worker's share of the monthly compute count (`compute_usage`, #11, ADR-0156): what
 * Cloud Run bills it for, as best the instance itself can measure. Google's docs: an
 * instance with request-based billing "is only charged when [it processes] requests, when
 * [it starts], and when [it shuts] down." So:
 *
 * - **Startup** ({@link UsageMeter.startup}, once per instance when it's listening): the
 *   process's age then, plus {@link SHUTDOWN_ALLOWANCE_MS} for its shutdown, counted up
 *   front because Cloud Run may kill the instance before a count at shutdown could land.
 *   Time before the process started (pulling and starting the container) isn't seen.
 * - **Each push** ({@link UsageMeter.push}, before it's answered, while the instance still
 *   has CPU): the request's time so far, one Cloud Run request, and one Cloud Tasks
 *   operation (the delivery; the website counts creating the task). A push answered `429`
 *   while a job runs overlaps it and is counted on top: an overcount, never an undercount.
 * - **Rounding:** each figure is rounded up to {@link BILLING_STEP_MS}, at least one step.
 *
 * A count that fails is logged (`compute_count_failed`) and the request goes on: the meter
 * must never fail a job. `GET /health` isn't counted (Cloud Run's probes run during startup).
 */

/** Each billed time is rounded up to this, at least once. */
export const BILLING_STEP_MS = 100;
/** The most a shutdown can bill: Cloud Run sends SIGKILL 10 s after SIGTERM. */
export const SHUTDOWN_ALLOWANCE_MS = 10_000;

/** `ms` rounded up to whole {@link BILLING_STEP_MS} steps, at least one. */
export function billedMs(ms: number): number {
  const steps = Number.isFinite(ms) ? Math.ceil(ms / BILLING_STEP_MS) : 1;
  return Math.max(1, steps) * BILLING_STEP_MS;
}

/** Counts the instance's own compute. Neither method rejects. */
export interface UsageMeter {
  /** The instance is listening, `ms` after its process started. */
  startup(ms: number): Promise<void>;
  /** A push is about to be answered, `ms` after it arrived. */
  push(ms: number): Promise<void>;
}

/** A {@link UsageMeter} adding to `compute_usage` in `db`. */
export function createUsageMeter(options: { db: AnyDatabase; log: WorkerLog }): UsageMeter {
  const { db, log } = options;
  const count = async (what: "startup" | "push", amounts: ComputeCount): Promise<void> => {
    try {
      await countComputeUsage(db, amounts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log({ event: "compute_count_failed", what, message });
    }
  };
  return {
    startup: (ms) => count("startup", { instanceMs: billedMs(ms) + SHUTDOWN_ALLOWANCE_MS }),
    push: (ms) => count("push", { instanceMs: billedMs(ms), runRequests: 1, taskOperations: 1 }),
  };
}
