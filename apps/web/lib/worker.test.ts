// @vitest-environment node
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  createEnqueueServer,
  jobIdFor,
  type JobQueue,
  type JobRequest,
  type JobStatus,
} from "@gitinside/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkerUnavailableError, createWorkerClient, parseJobStatus } from "./worker";

const SECRET = "s".repeat(43);
const SHA = "c".repeat(40);
const JOB = { owner: "acme", repo: "shop", sha: SHA };

describe("createWorkerClient against the real enqueue API", () => {
  const added: JobRequest[] = [];
  const ids = new Set<string>();
  const statuses = new Map<string, JobStatus>();
  const queue: JobQueue = {
    async add(id, request) {
      added.push(request);
      const created = !ids.has(id);
      ids.add(id);
      return { created };
    },
    get: async (id) => statuses.get(id),
    ping: async () => undefined,
  };
  const server = createEnqueueServer({ queue, secrets: [SECRET], analyzerVersion: "0.1.0" });
  let url = "";
  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("signs a job the worker accepts, and the same commit is one job", async () => {
    const client = createWorkerClient({ url, secret: SECRET });
    const first = await client.enqueue(JOB);
    const id = jobIdFor({ kind: "analyze", ...JOB }, "0.1.0");
    expect(first).toEqual({ id, created: true });
    expect(await client.enqueue({ ...JOB, owner: "ACME" })).toEqual({ id, created: false });
    expect(added[0]).toEqual({ kind: "analyze", ...JOB });
  });

  it("works with a trailing slash on the URL", async () => {
    const client = createWorkerClient({ url: `${url}/`, secret: SECRET });
    expect((await client.enqueue(JOB)).created).toBe(false);
  });

  it("a wrong secret or a stale clock is refused as unavailable", async () => {
    const wrong = createWorkerClient({ url, secret: "w".repeat(43) });
    await expect(wrong.enqueue(JOB)).rejects.toThrow(new WorkerUnavailableError("status 401"));
    await expect(wrong.status(`analyze-${"0".repeat(32)}`)).rejects.toThrow("status 401");
    const stale = createWorkerClient({ url, secret: SECRET, now: () => Date.now() - 3_600_000 });
    await expect(stale.enqueue(JOB)).rejects.toThrow("status 401");
  });

  it("reads a job's status with a signed GET, and an unknown job is undefined", async () => {
    const client = createWorkerClient({ url, secret: SECRET });
    const id = jobIdFor({ kind: "analyze", ...JOB }, "0.1.0");
    const running: JobStatus = {
      id,
      kind: "analyze",
      state: "running",
      stage: "analyze",
      progress: 34,
      step: "programs",
      count: 1204,
    };
    statuses.set(id, running);
    expect(await client.status(id)).toEqual(running);
    statuses.set(id, { id, kind: "analyze", state: "queued", position: 2 });
    expect(await client.status(id)).toEqual({ id, kind: "analyze", state: "queued", position: 2 });
    expect(await client.status(`analyze-${"f".repeat(32)}`)).toBeUndefined();
  });
});

describe("parseJobStatus", () => {
  const id = `analyze-${"a".repeat(32)}`;
  const ok = { id, kind: "analyze", state: "failed", errorCode: "LIMIT_FILES" };

  it("keeps documented fields only", () => {
    expect(parseJobStatus({ ...ok, extra: "secret" })).toEqual(ok);
    expect(parseJobStatus({ id, kind: "diff", state: "done" })).toEqual({
      id,
      kind: "diff",
      state: "done",
    });
  });

  it.each([
    ["not an object", null],
    ["an array", []],
    ["a bad ID", { ...ok, id: "x" }],
    ["a bad kind", { ...ok, kind: "build" }],
    ["a bad state", { ...ok, state: "stuck" }],
    ["a bad stage", { ...ok, stage: "compile" }],
    ["an inherited stage name", { ...ok, stage: "toString" }],
    ["progress over 100", { ...ok, progress: 101 }],
    ["a bad step", { ...ok, step: "magic" }],
    ["a fractional count", { ...ok, count: 1.5 }],
    ["a negative position", { ...ok, position: -1 }],
    ["free-text error", { ...ok, errorCode: "failed at /home/x" }],
  ])("refuses %s", (_, value) => {
    expect(parseJobStatus(value)).toBeUndefined();
  });
});

describe("createWorkerClient failures", () => {
  const answer = (response: Response | Error) =>
    createWorkerClient({
      url: "https://worker.example",
      secret: SECRET,
      fetch: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    });

  it("posts to /enqueue with the signature headers", async () => {
    let seen: Request | undefined;
    const client = createWorkerClient({
      url: "https://worker.example",
      secret: SECRET,
      now: () => 1_700_000_000_000,
      fetch: async (input, init) => {
        seen = new Request(input, init);
        return Response.json({ id: `analyze-${"0".repeat(32)}`, created: true }, { status: 202 });
      },
    });
    await client.enqueue(JOB);
    expect(seen?.url).toBe("https://worker.example/enqueue");
    expect(seen?.method).toBe("POST");
    expect(seen?.headers.get("x-gitinside-timestamp")).toBe("1700000000");
    expect(seen?.headers.get("x-gitinside-signature")).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(seen?.headers.get("content-type")).toBe("application/json");
  });

  it("network errors, other statuses, and malformed answers are WorkerUnavailableError", async () => {
    await expect(answer(new TypeError("fetch failed")).enqueue(JOB)).rejects.toThrow(
      "request failed",
    );
    await expect(answer(new Response("", { status: 503 })).enqueue(JOB)).rejects.toThrow(
      "status 503",
    );
    await expect(answer(new Response("{", { status: 202 })).enqueue(JOB)).rejects.toThrow(
      "malformed answer",
    );
    for (const body of [null, { id: "x", created: true }, { id: `analyze-${"0".repeat(32)}` }]) {
      await expect(
        answer(Response.json(body, { status: 202 })).enqueue(JOB),
      ).rejects.toBeInstanceOf(WorkerUnavailableError);
    }
  });

  it("status: GETs /jobs/<id> signed, without a body", async () => {
    const id = `analyze-${"1".repeat(32)}`;
    let seen: Request | undefined;
    const client = createWorkerClient({
      url: "https://worker.example/",
      secret: SECRET,
      fetch: async (input, init) => {
        seen = new Request(input, init);
        return Response.json({ id, kind: "analyze", state: "done" });
      },
    });
    expect(await client.status(id)).toEqual({ id, kind: "analyze", state: "done" });
    expect(seen?.url).toBe(`https://worker.example/jobs/${id}`);
    expect(seen?.method).toBe("GET");
    expect(seen?.headers.get("x-gitinside-signature")).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(seen?.headers.get("content-type")).toBeNull();
  });

  it("status: an ID the worker never issues isn't requested", async () => {
    let calls = 0;
    const client = createWorkerClient({
      url: "https://worker.example",
      secret: SECRET,
      fetch: async () => {
        calls += 1;
        return new Response("");
      },
    });
    for (const id of ["../health", "analyze-x", `diff-${"0".repeat(31)}`]) {
      expect(await client.status(id)).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  it("status: failures, malformed answers, and another job's answer are unavailable", async () => {
    const id = `analyze-${"2".repeat(32)}`;
    await expect(answer(new TypeError("fetch failed")).status(id)).rejects.toThrow(
      "request failed",
    );
    await expect(answer(new Response("", { status: 503 })).status(id)).rejects.toThrow(
      "status 503",
    );
    await expect(answer(new Response("{", { status: 200 })).status(id)).rejects.toThrow(
      "malformed answer",
    );
    await expect(answer(Response.json({ id, state: "done" })).status(id)).rejects.toThrow(
      "malformed answer",
    );
    const other = { id: `analyze-${"3".repeat(32)}`, kind: "analyze", state: "done" };
    await expect(answer(Response.json(other)).status(id)).rejects.toThrow("malformed answer");
    expect(await answer(new Response("", { status: 404 })).status(id)).toBeUndefined();
  });
});
