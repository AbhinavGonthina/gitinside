import { describe, expect, it } from "vitest";
import { JobFailure, RETRIABLE_CODES } from "./failure.js";

describe("JobFailure", () => {
  it("carries only its code as the message, with the detail kept apart", () => {
    const failure = new JobFailure("LIMIT_FILES", "/tmp/jobs/x: 20,001 files");
    expect([failure.message, failure.code, failure.detail]).toEqual([
      "LIMIT_FILES",
      "LIMIT_FILES",
      "/tmp/jobs/x: 20,001 files",
    ]);
    expect(failure.retriable).toBe(false);
  });

  it("is retriable exactly for the listed codes", () => {
    for (const code of RETRIABLE_CODES) expect(new JobFailure(code).retriable).toBe(true);
    for (const code of [
      "REPO_NOT_FOUND",
      "REPO_NOT_PUBLIC",
      "TAR_UNSAFE_PATH",
      "LIMIT_TIME",
      "ANALYZER_CRASHED",
    ]) {
      expect(new JobFailure(code).retriable).toBe(false);
    }
  });

  it.each(["", "lower", "HAS SPACE", "X".repeat(65)])("refuses %j as a code", (code) => {
    expect(() => new JobFailure(code)).toThrow(/not a failure code/);
  });
});
