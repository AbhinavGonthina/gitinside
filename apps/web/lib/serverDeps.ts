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
import { createTaskQueue, type TaskQueue } from "./cloudTasks";
import { createGoogleTokenSource, type GoogleTokenSource } from "./googleAuth";

/**
 * The API routes' dependencies from the environment (names in `apps/web/.env.example`,
 * ADR-0055, ADR-0066, ADR-0067, ADR-0141):
 *
 * - `DATABASE_URL` (Neon's pooled string), `ENQUEUE_HMAC_SECRET`, `WORKER_URL`, and the
 *   Cloud Tasks queue's `GCP_*` names ({@link taskQueue}): required to analyze. If one is
 *   missing or malformed, the API answers "temporarily unavailable" instead of failing on
 *   every request; nothing is logged with a value. Watching a job needs only `DATABASE_URL`.
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

/**
 * The header Vercel puts the deployment's OIDC token in on every function request; Google's
 * STS checks the token's signature, issuer, and audience, so a forged one gets nothing.
 */
export const VERCEL_OIDC_HEADER = "x-vercel-oidc-token";

let handle: { url: string; db: DbHandle } | undefined;

type Env = Readonly<Record<string, string | undefined>>;

const PROVIDER =
  /^\/\/iam\.googleapis\.com\/projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;

/**
 * One token source per Google identity, kept for the process so the access token is cached
 * across requests (googleAuth.ts). `platform` is the newest OIDC token a request carried.
 */
let google:
  | { key: string; source: GoogleTokenSource; platform: { token: string | undefined } }
  | undefined;

/**
 * The Cloud Tasks queue (ADR-0114, ADR-0141), if every variable is set and well formed:
 * `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_TASKS_QUEUE`, `GCP_WORKLOAD_IDENTITY_PROVIDER` (the
 * pool provider's full name), `GCP_ENQUEUE_SERVICE_ACCOUNT` (impersonated; may only create
 * tasks), `GCP_INVOKER_SERVICE_ACCOUNT` (Cloud Tasks pushes as it), `WORKER_URL` (the Cloud
 * Run service's https origin), and `ENQUEUE_HMAC_SECRET` (signs each job). The platform's
 * OIDC token is `oidcToken` (the request's {@link VERCEL_OIDC_HEADER}), else
 * `VERCEL_OIDC_TOKEN` (`vercel env pull`, local development).
 */
function taskQueue(env: Env, oidcToken: string | null | undefined): TaskQueue | undefined {
  const {
    GCP_PROJECT_ID: project,
    GCP_REGION: location,
    GCP_TASKS_QUEUE: queue,
    GCP_WORKLOAD_IDENTITY_PROVIDER: audience,
    GCP_ENQUEUE_SERVICE_ACCOUNT: serviceAccount,
    GCP_INVOKER_SERVICE_ACCOUNT: invokerServiceAccount,
    WORKER_URL: workerUrl,
    ENQUEUE_HMAC_SECRET: secret,
  } = env;
  if (
    !project ||
    !location ||
    !queue ||
    !audience ||
    !PROVIDER.test(audience) ||
    !serviceAccount ||
    !invokerServiceAccount ||
    !workerUrl ||
    !secret ||
    secret.length < MIN_SECRET_LENGTH
  ) {
    return undefined;
  }
  const key = JSON.stringify([audience, serviceAccount]);
  try {
    if (google?.key !== key) {
      const platform = { token: undefined as string | undefined };
      const source = createGoogleTokenSource({
        audience,
        serviceAccount,
        // Read at each refresh, so a token that expired in the environment isn't used when a
        // request brought a fresh one.
        subjectToken: async () => {
          const token = platform.token ?? env.VERCEL_OIDC_TOKEN;
          if (!token) throw new Error("no OIDC token");
          return token;
        },
      });
      google = { key, source, platform };
    }
    if (oidcToken) google.platform.token = oidcToken;
    const { source } = google;
    return createTaskQueue({
      queue: { project, location, queue },
      workerUrl,
      invokerServiceAccount,
      secret,
      token: () => source.token(),
    });
  } catch {
    return undefined; // a malformed name or URL; named nowhere public
  }
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

/**
 * Build the deps from `env`, or `undefined` if the server isn't configured. `oidcToken` is
 * the request's {@link VERCEL_OIDC_HEADER}.
 */
export function analyzeDepsFromEnv(
  env: Env = process.env,
  oidcToken?: string | null,
): AnalyzeDeps | undefined {
  const queue = taskQueue(env, oidcToken);
  const db = queue && database(env);
  const { ENQUEUE_HMAC_SECRET: secret } = env;
  if (!queue || !db || !secret) return undefined;
  return {
    db,
    queue,
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
  oidcToken?: string | null,
): ImageRouteDeps | undefined {
  const view = repoViewDepsFromEnv(env, oidcToken);
  return view && { view, graph: cdnGraphReader(origin) };
}

/** One process-wide memory of GitHub's answers (lib/repoView.ts). */
const heads = createHeadCache();

/**
 * The repo page's deps (ADR-0068): the database, else `undefined` (the page then says
 * analysis is unavailable). Without a configured queue, newer commits aren't analyzed.
 */
export function repoViewDepsFromEnv(
  env: Env = process.env,
  oidcToken?: string | null,
): RepoViewDeps | undefined {
  const db = database(env);
  if (!db) return undefined;
  return {
    db,
    queue: taskQueue(env, oidcToken),
    github: env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {},
    analyzerVersion: ANALYZER_VERSION,
    heads,
  };
}
