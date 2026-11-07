import { describe, expect, it } from "vitest";
import { JobRequestError, jobIdFor, parseJobRequest, type JobRequest } from "./request.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const PUBLIC: JobRequest = { kind: "analyze", owner: "acme", repo: "shop", sha: SHA };

describe("jobIdFor", () => {
  it("keeps a public job's ID as it was before installations, so queued tasks survive a deploy", () => {
    expect(jobIdFor(PUBLIC, "0.1.0")).toBe("analyze-e01e3944a3e4619fc5a9063a6ad6be6e");
  });

  it("ignores the case of the owner and repo", () => {
    expect(jobIdFor({ ...PUBLIC, owner: "ACME", repo: "Shop" }, "0.1.0")).toBe(
      jobIdFor(PUBLIC, "0.1.0"),
    );
  });

  it("scopes a job by its installation (ADR-0227)", () => {
    const one = jobIdFor({ ...PUBLIC, installationId: 1 }, "0.1.0");
    const two = jobIdFor({ ...PUBLIC, installationId: 2 }, "0.1.0");
    expect(one).toMatch(/^analyze-[0-9a-f]{32}$/);
    expect(new Set([one, two, jobIdFor(PUBLIC, "0.1.0")]).size).toBe(3);
    expect(jobIdFor({ ...PUBLIC, installationId: 1 }, "0.1.0")).toBe(one);
  });

  it("differs by kind, commit, base, and analyzer version", () => {
    const diff: JobRequest = { ...PUBLIC, kind: "diff", baseSha: "f".repeat(40) };
    const ids = [
      jobIdFor(PUBLIC, "0.1.0"),
      jobIdFor(PUBLIC, "0.2.0"),
      jobIdFor({ ...PUBLIC, sha: "a".repeat(40) }, "0.1.0"),
      jobIdFor(diff, "0.1.0"),
      jobIdFor({ ...diff, baseSha: "e".repeat(40) }, "0.1.0"),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[3]).toMatch(/^diff-[0-9a-f]{32}$/);
  });
});

describe("parseJobRequest", () => {
  it("carries a job's installation", () => {
    expect(parseJobRequest({ ...PUBLIC, installationId: 41 })).toEqual({
      ...PUBLIC,
      installationId: 41,
    });
    expect(parseJobRequest(PUBLIC)).toEqual(PUBLIC);
  });

  it.each([0, -1, 1.5, "41", null, Number.MAX_SAFE_INTEGER + 1])(
    "refuses the installation %s",
    (installationId) => {
      expect(() => parseJobRequest({ ...PUBLIC, installationId })).toThrow(
        new JobRequestError("installationId must be a positive integer"),
      );
    },
  );
});
