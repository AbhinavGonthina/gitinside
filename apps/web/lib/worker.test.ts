// @vitest-environment node
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createEnqueueServer, jobIdFor, type JobQueue, type JobRequest } from "@gitinside/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkerUnavailableError, createWorkerClient } from "./worker";

const SECRET = "s".repeat(43);
const SHA = "c".repeat(40);
const JOB = { owner: "acme", repo: "shop", sha: SHA };

describe("createWorkerClient against the real enqueue API", () => {
  const added: JobRequest[] = [];
  const ids = new Set<string>();
  const queue: JobQueue = {
    async add(id, request) {
      added.push(request);
      const created = !ids.has(id);
      ids.add(id);
      return { created };
    },
    get: async () => undefined,
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
    const stale = createWorkerClient({ url, secret: SECRET, now: () => Date.now() - 3_600_000 });
    await expect(stale.enqueue(JOB)).rejects.toThrow("status 401");
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
});
