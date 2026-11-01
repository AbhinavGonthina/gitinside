// @vitest-environment node
import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { FAKE_GCP, fakeGoogle } from "./google.testkit";
import {
  LOCAL_TASKS_OPT_IN,
  SIGNED_OUT_HOURLY_LIMIT,
  analyzeDepsFromEnv,
  graphDepsFromEnv,
  imageDepsFromEnv,
  jobDepsFromEnv,
  repoViewDepsFromEnv,
} from "./serverDeps";
import { WorkerUnavailableError } from "./worker";

const ENV = {
  // Never connected to: postgres.js opens connections on the first query only.
  DATABASE_URL: "postgres://user:pw@127.0.0.1:1/gitinside",
  WORKER_URL: FAKE_GCP.workerUrl,
  ENQUEUE_HMAC_SECRET: "h".repeat(43),
  GCP_PROJECT_ID: FAKE_GCP.project,
  GCP_REGION: FAKE_GCP.location,
  GCP_TASKS_QUEUE: FAKE_GCP.queue,
  GCP_WORKLOAD_IDENTITY_PROVIDER: FAKE_GCP.audience,
  GCP_ENQUEUE_SERVICE_ACCOUNT: FAKE_GCP.enqueuer,
  GCP_INVOKER_SERVICE_ACCOUNT: FAKE_GCP.invoker,
};

const JOB = { owner: "acme", repo: "shop", sha: "f".repeat(40) };

/**
 * Google behind the global `fetch`, trusting only `enqueuer` (each test names its own: the
 * token source is kept per identity for the process, with its cached token).
 */
function withGoogle(enqueuer: string) {
  const google = fakeGoogle({
    audience: FAKE_GCP.audience,
    subjectToken: FAKE_GCP.subjectToken,
    serviceAccount: enqueuer,
    queues: [
      `projects/${FAKE_GCP.project}/locations/${FAKE_GCP.location}/queues/${FAKE_GCP.queue}`,
    ],
  });
  vi.stubGlobal("fetch", google.fetch);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return { google, env: { ...ENV, GCP_ENQUEUE_SERVICE_ACCOUNT: enqueuer } };
}

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

  it("is undefined when something is missing or malformed", () => {
    for (const name of Object.keys(ENV)) {
      expect(analyzeDepsFromEnv({ ...ENV, [name]: undefined }), name).toBeUndefined();
      expect(analyzeDepsFromEnv({ ...ENV, [name]: "" }), name).toBeUndefined();
    }
    for (const bad of [
      { ENQUEUE_HMAC_SECRET: "short" },
      { WORKER_URL: "not a url" },
      // Cloud Run is https only; the OIDC token's audience is the origin.
      { WORKER_URL: "http://127.0.0.1:8080" },
      { WORKER_URL: `${FAKE_GCP.workerUrl}/run` },
      { GCP_PROJECT_ID: "Not A Project" },
      { GCP_REGION: "us-east4/../x" },
      { GCP_TASKS_QUEUE: "a/b" },
      { GCP_WORKLOAD_IDENTITY_PROVIDER: "projects/1/providers/vercel" },
      { GCP_ENQUEUE_SERVICE_ACCOUNT: "enqueue@example.com" },
    ]) {
      expect(analyzeDepsFromEnv({ ...ENV, ...bad }), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("creates tasks with the request's Vercel OIDC token, through Google's STS", async () => {
    const { google, env } = withGoogle("enqueue-header@gitinside-demo.iam.gserviceaccount.com");
    const deps = analyzeDepsFromEnv(env, FAKE_GCP.subjectToken);
    expect(await deps?.queue.createTask(JOB, "analyze-test-1")).toEqual({ created: true });
    expect(google.requests.map((r) => r.split("/")[0])).toEqual([
      "POST sts.googleapis.com",
      "POST iamcredentials.googleapis.com",
      "POST cloudtasks.googleapis.com",
    ]);
    expect(google.tasks[0]?.httpRequest).toMatchObject({
      url: `${FAKE_GCP.workerUrl}/run`,
      oidcToken: { serviceAccountEmail: FAKE_GCP.invoker, audience: FAKE_GCP.workerUrl },
    });
    // The access token is kept for the process: the next request goes straight to the queue.
    await analyzeDepsFromEnv(env)?.queue.createTask(JOB, "analyze-test-2");
    expect(google.requests.slice(3).map((r) => r.split("/")[0])).toEqual([
      "POST cloudtasks.googleapis.com",
    ]);
  });

  it("falls back to VERCEL_OIDC_TOKEN (local development)", async () => {
    const { google, env } = withGoogle("enqueue-env@gitinside-demo.iam.gserviceaccount.com");
    const deps = analyzeDepsFromEnv({ ...env, VERCEL_OIDC_TOKEN: FAKE_GCP.subjectToken });
    expect(await deps?.queue.createTask(JOB, "analyze-test-3")).toEqual({ created: true });
    expect(google.tasks).toHaveLength(1);
  });

  it("without any OIDC token the queue is unavailable, asking Google nothing", async () => {
    const { google, env } = withGoogle("enqueue-none@gitinside-demo.iam.gserviceaccount.com");
    const deps = analyzeDepsFromEnv(env, null);
    await expect(deps?.queue.createTask(JOB, "analyze-test-4")).rejects.toThrow(
      new WorkerUnavailableError("google token: no platform OIDC token"),
    );
    expect(google.requests).toEqual([]);
  });
});

describe("the local push queue (ADR-0149)", () => {
  const LOCAL = {
    DATABASE_URL: ENV.DATABASE_URL,
    ENQUEUE_HMAC_SECRET: ENV.ENQUEUE_HMAC_SECRET,
    WORKER_URL: "http://127.0.0.1:8080",
    LOCAL_TASKS: LOCAL_TASKS_OPT_IN,
  };

  it("pushes jobs to a local worker when opted in without any GCP_* variable", async () => {
    expect(LOCAL_TASKS_OPT_IN).toBe("push");
    const pushed: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      pushed.push(`${init.method ?? "GET"} ${input}`);
      return new Response("{}");
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    onTestFinished(() => info.mockRestore());

    const deps = analyzeDepsFromEnv(LOCAL);
    expect(deps).toBeDefined();
    expect(await deps?.queue.createTask(JOB, "analyze-local-1")).toEqual({ created: true });
    // The same queue for the process: a name it pushed is remembered by the repo page too.
    expect(await repoViewDepsFromEnv(LOCAL)?.queue?.createTask(JOB, "analyze-local-1")).toEqual({
      created: false,
    });
    await vi.waitFor(() => expect(pushed).toEqual(["POST http://127.0.0.1:8080/run"]));
  });

  it("needs the opt-in, a loopback worker, and the secret; never on Vercel", () => {
    for (const bad of [
      { LOCAL_TASKS: undefined },
      { LOCAL_TASKS: "1" },
      { LOCAL_TASKS: "PUSH" },
      { VERCEL: "1" },
      { WORKER_URL: undefined },
      { WORKER_URL: FAKE_GCP.workerUrl },
      { WORKER_URL: "http://192.168.1.20:8080" },
      { WORKER_URL: "http://127.0.0.1:8080/run" },
      { ENQUEUE_HMAC_SECRET: "short" },
      { ENQUEUE_HMAC_SECRET: undefined },
    ]) {
      expect(analyzeDepsFromEnv({ ...LOCAL, ...bad }), JSON.stringify(bad)).toBeUndefined();
      expect(repoViewDepsFromEnv({ ...LOCAL, ...bad })?.queue, JSON.stringify(bad)).toBeUndefined();
    }
    for (const url of ["http://localhost:8080", "http://[::1]:8080"]) {
      expect(analyzeDepsFromEnv({ ...LOCAL, WORKER_URL: url }), url).toBeDefined();
    }
  });

  it("any GCP_* variable turns it off: a half-configured Google queue is no queue", () => {
    expect(analyzeDepsFromEnv({ ...LOCAL, GCP_PROJECT_ID: FAKE_GCP.project })).toBeUndefined();
    expect(analyzeDepsFromEnv({ ...LOCAL, GCP_PROJECT_ID: "" })).toBeDefined();
  });

  it("a full Google configuration wins over the opt-in", () => {
    const deps = analyzeDepsFromEnv({ ...ENV, LOCAL_TASKS: LOCAL_TASKS_OPT_IN });
    expect(deps?.queue).toBeDefined();
    // The Google client, not the local queue (only the local one has `idle`).
    expect("idle" in (deps?.queue ?? {})).toBe(false);
    expect("idle" in (analyzeDepsFromEnv({ ...LOCAL })?.queue ?? {})).toBe(true);
    // The Google queue needs an https worker, so a loopback one gets neither.
    expect(
      analyzeDepsFromEnv({ ...ENV, LOCAL_TASKS: LOCAL_TASKS_OPT_IN, WORKER_URL: LOCAL.WORKER_URL }),
    ).toBeUndefined();
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

  it("is the repo page's deps; the queue stays optional", () => {
    const deps = imageDepsFromEnv(ORIGIN, ENV);
    expect(deps?.view.heads).toBe(repoViewDepsFromEnv(ENV)?.heads);
    expect(typeof deps?.view.queue?.createTask).toBe("function");
    expect(
      imageDepsFromEnv(ORIGIN, { ...ENV, GCP_TASKS_QUEUE: undefined })?.view.queue,
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
  it("needs only the database; the queue is optional", () => {
    const deps = repoViewDepsFromEnv(ENV);
    expect(deps).toMatchObject({ analyzerVersion: ANALYZER_VERSION, github: {} });
    expect(typeof deps?.queue?.createTask).toBe("function");
    // One memory of GitHub's answers for the whole process.
    expect(repoViewDepsFromEnv(ENV)?.heads).toBe(deps?.heads);
    expect(repoViewDepsFromEnv({ ...ENV, GITHUB_TOKEN: "t" })?.github).toEqual({ token: "t" });
    const noQueue = repoViewDepsFromEnv({ ...ENV, WORKER_URL: undefined });
    expect(noQueue).toBeDefined();
    expect(noQueue?.queue).toBeUndefined();
    expect(repoViewDepsFromEnv({ ...ENV, DATABASE_URL: "" })).toBeUndefined();
  });

  it("check-on-view creates tasks with the page request's OIDC token", async () => {
    const { google, env } = withGoogle("enqueue-view@gitinside-demo.iam.gserviceaccount.com");
    const deps = repoViewDepsFromEnv(env, FAKE_GCP.subjectToken);
    expect(await deps?.queue?.createTask(JOB, "analyze-test-5")).toEqual({ created: true });
    expect(google.tasks).toHaveLength(1);
  });
});

describe("jobDepsFromEnv", () => {
  it("needs only the database, not the worker (ADR-0139)", () => {
    const deps = jobDepsFromEnv({ DATABASE_URL: ENV.DATABASE_URL });
    expect(typeof deps?.findJob).toBe("function");
    expect(Object.keys(deps ?? {})).toEqual(["findJob"]);
  });

  it("is undefined without the database, whatever the worker's settings", () => {
    expect(jobDepsFromEnv({ ...ENV, DATABASE_URL: undefined })).toBeUndefined();
    expect(jobDepsFromEnv({ ...ENV, DATABASE_URL: "" })).toBeUndefined();
  });
});
