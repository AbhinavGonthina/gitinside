import { describe, expect, it } from "vitest";
import { parseChildJob, parseChildReport } from "./protocol.js";

const STATS = {
  nodes: 3,
  edges: 2,
  unresolved: 1,
  warnings: 0,
  graphBytes: 120,
  stageMs: { a: 4 },
};

describe("parseChildJob", () => {
  it("accepts a job with or without a SHA", () => {
    const job = { src: "/s", out: "/o", owner: "a", name: "b" };
    expect(parseChildJob(JSON.stringify(job))).toEqual(job);
    expect(parseChildJob(JSON.stringify({ ...job, sha: "abc1234" }))).toEqual({
      ...job,
      sha: "abc1234",
    });
  });

  it("drops unknown fields", () => {
    expect(
      parseChildJob(JSON.stringify({ src: "/s", out: "/o", owner: "a", name: "b", extra: 1 })),
    ).toEqual({ src: "/s", out: "/o", owner: "a", name: "b" });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a missing field", JSON.stringify({ src: "/s", out: "/o", owner: "a" })],
    ["an empty field", JSON.stringify({ src: "", out: "/o", owner: "a", name: "b" })],
    ["a non-string SHA", JSON.stringify({ src: "/s", out: "/o", owner: "a", name: "b", sha: 1 })],
  ])("rejects %s", (_, text) => {
    expect(() => parseChildJob(text)).toThrow();
  });
});

describe("parseChildReport", () => {
  it("accepts success and failure reports", () => {
    expect(parseChildReport(JSON.stringify({ ok: true, stats: STATS }))).toEqual({
      ok: true,
      stats: STATS,
    });
    expect(
      parseChildReport(JSON.stringify({ ok: false, code: "LIMIT_FILES", message: "m" })),
    ).toEqual({ ok: false, code: "LIMIT_FILES", message: "m" });
  });

  it("keeps only known stats fields", () => {
    const report = parseChildReport(JSON.stringify({ ok: true, stats: { ...STATS, x: 1 } }));
    expect(report).toEqual({ ok: true, stats: STATS });
  });

  it.each([
    ["half a line", '{"ok":tr'],
    ["a non-object", "1"],
    ["no ok flag", JSON.stringify({ stats: STATS })],
    ["missing stats", JSON.stringify({ ok: true })],
    ["a negative count", JSON.stringify({ ok: true, stats: { ...STATS, nodes: -1 } })],
    ["a fractional count", JSON.stringify({ ok: true, stats: { ...STATS, edges: 1.5 } })],
    ["a bad stage time", JSON.stringify({ ok: true, stats: { ...STATS, stageMs: { a: "1" } } })],
    ["stage times as an array", JSON.stringify({ ok: true, stats: { ...STATS, stageMs: [1] } })],
    ["a free-text code", JSON.stringify({ ok: false, code: "no such file", message: "m" })],
    ["a missing message", JSON.stringify({ ok: false, code: "LIMIT_FILES" })],
  ])("rejects %s", (_, text) => {
    expect(parseChildReport(text)).toBeUndefined();
  });
});
