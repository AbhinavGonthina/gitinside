import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import { countStoreRequests, createDb, type AnyDatabase, type DbHandle } from "@gitinside/db";
import { derivedSecret, MIN_SECRET_LENGTH, TOKEN_REQUEST_PURPOSE } from "@gitinside/worker/hmac";
import {
  countingFetch,
  createObjectStore,
  storeConfigFromEnv,
  type ObjectStore,
  type StoreConfig,
} from "@gitinside/worker/storage";
import type { AnalyzeDeps } from "./analyze";
import type { AuthDeps } from "./authRoute";
import { appCredentials, type AppCredentials } from "./githubApp";
import { fakeOrigin } from "./githubOAuth";
import type { WebhookDeps } from "./githubWebhook";
import type { TokenRouteDeps } from "./installationTokenRoute";
import { sessionKeys, type SessionKeys } from "./session";
import { createTurnstile, type BotCheck } from "./botCheck";
import { purgeRepoCache } from "./cdnCache";
import { createCodeSizeCache } from "./codeSize";
import type { GraphRouteDeps } from "./graphRoute";
import { cdnGraphReader, type ImageRouteDeps } from "./imageRoute";
import { jobRouteDeps, type JobRouteDeps } from "./jobRoute";
import { createHeadCache, type RepoViewDeps } from "./repoView";
import { createTaskQueue, type TaskQueue } from "./cloudTasks";
import { createGoogleTokenSource, type GoogleTokenSource } from "./googleAuth";
import { createLocalTaskQueue, isLoopbackOrigin, type LocalTaskQueue } from "./localTasks";

/**
 * The API routes' dependencies from the environment (names in `apps/web/.env.example`,
 * ADR-0055, ADR-0066, ADR-0067, ADR-0141):
 *
 * - `DATABASE_URL` (Neon's pooled string), `ENQUEUE_HMAC_SECRET`, `WORKER_URL`, and the
 *   Cloud Tasks queue's `GCP_*` names ({@link taskQueue}): required to analyze. If one is
 *   missing or malformed, the API answers "temporarily unavailable" instead of failing on
 *   every request; nothing is logged with a value. Watching a job needs only `DATABASE_URL`.
 *   In local development, `LOCAL_TASKS=push` with no `GCP_*` variable pushes jobs straight to
 *   a worker on this machine instead ({@link localQueue}, ADR-0149).
 * - `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`: the bot check on Analyze
 *   ({@link botCheck}, ADR-0157); both or neither.
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
/** Signed-in analyses per hour per user (SPEC §3, M8.2b). */
export const SIGNED_IN_HOURLY_LIMIT = 30;

/**
 * The header Vercel puts the deployment's OIDC token in on every function request; Google's
 * STS checks the token's signature, issuer, and audience, so a forged one gets nothing.
 * Vercel's docs don't say a client-sent header of this name is replaced (checked 2026-11-05,
 * M5.14b3g3), so a request's header is used only for that request's own refresh, never kept.
 */
export const VERCEL_OIDC_HEADER = "x-vercel-oidc-token";

let handle: { url: string; db: DbHandle } | undefined;

type Env = Readonly<Record<string, string | undefined>>;

const PROVIDER =
  /^\/\/iam\.googleapis\.com\/projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;

/**
 * One token source per Google identity, kept for the process so the access token is cached
 * across requests (googleAuth.ts). No request's OIDC token is kept in it.
 */
let google: { key: string; source: GoogleTokenSource } | undefined;

/**
 * The Cloud Tasks queue (ADR-0114, ADR-0141), if every variable is set and well formed:
 * `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_TASKS_QUEUE`, `GCP_WORKLOAD_IDENTITY_PROVIDER` (the
 * pool provider's full name), `GCP_ENQUEUE_SERVICE_ACCOUNT` (impersonated; may only create
 * tasks), `GCP_INVOKER_SERVICE_ACCOUNT` (Cloud Tasks pushes as it), `WORKER_URL` (the Cloud
 * Run service's https origin), and `ENQUEUE_HMAC_SECRET` (signs each job). A refresh this
 * request causes uses its own `oidcToken` (the request's {@link VERCEL_OIDC_HEADER}), else
 * `VERCEL_OIDC_TOKEN` (`vercel env pull`, local development; Vercel's functions get the token
 * only in the header, so the variable can't replace it there). With no `GCP_*` variable set at
 * all, it's the local push queue if opted in ({@link localQueue}); with only some set, none.
 */
function taskQueue(env: Env, oidcToken: string | null | undefined): TaskQueue | undefined {
  if (!Object.keys(env).some((name) => name.startsWith("GCP_") && env[name])) {
    return localQueue(env);
  }
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
      const source = createGoogleTokenSource({
        audience,
        serviceAccount,
        // Only for a request without the header (local development).
        subjectToken: async () => {
          const token = env.VERCEL_OIDC_TOKEN;
          if (!token) throw new Error("no OIDC token");
          return token;
        },
      });
      google = { key, source };
    }
    const { source } = google;
    const subject = oidcToken || undefined;
    return createTaskQueue({
      queue: { project, location, queue },
      workerUrl,
      invokerServiceAccount,
      secret,
      token: () => source.token(subject),
    });
  } catch {
    return undefined; // a malformed name or URL; named nowhere public
  }
}

/** The opt-in to {@link localQueue}: exactly this value of `LOCAL_TASKS`. */
export const LOCAL_TASKS_OPT_IN = "push";

/**
 * One local queue per worker and secret for the whole process (its task names, its order),
 * kept on `globalThis`: Next.js can load this module once per bundle layer, and two queues
 * would push two jobs at once to a worker that runs one.
 */
const LOCAL_QUEUE = Symbol.for("gitinside.localTaskQueue");
type LocalHolder = { [LOCAL_QUEUE]?: { key: string; queue: LocalTaskQueue } };

/**
 * Local development without Google (ADR-0149): with no `GCP_*` variable set, `LOCAL_TASKS`
 * set to {@link LOCAL_TASKS_OPT_IN}, a loopback `WORKER_URL`, and `ENQUEUE_HMAC_SECRET`, jobs
 * are pushed straight to the local worker's `POST /run` (localTasks.ts). Never on Vercel
 * (`VERCEL` is set there), whatever else is set.
 */
function localQueue(env: Env): TaskQueue | undefined {
  const { LOCAL_TASKS: optIn, VERCEL: vercel, WORKER_URL: workerUrl } = env;
  const { ENQUEUE_HMAC_SECRET: secret } = env;
  if (
    optIn !== LOCAL_TASKS_OPT_IN ||
    vercel ||
    !workerUrl ||
    !isLoopbackOrigin(workerUrl) ||
    !secret ||
    secret.length < MIN_SECRET_LENGTH
  ) {
    return undefined;
  }
  const key = JSON.stringify([workerUrl, secret]);
  const holder = globalThis as LocalHolder;
  let local = holder[LOCAL_QUEUE];
  if (local?.key !== key) {
    local = { key, queue: createLocalTaskQueue({ workerUrl, secret }) };
    holder[LOCAL_QUEUE] = local;
  }
  return local.queue;
}

/**
 * The job routes' deps (`/api/jobs/:id`, ADR-0067, ADR-0139): the database, where each job's
 * row is, so watching a job never asks the worker, and sign-in's deps when it's configured, for
 * private jobs (M8.4c2c). `undefined` without `DATABASE_URL`.
 */
export function jobDepsFromEnv(env: Env = process.env): JobRouteDeps | undefined {
  const db = database(env);
  return db && jobRouteDeps(db, authDepsFromEnv(env));
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
  const check = botCheck(env);
  if (!queue || !db || !secret || check === null) return undefined;
  return {
    db,
    queue,
    github: env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {},
    analyzerVersion: ANALYZER_VERSION,
    rateLimitSecret: secret,
    hourlyLimit: SIGNED_OUT_HOURLY_LIMIT,
    signedInHourlyLimit: SIGNED_IN_HOURLY_LIMIT,
    signInAvailable: authDepsFromEnv(env) !== undefined,
    codeSizes,
    ...(check && { botCheck: check }),
  };
}

/**
 * The Turnstile bot check (ADR-0157) from `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and
 * `TURNSTILE_SECRET_KEY`: with both, the check; with neither, `undefined` (nobody is asked,
 * e.g. local development); with only one, `null`, and analysis is unavailable rather than
 * running without the check it was meant to have.
 */
function botCheck(env: Env): BotCheck | undefined | null {
  const { NEXT_PUBLIC_TURNSTILE_SITE_KEY: siteKey, TURNSTILE_SECRET_KEY: secret } = env;
  if (!siteKey && !secret) return undefined;
  if (!siteKey || !secret) return null;
  return createTurnstile({ siteKey, secret });
}

/**
 * `/api/graph`'s deps (ADR-0068): the database and the `SNAPSHOTS_*` bucket, else
 * `undefined`; with sign-in's deps when it's configured, for private repos (M8.4b).
 */
export function graphDepsFromEnv(env: Env = process.env): GraphRouteDeps | undefined {
  const stored = snapshotStore(env);
  if (!stored) return undefined;
  const auth = authDepsFromEnv(env);
  return { ...stored, ...(auth !== undefined && { auth }) };
}

/**
 * The database and the `SNAPSHOTS_*` bucket, each bucket request counted against the month's
 * free requests (ADR-0096); else `undefined`.
 */
function snapshotStore(env: Env): { db: AnyDatabase; store: ObjectStore } | undefined {
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

/** Keys derived per `SESSION_SECRET`, kept so each request doesn't run HKDF again. */
let keys: { secret: string; keys: SessionKeys } | undefined;

/** A GitHub App's URL name: lowercase letters, digits, and hyphens. */
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

/**
 * Sign-in's deps (M8.2, ADR-0220, ADR-0221): `DATABASE_URL`, `GITHUB_APP_CLIENT_ID`,
 * `GITHUB_APP_CLIENT_SECRET`, and a `SESSION_SECRET` of at least 32 characters; else
 * `undefined`, and sign-in says it's unavailable. `GITHUB_APP_SLUG` (optional, well formed)
 * gives the dashboard its install link. `GITHUB_FAKE_ORIGIN` points the server's GitHub calls
 * at the E2E's fake GitHub, and only a loopback origin is taken (ADR-0223).
 */
export function authDepsFromEnv(env: Env = process.env): AuthDeps | undefined {
  const {
    GITHUB_APP_CLIENT_ID: clientId,
    GITHUB_APP_CLIENT_SECRET: clientSecret,
    GITHUB_APP_SLUG: slug,
    SESSION_SECRET: secret,
  } = env;
  if (!clientId || !clientSecret || !secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  const db = database(env);
  if (!db) return undefined;
  if (keys?.secret !== secret) keys = { secret, keys: sessionKeys(secret) };
  const fake = fakeOrigin(env.GITHUB_FAKE_ORIGIN);
  return {
    db,
    client: { clientId, clientSecret, ...(fake !== undefined && { fakeOrigin: fake }) },
    keys: keys.keys,
    ...(slug !== undefined && APP_SLUG.test(slug) && { appSlug: slug }),
  };
}

/**
 * The webhook route's deps (M8.3a, ADR-0220, ADR-0224): `DATABASE_URL`, the `SNAPSHOTS_*`
 * bucket (an uninstall deletes its objects, M8.5a), and `GITHUB_APP_WEBHOOK_SECRET`, plus
 * `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` during a rotation; each secret at least 32
 * characters. Else `undefined`, and every delivery gets `503`, so GitHub shows a deletion
 * that couldn't run as failed rather than it being half done. The task queue
 * ({@link taskQueue}, with the request's `oidcToken`) is optional: without it only
 * `pull_request` deliveries, and pushes that would queue, get `503` (M8.6d2, M8.7). A pushed
 * public repo's code count reads GitHub with `GITHUB_TOKEN`, as the pages do.
 */
export function webhookDepsFromEnv(
  env: Env = process.env,
  oidcToken?: string | null,
): WebhookDeps | undefined {
  const secrets: string[] = [];
  for (const name of ["GITHUB_APP_WEBHOOK_SECRET", "GITHUB_APP_WEBHOOK_SECRET_PREVIOUS"]) {
    const value = env[name];
    if (!value) {
      if (name === "GITHUB_APP_WEBHOOK_SECRET") return undefined;
      continue;
    }
    if (value.length < MIN_SECRET_LENGTH) return undefined;
    secrets.push(value);
  }
  const stored = snapshotStore(env);
  if (!stored) return undefined;
  const queue = taskQueue(env, oidcToken);
  return {
    ...stored,
    secrets,
    analyzerVersion: ANALYZER_VERSION,
    ...(queue !== undefined && { queue }),
    github: env.GITHUB_TOKEN ? { token: env.GITHUB_TOKEN } : {},
    codeSizes,
  };
}

/** The app's credentials per key text, kept so each request doesn't parse the PEM again. */
let app: { id: string; pem: string; credentials: AppCredentials | undefined } | undefined;

/**
 * The GitHub App acting as itself (M8.3c1, ADR-0226): `GITHUB_APP_ID` and
 * `GITHUB_APP_PRIVATE_KEY` (an RSA key in PEM, `appCredentials`), else `undefined`, and no
 * installation token can be minted. `GITHUB_FAKE_ORIGIN` points its calls at the E2E's
 * loopback fake GitHub, as for sign-in (ADR-0223).
 */
export function githubAppFromEnv(env: Env = process.env): AppCredentials | undefined {
  const { GITHUB_APP_ID: id = "", GITHUB_APP_PRIVATE_KEY: pem = "" } = env;
  if (app?.id !== id || app.pem !== pem) {
    app = { id, pem, credentials: appCredentials(id, pem) };
  }
  if (app.credentials === undefined) return undefined;
  const fake = fakeOrigin(env.GITHUB_FAKE_ORIGIN);
  return { ...app.credentials, ...(fake !== undefined && { fakeOrigin: fake }) };
}

/**
 * The token route's deps (M8.3c3a, ADR-0228): `DATABASE_URL`, the app's credentials
 * ({@link githubAppFromEnv}), and `ENQUEUE_HMAC_SECRET` (+ `ENQUEUE_HMAC_SECRET_PREVIOUS`
 * during a rotation), each at least 32 characters, from which the worker's signing keys are
 * derived. Else `undefined`, and the worker is told the route is unavailable.
 */
export function tokenRouteDepsFromEnv(env: Env = process.env): TokenRouteDeps | undefined {
  const secrets: string[] = [];
  for (const name of ["ENQUEUE_HMAC_SECRET", "ENQUEUE_HMAC_SECRET_PREVIOUS"]) {
    const value = env[name];
    if (!value) {
      if (name === "ENQUEUE_HMAC_SECRET") return undefined;
      continue;
    }
    if (value.length < MIN_SECRET_LENGTH) return undefined;
    secrets.push(value);
  }
  const app = githubAppFromEnv(env);
  const db = database(env);
  if (!app || !db) return undefined;
  return { db, app, keys: secrets.map((s) => derivedSecret(s, TOKEN_REQUEST_PURPOSE)) };
}

/** One process-wide memory of GitHub's answers (lib/repoView.ts). */
const heads = createHeadCache();
/** One process-wide memory of GitHub's code counts by commit (lib/codeSize.ts). */
const codeSizes = createCodeSizeCache();

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
    codeSizes,
    purgeRepo: (providerRepoId) => purgeRepoCache(providerRepoId),
  };
}
