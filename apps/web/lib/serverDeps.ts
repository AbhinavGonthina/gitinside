import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import { countStoreRequests, createDb, type AnyDatabase, type DbHandle } from "@gitinside/db";
import { MIN_SECRET_LENGTH } from "@gitinside/worker/hmac";
import {
  countingFetch,
  createObjectStore,
  storeConfigFromEnv,
  type StoreConfig,
} from "@gitinside/worker/storage";
import type { AnalyzeDeps } from "./analyze";
import type { GraphRouteDeps } from "./graphRoute";
import { cdnGraphReader, type ImageRouteDeps } from "./imageRoute";
import { jobRouteDeps, type JobRouteDeps } from "./jobRoute";
import { createHeadCache, type RepoViewDeps } from "./repoView";
import { createWorkerClient } from "./worker";

/**
 * The API routes' dependencies from the environment (names in `apps/web/.env.example`,
 * ADR-0055, ADR-0066, ADR-0067):
 *
 * - `DATABASE_URL` (Neon's pooled string), `WORKER_URL`, `ENQUEUE_HMAC_SECRET`: required.
 *   If one is missing or the secret is short, the API answers "temporarily unavailable"
 *   instead of failing on every request; nothing is logged with a value. Watching a job
 *   needs only `DATABASE_URL`.
 * - `GITHUB_TOKEN`: optional, raises GitHub's limit from 60 to 5,000 requests an hour.
 * - `SNAPSHOTS_*` (ADR-0055, ADR-0068, ADR-0095): `/api/graph` reads snapshots with them, alongside
 *   `DATABASE_URL`; the repo page needs only the database (and the worker to re-analyze).
 *   The README images read graphs through `/api/graph` (ADR-0072, ADR-0097). Every bucket request is counted as `web` in
 *   `store_requests` (ADR-0096), against Oracle's free 50,000 a month.
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
 * The job routes' deps (`/api/jobs/:id`, ADR-0067, ADR-0139): only the database, where each
 * job's row is, so watching a job never asks the worker. `undefined` without `DATABASE_URL`.
 */
export function jobDepsFromEnv(env: Env = process.env): JobRouteDeps | undefined {
  const db = database(env);
  return db && jobRouteDeps(db);
}

/** The shared connection for `DATABASE_URL`, or `undefined` if it isn't set. */
function database(env: Env): AnyDatabase | undefined {
  const { DATABASE_URL: databaseUrl } = env;
  if (!databaseUrl) return undefined;
  if (handle?.url !== databaseUrl) {
    handle = { url: databaseUrl, db: createDb(databaseUrl, { max: 1 }) };
  }
  return handle.db.db;
}

/** Build the deps from `env`, or `undefined` if the server isn't configured. */
export function analyzeDepsFromEnv(env: Env = process.env): AnalyzeDeps | undefined {
  const config = workerConfig(env);
  const db = config && database(env);
  if (!config || !db) return undefined;
  const { secret } = config;
  return {
    db,
    worker: createWorkerClient(config),
    github: env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {},
    analyzerVersion: ANALYZER_VERSION,
    rateLimitSecret: secret,
    hourlyLimit: SIGNED_OUT_HOURLY_LIMIT,
  };
}

/** `/api/graph`'s deps (ADR-0068): the database and the `SNAPSHOTS_*` bucket, else `undefined`. */
export function graphDepsFromEnv(env: Env = process.env): GraphRouteDeps | undefined {
  let config: StoreConfig;
  try {
    config = storeConfigFromEnv(env);
  } catch {
    return undefined; // a missing or malformed SNAPSHOTS_* variable; named nowhere public
  }
  const db = database(env);
  if (!db) return undefined;
  const fetch = countingFetch({
    count: () => countStoreRequests(db, "web"),
    // By name only: a message can carry connection details.
    onCountError: (error) =>
      console.error(
        JSON.stringify({
          event: "store_request_count_failed",
          error: error instanceof Error ? error.name : "unknown",
        }),
      ),
  });
  return { db, store: createObjectStore(config, { fetch }) };
}

/**
 * The README images' deps (ADR-0072, ADR-0097): the repo page's, plus graphs read from
 * `origin`'s day-cached `/api/graph`, never from the bucket directly; `undefined` without
 * the database (the images are then the link-only badge).
 */
export function imageDepsFromEnv(
  origin: string,
  env: Env = process.env,
): ImageRouteDeps | undefined {
  const view = repoViewDepsFromEnv(env);
  return view && { view, graph: cdnGraphReader(origin) };
}

/** One process-wide memory of GitHub's answers (lib/repoView.ts). */
const heads = createHeadCache();

/**
 * The repo page's deps (ADR-0068): the database, else `undefined` (the page then says
 * analysis is unavailable). Without a configured worker, newer commits aren't analyzed.
 */
export function repoViewDepsFromEnv(env: Env = process.env): RepoViewDeps | undefined {
  const db = database(env);
  if (!db) return undefined;
  const config = workerConfig(env);
  return {
    db,
    worker: config && createWorkerClient(config),
    github: env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {},
    analyzerVersion: ANALYZER_VERSION,
    heads,
  };
}
