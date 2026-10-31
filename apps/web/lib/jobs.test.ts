// @vitest-environment node
import { MAX_SOURCE_MB } from "@gitinside/analyzer";
import type { JobProgress, JobRecord } from "@gitinside/db";
import { describe, expect, it } from "vitest";
import { NBSP, SUPPORTED_SIZE } from "./limits";
import {
  MISSING_MESSAGE,
  PROGRESS_STEPS,
  UNAVAILABLE_VIEW,
  failureView,
  isFinal,
  jobView,
  permanentFailure,
  queueText,
} from "./jobs";

/** A job as `findJob` reads it: queued, public, unless `fields` say otherwise. */
const record = (fields: Partial<JobRecord>): JobRecord => ({
  analysisId: "00000000-0000-4000-8000-000000000001",
  status: "queued",
  errorCode: null,
  attempts: 0,
  progress: null,
  visibility: "public",
  ...fields,
});
const running = (progress: unknown, progressAgeMs = 0): JobRecord =>
  record({ status: "running", attempts: 1, progress: progress as JobProgress, progressAgeMs });

describe("jobView", () => {
  it("a waiting job says how many are ahead (UX.md: '2 ahead of you')", () => {
    expect(jobView(record({ position: 2 }))).toEqual({
      state: "queued",
      step: "queue",
      progress: 0,
      text: "2 ahead of you",
      position: 2,
    });
    expect(jobView(record({ position: 0 }))).toMatchObject({ text: "You're next" });
    expect(jobView(record({ position: 1_204 }))).toMatchObject({ text: "1,204 ahead of you" });
    expect(jobView(record({}))).toEqual({
      state: "queued",
      step: "queue",
      progress: 0,
      text: "Waiting in the queue",
    });
  });

  it("a running job carries the worker's stage, progress, and words", () => {
    expect(
      jobView(running({ stage: "analyze", progress: 34, step: "programs", count: 1204 })),
    ).toEqual({
      state: "running",
      step: "analyze",
      progress: 34,
      text: "Parsing 1,204 files",
      found: [],
    });
    expect(
      jobView(running({ stage: "analyze", progress: 70, step: "http", count: 87 })),
    ).toMatchObject({ text: "Linking 87 calls to routes", progress: 70 });
    expect(jobView(running({ stage: "upload", progress: 90 }))).toMatchObject({
      step: "upload",
      text: "Saving the diagram",
    });
  });

  it("running before any progress is stored counts as downloading", () => {
    expect(jobView(record({ status: "running", attempts: 1 }))).toEqual({
      state: "running",
      step: "download",
      progress: 0,
      text: "Downloading",
      found: [],
    });
  });

  it.each([
    { stage: "hacking", progress: 30 },
    { stage: "analyze", progress: 40, step: "programs", count: -1 },
    { stage: "analyze", progress: 40, found: { services: { count: 1, names: ["a‮b"] } } },
    { stage: "analyze", progress: 40, leftMs: "soon" },
  ])("shows nothing of progress that isn't well formed: %j", (progress) => {
    expect(jobView(running(progress))).toEqual({
      state: "running",
      step: "download",
      progress: 0,
      text: "Downloading",
      found: [],
    });
  });

  it("copies nothing the row holds beyond the documented fields", () => {
    const view = jobView(running({ stage: "upload", progress: 90, html: "<b>", since: 1 }));
    expect(view).toEqual({
      state: "running",
      step: "upload",
      progress: 90,
      text: "Saving the diagram",
      found: [],
    });
  });

  it("a running job says what the analyzer has found so far, in words (#8)", () => {
    const view = jobView(
      running({
        stage: "upload",
        progress: 90,
        found: {
          services: { count: 2, names: ["@shop/api", "@shop/web"] },
          routes: 2,
          pages: 3,
          stores: { count: 1, names: ["db"] },
          externals: { count: 0, names: [] },
        },
      }),
    );
    expect(view).toMatchObject({
      step: "upload",
      found: [
        { key: "services", label: "2 services", text: "@shop/api, @shop/web" },
        { key: "routes", label: "Entry points", text: "2 routes, 3 pages" },
        { key: "stores", label: "Data", text: "db" },
      ],
    });
  });

  it("the time left is the written time left minus the row's age, both on the database's clock (ADR-0140)", () => {
    const calls = { stage: "analyze", progress: 70, step: "calls" };
    expect(jobView(running({ ...calls, leftMs: 41_500 }))).toMatchObject({
      text: "Linking function calls",
      timeLeft: "About 50 s left",
    });
    expect(jobView(running({ ...calls, leftMs: 60_000 }, 39_500))).toMatchObject({
      timeLeft: "About 30 s left",
    });
    expect(jobView(running({ ...calls, leftMs: 60_000 }, 61_000))).toMatchObject({
      timeLeft: "Taking longer than usual",
    });
    expect(jobView(running({ ...calls, leftMs: 0 }))).toMatchObject({
      timeLeft: "Taking longer than usual",
    });
    expect(jobView(running(calls))).not.toHaveProperty("timeLeft");
    // A row written before ADR-0140 holds the worker's `since`, which this clock can't use.
    expect(jobView(running({ ...calls, since: 1, expectMs: 9_000 }))).not.toHaveProperty(
      "timeLeft",
    );
  });

  it("done, failed, and missing jobs", () => {
    expect(jobView(record({ status: "done" }))).toEqual({ state: "done" });
    expect(jobView(record({ status: "failed", errorCode: "LIMIT_TIME" }))).toEqual(
      failureView("LIMIT_TIME"),
    );
    expect(jobView(record({ status: "failed" }))).toEqual(failureView("WORKER_ERROR"));
    expect(jobView(undefined)).toEqual({ state: "missing", message: MISSING_MESSAGE });
  });

  it("a stored code that isn't one of ours never reaches the page", () => {
    for (const errorCode of ["<script>", "limit_files", "X".repeat(65), ""]) {
      expect(jobView(record({ status: "failed", errorCode })), errorCode).toEqual(
        failureView("WORKER_ERROR"),
      );
    }
  });

  it("a private repo's job reads as missing, whatever its state (until M8's access check)", () => {
    for (const fields of [
      { position: 0 },
      { status: "running", progress: { stage: "upload", progress: 90 }, progressAgeMs: 0 },
      { status: "done" },
      { status: "failed", errorCode: "LIMIT_FILES" },
    ] as Partial<JobRecord>[]) {
      expect(jobView(record({ ...fields, visibility: "private" }))).toEqual({
        state: "missing",
        message: MISSING_MESSAGE,
      });
    }
  });
});

describe("failureView", () => {
  it("permanent failures say what happened and point to a smaller repo, without a retry", () => {
    for (const code of [
      "LIMIT_FILES",
      "LIMIT_SOURCE_SIZE",
      "LIMIT_SIZE",
      "LIMIT_ENTRIES",
      "LIMIT_TIME",
      "LIMIT_MEMORY",
    ]) {
      const view = failureView(code);
      expect(view.retry, code).toBe(false);
      expect(view.message, code).toMatch(/limit|may use|GitInside analyzes/);
      expect(view.message, code).toMatch(/Try a smaller repo\.$/);
    }
    // The size limits say what is supported, so a repo over one knows about the other (M5.16c).
    expect(failureView("LIMIT_FILES").message).toBe(
      `This repo has over 20,000 source files. GitInside analyzes repos ${SUPPORTED_SIZE}. Try a smaller repo.`,
    );
    expect(failureView("LIMIT_SOURCE_SIZE").message).toBe(
      `This repo has over ${MAX_SOURCE_MB}${NBSP}MB of source code. GitInside analyzes repos ${SUPPORTED_SIZE}. Try a smaller repo.`,
    );
    // Memory and time fail only after both size checks passed: say that's still possible.
    for (const code of ["LIMIT_TIME", "LIMIT_MEMORY"]) {
      expect(failureView(code).message, code).toContain(
        `A repo with many services can ${code === "LIMIT_TIME" ? "take that long" : "need that much"} even under ${MAX_SOURCE_MB}${NBSP}MB of source code.`,
      );
    }
    expect(failureView("REPO_NOT_PUBLIC").message).toBe(failureView("REPO_NOT_FOUND").message);
    expect(failureView("REPO_NOT_PUBLIC").message).toContain("Private repos aren't supported yet");
    expect(failureView("TAR_UNSAFE_PATH").retry).toBe(false);
  });

  it("anything else is on our side, worth trying again, and never shows the code's words", () => {
    for (const code of ["DOWNLOAD_FAILED", "JOB_STALLED", "ANALYZER_CRASHED", "SOMETHING_NEW"]) {
      expect(failureView(code)).toEqual({
        state: "failed",
        errorCode: code,
        message: "The analysis failed on our side. Try again.",
        retry: true,
      });
    }
  });

  it("an inherited property name isn't a message", () => {
    expect(failureView("constructor").retry).toBe(true);
  });
});

describe("permanentFailure", () => {
  it("is the first sentence of a no-retry message, without the advice", () => {
    for (const code of [
      "LIMIT_FILES",
      "LIMIT_TIME",
      "REPO_NOT_FOUND",
      "REPO_UNAVAILABLE",
      "TAR_INVALID",
    ]) {
      const reason = permanentFailure(code);
      expect(reason, code).toBeDefined();
      expect(failureView(code).message.startsWith(reason as string), code).toBe(true);
      expect(reason, code).not.toMatch(/Try a smaller repo|Private repos/);
    }
    expect(failureView("REPO_UNAVAILABLE").message).toBe(permanentFailure("REPO_UNAVAILABLE"));
  });

  it("is undefined when another try could pass", () => {
    for (const code of ["ANALYZER_CRASHED", "WORKER_ERROR", "constructor"]) {
      expect(permanentFailure(code), code).toBeUndefined();
    }
  });
});

describe("helpers", () => {
  it("queueText", () => {
    expect(queueText(undefined)).toBe("Waiting in the queue");
    expect(queueText(3)).toBe("3 ahead of you");
  });

  it("isFinal: done, failed, and missing end the stream; the rest don't", () => {
    expect(isFinal({ state: "done" })).toBe(true);
    expect(isFinal(failureView("LIMIT_TIME"))).toBe(true);
    expect(isFinal(jobView(undefined))).toBe(true);
    expect(isFinal(jobView(record({})))).toBe(false);
    expect(isFinal(UNAVAILABLE_VIEW)).toBe(false);
  });

  it("the steps are the queue, then the worker's stages in order", () => {
    expect(PROGRESS_STEPS.map((s) => s.step)).toEqual([
      "queue",
      "download",
      "extract",
      "analyze",
      "upload",
    ]);
  });
});
