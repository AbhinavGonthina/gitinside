// @vitest-environment node
import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { FAKE_APP_ID, FAKE_KEYS } from "./githubApp.testkit";
import { FAKE_GCP, fakeGoogle } from "./google.testkit";
import {
  LOCAL_TASKS_OPT_IN,
  SIGNED_IN_HOURLY_LIMIT,
  SIGNED_OUT_HOURLY_LIMIT,
  analyzeDepsFromEnv,
  authDepsFromEnv,
  githubAppFromEnv,
  graphDepsFromEnv,
  imageDepsFromEnv,
  jobDepsFromEnv,
  repoViewDepsFromEnv,
  webhookDepsFromEnv,
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
      signedInHourlyLimit: SIGNED_IN_HOURLY_LIMIT,
      signInAvailable: false,
      github: {},
    });
    expect(SIGNED_OUT_HOURLY_LIMIT).toBe(5);
    expect(SIGNED_IN_HOURLY_LIMIT).toBe(30);
    expect(analyzeDepsFromEnv({ ...ENV, GITHUB_TOKEN: "t" })?.github).toEqual({ token: "t" });
  });

  it("says sign-in is available only when sign-in is configured (M8.2b)", () => {
    const signIn = {
      GITHUB_APP_CLIENT_ID: "Iv1.x",
      GITHUB_APP_CLIENT_SECRET: "c",
      SESSION_SECRET: "s".repeat(43),
    };
    expect(analyzeDepsFromEnv({ ...ENV, ...signIn })?.signInAvailable).toBe(true);
    expect(
      analyzeDepsFromEnv({ ...ENV, ...signIn, SESSION_SECRET: "short" })?.signInAvailable,
    ).toBe(false);
  });

  it("has the Turnstile bot check with both keys, none with neither, and no analysis with one (ADR-0157)", async () => {
    expect(analyzeDepsFromEnv(ENV)?.botCheck).toBeUndefined();
    const keys = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAA", TURNSTILE_SECRET_KEY: "0x4BBB" };
    const deps = analyzeDepsFromEnv({ ...ENV, ...keys });
    expect(deps?.botCheck?.siteKey).toBe("0x4AAA");
    // The secret goes to Cloudflare's siteverify, and only there.
    const seen: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: String(init?.body) });
      return Response.json({ success: true, action: "analyze" });
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    expect(await deps?.botCheck?.verify("tok")).toBe("passed");
    expect(seen).toEqual([
      {
        url: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        body: "secret=0x4BBB&response=tok",
      },
    ]);
    for (const name of Object.keys(keys)) {
      expect(analyzeDepsFromEnv({ ...ENV, ...keys, [name]: "" }), name).toBeUndefined();
    }
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

  it("a forged header fails only its own request, never another request's refresh (R12)", async () => {
    const { google, env } = withGoogle("enqueue-forged@gitinside-demo.iam.gserviceaccount.com");
    // A genuine request takes its deps, then a forged one arrives before the first refreshes.
    const genuine = analyzeDepsFromEnv(env, FAKE_GCP.subjectToken);
    const forged = analyzeDepsFromEnv(env, "forged.oidc.token");
    await expect(forged?.queue.createTask(JOB, "analyze-forged-1")).rejects.toThrow(
      new WorkerUnavailableError("google token: sts status 400"),
    );
    expect(await genuine?.queue.createTask(JOB, "analyze-forged-2")).toEqual({ created: true });
    expect(google.tasks).toHaveLength(1);
  });

  it("a request without the header doesn't borrow an earlier request's token", async () => {
    const { google, env } = withGoogle("enqueue-borrow@gitinside-demo.iam.gserviceaccount.com");
    // The first request's token is never stored for others; the second has none of its own.
    analyzeDepsFromEnv(env, FAKE_GCP.subjectToken);
    await expect(
      analyzeDepsFromEnv(env)?.queue.createTask(JOB, "analyze-borrow-1"),
    ).rejects.toThrow(new WorkerUnavailableError("google token: no platform OIDC token"));
    expect(google.requests).toEqual([]);
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
    // Without sign-in, private repos are simply never served.
    expect(deps?.auth).toBeUndefined();
  });

  it("carries sign-in's deps when it's configured, for private repos (M8.4b)", () => {
    const signIn = {
      GITHUB_APP_CLIENT_ID: "Iv1.x",
      GITHUB_APP_CLIENT_SECRET: "c",
      SESSION_SECRET: "s".repeat(43),
    };
    const deps = graphDepsFromEnv({ DATABASE_URL: ENV.DATABASE_URL, ...BUCKET, ...signIn });
    expect(deps?.auth?.client.clientId).toBe("Iv1.x");
    expect(deps?.auth?.db).toBe(deps?.db);
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

  it("purges hidden repos from Vercel's CDN, a no-op outside Vercel (ADR-0238)", async () => {
    await expect(repoViewDepsFromEnv(ENV)?.purgeRepo?.(4242)).resolves.toBeUndefined();
  });

  it("runs the hide's second purge later, past the response (F14)", async () => {
    let ran = false;
    repoViewDepsFromEnv(ENV)?.later?.(async () => {
      ran = true;
    }, 0);
    await vi.waitFor(() => expect(ran).toBe(true));
  });

  it("check-on-view creates tasks with the page request's OIDC token", async () => {
    const { google, env } = withGoogle("enqueue-view@gitinside-demo.iam.gserviceaccount.com");
    const deps = repoViewDepsFromEnv(env, FAKE_GCP.subjectToken);
    expect(await deps?.queue?.createTask(JOB, "analyze-test-5")).toEqual({ created: true });
    expect(google.tasks).toHaveLength(1);
  });
});

describe("authDepsFromEnv", () => {
  const AUTH = {
    DATABASE_URL: ENV.DATABASE_URL,
    GITHUB_APP_CLIENT_ID: "Iv23liTEST",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    SESSION_SECRET: "s".repeat(43),
  };

  it("needs the database, the app's client, and a long enough session secret", () => {
    const deps = authDepsFromEnv(AUTH);
    expect(deps?.client).toEqual({ clientId: "Iv23liTEST", clientSecret: "client-secret" });
    expect(deps?.keys.seal).toHaveLength(32);
    expect(authDepsFromEnv(AUTH)?.keys).toBe(deps?.keys); // derived once per secret
    for (const name of Object.keys(AUTH)) {
      expect(authDepsFromEnv({ ...AUTH, [name]: undefined }), name).toBeUndefined();
      expect(authDepsFromEnv({ ...AUTH, [name]: "" }), name).toBeUndefined();
    }
    expect(authDepsFromEnv({ ...AUTH, SESSION_SECRET: "s".repeat(31) })).toBeUndefined();
  });

  it("takes a well-formed app slug for the install link (M8.2c)", () => {
    expect(authDepsFromEnv(AUTH)?.appSlug).toBeUndefined();
    expect(authDepsFromEnv({ ...AUTH, GITHUB_APP_SLUG: "gitinside" })?.appSlug).toBe("gitinside");
    for (const slug of ["", "Git Inside", "../x", "-gitinside", "a/b"]) {
      expect(authDepsFromEnv({ ...AUTH, GITHUB_APP_SLUG: slug })?.appSlug, slug).toBeUndefined();
    }
  });

  it("points GitHub calls at a fake only on this machine (ADR-0223)", () => {
    const origin = (value: string) =>
      authDepsFromEnv({ ...AUTH, GITHUB_FAKE_ORIGIN: value })?.client.fakeOrigin;
    expect(origin("http://127.0.0.1:3110")).toBe("http://127.0.0.1:3110");
    expect(origin("http://localhost:3110")).toBe("http://localhost:3110");
    for (const value of [
      "https://evil.example",
      "http://127.0.0.1.evil.example:80",
      "http://127.0.0.1:3110/path",
      "http://user@127.0.0.1:3110",
      "",
    ]) {
      expect(origin(value), value).toBeUndefined();
    }
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

describe("githubAppFromEnv", () => {
  const APP = {
    GITHUB_APP_ID: FAKE_APP_ID,
    GITHUB_APP_PRIVATE_KEY: FAKE_KEYS.privateKey
      .export({ type: "pkcs1", format: "pem" })
      .toString(),
  };

  it("needs the App ID and its RSA private key, and parses the key once", () => {
    const app = githubAppFromEnv(APP);
    expect(app?.appId).toBe(FAKE_APP_ID);
    expect(app?.privateKey.asymmetricKeyType).toBe("rsa");
    expect(githubAppFromEnv(APP)?.privateKey).toBe(app?.privateKey);
    for (const name of Object.keys(APP)) {
      expect(githubAppFromEnv({ ...APP, [name]: undefined }), name).toBeUndefined();
      expect(githubAppFromEnv({ ...APP, [name]: "" }), name).toBeUndefined();
    }
    expect(githubAppFromEnv({ ...APP, GITHUB_APP_ID: "app" })).toBeUndefined();
    expect(githubAppFromEnv({ ...APP, GITHUB_APP_PRIVATE_KEY: "not a key" })).toBeUndefined();
    expect(githubAppFromEnv(APP)?.appId).toBe(FAKE_APP_ID); // back after a bad value
  });

  it("points its calls at a fake only on this machine (ADR-0223)", () => {
    expect(githubAppFromEnv(APP)?.fakeOrigin).toBeUndefined();
    expect(
      githubAppFromEnv({ ...APP, GITHUB_FAKE_ORIGIN: "http://127.0.0.1:3110" })?.fakeOrigin,
    ).toBe("http://127.0.0.1:3110");
    expect(
      githubAppFromEnv({ ...APP, GITHUB_FAKE_ORIGIN: "https://evil.example" })?.fakeOrigin,
    ).toBeUndefined();
  });
});

describe("webhookDepsFromEnv", () => {
  const HOOK = {
    DATABASE_URL: ENV.DATABASE_URL,
    GITHUB_APP_WEBHOOK_SECRET: "w".repeat(43),
    ...BUCKET,
  };

  it("needs the database, the bucket, and a long enough webhook secret", () => {
    expect(webhookDepsFromEnv(HOOK)?.secrets).toEqual(["w".repeat(43)]);
    expect(typeof webhookDepsFromEnv(HOOK)?.store.delete).toBe("function");
    for (const name of Object.keys(HOOK)) {
      expect(webhookDepsFromEnv({ ...HOOK, [name]: undefined }), name).toBeUndefined();
      expect(webhookDepsFromEnv({ ...HOOK, [name]: "" }), name).toBeUndefined();
    }
    expect(
      webhookDepsFromEnv({ ...HOOK, GITHUB_APP_WEBHOOK_SECRET: "w".repeat(31) }),
    ).toBeUndefined();
  });

  it("adds the task queue when it's configured, for pull requests' diff jobs (M8.6d2)", () => {
    expect(webhookDepsFromEnv(HOOK)?.queue).toBeUndefined();
    expect(webhookDepsFromEnv(HOOK)?.analyzerVersion).toBe(ANALYZER_VERSION);
    const deps = webhookDepsFromEnv({ ...ENV, ...HOOK }, "oidc");
    expect(typeof deps?.queue?.createTask).toBe("function");
  });

  it("reads pushed public repos' code counts with the server's token (M8.7)", () => {
    expect(webhookDepsFromEnv(HOOK)?.github).toEqual({});
    expect(webhookDepsFromEnv({ ...HOOK, GITHUB_TOKEN: "ghs_x" })?.github).toEqual({
      token: "ghs_x",
    });
    expect(webhookDepsFromEnv(HOOK)?.codeSizes).toBeDefined();
  });

  it("accepts the previous secret too during a rotation, if it's long enough", () => {
    const previous = "p".repeat(43);
    expect(
      webhookDepsFromEnv({ ...HOOK, GITHUB_APP_WEBHOOK_SECRET_PREVIOUS: previous })?.secrets,
    ).toEqual(["w".repeat(43), previous]);
    expect(
      webhookDepsFromEnv({ ...HOOK, GITHUB_APP_WEBHOOK_SECRET_PREVIOUS: "p".repeat(31) }),
    ).toBeUndefined();
    expect(
      webhookDepsFromEnv({ ...HOOK, GITHUB_APP_WEBHOOK_SECRET_PREVIOUS: "" })?.secrets,
    ).toEqual(["w".repeat(43)]);
  });
});
