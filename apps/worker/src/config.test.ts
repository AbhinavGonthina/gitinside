import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, ConfigError, workerConfigFromEnv } from "./config.js";

const SECRET = "s".repeat(43);
const ENV = {
  REDIS_URL: "redis://redis:6379",
  DATABASE_URL: "postgresql://user:pw-value@db.example/gitinside?sslmode=require",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "key-id",
  R2_SECRET_ACCESS_KEY: "key-secret",
  R2_BUCKET: "gitinside-snapshots",
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
      redisUrl: ENV.REDIS_URL,
      databaseUrl: ENV.DATABASE_URL,
      store: {
        endpoint: `https://${ENV.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        bucket: "gitinside-snapshots",
        credentials: { accessKeyId: "key-id", secretAccessKey: "key-secret" },
        region: "auto",
      },
      secrets: [SECRET],
      jobsRoot: CONFIG_DEFAULTS.jobsRoot,
      host: "127.0.0.1",
      port: 8080,
    });
  });

  it("takes the optional settings when set", () => {
    const previous = "p".repeat(43);
    const config = workerConfigFromEnv({
      ...ENV,
      REDIS_URL: "rediss://redis:6380",
      DATABASE_URL: "postgres://db/x",
      ENQUEUE_HMAC_SECRET_PREVIOUS: previous,
      JOBS_ROOT: "/var/jobs",
      HOST: "0.0.0.0",
      PORT: "65535",
      GITHUB_TOKEN: "gh-token",
    });
    expect(config).toMatchObject({
      redisUrl: "rediss://redis:6380",
      databaseUrl: "postgres://db/x",
      secrets: [SECRET, previous],
      jobsRoot: "/var/jobs",
      host: "0.0.0.0",
      port: 65535,
      githubToken: "gh-token",
    });
  });

  it("treats empty optional variables as unset", () => {
    const config = workerConfigFromEnv({
      ...ENV,
      JOBS_ROOT: "",
      HOST: "",
      PORT: "",
      GITHUB_TOKEN: "",
    });
    expect(config).toMatchObject({ jobsRoot: "/tmp/jobs", host: "127.0.0.1", port: 8080 });
    expect(config).not.toHaveProperty("githubToken");
  });

  it("lists every missing variable at once", () => {
    expect(problems({})).toEqual([
      "REDIS_URL is not set",
      "DATABASE_URL is not set",
      "R2_ACCOUNT_ID is not set",
      "ENQUEUE_HMAC_SECRET is not set",
    ]);
  });

  it.each([
    [{ REDIS_URL: "http://redis" }, "REDIS_URL must start with redis:// or rediss://"],
    [{ REDIS_URL: "not a url" }, "REDIS_URL is not a URL"],
    [{ DATABASE_URL: "mysql://db/x" }, "DATABASE_URL must start with postgres:// or postgresql://"],
    [{ JOBS_ROOT: "jobs" }, "JOBS_ROOT must be an absolute path"],
    [{ PORT: "0" }, "PORT must be 1–65535"],
    [{ PORT: "65536" }, "PORT must be 1–65535"],
    [{ PORT: "80a" }, "PORT must be 1–65535"],
    [{ PORT: "080" }, "PORT must be 1–65535"],
    [{ ENQUEUE_HMAC_SECRET: "short" }, "ENQUEUE_HMAC_SECRET must be at least 32 characters"],
    [{ R2_BUCKET: "" }, "R2_BUCKET is not set"],
  ])("refuses %j", (override, problem) => {
    expect(problems({ ...ENV, ...override })).toEqual([problem]);
  });

  it("never puts a value in its messages", () => {
    const bad = {
      REDIS_URL: "http://user:redis-pass@redis",
      DATABASE_URL: "mysql://user:db-pass@db",
      ENQUEUE_HMAC_SECRET: "short-secret-value",
      R2_ACCOUNT_ID: "acct-value",
      PORT: "port-value",
    };
    const text = problems({ ...ENV, ...bad }).join("\n");
    for (const value of [
      "redis-pass",
      "db-pass",
      "short-secret-value",
      "acct-value",
      "port-value",
    ]) {
      expect(text).not.toContain(value);
    }
    expect(text.split("\n")).toHaveLength(5);
  });

  it("says what is wrong in the error message too", () => {
    expect(() => workerConfigFromEnv({ ...ENV, REDIS_URL: undefined })).toThrow(
      "invalid worker configuration: REDIS_URL is not set",
    );
  });
});
