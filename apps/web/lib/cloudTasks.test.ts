// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JobFailure,
  RETRY_COUNT_HEADER,
  createRunServer,
  jobIdFor,
  type JobRecorder,
} from "@gitinside/worker";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "@gitinside/worker/hmac";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  DISPATCH_DEADLINE_SECONDS,
  RUN_PATH,
  createTaskQueue,
  taskIdFor,
  type TaskQueueOptions,
} from "./cloudTasks";
import { fakeGoogle, type FakeTask as GoogleTask } from "./google.testkit";
import { createGoogleTokenSource } from "./googleAuth";
import { WorkerUnavailableError } from "./worker";

const SECRET = "s".repeat(43);
const SHA = "c".repeat(40);
const JOB = { owner: "acme", repo: "shop", sha: SHA };
const JOB_ID = `analyze-${"0123456789abcdef".repeat(2)}`;
const QUEUE = "projects/gitinside-demo/locations/us-east4/queues/analyses";
const AUDIENCE =
  "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel/providers/vercel";
const ENQUEUER = "enqueue@gitinside-demo.iam.gserviceaccount.com";
const INVOKER = "tasks-invoker@gitinside-demo.iam.gserviceaccount.com";
const WORKER = "https://worker-abc123-uk.a.run.app";
const NOW = Date.parse("2026-10-31T12:00:00Z");

/** `wrap` sits between the queue client and this setup's fake Google. */
function setup(
  overrides: Partial<TaskQueueOptions> = {},
  wrap: (google: typeof fetch) => typeof fetch = (google) => google,
) {
  const google = fakeGoogle({
    audience: AUDIENCE,
    subjectToken: "vercel-oidc",
    serviceAccount: ENQUEUER,
    queues: [QUEUE],
  });
  const tokens = createGoogleTokenSource({
    subjectToken: async () => "vercel-oidc",
    audience: AUDIENCE,
    serviceAccount: ENQUEUER,
    fetch: google.fetch,
  });
  const queue = createTaskQueue({
    queue: { project: "gitinside-demo", location: "us-east4", queue: "analyses" },
    workerUrl: WORKER,
    invokerServiceAccount: INVOKER,
    secret: SECRET,
    token: () => tokens.token(),
    fetch: wrap(google.fetch),
    now: () => NOW,
    ...overrides,
  });
  return { google, queue };
}

describe("createTaskQueue against the fake Google", () => {
  it("creates a named task pushing the signed job to the worker's /run", async () => {
    const { google, queue } = setup();
    const id = taskIdFor(JOB_ID, new Date(NOW));
    expect(await queue.createTask(JOB, id)).toEqual({ created: true });

    expect(google.tasks).toHaveLength(1);
    const [task] = google.tasks;
    expect(task?.name).toBe(`${QUEUE}/tasks/${id}`);
    expect(task?.dispatchDeadline).toBe(`${DISPATCH_DEADLINE_SECONDS}s`);
    expect(task?.httpRequest.url).toBe(`${WORKER}${RUN_PATH}`);
    expect(task?.httpRequest.httpMethod).toBe("POST");
    expect(task?.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: INVOKER,
      audience: WORKER,
    });
    expect(task?.httpRequest.headers["content-type"]).toBe("application/json");

    const body = new Uint8Array(Buffer.from(task?.httpRequest.body ?? "", "base64"));
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({ kind: "analyze", ...JOB });
    // The worker's own check accepts the signature over exactly what it will receive.
    const headers = task?.httpRequest.headers ?? {};
    expect(
      verifyRequest(
        [SECRET],
        { method: "POST", path: RUN_PATH, body },
        { timestamp: headers[TIMESTAMP_HEADER], signature: headers[SIGNATURE_HEADER] },
        NOW,
      ),
    ).toEqual({ ok: true });
    // A signature can't be moved to another job.
    const other = new TextEncoder().encode(
      JSON.stringify({ kind: "analyze", ...JOB, sha: "d".repeat(40) }),
    );
    expect(
      verifyRequest(
        [SECRET],
        { method: "POST", path: RUN_PATH, body: other },
        { timestamp: headers[TIMESTAMP_HEADER], signature: headers[SIGNATURE_HEADER] },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("a used task name is the job already queued", async () => {
    const { google, queue } = setup();
    const id = taskIdFor(JOB_ID, new Date(NOW));
    await queue.createTask(JOB, id);
    expect(await queue.createTask(JOB, id)).toEqual({ created: false });
    // Queued again later (after a failure), the job gets a fresh name.
    expect(await queue.createTask(JOB, taskIdFor(JOB_ID, new Date(NOW + 1)))).toEqual({
      created: true,
    });
    expect(google.tasks).toHaveLength(2);
  });

  it("gets one Google token for many tasks", async () => {
    const { google, queue } = setup();
    await queue.createTask(JOB, taskIdFor(JOB_ID, new Date(NOW)));
    await queue.createTask(JOB, taskIdFor(JOB_ID, new Date(NOW + 1)));
    expect(google.requests.filter((r) => r.startsWith("POST sts."))).toHaveLength(1);
  });

  it("any other refusal is the queue unavailable", async () => {
    const { google, queue } = setup();
    const id = taskIdFor(JOB_ID, new Date(NOW));
    await queue.createTask(JOB, "warm-up");
    const aborted = Response.json(
      { error: { code: 409, message: "Aborted", status: "ABORTED" } },
      { status: 409 },
    );
    const answers: [Response | Error, string][] = [
      [aborted, "status 409"],
      [new Response("not json", { status: 409 }), "status 409"],
      [new Response("", { status: 500 }), "status 500"],
      [
        new Response("", { status: 302, headers: { location: "https://example.com" } }),
        "status 302",
      ],
      [new TypeError("fetch failed"), "request failed"],
    ];
    for (const [answer, reason] of answers) {
      google.failNext(answer);
      await expect(queue.createTask(JOB, id)).rejects.toThrow(new WorkerUnavailableError(reason));
    }
    expect(google.tasks.map((t) => t.name)).toEqual([`${QUEUE}/tasks/warm-up`]);
  });

  it("a queue that doesn't exist or a token Google refuses is unavailable", async () => {
    const missing = setup({
      queue: { project: "gitinside-demo", location: "us-east4", queue: "gone" },
    });
    await expect(missing.queue.createTask(JOB, "x")).rejects.toThrow("status 404");

    const badToken = setup({ token: async () => "access-forged" });
    await expect(badToken.queue.createTask(JOB, "x")).rejects.toThrow("status 401");
  });

  it("no Google token is unavailable, naming the step", async () => {
    const { google, queue } = setup();
    google.failNext(new Response("", { status: 400 }));
    await expect(queue.createTask(JOB, "x")).rejects.toThrow(
      new WorkerUnavailableError("google token: sts status 400"),
    );
    const thrown = setup({ token: () => Promise.reject(new Error("boom")) });
    await expect(thrown.queue.createTask(JOB, "x")).rejects.toThrow("google token: failed");
  });

  it("the fake refuses what Google would, so the fields are right", async () => {
    // A deadline out of Google's range: the fake answers 400, as Google does.
    const withDeadline =
      (deadline: string) =>
      (google: typeof fetch): typeof fetch =>
      async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { task: { dispatchDeadline: string } };
        body.task.dispatchDeadline = deadline;
        return google(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(body),
        });
      };
    for (const deadline of ["14s", "1801s"]) {
      const { queue } = setup({}, withDeadline(deadline));
      await expect(queue.createTask(JOB, "x")).rejects.toThrow("status 400");
    }
    for (const deadline of ["15s", "1800s"]) {
      const { queue } = setup({}, withDeadline(deadline));
      expect(await queue.createTask(JOB, "x")).toEqual({ created: true });
    }
  });

  it("refuses malformed settings and task IDs before calling Google", async () => {
    expect(() => setup({ workerUrl: "http://worker.example.com" })).toThrow("https origin");
    expect(() => setup({ workerUrl: `${WORKER}/run` })).toThrow("https origin");
    expect(() =>
      setup({ queue: { project: "Bad_Project", location: "us-east4", queue: "q" } }),
    ).toThrow("project ID");
    expect(() =>
      setup({ queue: { project: "gitinside-demo", location: "east", queue: "q" } }),
    ).toThrow("region");
    const { google, queue } = setup();
    await expect(queue.createTask(JOB, "a/b")).rejects.toThrow("taskId");
    await expect(queue.createTask(JOB, "")).rejects.toThrow("taskId");
    expect(google.requests).toEqual([]);
  });
});

describe("a task from createTask, pushed to the worker's POST /run (contract, M5.17c2b)", () => {
  const VERSION = "0.1.0";
  // The ID the website stores on the row (enqueue.ts) and the worker derives from the body.
  const ID = jobIdFor({ kind: "analyze", ...JOB }, VERSION);

  /** Deliver `task` as Cloud Tasks would (first attempt) to a worker built from `recorder`. */
  async function deliver(task: GoogleTask, recorder: JobRecorder) {
    const jobsRoot = await mkdtemp(join(tmpdir(), "gitinside-contract-"));
    onTestFinished(() => rm(jobsRoot, { recursive: true, force: true }));
    const server = createRunServer({
      deps: { jobsRoot, recorder, publish: async () => undefined },
      secrets: [SECRET],
      analyzerVersion: VERSION,
      now: () => NOW,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    const url = new URL(task.httpRequest.url);
    const response = await fetch(`http://127.0.0.1:${port}${url.pathname}`, {
      method: task.httpRequest.httpMethod,
      headers: { ...task.httpRequest.headers, [RETRY_COUNT_HEADER]: "0", connection: "close" },
      body: Buffer.from(task.httpRequest.body, "base64"),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  }

  async function createdTask(): Promise<GoogleTask> {
    const { google, queue } = setup();
    await queue.createTask(JOB, taskIdFor(ID, new Date(NOW)));
    const [task] = google.tasks;
    if (task === undefined) throw new Error("no task created");
    return task;
  }

  it("is accepted and starts the website's job under the website's job ID", async () => {
    const started: { request: unknown; jobId: string }[] = [];
    const recorder: JobRecorder = {
      done: async () => false,
      start: async (request, _signal, jobId) => {
        started.push({ request, jobId });
        // Stop before any download: a permanent failure, answered 200 so it isn't retried.
        throw new JobFailure("REPO_NOT_PUBLIC", "contract test");
      },
      failed: async () => undefined,
    };
    expect(await deliver(await createdTask(), recorder)).toEqual({
      status: 200,
      body: { id: ID, state: "failed", errorCode: "REPO_NOT_PUBLIC" },
    });
    expect(started).toEqual([{ request: { kind: "analyze", ...JOB }, jobId: ID }]);
  });

  it("is answered done at once when the website's row for that job ID is done", async () => {
    const looked: string[] = [];
    const recorder: JobRecorder = {
      done: async (jobId) => {
        looked.push(jobId);
        return jobId === ID;
      },
      start: () => Promise.reject(new Error("must not start")),
      failed: async () => undefined,
    };
    expect(await deliver(await createdTask(), recorder)).toEqual({
      status: 200,
      body: { id: ID, state: "done" },
    });
    expect(looked).toEqual([ID]);
  });
});

describe("taskIdFor", () => {
  it("is the job ID, then the queue entry time in ms", () => {
    expect(taskIdFor(JOB_ID, new Date(NOW))).toBe(`${JOB_ID}-${NOW}`);
  });

  it("refuses anything but a job ID and a real time", () => {
    expect(() => taskIdFor("analyze-xyz", new Date(NOW))).toThrow();
    expect(() => taskIdFor(JOB_ID, new Date(Number.NaN))).toThrow();
    expect(() => taskIdFor(JOB_ID, new Date(-1))).toThrow();
  });
});
