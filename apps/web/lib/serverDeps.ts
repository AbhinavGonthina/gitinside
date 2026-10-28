import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import { createDb, type DbHandle } from "@gitinside/db";
import { MIN_SECRET_LENGTH } from "@gitinside/worker/hmac";
import type { AnalyzeDeps } from "./analyze";
import { createWorkerClient } from "./worker";

/**
 * `/api/analyze`'s dependencies from the environment (names in `apps/web/.env.example`,
 * ADR-0055, ADR-0066):
 *
 * - `DATABASE_URL` (Neon's pooled string), `WORKER_URL`, `ENQUEUE_HMAC_SECRET`: required.
 *   If one is missing or the secret is short, the API answers "temporarily unavailable"
 *   instead of failing on every request; nothing is logged with a value.
 * - `GITHUB_TOKEN`: optional, raises GitHub's limit from 60 to 5,000 requests an hour.
 *
 * One database connection per serverless instance (`max: 1`), opened on first use and kept.
 */

/** Signed-out analyses per hour per address (SPEC §3). */
export const SIGNED_OUT_HOURLY_LIMIT = 5;

let handle: { url: string; db: DbHandle } | undefined;

/** Build the deps from `env`, or `undefined` if the server isn't configured. */
export function analyzeDepsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AnalyzeDeps | undefined {
  const { DATABASE_URL: databaseUrl, WORKER_URL: workerUrl, ENQUEUE_HMAC_SECRET: secret } = env;
  if (!databaseUrl || !workerUrl || !secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  try {
    if (new URL(workerUrl).protocol !== "https:" && env.NODE_ENV === "production") return undefined;
  } catch {
    return undefined;
  }
  if (handle?.url !== databaseUrl) {
    handle = { url: databaseUrl, db: createDb(databaseUrl, { max: 1 }) };
  }
  return {
    db: handle.db.db,
    worker: createWorkerClient({ url: workerUrl, secret }),
    github: env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {},
    analyzerVersion: ANALYZER_VERSION,
    rateLimitSecret: secret,
    hourlyLimit: SIGNED_OUT_HOURLY_LIMIT,
  };
}
