// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JobFailure,
  MAX_ATTEMPTS,
  RETRY_COUNT_HEADER as WORKER_RETRY_COUNT_HEADER,
  createRunServer,
  jobIdFor,
  type JobRecorder,
} from "@gitinside/worker";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "@gitinside/worker/hmac";
import { parseJobRequest } from "@gitinside/worker/request";
import { describe, expect, it, onTestFinished } from "vitest";
import { RUN_PATH, taskIdFor } from "./cloudTasks";
import {
  LOCAL_MAX_ATTEMPTS,
  RETRY_COUNT_HEADER,
  TASK_NAME_WINDOW_MS,
  createLocalTaskQueue,
  isLoopbackOrigin,
  type LocalTaskEvent,
  type LocalTaskQueueOptions,
} from "./localTasks";

const SECRET = "s".repeat(43);
const JOB = { owner: "acme", repo: "shop", sha: "c".repeat(40) };
const NOW = Date.parse("2026-11-01T12:00:00Z");
const VERSION = "0.1.0";
const ID = jobIdFor({ kind: "analyze", ...JOB }, VERSION);

/** What a fake worker received: path, headers, body, and how many pushes were open at once. */
interface Received {
  path: string | undefined;
  headers: IncomingMessage["headers"];
  body: Buffer;
  open: number;
}

/** A worker stand-in answering each push with the next status of `statuses` (last repeats). */
async function fakeWorker(statuses: number[], holdMs = 0) {
  const received: Received[] = [];
  let open = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    open++;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks), open });
      const status = statuses[Math.min(received.length - 1, statuses.length - 1)] ?? 200;
      setTimeout(() => {
        open--;
        res.writeHead(status, { "content-type": "application/json", connection: "close" });
        res.end("{}");
      }, holdMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, received };
}

function queueFor(origin: string, overrides: Partial<LocalTaskQueueOptions> = {}) {
  const events: LocalTaskEvent[] = [];
  const queue = createLocalTaskQueue({
    workerUrl: origin,
    secret: SECRET,
    backoffMs: () => 0,
    log: (event) => events.push(event),
    now: () => NOW,
    ...overrides,
  });
  return { queue, events };
}

describe("createLocalTaskQueue", () => {
  it("pushes the signed job to the worker's /run, as Cloud Tasks would", async () => {
    const worker = await fakeWorker([200]);
    const { queue, events } = queueFor(worker.origin);
    const id = taskIdFor(ID, new Date(NOW));
    expect(await queue.createTask(JOB, id)).toEqual({ created: true });
    await queue.idle();

    expect(worker.received).toHaveLength(1);
    const [push] = worker.received;
    expect(push?.path).toBe(RUN_PATH);
    expect(push?.headers["content-type"]).toBe("application/json");
    expect(push?.headers[RETRY_COUNT_HEADER]).toBe("0");
    const body = new Uint8Array(push?.body ?? []);
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({ kind: "analyze", ...JOB });
    expect(
      verifyRequest(
        [SECRET],
        { method: "POST", path: RUN_PATH, body },
        {
          timestamp: push?.headers[TIMESTAMP_HEADER],
          signature: push?.headers[SIGNATURE_HEADER],
        },
        NOW,
      ),
    ).toEqual({ ok: true });
    expect(events).toEqual([
      { event: "local_task_delivered", taskId: id, attempt: 1, status: 200 },
    ]);
  });

  it("pushes a diff job with its kind, base, and installation, as the worker parses them", async () => {
    const worker = await fakeWorker([200]);
    const { queue } = queueFor(worker.origin);
    const diff = { kind: "diff", ...JOB, baseSha: "b".repeat(40), installationId: 41 } as const;
    expect(await queue.createTask(diff, "diff-task")).toEqual({ created: true });
    await queue.idle();
    const body = worker.received[0]?.body.toString() ?? "";
    expect(parseJobRequest(JSON.parse(body))).toEqual(diff);
  });

  it("uses the worker's header name and attempt count", () => {
    expect(RETRY_COUNT_HEADER).toBe(WORKER_RETRY_COUNT_HEADER);
    expect(LOCAL_MAX_ATTEMPTS).toBe(MAX_ATTEMPTS);
  });

  it("a used task name is the job already queued, for 24 hours", async () => {
    const worker = await fakeWorker([200]);
    let now = NOW;
    const { queue } = queueFor(worker.origin, { now: () => now });
    expect(await queue.createTask(JOB, "task-a")).toEqual({ created: true });
    expect(await queue.createTask(JOB, "task-a")).toEqual({ created: false });
    now = NOW + TASK_NAME_WINDOW_MS - 1;
    expect(await queue.createTask(JOB, "task-a")).toEqual({ created: false });
    now = NOW + TASK_NAME_WINDOW_MS;
    expect(await queue.createTask(JOB, "task-a")).toEqual({ created: true });
    await queue.idle();
    expect(worker.received).toHaveLength(2);
  });

  it("retries an answer that isn't 2xx, counting attempts like Cloud Tasks", async () => {
    const worker = await fakeWorker([503, 429, 200]);
    const delays: number[] = [];
    const { queue, events } = queueFor(worker.origin, {
      backoffMs: (retry) => {
        delays.push(retry);
        return 0;
      },
    });
    await queue.createTask(JOB, "task-r");
    await queue.idle();
    expect(worker.received.map((r) => r.headers[RETRY_COUNT_HEADER])).toEqual(["0", "1", "2"]);
    expect(delays).toEqual([1, 2]);
    expect(events).toEqual([
      { event: "local_task_retry", taskId: "task-r", attempt: 1, status: 503 },
      { event: "local_task_retry", taskId: "task-r", attempt: 2, status: 429 },
      { event: "local_task_delivered", taskId: "task-r", attempt: 3, status: 200 },
    ]);
    // Every delivery carries the signature made when the task was created.
    const stamps = new Set(worker.received.map((r) => r.headers[TIMESTAMP_HEADER]));
    expect(stamps.size).toBe(1);
  });

  it("drops a task after the last attempt, and later tasks still go", async () => {
    const worker = await fakeWorker([500, 500, 500, 200]);
    const { queue, events } = queueFor(worker.origin);
    await queue.createTask(JOB, "task-x");
    await queue.createTask(JOB, "task-y");
    await queue.idle();
    expect(worker.received).toHaveLength(LOCAL_MAX_ATTEMPTS + 1);
    expect(events.filter((e) => e.event !== "local_task_retry")).toEqual([
      { event: "local_task_dropped", taskId: "task-x", attempts: LOCAL_MAX_ATTEMPTS },
      { event: "local_task_delivered", taskId: "task-y", attempt: 1, status: 200 },
    ]);
  });

  it("a worker that isn't running: createTask still succeeds, the push is retried, then dropped", async () => {
    // A port that was just free: nothing listens there.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const { queue, events } = queueFor(`http://127.0.0.1:${port}`);
    expect(await queue.createTask(JOB, "task-d")).toEqual({ created: true });
    await queue.idle();
    expect(events).toEqual([
      { event: "local_task_retry", taskId: "task-d", attempt: 1, status: "no answer" },
      { event: "local_task_retry", taskId: "task-d", attempt: 2, status: "no answer" },
      { event: "local_task_dropped", taskId: "task-d", attempts: 3 },
    ]);
  });

  it("pushes one task at a time, in order, so a local worker is never busy", async () => {
    const worker = await fakeWorker([200], 30);
    const { queue } = queueFor(worker.origin);
    for (const sha of ["a", "b", "c"]) {
      await queue.createTask({ ...JOB, sha: sha.repeat(40) }, `task-${sha}`);
    }
    await queue.idle();
    expect(worker.received.map((r) => r.open)).toEqual([1, 1, 1]);
    expect(
      worker.received.map((r) => (JSON.parse(r.body.toString("utf8")) as { sha: string }).sha[0]),
    ).toEqual(["a", "b", "c"]);
  });

  it("refuses a worker that isn't on this machine, and bad task IDs", async () => {
    for (const url of [
      "https://worker-abc123-uk.a.run.app",
      "http://10.0.0.5:8080",
      "http://127.0.0.1.example.com:8080",
      "http://localhost:8080/run",
      "http://user:pw@localhost:8080",
      "file:///tmp/x",
      "not a url",
    ]) {
      expect(isLoopbackOrigin(url), url).toBe(false);
      expect(() => queueFor(url), url).toThrow("localhost");
    }
    for (const url of ["http://localhost:8080", "http://127.0.0.1:8080/", "http://[::1]:8080"]) {
      expect(isLoopbackOrigin(url), url).toBe(true);
    }
    const worker = await fakeWorker([200]);
    const { queue } = queueFor(worker.origin);
    await expect(queue.createTask(JOB, "a/b")).rejects.toThrow("taskId");
    await queue.idle();
    expect(worker.received).toEqual([]);
  });
});

describe("a local push to the worker's real POST /run (contract)", () => {
  it("starts the website's job under the website's job ID", async () => {
    const jobsRoot = await mkdtemp(join(tmpdir(), "gitinside-local-tasks-"));
    onTestFinished(() => rm(jobsRoot, { recursive: true, force: true }));
    const started: { request: unknown; jobId: string; attempt: number }[] = [];
    const recorder: JobRecorder = {
      done: async () => false,
      start: async (request, _signal, jobId) => {
        started.push({ request, jobId, attempt: started.length + 1 });
        // Retriable, so the worker answers 503 until the last attempt, then 200 (final).
        throw new JobFailure("DOWNLOAD_FAILED", "contract test");
      },
      failed: async () => undefined,
    };
    const server = createRunServer({
      deps: { jobsRoot, recorder, publish: async () => undefined },
      secrets: [SECRET],
      analyzerVersion: VERSION,
      now: () => NOW,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;

    const { queue, events } = queueFor(`http://127.0.0.1:${port}`);
    const id = taskIdFor(ID, new Date(NOW));
    await queue.createTask(JOB, id);
    await queue.idle();
    expect(started.map((s) => s.jobId)).toEqual([ID, ID, ID]);
    expect(started[0]?.request).toEqual({ kind: "analyze", ...JOB });
    expect(events).toEqual([
      { event: "local_task_retry", taskId: id, attempt: 1, status: 503 },
      { event: "local_task_retry", taskId: id, attempt: 2, status: 503 },
      { event: "local_task_delivered", taskId: id, attempt: 3, status: 200 },
    ]);
  });
});
