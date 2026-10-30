import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import { createDb, type AnyDatabase, type DbHandle } from "@gitinside/db";
import { MIN_SECRET_LENGTH } from "@gitinside/worker/hmac";
import { createObjectStore, storeConfigFromEnv } from "@gitinside/worker/storage";
import type { AnalyzeDeps } from "./analyze";
import type { GraphRouteDeps } from "./graphRoute";
import type { ImageRouteDeps } from "./imageRoute";
import type { JobRouteDeps } from "./jobRoute";
import { createHeadCache, type RepoViewDeps } from "./repoView";
import { createWorkerClient } from "./worker";

/**
 * The API routes' dependencies from the environment (names in `apps/web/.env.example`,
 * ADR-0055, ADR-0066, ADR-0067):
 *
 * - `DATABASE_URL` (Neon's pooled string), `WORKER_URL`, `ENQUEUE_HMAC_SECRET`: required.
 *   If one is missing or the secret is short, the API answers "temporarily unavailable"
 *   instead of failing on every request; nothing is logged with a value.
 * - `GITHUB_TOKEN`: optional, raises GitHub's limit from 60 to 5,000 requests an hour.
 * - `SNAPSHOTS_*` (ADR-0055, ADR-0068, ADR-0095): `/api/graph` reads snapshots with them, alongside
 *   `DATABASE_URL`; the repo page needs only the database (and the worker to re-analyze).
 *   The README images need both (ADR-0072).
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
  let store: GraphRouteDeps["store"];
  try {
    store = createObjectStore(storeConfigFromEnv(env));
  } catch {
    return undefined; // a missing or malformed SNAPSHOTS_* variable; named nowhere public
  }
  const db = database(env);
  return db && { db, store };
}

/**
 * The README images' deps (ADR-0072): the repo page's, plus the `SNAPSHOTS_*` bucket the graph is
 * read from; `undefined` without either (the images are then the link-only badge).
 */
export function imageDepsFromEnv(env: Env = process.env): ImageRouteDeps | undefined {
  const graph = graphDepsFromEnv(env);
  const view = graph && repoViewDepsFromEnv(env);
  return graph && view && { view, store: graph.store };
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
