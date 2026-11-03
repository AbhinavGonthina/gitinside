import { describe, expect, it } from "vitest";
import {
  CONFIG_DEFAULTS,
  ConfigError,
  directUrlOf,
  quotaConfigFromEnv,
  workerConfigFromEnv,
} from "./config.js";

const SECRET = "s".repeat(43);
const ENV = {
  DATABASE_URL: "postgresql://user:pw-value@db.example/gitinside?sslmode=require",
  SNAPSHOTS_NAMESPACE: "axq1ns2example",
  SNAPSHOTS_REGION: "us-ashburn-1",
  SNAPSHOTS_ACCESS_KEY_ID: "key-id",
  SNAPSHOTS_SECRET_ACCESS_KEY: "key-secret",
  SNAPSHOTS_BUCKET: "gitinside-snapshots",
  ENQUEUE_HMAC_SECRET: SECRET,
};

function problems(env: Record<string, string | undefined>): readonly string[] {
  try {
    workerConfigFromEnv(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("workerConfigFromEnv", () => {
  it("reads every setting, with defaults for the optional ones", () => {
    expect(workerConfigFromEnv(ENV)).toEqual({
      databaseUrl: ENV.DATABASE_URL,
      // No pooler locally: migrations go through the same URL.
      migrationUrl: ENV.DATABASE_URL,
      store: {
        endpoint: "https://axq1ns2example.compat.objectstorage.us-ashburn-1.oraclecloud.com",
        bucket: "gitinside-snapshots",
        credentials: { accessKeyId: "key-id", secretAccessKey: "key-secret" },
        region: "us-ashburn-1",
      },
      secrets: [SECRET],
      jobsRoot: CONFIG_DEFAULTS.jobsRoot,
      cacheRoot: "/tmp/cache",
      host: "127.0.0.1",
      port: 8080,
    });
  });

  it.each([
    [{ CACHE_ROOT: "/tmp/jobs" }],
    [{ CACHE_ROOT: "/tmp/jobs/cache" }],
    [{ CACHE_ROOT: "/tmp", JOBS_ROOT: "/tmp/jobs" }],
  ])("refuses a cache root that holds the job folders or sits among them: %j", (override) => {
    expect(problems({ ...ENV, ...override })).toEqual([
      "CACHE_ROOT and JOBS_ROOT must not contain each other",
    ]);
  });

  it("takes a cache root beside the job folders, including a name that starts like theirs", () => {
    expect(workerConfigFromEnv({ ...ENV, CACHE_ROOT: "/tmp/jobs-cache" }).cacheRoot).toBe(
      "/tmp/jobs-cache",
    );
  });

  it("takes the optional settings when set", () => {
    const previous = "p".repeat(43);
    const config = workerConfigFromEnv({
      ...ENV,
      DATABASE_URL: "postgres://db/x",
      ENQUEUE_HMAC_SECRET_PREVIOUS: previous,
      JOBS_ROOT: "/var/jobs",
      CACHE_ROOT: "/var/cache",
      HOST: "0.0.0.0",
      PORT: "65535",
      GITHUB_TOKEN: "gh-token",
    });
    expect(config).toMatchObject({
      databaseUrl: "postgres://db/x",
      secrets: [SECRET, previous],
      jobsRoot: "/var/jobs",
      cacheRoot: "/var/cache",
      host: "0.0.0.0",
      port: 65535,
      githubToken: "gh-token",
    });
  });

  it("migrates through Neon's direct endpoint: the pooled host without -pooler (ADR-0192)", () => {
    const pooled =
      "postgresql://app:pw-value@ep-cool-darkness-a1b2c3d4-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
    const config = workerConfigFromEnv({ ...ENV, DATABASE_URL: pooled });
    expect(config.databaseUrl).toBe(pooled);
    expect(config.migrationUrl).toBe(
      "postgresql://app:pw-value@ep-cool-darkness-a1b2c3d4.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    );
  });

  it.each([
    ["a direct Neon host", "postgres://app:pw@ep-quiet-1234.us-east-2.aws.neon.tech/db"],
    ["a non-Neon host named like one", "postgres://app:pw@ep-x-pooler.example.com/db"],
    ["-pooler outside the endpoint ID", "postgres://app:pw@db-pooler.us-east-2.aws.neon.tech/db"],
  ])("leaves %s as it is", (_what, url) => {
    expect(directUrlOf(url)).toBe(url);
  });

  it("migrates through DATABASE_URL_UNPOOLED when set, checked like DATABASE_URL", () => {
    const direct = "postgresql://user:pw-value@db-direct.example/gitinside?sslmode=require";
    const config = workerConfigFromEnv({ ...ENV, DATABASE_URL_UNPOOLED: direct });
    expect(config).toMatchObject({ databaseUrl: ENV.DATABASE_URL, migrationUrl: direct });
    expect(workerConfigFromEnv({ ...ENV, DATABASE_URL_UNPOOLED: "" }).migrationUrl).toBe(
      ENV.DATABASE_URL,
    );
    expect(problems({ ...ENV, DATABASE_URL_UNPOOLED: "mysql://user:pw-value@db/x" })).toEqual([
      "DATABASE_URL_UNPOOLED must start with postgres:// or postgresql://",
    ]);
    expect(problems({ ...ENV, DATABASE_URL_UNPOOLED: "not a url" })).toEqual([
      "DATABASE_URL_UNPOOLED is not a URL",
    ]);
  });

  it("needs no Redis, and ignores its variables when they're still set", () => {
    const config = workerConfigFromEnv({
      ...ENV,
      REDIS_URL: "redis://redis:6379",
      REDIS_PASSWORD: "redis-pass",
    });
    expect(config).toEqual(workerConfigFromEnv(ENV));
    expect(JSON.stringify(config)).not.toContain("redis");
  });

  it("treats empty optional variables as unset", () => {
    const config = workerConfigFromEnv({
      ...ENV,
      JOBS_ROOT: "",
      CACHE_ROOT: "",
      HOST: "",
      PORT: "",
      GITHUB_TOKEN: "",
    });
    expect(config).toMatchObject({
      jobsRoot: "/tmp/jobs",
      cacheRoot: "/tmp/cache",
      host: "127.0.0.1",
      port: 8080,
    });
    expect(config).not.toHaveProperty("githubToken");
  });

  it("lists every missing variable at once", () => {
    expect(problems({})).toEqual([
      "DATABASE_URL is not set",
      "SNAPSHOTS_NAMESPACE is not set",
      "ENQUEUE_HMAC_SECRET is not set",
    ]);
  });

  it.each([
    [{ DATABASE_URL: "mysql://db/x" }, "DATABASE_URL must start with postgres:// or postgresql://"],
    [{ DATABASE_URL: "not a url" }, "DATABASE_URL is not a URL"],
    [{ JOBS_ROOT: "jobs" }, "JOBS_ROOT must be an absolute path"],
    [{ CACHE_ROOT: "cache" }, "CACHE_ROOT must be an absolute path"],
    [{ PORT: "0" }, "PORT must be 1–65535"],
    [{ PORT: "65536" }, "PORT must be 1–65535"],
    [{ PORT: "80a" }, "PORT must be 1–65535"],
    [{ PORT: "080" }, "PORT must be 1–65535"],
    [{ ENQUEUE_HMAC_SECRET: "short" }, "ENQUEUE_HMAC_SECRET must be at least 32 characters"],
    [{ SNAPSHOTS_BUCKET: "" }, "SNAPSHOTS_BUCKET is not set"],
  ])("refuses %j", (override, problem) => {
    expect(problems({ ...ENV, ...override })).toEqual([problem]);
  });

  it("never puts a value in its messages", () => {
    const bad = {
      DATABASE_URL: "mysql://user:db-pass@db",
      ENQUEUE_HMAC_SECRET: "short-secret-value",
      SNAPSHOTS_NAMESPACE: "ns.value",
      PORT: "port-value",
    };
    const text = problems({ ...ENV, ...bad }).join("\n");
    for (const value of ["db-pass", "short-secret-value", "ns.value", "port-value"]) {
      expect(text).not.toContain(value);
    }
    expect(text.split("\n")).toHaveLength(4);
  });

  it("says what is wrong in the error message too", () => {
    expect(() => workerConfigFromEnv({ ...ENV, DATABASE_URL: undefined })).toThrow(
      "invalid worker configuration: DATABASE_URL is not set",
    );
  });
});

describe("quotaConfigFromEnv", () => {
  it("reads only the database and the bucket", () => {
    const onlyQuota = Object.fromEntries(
      Object.entries(ENV).filter(
        ([name]) => name === "DATABASE_URL" || name.startsWith("SNAPSHOTS_"),
      ),
    );
    expect(quotaConfigFromEnv(onlyQuota)).toEqual({
      databaseUrl: ENV.DATABASE_URL,
      store: workerConfigFromEnv(ENV).store,
    });
  });

  it("lists both problems at once, never a value", () => {
    let error: unknown;
    try {
      quotaConfigFromEnv({ ...ENV, DATABASE_URL: "nope", SNAPSHOTS_REGION: "region.value" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      "DATABASE_URL is not a URL",
      "SNAPSHOTS_REGION must be an Oracle region identifier (e.g. us-ashburn-1)",
    ]);
  });
});
