import { createDb } from "@gitinside/db";
import { ConfigError, quotaConfigFromEnv, type QuotaConfig } from "./config.js";
import { createJsonLog } from "./log.js";
import type { DbConnection } from "./main.js";
import { logQuotas, measureQuotas, type QuotaLimits } from "./maintenance.js";
import { createObjectStore, type ObjectStore, type StoreConfig } from "./storage.js";

/**
 * `node dist/quota-bin.js` (`pnpm --filter @gitinside/worker quota`; on the VM,
 * `docker compose exec worker node dist/quota-bin.js`): the quota check M5.13's smoke test
 * runs (ADR-0078). It measures the bucket and the database against the free limits and
 * prints the worker's own `quota` / `quota_alarm` JSON lines. Read-only: it deletes nothing.
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
  /** Default `createObjectStore`. */
  openStore?: (config: StoreConfig) => Pick<ObjectStore, "list">;
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
      store: (io.openStore ?? createObjectStore)(config.store),
      ...(io.limits === undefined ? {} : { limits: io.limits }),
    });
    logQuotas(log, quotas);
    return quotas.some((quota) => quota.alarm) ? QUOTA_ALARM_EXIT : 0;
  } catch (error) {
    log({ event: "quota_failed", message: error instanceof Error ? error.message : String(error) });
    return 1;
  } finally {
    await close().catch(() => undefined);
  }
}
