// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYZE_JOB_ID, handleJobEvents, handleJobRequest, type JobRouteDeps } from "./jobRoute";
import { UNAVAILABLE_VIEW, failureView } from "./jobs";
import { WorkerUnavailableError, type WorkerJobStatus } from "./worker";

const ID = `analyze-${"a".repeat(32)}`;
const FAST = { intervalMs: 2, lifetimeMs: 2_000, heartbeatMs: 60_000, retryMs: 500 };

/** A worker that answers each `status` call with the next entry (the last one repeats). */
function scripted(answers: (WorkerJobStatus | undefined | Error)[]) {
  const calls: string[] = [];
  const deps: JobRouteDeps = {
    worker: {
      async status(id) {
        calls.push(id);
        const answer = answers[Math.min(calls.length, answers.length) - 1];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
  return { deps, calls };
}

const queued = (position?: number): WorkerJobStatus => ({
  id: ID,
  kind: "analyze",
  state: "queued",
  ...(position === undefined ? {} : { position }),
});
const running = (fields: Partial<WorkerJobStatus>): WorkerJobStatus => ({
  id: ID,
  kind: "analyze",
  state: "running",
  ...fields,
});
const done: WorkerJobStatus = { id: ID, kind: "analyze", state: "done" };

/** The `status` events in a finished stream, parsed, plus the raw text. */
async function events(response: Response) {
  const text = await response.text();
  const views = [...text.matchAll(/^event: status\ndata: (.*)$/gm)].map(
    (m) => JSON.parse(m[1] as string) as unknown,
  );
  return { text, views };
}

afterEach(() => vi.restoreAllMocks());

describe("handleJobRequest", () => {
  it("answers the view as JSON, never cached", async () => {
    const { deps } = scripted([queued(2)]);
    const response = await handleJobRequest(ID, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      state: "queued",
      step: "queue",
      progress: 0,
      text: "2 ahead of you",
      position: 2,
    });
  });

  it("missing is 404, unavailable 503, a malformed ID 404 without asking", async () => {
    const { deps, calls } = scripted([undefined]);
    expect((await handleJobRequest(ID, deps)).status).toBe(404);
    expect((await handleJobRequest(ID, undefined)).status).toBe(503);
    const bad = await handleJobRequest(`diff-${"a".repeat(32)}`, deps);
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({
      error: "JOB_NOT_FOUND",
      message: "There's no analysis with that ID.",
    });
    expect(calls).toEqual([ID]);
  });

  it("a worker error is unavailable; an unexpected one is also logged, by name only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = scripted([new WorkerUnavailableError("status 503")]);
    expect(await (await handleJobRequest(ID, down.deps)).json()).toEqual(UNAVAILABLE_VIEW);
    expect(log).not.toHaveBeenCalled();

    const broken = scripted([new RangeError("postgres://user:pw@host")]);
    expect((await handleJobRequest(ID, broken.deps)).status).toBe(503);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "job_status_failed", error: "RangeError" }),
    );
  });
});

describe("handleJobEvents", () => {
  it("streams each change once and ends after the final view", async () => {
    const { deps, calls } = scripted([
      queued(1),
      queued(1),
      queued(0),
      running({ stage: "download", progress: 0 }),
      running({ stage: "analyze", progress: 34, step: "programs", count: 1204 }),
      running({ stage: "analyze", progress: 34, step: "programs", count: 1204 }),
      done,
    ]);
    const response = handleJobEvents(ID, new AbortController().signal, deps, FAST);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const { text, views } = await events(response);
    expect(text.startsWith("retry: 500\n\n")).toBe(true);
    expect(views).toEqual([
      { state: "queued", step: "queue", progress: 0, text: "1 ahead of you", position: 1 },
      { state: "queued", step: "queue", progress: 0, text: "You're next", position: 0 },
      { state: "running", step: "download", progress: 0, text: "Downloading" },
      { state: "running", step: "analyze", progress: 34, text: "Parsing 1,204 files" },
      { state: "done" },
    ]);
    expect(calls).toHaveLength(7);
  });

  it("a failure and a missing job are final too", async () => {
    const failed = scripted([{ ...done, state: "failed", errorCode: "LIMIT_FILES" }]);
    const a = await events(handleJobEvents(ID, new AbortController().signal, failed.deps, FAST));
    expect(a.views).toEqual([failureView("LIMIT_FILES")]);
    expect(failed.calls).toHaveLength(1);

    const missing = scripted([undefined]);
    const b = await events(handleJobEvents(ID, new AbortController().signal, missing.deps, FAST));
    expect(b.views).toMatchObject([{ state: "missing" }]);
  });

  it("says unavailable while the worker is down and carries on when it's back", async () => {
    const { deps } = scripted([
      queued(0),
      new WorkerUnavailableError("request failed"),
      new WorkerUnavailableError("request failed"),
      queued(0),
      done,
    ]);
    const { views } = await events(handleJobEvents(ID, new AbortController().signal, deps, FAST));
    expect(views.map((v) => (v as { state: string }).state)).toEqual([
      "queued",
      "unavailable",
      "queued",
      "done",
    ]);
  });

  it("unconfigured: unavailable, and the stream stays open until its lifetime ends", async () => {
    const response = handleJobEvents(ID, new AbortController().signal, undefined, {
      ...FAST,
      lifetimeMs: 30,
    });
    const { views } = await events(response);
    expect(views).toEqual([UNAVAILABLE_VIEW]);
  });

  it("ends by itself after its lifetime, so the browser reconnects", async () => {
    const { deps, calls } = scripted([queued(3)]);
    const started = Date.now();
    const { views } = await events(
      handleJobEvents(ID, new AbortController().signal, deps, { ...FAST, lifetimeMs: 60 }),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(views).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("sends a keep-alive comment when nothing changes for a while", async () => {
    const { deps } = scripted([queued(3)]);
    const { text } = await events(
      handleJobEvents(ID, new AbortController().signal, deps, {
        ...FAST,
        intervalMs: 5,
        heartbeatMs: 10,
        lifetimeMs: 80,
      }),
    );
    expect(text).toContain("\n\n: keep-alive\n\n");
  });

  it("stops asking the worker once the browser goes away", async () => {
    const { deps, calls } = scripted([queued(3)]);
    const abort = new AbortController();
    const response = handleJobEvents(ID, abort.signal, deps, { ...FAST, lifetimeMs: 60_000 });
    const reader = response.body!.getReader();
    await reader.read(); // retry
    await reader.read(); // first status
    abort.abort();
    await new Promise((r) => setTimeout(r, 30));
    const seen = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(seen);
    expect((await reader.read()).done).toBe(true);
  });

  it("stops when the reader cancels the stream", async () => {
    const { deps, calls } = scripted([queued(3)]);
    const response = handleJobEvents(ID, new AbortController().signal, deps, {
      ...FAST,
      lifetimeMs: 60_000,
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 30));
    const seen = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(seen);
  });

  it("a malformed ID is a plain 404, not a stream", async () => {
    const { deps, calls } = scripted([done]);
    const response = handleJobEvents("analyze-zz", new AbortController().signal, deps);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(calls).toEqual([]);
  });

  it("ANALYZE_JOB_ID accepts only analysis IDs", () => {
    expect(ANALYZE_JOB_ID.test(ID)).toBe(true);
    expect(ANALYZE_JOB_ID.test(`diff-${"a".repeat(32)}`)).toBe(false);
    expect(ANALYZE_JOB_ID.test(`${ID}x`)).toBe(false);
  });
});
