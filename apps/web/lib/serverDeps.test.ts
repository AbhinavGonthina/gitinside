// @vitest-environment node
import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import { describe, expect, it } from "vitest";
import { SIGNED_OUT_HOURLY_LIMIT, analyzeDepsFromEnv, jobDepsFromEnv } from "./serverDeps";

const ENV = {
  // Never connected to: postgres.js opens connections on the first query only.
  DATABASE_URL: "postgres://user:pw@127.0.0.1:1/gitinside",
  WORKER_URL: "https://worker.example",
  ENQUEUE_HMAC_SECRET: "h".repeat(43),
};

describe("analyzeDepsFromEnv", () => {
  it("builds the deps from the environment", () => {
    const deps = analyzeDepsFromEnv(ENV);
    expect(deps).toMatchObject({
      analyzerVersion: ANALYZER_VERSION,
      rateLimitSecret: ENV.ENQUEUE_HMAC_SECRET,
      hourlyLimit: SIGNED_OUT_HOURLY_LIMIT,
      github: {},
    });
    expect(SIGNED_OUT_HOURLY_LIMIT).toBe(5);
    expect(analyzeDepsFromEnv({ ...ENV, GITHUB_TOKEN: "t" })?.github).toEqual({ token: "t" });
  });

  it("keeps one database handle per URL", () => {
    const a = analyzeDepsFromEnv(ENV);
    const b = analyzeDepsFromEnv(ENV);
    expect(a?.db).toBe(b?.db);
    const c = analyzeDepsFromEnv({ ...ENV, DATABASE_URL: "postgres://u:p@127.0.0.1:2/other" });
    expect(c?.db).not.toBe(a?.db);
  });

  it("is undefined when something is missing or unsafe", () => {
    for (const name of Object.keys(ENV)) {
      expect(analyzeDepsFromEnv({ ...ENV, [name]: undefined }), name).toBeUndefined();
      expect(analyzeDepsFromEnv({ ...ENV, [name]: "" }), name).toBeUndefined();
    }
    expect(analyzeDepsFromEnv({ ...ENV, ENQUEUE_HMAC_SECRET: "short" })).toBeUndefined();
    expect(analyzeDepsFromEnv({ ...ENV, WORKER_URL: "not a url" })).toBeUndefined();
    const plain = { ...ENV, WORKER_URL: "http://127.0.0.1:8080" };
    expect(analyzeDepsFromEnv({ ...plain, NODE_ENV: "production" })).toBeUndefined();
    expect(analyzeDepsFromEnv(plain)).toBeDefined();
  });
});

describe("jobDepsFromEnv", () => {
  it("needs only the worker, not the database", () => {
    const deps = jobDepsFromEnv({ ...ENV, DATABASE_URL: undefined });
    expect(typeof deps?.worker.status).toBe("function");
  });

  it("is undefined without a usable worker URL and secret", () => {
    expect(jobDepsFromEnv({ ...ENV, WORKER_URL: undefined })).toBeUndefined();
    expect(jobDepsFromEnv({ ...ENV, ENQUEUE_HMAC_SECRET: "short" })).toBeUndefined();
    const plain = { ...ENV, WORKER_URL: "http://127.0.0.1:8080", NODE_ENV: "production" };
    expect(jobDepsFromEnv(plain)).toBeUndefined();
  });
});
