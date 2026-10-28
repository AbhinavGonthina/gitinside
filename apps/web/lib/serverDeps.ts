import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import { createDb, type DbHandle } from "@gitinside/db";
import { MIN_SECRET_LENGTH } from "@gitinside/worker/hmac";
import type { AnalyzeDeps } from "./analyze";
import type { JobRouteDeps } from "./jobRoute";
import { createWorkerClient } from "./worker";

/**
 * The API routes' dependencies from the environment (names in `apps/web/.env.example`,
 * ADR-0055, ADR-0066, ADR-0067):
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

type Env = Readonly<Record<string, string | undefined>>;

/** `WORKER_URL` and `ENQUEUE_HMAC_SECRET` if both are usable (https in production). */
function workerConfig(env: Env): { url: string; secret: string } | undefined {
  const { WORKER_URL: url, ENQUEUE_HMAC_SECRET: secret } = env;
  if (!url || !secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  try {
    if (new URL(url).protocol !== "https:" && env.NODE_ENV === "production") return undefined;
  } catch {
    return undefined;
  }
  return { url, secret };
}

/**
 * The job routes' deps (`/api/jobs/:id`, ADR-0067): only the worker, so watching a job
 * needs no database connection. `undefined` if the worker isn't configured.
 */
export function jobDepsFromEnv(env: Env = process.env): JobRouteDeps | undefined {
  const config = workerConfig(env);
  return config && { worker: createWorkerClient(config) };
}

/** Build the deps from `env`, or `undefined` if the server isn't configured. */
export function analyzeDepsFromEnv(env: Env = process.env): AnalyzeDeps | undefined {
  const { DATABASE_URL: databaseUrl } = env;
  const config = workerConfig(env);
  if (!databaseUrl || !config) return undefined;
  if (handle?.url !== databaseUrl) {
    handle = { url: databaseUrl, db: createDb(databaseUrl, { max: 1 }) };
  }
  const { secret } = config;
  return {
    db: handle.db.db,
    worker: createWorkerClient(config),
    github: env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {},
    analyzerVersion: ANALYZER_VERSION,
    rateLimitSecret: secret,
    hourlyLimit: SIGNED_OUT_HOURLY_LIMIT,
  };
}
