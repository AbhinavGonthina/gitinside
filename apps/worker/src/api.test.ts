// @vitest-environment node
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  HEALTH_TIMEOUT_MS,
  JobRequestError,
  createEnqueueHandler,
  createEnqueueServer,
  jobIdFor,
  parseJobRequest,
  type JobQueue,
  type JobRequest,
  type JobStatus,
} from "./api.js";
import { signRequest } from "./hmac.js";

const CURRENT = "c".repeat(43);
const PREVIOUS = "p".repeat(43);
const NOW = 1_793_000_000_000;
const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const VERSION = "0.1.0";

/** An in-memory queue with the same contract BullMQ will meet (M5.4d). */
class MemoryQueue implements JobQueue {
  jobs = new Map<string, { request: JobRequest; status: JobStatus }>();
  failing = false;
  hanging = false;

  add(id: string, request: JobRequest): Promise<{ created: boolean }> {
    if (this.failing) return Promise.reject(new Error("redis down"));
    if (this.jobs.has(id)) return Promise.resolve({ created: false });
    this.jobs.set(id, {
      request,
      status: { id, kind: request.kind, state: "queued", position: this.jobs.size },
    });
    return Promise.resolve({ created: true });
  }

  get(id: string): Promise<JobStatus | undefined> {
    if (this.failing) return Promise.reject(new Error("redis down"));
    return Promise.resolve(this.jobs.get(id)?.status);
  }

  ping(): Promise<void> {
    if (this.hanging) return new Promise(() => undefined);
    return this.failing ? Promise.reject(new Error("redis down")) : Promise.resolve();
  }
}

function setup(now = NOW) {
  const queue = new MemoryQueue();
  const handler = createEnqueueHandler({
    queue,
    secrets: [CURRENT, PREVIOUS],
    analyzerVersion: VERSION,
    now: () => now,
  });
  return { queue, app: request(handler) };
}

const JOB = { kind: "analyze", owner: "vercel", repo: "next.js", sha: SHA };

function signed(method: string, path: string, body = "", secret = CURRENT, at = NOW) {
  return signRequest(secret, { method, path, body: Buffer.from(body) }, at);
}

function enqueue(app: ReturnType<typeof setup>["app"], body: unknown, secret = CURRENT) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return app
    .post("/enqueue")
    .set(signed("POST", "/enqueue", text, secret))
    .set("content-type", "application/json")
    .send(text);
}

describe("POST /enqueue", () => {
  it("queues a job and answers with its derived ID", async () => {
    const { app, queue } = setup();
    const res = await enqueue(app, JOB);
    expect(res.status).toBe(202);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    const id = jobIdFor(JOB as JobRequest, VERSION);
    expect(res.body).toEqual({ id, created: true });
    expect(queue.jobs.get(id)?.request).toEqual(JOB);
  });

  it("dedupes the same commit, ignoring owner and repo case", async () => {
    const { app, queue } = setup();
    const first = await enqueue(app, JOB);
    const again = await enqueue(app, { ...JOB, owner: "Vercel", repo: "Next.JS" });
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ id: first.body.id, created: false });
    expect(queue.jobs.size).toBe(1);
  });

  it("accepts the previous secret during a rollover", async () => {
    const { app } = setup();
    expect((await enqueue(app, JOB, PREVIOUS)).status).toBe(202);
  });

  it("queues diff jobs with their base", async () => {
    const { app, queue } = setup();
    const diff = {
      kind: "diff",
      owner: "o",
      repo: "r",
      sha: SHA,
      baseSha: BASE,
      installationId: 42,
    };
    const res = await enqueue(app, diff);
    expect(res.status).toBe(202);
    expect(res.body.id).toMatch(/^diff-[0-9a-f]{32}$/);
    expect(queue.jobs.get(res.body.id)?.request).toEqual(diff);
  });

  it("refuses bodies that aren't valid jobs, naming the field only", async () => {
    const { app, queue } = setup();
    const bad = await enqueue(app, { ...JOB, owner: "<script>" });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({
      error: "INVALID_REQUEST",
      message: "owner is not a GitHub owner name",
    });
    const json = await enqueue(app, "{not json");
    expect(json.status).toBe(400);
    expect(json.body).toEqual({ error: "INVALID_JSON" });
    expect(queue.jobs.size).toBe(0);
  });

  it("requires a JSON content type", async () => {
    const { app } = setup();
    const text = JSON.stringify(JOB);
    const res = await app
      .post("/enqueue")
      .set(signed("POST", "/enqueue", text))
      .set("content-type", "text/plain")
      .send(text);
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("answers 503 when the queue fails", async () => {
    const { app, queue } = setup();
    queue.failing = true;
    const res = await enqueue(app, JOB);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "QUEUE_UNAVAILABLE" });
  });

  it("refuses other methods", async () => {
    const { app } = setup();
    const res = await app.get("/enqueue").set(signed("GET", "/enqueue"));
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });
});

describe("authentication", () => {
  it("refuses unsigned requests on every route but /health, before routing", async () => {
    const { app, queue } = setup();
    for (const res of [
      await app.post("/enqueue").set("content-type", "application/json").send(JSON.stringify(JOB)),
      await app.get(`/jobs/${jobIdFor(JOB as JobRequest, VERSION)}`),
      await app.get("/no-such-path"),
      await app.delete("/jobs/x"),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "MISSING_SIGNATURE" });
    }
    expect(queue.jobs.size).toBe(0);
  });

  it("refuses a wrong secret, a changed body, and a signature for another path", async () => {
    const { app, queue } = setup();
    const text = JSON.stringify(JOB);
    const wrongSecret = await enqueue(app, JOB, "x".repeat(43));
    const changedBody = await app
      .post("/enqueue")
      .set(signed("POST", "/enqueue", text))
      .set("content-type", "application/json")
      .send(JSON.stringify({ ...JOB, repo: "other" }));
    const otherPath = await app
      .post("/enqueue")
      .set(signed("POST", "/enqueue?x", text))
      .set("content-type", "application/json")
      .send(text);
    for (const res of [wrongSecret, changedBody, otherPath]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "BAD_SIGNATURE" });
    }
    expect(queue.jobs.size).toBe(0);
  });

  it("refuses timestamps outside ±5 minutes", async () => {
    const { app } = setup();
    const text = JSON.stringify(JOB);
    for (const at of [NOW - 301_000, NOW + 301_000]) {
      const res = await app
        .post("/enqueue")
        .set(signed("POST", "/enqueue", text, CURRENT, at))
        .set("content-type", "application/json")
        .send(text);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "STALE_TIMESTAMP" });
    }
    expect((await enqueue(app, JOB)).status).toBe(202);
  });

  it("refuses large bodies unread, declared or chunked", async () => {
    const { app } = setup();
    const big = "x".repeat(16 * 1024 + 1);
    const declared = await app
      .post("/enqueue")
      .set(signed("POST", "/enqueue", big))
      .set("content-type", "application/json")
      .send(big);
    expect(declared.status).toBe(413);
    expect(declared.body).toEqual({ error: "BODY_TOO_LARGE" });

    // No content-length: the body arrives in chunks and is counted as it streams.
    const server = createEnqueueServer({
      queue: new MemoryQueue(),
      secrets: [CURRENT],
      analyzerVersion: VERSION,
      maxBodyBytes: 4,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, method: "POST", path: "/enqueue" },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.write("abc");
        req.end("def");
      });
      expect(status).toBe(413);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("GET /jobs/:id", () => {
  it("returns only the documented status fields", async () => {
    const { app, queue } = setup();
    const { body } = await enqueue(app, JOB);
    const entry = queue.jobs.get(body.id);
    if (entry === undefined) throw new Error("job missing");
    entry.status = {
      ...entry.status,
      state: "failed",
      errorCode: "LIMIT_TIME",
      // A field the queue may hold internally must not reach the caller.
      ...({ token: "secret-token" } as object),
    };
    const path = `/jobs/${body.id}`;
    const res = await app.get(path).set(signed("GET", path));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: body.id,
      kind: "analyze",
      state: "failed",
      position: 0,
      errorCode: "LIMIT_TIME",
    });
  });

  it("returns a running job's stage, step, count, findings, and time left", async () => {
    const { app, queue } = setup();
    const { body } = await enqueue(app, JOB);
    const entry = queue.jobs.get(body.id);
    if (entry === undefined) throw new Error("job missing");
    entry.status = {
      id: body.id,
      kind: "analyze",
      state: "running",
      stage: "analyze",
      progress: 38,
      step: "programs",
      count: 1204,
      found: { services: { count: 1, names: ["web"] }, routes: 3 },
      leftMs: 41_500,
    };
    const path = `/jobs/${body.id}`;
    const res = await app.get(path).set(signed("GET", path));
    expect(res.body).toEqual(entry.status);
  });

  it("answers 404 for unknown and malformed IDs", async () => {
    const { app } = setup();
    for (const id of [`analyze-${"0".repeat(32)}`, "analyze-XYZ", "..", "%2e%2e"]) {
      const path = `/jobs/${id}`;
      const res = await app.get(path).set(signed("GET", path));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "JOB_NOT_FOUND" });
    }
  });

  it("answers 503 when the queue fails and 405 for other methods", async () => {
    const { app, queue } = setup();
    const path = `/jobs/analyze-${"0".repeat(32)}`;
    expect((await app.post(path).set(signed("POST", path))).status).toBe(405);
    queue.failing = true;
    const res = await app.get(path).set(signed("GET", path));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "QUEUE_UNAVAILABLE" });
  });

  it("answers 404 for unknown signed paths", async () => {
    const { app } = setup();
    const res = await app.get("/jobs").set(signed("GET", "/jobs"));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "NOT_FOUND" });
  });
});

describe("GET /health", () => {
  it("is open and reports the queue's reachability only", async () => {
    const { app, queue } = setup();
    const ok = await app.get("/health");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: "ok" });
    queue.failing = true;
    const down = await app.get("/health");
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ status: "unavailable" });
    expect((await app.post("/health")).status).toBe(405);
  });

  it(
    "gives up on a queue that doesn't answer",
    async () => {
      const { app, queue } = setup();
      queue.hanging = true;
      const res = await app.get("/health");
      expect(res.status).toBe(503);
    },
    HEALTH_TIMEOUT_MS + 5_000,
  );
});

describe("handler", () => {
  it("needs a secret", () => {
    expect(() =>
      createEnqueueHandler({ queue: new MemoryQueue(), secrets: [], analyzerVersion: VERSION }),
    ).toThrow("at least one secret");
  });

  it("treats a ping that throws synchronously as an unhealthy queue", async () => {
    const queue = new MemoryQueue();
    queue.ping = () => {
      throw new Error("bug");
    };
    const app = request(
      createEnqueueHandler({ queue, secrets: [CURRENT], analyzerVersion: VERSION, now: () => NOW }),
    );
    const res = await app.get("/health");
    expect(res.status).toBe(503);
  });

  it("uses the real clock by default", async () => {
    const app = request(
      createEnqueueHandler({
        queue: new MemoryQueue(),
        secrets: [CURRENT],
        analyzerVersion: VERSION,
      }),
    );
    const text = JSON.stringify(JOB);
    const res = await app
      .post("/enqueue")
      .set(signRequest(CURRENT, { method: "POST", path: "/enqueue", body: Buffer.from(text) }))
      .set("content-type", "application/json")
      .send(text);
    expect(res.status).toBe(202);
  });

  it("serves the same routes from createEnqueueServer with request timeouts set", async () => {
    const server = createEnqueueServer({
      queue: new MemoryQueue(),
      secrets: [CURRENT],
      analyzerVersion: VERSION,
    });
    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(15_000);
    const res = await request(server).get("/health");
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("parseJobRequest", () => {
  it("accepts GitHub names and drops nothing it was given", () => {
    expect(parseJobRequest({ ...JOB, owner: "a-b-c", repo: "_x.y-z" })).toEqual({
      ...JOB,
      owner: "a-b-c",
      repo: "_x.y-z",
    });
  });

  it.each([
    [[], "body must be a JSON object"],
    [null, "body must be a JSON object"],
    [{ ...JOB, extra: 1 }, 'unknown field "extra"'],
    [{ ...JOB, kind: "run" }, 'kind must be "analyze" or "diff"'],
    [{ ...JOB, owner: "-a" }, "owner is not a GitHub owner name"],
    [{ ...JOB, owner: "a--b" }, "owner is not a GitHub owner name"],
    [{ ...JOB, owner: "a".repeat(40) }, "owner is not a GitHub owner name"],
    [{ ...JOB, repo: ".." }, "repo is not a GitHub repo name"],
    [{ ...JOB, repo: "a/b" }, "repo is not a GitHub repo name"],
    [{ ...JOB, repo: 7 }, "repo is not a GitHub repo name"],
    [{ ...JOB, sha: SHA.toUpperCase() }, "sha must be 40 lowercase hex characters"],
    [{ ...JOB, sha: "abc" }, "sha must be 40 lowercase hex characters"],
    [{ ...JOB, baseSha: BASE }, "baseSha is only for diff jobs"],
    [{ ...JOB, kind: "diff" }, "baseSha must be 40 lowercase hex characters"],
    [{ ...JOB, installationId: 0 }, "installationId must be a positive integer"],
    [{ ...JOB, installationId: 1.5 }, "installationId must be a positive integer"],
    [{ ...JOB, installationId: "1" }, "installationId must be a positive integer"],
  ])("refuses %j", (value, message) => {
    expect(() => parseJobRequest(value)).toThrow(new JobRequestError(message));
  });
});

describe("jobIdFor", () => {
  const job = JOB as JobRequest;

  it("depends on the commit, the base, and the analyzer version", () => {
    const id = jobIdFor(job, VERSION);
    expect(id).toMatch(/^analyze-[0-9a-f]{32}$/);
    expect(jobIdFor({ ...job, installationId: 9 }, VERSION)).toBe(id);
    expect(jobIdFor({ ...job, sha: BASE }, VERSION)).not.toBe(id);
    expect(jobIdFor(job, "0.2.0")).not.toBe(id);
    expect(jobIdFor({ ...job, kind: "diff", baseSha: BASE }, VERSION)).not.toBe(
      jobIdFor({ ...job, kind: "diff", baseSha: SHA }, VERSION),
    );
  });
});
