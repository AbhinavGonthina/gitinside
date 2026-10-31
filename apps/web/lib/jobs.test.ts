// @vitest-environment node
import { describe, expect, it } from "vitest";
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
import type { WorkerJobStatus } from "./worker";

const id = `analyze-${"a".repeat(32)}`;
const status = (fields: Partial<WorkerJobStatus>): WorkerJobStatus => ({
  id,
  kind: "analyze",
  state: "queued",
  ...fields,
});

describe("jobView", () => {
  it("a waiting job says how many are ahead (UX.md: '2 ahead of you')", () => {
    expect(jobView(status({ position: 2 }))).toEqual({
      state: "queued",
      step: "queue",
      progress: 0,
      text: "2 ahead of you",
      position: 2,
    });
    expect(jobView(status({ position: 0 }))).toMatchObject({ text: "You're next" });
    expect(jobView(status({ position: 1_204 }))).toMatchObject({ text: "1,204 ahead of you" });
    // Delayed for a retry, or prioritized: no position to give.
    expect(jobView(status({}))).toEqual({
      state: "queued",
      step: "queue",
      progress: 0,
      text: "Waiting in the queue",
    });
  });

  it("a running job carries the worker's stage, progress, and words", () => {
    expect(
      jobView(
        status({ state: "running", stage: "analyze", progress: 34, step: "programs", count: 1204 }),
      ),
    ).toEqual({
      state: "running",
      step: "analyze",
      progress: 34,
      text: "Parsing 1,204 files",
      found: [],
    });
    expect(
      jobView(status({ state: "running", stage: "analyze", step: "http", count: 87 })),
    ).toMatchObject({ text: "Linking 87 calls to routes", progress: 0 });
    expect(jobView(status({ state: "running", stage: "upload", progress: 90 }))).toMatchObject({
      step: "upload",
      text: "Saving the diagram",
    });
  });

  it("running before any progress is stored counts as downloading", () => {
    expect(jobView(status({ state: "running" }))).toEqual({
      state: "running",
      step: "download",
      progress: 0,
      text: "Downloading",
      found: [],
    });
  });

  it("a running job says what the analyzer has found so far, in words (#8)", () => {
    const view = jobView(
      status({
        state: "running",
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

  it("a running job says how long it has left once the worker estimates it (#8)", () => {
    const running = { state: "running", stage: "analyze", step: "calls" } as const;
    expect(jobView(status({ ...running, leftMs: 41_500 }))).toMatchObject({
      text: "Linking function calls",
      timeLeft: "About 50 s left",
    });
    expect(jobView(status({ ...running, leftMs: 0 }))).toMatchObject({
      timeLeft: "Taking longer than usual",
    });
    expect(jobView(status(running))).not.toHaveProperty("timeLeft");
  });

  it("done, failed, missing, and diff jobs", () => {
    expect(jobView(status({ state: "done" }))).toEqual({ state: "done" });
    expect(jobView(status({ state: "failed", errorCode: "LIMIT_TIME" }))).toEqual(
      failureView("LIMIT_TIME"),
    );
    expect(jobView(status({ state: "failed" }))).toEqual(failureView("WORKER_ERROR"));
    expect(jobView(undefined)).toEqual({ state: "missing", message: MISSING_MESSAGE });
    expect(jobView(status({ kind: "diff", state: "done" }))).toEqual({
      state: "missing",
      message: MISSING_MESSAGE,
    });
  });
});

describe("failureView", () => {
  it("permanent failures say what happened and point to a smaller repo, without a retry", () => {
    for (const code of [
      "LIMIT_FILES",
      "LIMIT_SIZE",
      "LIMIT_ENTRIES",
      "LIMIT_TIME",
      "LIMIT_MEMORY",
    ]) {
      const view = failureView(code);
      expect(view.retry, code).toBe(false);
      expect(view.message, code).toMatch(/limit|may use/);
      expect(view.message, code).toMatch(/Try a smaller repo\.$/);
    }
    expect(failureView("LIMIT_FILES").message).toContain("20,000 source files");
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
    expect(isFinal(jobView(status({})))).toBe(false);
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
