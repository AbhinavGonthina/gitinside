import { describe, expect, it } from "vitest";
import { parseChildJob, parseChildReport, parseProgressLine, progressLine } from "./protocol.js";

const STATS = {
  files: 1,
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

describe("progress lines", () => {
  it("round-trip one event per line, with or without a count", () => {
    for (const event of [{ step: "programs", count: 1204 }, { step: "imports" }] as const) {
      const line = progressLine(event);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1)).not.toContain("\n");
      expect(parseProgressLine(line.slice(0, -1))).toEqual(event);
    }
  });

  it("keeps only the step and count", () => {
    const line = JSON.stringify({ progress: { step: "http", count: 3, note: "x" }, ok: true });
    expect(parseProgressLine(line)).toEqual({ step: "http", count: 3 });
  });

  it.each([
    ["half a line", '{"progress":{"st'],
    ["a report", JSON.stringify({ ok: true, stats: STATS })],
    ["a non-object", JSON.stringify({ progress: "programs" })],
    ["an unknown step", JSON.stringify({ progress: { step: "download" } })],
    ["a negative count", JSON.stringify({ progress: { step: "http", count: -1 } })],
    ["a text count", JSON.stringify({ progress: { step: "http", count: "1" } })],
  ])("aren't %s", (_, text) => {
    expect(parseProgressLine(text)).toBeUndefined();
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
    ["a missing file count", JSON.stringify({ ok: true, stats: { ...STATS, files: undefined } })],
    ["a fractional count", JSON.stringify({ ok: true, stats: { ...STATS, edges: 1.5 } })],
    ["a bad stage time", JSON.stringify({ ok: true, stats: { ...STATS, stageMs: { a: "1" } } })],
    ["stage times as an array", JSON.stringify({ ok: true, stats: { ...STATS, stageMs: [1] } })],
    ["a free-text code", JSON.stringify({ ok: false, code: "no such file", message: "m" })],
    ["a missing message", JSON.stringify({ ok: false, code: "LIMIT_FILES" })],
  ])("rejects %s", (_, text) => {
    expect(parseChildReport(text)).toBeUndefined();
  });
});
