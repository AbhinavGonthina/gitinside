// @vitest-environment node
import {
  completeAnalysis,
  queueAnalysis,
  recordJobProgress,
  startAnalysis,
  upsertRepo,
  type JobProgress,
  type JobRecord,
} from "@gitinside/db";
import { createTestDb } from "@gitinside/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYZE_JOB_ID,
  handleJobEvents,
  handleJobRequest,
  jobRouteDeps,
  type JobRouteDeps,
} from "./jobRoute";
import { MISSING_MESSAGE, UNAVAILABLE_VIEW, failureView } from "./jobs";

const ID = `analyze-${"a".repeat(32)}`;
const FAST = { intervalMs: 2, lifetimeMs: 2_000, heartbeatMs: 60_000, retryMs: 500 };

/** A database that answers each read with the next entry (the last one repeats). */
function scripted(answers: (JobRecord | undefined | Error)[]) {
  const calls: string[] = [];
  const deps: JobRouteDeps = {
    async findJob(id) {
      calls.push(id);
      const answer = answers[Math.min(calls.length, answers.length) - 1];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { deps, calls };
}

const row = (fields: Partial<JobRecord>): JobRecord => ({
  analysisId: "00000000-0000-4000-8000-000000000001",
  status: "queued",
  errorCode: null,
  attempts: 0,
  progress: null,
  visibility: "public",
  ...fields,
});
const queued = (position?: number): JobRecord => row(position === undefined ? {} : { position });
const running = (progress?: JobProgress): JobRecord =>
  row({
    status: "running",
    attempts: 1,
    ...(progress === undefined ? {} : { progress, progressAgeMs: 0 }),
  });
const done: JobRecord = row({ status: "done" });

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

  it("a database error is unavailable, logged by name only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = scripted([new RangeError("postgres://user:pw@host")]);
    const response = await handleJobRequest(ID, broken.deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(UNAVAILABLE_VIEW);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "job_status_failed", error: "RangeError" }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("pw@host");
  });
});

describe("the job routes on the database (ADR-0139, ADR-0140)", { timeout: 60_000 }, () => {
  const SHA = "a".repeat(40);
  const FACTS = {
    providerRepoId: 3_000_000_001,
    owner: "acme",
    name: "shop",
    visibility: "public" as const,
    defaultBranch: "main",
  };

  it("follow a job's row from the queue to done, the worker never asked", async () => {
    const t = await createTestDb();
    try {
      const deps = jobRouteDeps(t.db);
      const view = async () => (await handleJobRequest(ID, deps)).json();
      expect(await view()).toMatchObject({ state: "missing", message: MISSING_MESSAGE });

      const { id: repoId } = await upsertRepo(t.db, FACTS);
      const key = { repoId, sha: SHA, analyzerVersion: "0.1.0" };
      const other = { ...key, sha: "b".repeat(40) };
      await queueAnalysis(t.db, other, { jobId: `analyze-${"b".repeat(32)}` });
      // Past the clock's resolution, so the two rows can't enter the queue at the same instant.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await queueAnalysis(t.db, key, { jobId: ID });
      expect(await view()).toMatchObject({ state: "queued", text: "1 ahead of you" });

      await startAnalysis(t.db, key, { jobId: ID });
      expect(await view()).toMatchObject({ state: "running", text: "Downloading" });
      await recordJobProgress(t.db, ID, {
        stage: "analyze",
        progress: 34,
        step: "programs",
        count: 1204,
        found: { routes: 2 },
        // "About 50 s left" while the read comes within 5 s of the write.
        leftMs: 45_000,
      });
      expect(await view()).toEqual({
        state: "running",
        step: "analyze",
        progress: 34,
        text: "Parsing 1,204 files",
        found: [{ key: "routes", label: "Entry points", text: "2 routes" }],
        timeLeft: "About 50 s left",
      });

      await completeAnalysis(t.db, (await startAnalysis(t.db, key)).id, {
        snapshotKey: "k",
        stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
      });
      expect(await view()).toEqual({ state: "done" });
    } finally {
      await t.close();
    }
  });

  it("hide a private repo's job", async () => {
    const t = await createTestDb();
    try {
      const { id: repoId } = await upsertRepo(t.db, { ...FACTS, visibility: "private" });
      await queueAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: "0.1.0" }, { jobId: ID });
      const response = await handleJobRequest(ID, jobRouteDeps(t.db));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ state: "missing", message: MISSING_MESSAGE });
    } finally {
      await t.close();
    }
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
      // Something found is a change of its own, even on the same step (#8).
      running({
        stage: "analyze",
        progress: 34,
        step: "programs",
        count: 1204,
        found: { routes: 2 },
      }),
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
      { state: "running", step: "download", progress: 0, text: "Downloading", found: [] },
      { state: "running", step: "analyze", progress: 34, text: "Parsing 1,204 files", found: [] },
      {
        state: "running",
        step: "analyze",
        progress: 34,
        text: "Parsing 1,204 files",
        found: [{ key: "routes", label: "Entry points", text: "2 routes" }],
      },
      { state: "done" },
    ]);
    expect(calls).toHaveLength(8);
  });

  it("a failure and a missing job are final too", async () => {
    const failed = scripted([row({ status: "failed", errorCode: "LIMIT_FILES" })]);
    const a = await events(handleJobEvents(ID, new AbortController().signal, failed.deps, FAST));
    expect(a.views).toEqual([failureView("LIMIT_FILES")]);
    expect(failed.calls).toHaveLength(1);

    const missing = scripted([undefined]);
    const b = await events(handleJobEvents(ID, new AbortController().signal, missing.deps, FAST));
    expect(b.views).toMatchObject([{ state: "missing" }]);
  });

  it("says unavailable while the database is down and carries on when it's back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = scripted([
      queued(0),
      new Error("connection refused"),
      new Error("connection refused"),
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
