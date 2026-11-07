import { describe, expect, it } from "vitest";
import { EvalInputError } from "../format.js";
import { classifiedCounts, classifyCrossCheck, parseClassifiedFile } from "./classify.js";
import type { FollowUpFile } from "./followUp.js";

const run = {
  gitinside: "f".repeat(40),
  analyzerVersion: "0.2.0",
  started: "2026-11-07",
  machine: { cpu: "test", cores: 1, ramGiB: 1, os: "test", node: "v22.0.0" },
};

const fixed = {
  sha: "c".repeat(40),
  committedAt: "2026-07-02T12:00:00Z",
  how: "restored" as const,
  pr: null,
};

const followUp: FollowUpFile = {
  repo: "test/repo",
  run,
  replay: "r".repeat(40),
  endSha: "e".repeat(40),
  prs: [
    {
      number: 1,
      baseSha: "a".repeat(40),
      mergeSha: "b".repeat(40),
      mergedAt: "2026-07-01T12:00:00Z",
      later: 2,
      checked: 1,
      unreadable: [],
      breaks: [
        { edge: "calls:a->b", reason: "TARGET_REMOVED", fixed, offLine: null, atEnd: "clear" },
        {
          edge: "calls:a->c",
          reason: "TARGET_REMOVED",
          fixed: null,
          offLine: null,
          atEnd: "flagged",
        },
      ],
    },
  ],
};

const blob = `https://github.com/test/repo/blob/${"b".repeat(40)}/src/a.ts#L3`;

function file(overrides: Record<string, unknown> = {}) {
  return {
    repo: "test/repo",
    followUp: run.gitinside,
    classifiedBy: "Claude",
    drafted: "2026-11-07",
    prs: [
      {
        number: 1,
        breaks: [
          {
            edge: "calls:a->b",
            verdict: "true",
            why: "a still calls b, which the PR deleted",
            evidence: [blob, `https://github.com/test/repo/commit/${"c".repeat(40)}`],
            fix: { verdict: "real", why: "c restores b" },
            reviewedBy: null,
          },
          {
            edge: "calls:a->c",
            verdict: "unclear",
            why: "c may be loaded another way",
            evidence: [`https://github.com/test/repo/pull/1`],
            fix: null,
            reviewedBy: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

const parse = (value: unknown) => parseClassifiedFile("c.json", JSON.stringify(value));

describe("classification files", () => {
  it("parse a draft with a verdict, a reason, and permalinks per break", () => {
    const parsed = parse(file());
    expect(parsed.prs[0]?.breaks.map((b) => b.verdict)).toEqual(["true", "unclear"]);
    expect(classifyCrossCheck(parsed, followUp)).toEqual([]);
  });

  it("reject an unknown verdict, an empty reason, and a break with no evidence", () => {
    const one = (patch: Record<string, unknown>) => {
      const f = file();
      Object.assign(f.prs[0]!.breaks[0]!, patch);
      return f;
    };
    expect(() => parse(one({ verdict: "probably" }))).toThrow(EvalInputError);
    expect(() => parse(one({ why: "" }))).toThrow(EvalInputError);
    expect(() => parse(one({ evidence: [] }))).toThrow(EvalInputError);
  });

  it("take evidence only as permalinks into the classified repo", () => {
    const withEvidence = (url: string) => {
      const f = file();
      f.prs[0]!.breaks[0]!.evidence = [url];
      return f;
    };
    // A branch name isn't a permalink: the file can change under it.
    expect(() => parse(withEvidence("https://github.com/test/repo/blob/main/src/a.ts#L3"))).toThrow(
      /permalink/,
    );
    expect(() =>
      parse(withEvidence(`https://github.com/test/other/commit/${"c".repeat(40)}`)),
    ).toThrow(/permalink/);
    expect(() => parse(withEvidence("https://example.com/x"))).toThrow(/permalink/);
  });

  it("name who drafted and say per break who reviewed it", () => {
    expect(() => parse(file({ classifiedBy: "" }))).toThrow(EvalInputError);
    const reviewed = file();
    reviewed.prs[0]!.breaks[0]!.reviewedBy = "AbhinavGonthina" as unknown as null;
    expect(parse(reviewed).prs[0]?.breaks[0]?.reviewedBy).toBe("AbhinavGonthina");
  });

  it("are checked against the follow-up file's breaks and fixes, in order", () => {
    const parsed = parse(file());
    expect(classifyCrossCheck({ ...parsed, repo: "test/other" }, followUp)).toEqual([
      "classifies test/other, but the follow-up file is test/repo",
    ]);
    expect(classifyCrossCheck({ ...parsed, followUp: "x" }, followUp)).toEqual([
      `classifies the follow-up at x, the follow-up file's is ${run.gitinside}`,
    ]);
    const swapped = {
      ...parsed,
      prs: [{ ...parsed.prs[0]!, breaks: [...parsed.prs[0]!.breaks].reverse() }],
    };
    expect(classifyCrossCheck(swapped, followUp)).toEqual([
      "prs[0].breaks aren't the follow-up file's breaks of #1",
    ]);
    expect(classifyCrossCheck({ ...parsed, prs: [] }, followUp)).toEqual([
      "0 PRs classified, but the follow-up file has 1",
    ]);
    expect(
      classifyCrossCheck({ ...parsed, prs: [{ ...parsed.prs[0]!, number: 2 }] }, followUp),
    ).toEqual(["prs[0].number is 2, the follow-up file's is 1"]);
  });

  it("judge a fix exactly when the follow-up found one", () => {
    const parsed = parse(file());
    const [first, second] = parsed.prs[0]!.breaks as [
      (typeof parsed.prs)[0]["breaks"][0],
      (typeof parsed.prs)[0]["breaks"][0],
    ];
    const breaks = [
      { ...first, fix: null },
      { ...second, fix: { verdict: "real" as const, why: "?" } },
    ];
    expect(classifyCrossCheck({ ...parsed, prs: [{ number: 1, breaks }] }, followUp)).toEqual([
      "prs[0].breaks[0] has no fix judgment, but the follow-up found a fix",
      "prs[0].breaks[1] judges a fix, but the follow-up found none",
    ]);
  });

  it("count verdicts, fixes, and reviews", () => {
    expect(classifiedCounts([parse(file())])).toEqual({
      breaks: 2,
      verdicts: { true: 1, false: 0, unclear: 1 },
      fixes: { real: 1, coincidental: 0, unclear: 0 },
      reviewed: 0,
    });
  });
});
