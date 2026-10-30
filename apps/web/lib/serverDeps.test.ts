// @vitest-environment node
import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import { describe, expect, it, vi } from "vitest";
import {
  SIGNED_OUT_HOURLY_LIMIT,
  analyzeDepsFromEnv,
  graphDepsFromEnv,
  imageDepsFromEnv,
  jobDepsFromEnv,
  repoViewDepsFromEnv,
} from "./serverDeps";

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

const BUCKET = {
  SNAPSHOTS_NAMESPACE: "axq1ns2example",
  SNAPSHOTS_REGION: "us-ashburn-1",
  SNAPSHOTS_ACCESS_KEY_ID: "key-id",
  SNAPSHOTS_SECRET_ACCESS_KEY: "secret-key",
  SNAPSHOTS_BUCKET: "gitinside-snapshots",
};

describe("graphDepsFromEnv", () => {
  it("needs the database and the bucket, not the worker", () => {
    const deps = graphDepsFromEnv({ DATABASE_URL: ENV.DATABASE_URL, ...BUCKET });
    expect(typeof deps?.store.get).toBe("function");
    expect(deps?.db).toBe(analyzeDepsFromEnv(ENV)?.db);
  });

  it("counts each bucket request, and a count that fails doesn't fail the read", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: URL) => {
      requests.push(input.pathname);
      return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // The database at ENV.DATABASE_URL refuses connections, so the count fails.
      const deps = graphDepsFromEnv({ DATABASE_URL: ENV.DATABASE_URL, ...BUCKET });
      expect(await deps?.store.get("public/acme/shop/x.json.gz")).toBeUndefined();
      expect(requests).toEqual(["/gitinside-snapshots/public/acme/shop/x.json.gz"]);
      expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { event: "store_request_count_failed", error: expect.any(String) },
      ]);
      expect(String(errors.mock.calls)).not.toContain("pw@");
    } finally {
      errors.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("is undefined when a variable is missing or malformed", () => {
    for (const name of ["DATABASE_URL", ...Object.keys(BUCKET)]) {
      expect(graphDepsFromEnv({ ...ENV, ...BUCKET, [name]: "" }), name).toBeUndefined();
    }
    for (const bad of [
      { SNAPSHOTS_NAMESPACE: "evil.example" },
      { SNAPSHOTS_REGION: "us-ashburn-1.evil.example" },
    ]) {
      expect(graphDepsFromEnv({ ...ENV, ...BUCKET, ...bad })).toBeUndefined();
    }
  });
});

describe("imageDepsFromEnv", () => {
  const ORIGIN = "https://gitinside.test";

  it("is the repo page's deps; the worker stays optional", () => {
    const deps = imageDepsFromEnv(ORIGIN, ENV);
    expect(deps?.view.heads).toBe(repoViewDepsFromEnv(ENV)?.heads);
    expect(
      imageDepsFromEnv(ORIGIN, { ...ENV, WORKER_URL: undefined })?.view.worker,
    ).toBeUndefined();
  });

  it("reads graphs from the origin's /api/graph, never the bucket (ADR-0097)", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: URL) => {
      requests.push(input.href);
      return new Response("{}");
    });
    try {
      const deps = imageDepsFromEnv(ORIGIN, { ...ENV, ...BUCKET });
      await deps?.graph("/api/graph/Acme/Shop/abc");
      expect(requests).toEqual([`${ORIGIN}/api/graph/Acme/Shop/abc`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is undefined without the database", () => {
    expect(imageDepsFromEnv(ORIGIN, { ...ENV, ...BUCKET, DATABASE_URL: "" })).toBeUndefined();
  });
});

describe("repoViewDepsFromEnv", () => {
  it("needs only the database; the worker is optional", () => {
    const deps = repoViewDepsFromEnv(ENV);
    expect(deps).toMatchObject({ analyzerVersion: ANALYZER_VERSION, github: {} });
    expect(typeof deps?.worker?.enqueue).toBe("function");
    // One memory of GitHub's answers for the whole process.
    expect(repoViewDepsFromEnv(ENV)?.heads).toBe(deps?.heads);
    expect(repoViewDepsFromEnv({ ...ENV, GITHUB_TOKEN: "t" })?.github).toEqual({ token: "t" });
    const noWorker = repoViewDepsFromEnv({ ...ENV, WORKER_URL: undefined });
    expect(noWorker).toBeDefined();
    expect(noWorker?.worker).toBeUndefined();
    expect(repoViewDepsFromEnv({ ...ENV, DATABASE_URL: "" })).toBeUndefined();
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
