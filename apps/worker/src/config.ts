import { isAbsolute, relative } from "node:path";
import { secretsFromEnv } from "./hmac.js";
import { storeConfigFromEnv, type StoreConfig } from "./storage.js";

/**
 * The worker process's settings, read once from the environment at startup (ADR-0055,
 * ADR-0065, ADR-0144). Secrets live only in the deployment's secret store, never in the repo.
 * The worker takes its jobs from Cloud Tasks pushes (`POST /run`), so it needs no Redis.
 *
 * | Variable | Required | Meaning |
 * |---|---|---|
 * | `DATABASE_URL` | yes | `postgres://` or `postgresql://` (Neon's pooled endpoint) |
 * | `DATABASE_URL_UNPOOLED` | no, {@link directUrlOf} `DATABASE_URL` | a direct (unpooled) endpoint for the migrations run at startup (ADR-0192) |
 * | `SNAPSHOTS_NAMESPACE`, `SNAPSHOTS_REGION`, `SNAPSHOTS_ACCESS_KEY_ID`, `SNAPSHOTS_SECRET_ACCESS_KEY`, `SNAPSHOTS_BUCKET` | yes | snapshot bucket on Oracle Object Storage (storage.ts) |
 * | `ENQUEUE_HMAC_SECRET` (+ optional `…_PREVIOUS`) | yes | the website's job signing (hmac.ts) |
 * | `JOBS_ROOT` | no, `/tmp/jobs` | absolute parent of the job folders |
 * | `CACHE_ROOT` | no, `/tmp/cache` | absolute parent of the fact cache folders (factcache.ts), apart from `JOBS_ROOT` |
 * | `HOST` | no, `127.0.0.1` | `POST /run`'s address (a container sets `0.0.0.0`) |
 * | `PORT` | no, `8080` | `POST /run`'s port (Cloud Run sets it) |
 * | `GITHUB_TOKEN` | no | sent to GitHub's API only (raises the 60/hour limit) |
 *
 * Every problem is reported at once, and messages name the variable, never its value.
 */

/** What {@link workerConfigFromEnv} returns. */
export interface WorkerConfig {
  databaseUrl: string;
  /** Where startup migrates: `DATABASE_URL_UNPOOLED`, else {@link directUrlOf} `databaseUrl`. */
  migrationUrl: string;
  store: StoreConfig;
  /** Current signing secret first, then the previous one during a rollover. */
  secrets: string[];
  jobsRoot: string;
  /** Where the analysis child caches facts between jobs (factcache.ts). */
  cacheRoot: string;
  host: string;
  port: number;
  githubToken?: string;
}

/** Defaults for the optional variables. */
export const CONFIG_DEFAULTS = {
  jobsRoot: "/tmp/jobs",
  cacheRoot: "/tmp/cache",
  host: "127.0.0.1",
  port: 8080,
} as const;

/** Whether `inner` is `outer` or a path inside it. */
function within(outer: string, inner: string): boolean {
  const path = relative(outer, inner);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Thrown by {@link workerConfigFromEnv}; `problems` has one line per variable. */
export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(readonly problems: readonly string[]) {
    super(`invalid worker configuration: ${problems.join("; ")}`);
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const PORT = /^[1-9][0-9]{0,4}$/;

function urlWithScheme(env: Env, name: string, schemes: readonly string[]): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (!schemes.includes(protocol)) {
    throw new Error(`${name} must start with ${schemes.map((s) => `${s}//`).join(" or ")}`);
  }
  return value;
}

// A pooled Neon host: the endpoint ID with `-pooler`, then the region and `neon.tech`.
const NEON_POOLED_HOST = /^(ep-[a-z0-9-]+)-pooler(\.[a-z0-9.-]+\.neon\.tech)$/;

/**
 * The direct (unpooled) form of a Postgres URL, for migrations (ADR-0192). Neon names its
 * pooled endpoint by adding `-pooler` to the endpoint ID (`ep-x-123-pooler.us-east-1.aws.
 * neon.tech`; the same role and password reach both), so that's removed; any other URL is
 * returned as is (a local Postgres has no pooler).
 */
export function directUrlOf(url: string): string {
  const parsed = new URL(url);
  const match = NEON_POOLED_HOST.exec(parsed.hostname);
  if (match === null) return url;
  parsed.hostname = `${match[1]}${match[2]}`;
  return parsed.href;
}

/** What {@link quotaConfigFromEnv} returns: only what the quota command reads. */
export interface QuotaConfig {
  databaseUrl: string;
  store: StoreConfig;
}

/**
 * The quota command's settings: `DATABASE_URL` and the `SNAPSHOTS_*` variables, checked as
 * {@link workerConfigFromEnv} checks them. Throws a {@link ConfigError} listing every problem.
 */
export function quotaConfigFromEnv(env: Env): QuotaConfig {
  const problems: string[] = [];
  let databaseUrl: string | undefined;
  let store: StoreConfig | undefined;
  try {
    databaseUrl = urlWithScheme(env, "DATABASE_URL", ["postgres:", "postgresql:"]);
  } catch (error) {
    problems.push((error as Error).message);
  }
  try {
    store = storeConfigFromEnv(env);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (databaseUrl === undefined || store === undefined) throw new ConfigError(problems);
  return { databaseUrl, store };
}

/** Read and check the worker's settings; throws a {@link ConfigError} listing every problem. */
export function workerConfigFromEnv(env: Env): WorkerConfig {
  const problems: string[] = [];
  const check = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const databaseUrl = check(() => urlWithScheme(env, "DATABASE_URL", ["postgres:", "postgresql:"]));
  const migrationUrl = check(() => {
    if (env.DATABASE_URL_UNPOOLED) {
      return urlWithScheme(env, "DATABASE_URL_UNPOOLED", ["postgres:", "postgresql:"]);
    }
    return databaseUrl === undefined ? undefined : directUrlOf(databaseUrl);
  });
  const store = check(() => storeConfigFromEnv(env));
  const secrets = check(() => secretsFromEnv(env));
  const jobsRoot = check(() => {
    const value = env.JOBS_ROOT || CONFIG_DEFAULTS.jobsRoot;
    if (!isAbsolute(value)) throw new Error("JOBS_ROOT must be an absolute path");
    return value;
  });
  const cacheRoot = check(() => {
    const value = env.CACHE_ROOT || CONFIG_DEFAULTS.cacheRoot;
    if (!isAbsolute(value)) throw new Error("CACHE_ROOT must be an absolute path");
    // Job folders are deleted after each job and swept at startup; the cache must outlive them.
    if (jobsRoot !== undefined && (within(jobsRoot, value) || within(value, jobsRoot))) {
      throw new Error("CACHE_ROOT and JOBS_ROOT must not contain each other");
    }
    return value;
  });
  const host = env.HOST || CONFIG_DEFAULTS.host;
  const port = check(() => {
    const value = env.PORT || String(CONFIG_DEFAULTS.port);
    const port = Number(value);
    if (!PORT.test(value) || port > 65_535) throw new Error("PORT must be 1–65535");
    return port;
  });

  if (
    problems.length > 0 ||
    databaseUrl === undefined ||
    migrationUrl === undefined ||
    store === undefined ||
    secrets === undefined ||
    jobsRoot === undefined ||
    cacheRoot === undefined ||
    port === undefined
  ) {
    throw new ConfigError(problems);
  }
  const githubToken = env.GITHUB_TOKEN;
  return {
    databaseUrl,
    migrationUrl,
    store,
    secrets,
    jobsRoot,
    cacheRoot,
    host,
    port,
    ...(githubToken === undefined || githubToken === "" ? {} : { githubToken }),
  };
}
