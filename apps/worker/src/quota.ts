import { createDb, type AnyDatabase } from "@gitinside/db";
import { ConfigError, quotaConfigFromEnv, type QuotaConfig } from "./config.js";
import { createJsonLog, errorFields } from "./log.js";
import type { DbConnection } from "./main.js";
import { createCountedStore, logQuotas, measureQuotas, type QuotaLimits } from "./maintenance.js";
import type { ObjectStore, StoreConfig } from "./storage.js";

/**
 * `node dist/quota-bin.js` (`pnpm --filter @gitinside/worker quota`, run from a checkout with
 * production's values, infra/gcp/README.md): the quota check M5.13's smoke test
 * runs (ADR-0078). It measures the bucket, the database, the month's bucket requests
 * (ADR-0096), and the month's Google compute (Cloud Run vCPU- and GB-seconds and requests,
 * Cloud Tasks operations; ADR-0156) against the free limits and prints the worker's own
 * `quota` / `quota_alarm` JSON lines. A compute alarm means new analyses are paused until the
 * next UTC month. It deletes nothing; it only adds its own listing to the request count.
 *
 * Reads `DATABASE_URL` and the `SNAPSHOTS_*` variables only. Exit codes: 0 when every resource is
 * under 80%, 2 when any is in alarm, 1 when the config is invalid or a measurement failed.
 */

/** What {@link runQuota} needs from the process (tests fake all of it). */
export interface QuotaIo {
  env: Readonly<Record<string, string | undefined>>;
  /** Writes one log line (stdout in production). */
  write: (line: string) => void;
  /** Default `createDb` on the URL, one connection. */
  openDb?: (url: string) => DbConnection;
  /** Default {@link createCountedStore}: the check's own listing counts as worker requests. */
  openStore?: (config: StoreConfig, db: AnyDatabase) => Pick<ObjectStore, "list">;
  limits?: QuotaLimits;
}

/** Exit code when a resource is at or past the alarm threshold. */
export const QUOTA_ALARM_EXIT = 2;

/** Measure, print, and return the exit code. */
export async function runQuota(io: QuotaIo): Promise<number> {
  const log = createJsonLog(io.write);
  let config: QuotaConfig;
  try {
    config = quotaConfigFromEnv(io.env);
  } catch (error) {
    const problems = error instanceof ConfigError ? error.problems : [String(error)];
    log({ event: "config_invalid", problems });
    return 1;
  }

  const { db, close } = (io.openDb ?? ((url) => createDb(url, { max: 1 })))(config.databaseUrl);
  try {
    const quotas = await measureQuotas({
      db,
      store: (io.openStore ?? ((store, db) => createCountedStore(store, db, log)))(
        config.store,
        db,
      ),
      ...(io.limits === undefined ? {} : { limits: io.limits }),
    });
    logQuotas(log, quotas);
    return quotas.some((quota) => quota.alarm) ? QUOTA_ALARM_EXIT : 0;
  } catch (error) {
    log({ event: "quota_failed", ...errorFields(error) });
    return 1;
  } finally {
    await close().catch(() => undefined);
  }
}
