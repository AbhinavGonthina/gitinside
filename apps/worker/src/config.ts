import { isAbsolute } from "node:path";
import { secretsFromEnv } from "./hmac.js";
import { storeConfigFromEnv, type StoreConfig } from "./storage.js";

/**
 * The worker process's settings, read once from the environment at startup (ADR-0055,
 * ADR-0065). Secrets live only in the VM's env file (M5.10), never in the repo.
 *
 * | Variable | Required | Meaning |
 * |---|---|---|
 * | `REDIS_URL` | yes | `redis://` or `rediss://`, the Redis next to the worker |
 * | `REDIS_PASSWORD` | no | Redis's `requirepass` (production generates it, ADR-0083) |
 * | `DATABASE_URL` | yes | `postgres://` or `postgresql://` (Neon's pooled endpoint) |
 * | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | yes | snapshot bucket (storage.ts) |
 * | `ENQUEUE_HMAC_SECRET` (+ optional `…_PREVIOUS`) | yes | enqueue API signing (hmac.ts) |
 * | `JOBS_ROOT` | no, `/tmp/jobs` | absolute parent of the job folders |
 * | `HOST` | no, `127.0.0.1` | enqueue API address (the container sets `0.0.0.0` behind Caddy) |
 * | `PORT` | no, `8080` | enqueue API port |
 * | `GITHUB_TOKEN` | no | sent to GitHub's API only (raises the 60/hour limit) |
 *
 * Every problem is reported at once, and messages name the variable, never its value.
 */

/** What {@link workerConfigFromEnv} returns. */
export interface WorkerConfig {
  redisUrl: string;
  /** Sent on every Redis connection; never part of `redisUrl`, so the URL stays loggable. */
  redisPassword?: string;
  databaseUrl: string;
  store: StoreConfig;
  /** Current signing secret first, then the previous one during a rollover. */
  secrets: string[];
  jobsRoot: string;
  host: string;
  port: number;
  githubToken?: string;
}

/** Defaults for the optional variables. */
export const CONFIG_DEFAULTS = { jobsRoot: "/tmp/jobs", host: "127.0.0.1", port: 8080 } as const;

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

/** What {@link quotaConfigFromEnv} returns: only what the quota command reads. */
export interface QuotaConfig {
  databaseUrl: string;
  store: StoreConfig;
}

/**
 * The quota command's settings: `DATABASE_URL` and the `R2_*` variables, checked as
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

  const redisUrl = check(() => urlWithScheme(env, "REDIS_URL", ["redis:", "rediss:"]));
  const databaseUrl = check(() => urlWithScheme(env, "DATABASE_URL", ["postgres:", "postgresql:"]));
  const store = check(() => storeConfigFromEnv(env));
  const secrets = check(() => secretsFromEnv(env));
  const jobsRoot = check(() => {
    const value = env.JOBS_ROOT || CONFIG_DEFAULTS.jobsRoot;
    if (!isAbsolute(value)) throw new Error("JOBS_ROOT must be an absolute path");
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
    redisUrl === undefined ||
    databaseUrl === undefined ||
    store === undefined ||
    secrets === undefined ||
    jobsRoot === undefined ||
    port === undefined
  ) {
    throw new ConfigError(problems);
  }
  const githubToken = env.GITHUB_TOKEN;
  const redisPassword = env.REDIS_PASSWORD;
  return {
    redisUrl,
    ...(redisPassword === undefined || redisPassword === "" ? {} : { redisPassword }),
    databaseUrl,
    store,
    secrets,
    jobsRoot,
    host,
    port,
    ...(githubToken === undefined || githubToken === "" ? {} : { githubToken }),
  };
}

/**
 * The BullMQ connection for the worker's Redis: the URL, plus the password when one is
 * set (ioredis lets an explicit `password` win over the URL's).
 */
export function redisConnection(config: Pick<WorkerConfig, "redisUrl" | "redisPassword">): {
  url: string;
  password?: string;
} {
  return {
    url: config.redisUrl,
    ...(config.redisPassword === undefined ? {} : { password: config.redisPassword }),
  };
}
