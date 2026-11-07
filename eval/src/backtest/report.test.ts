import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrokenEdge, DiffSummary } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import type { ClassifiedFile } from "./classify.js";
import type { FollowUpFile } from "./followUp.js";
import type { BacktestRepo } from "./format.js";
import { backtestProblems, loadBacktestInputs, type BacktestInputs } from "./inputs.js";
import type { PrsFile } from "./prs.js";
import type { RawFile } from "./replay.js";
import {
  backtestReportDate,
  backtestReportFileName,
  BacktestReportError,
  changed,
  edgeKind,
  elapsed,
  group,
  renderBacktestReport,
} from "./report.js";

const sha = (c: string): string => c.repeat(40);

const run = {
  gitinside: sha("f"),
  analyzerVersion: "0.2.0",
  started: "2026-11-07",
  machine: { cpu: "Test CPU", cores: 4, ramGiB: 15.6, os: "linux 6", node: "v22.0.0" },
};

const counts0 = { added: 0, removed: 0, modified: 0, updated: 0, renamed: 0 };

function summary(edges: Partial<typeof counts0> = {}, broken = 0): DiffSummary {
  return { nodes: { ...counts0 }, edges: { ...counts0, ...edges }, broken };
}

function pin(owner: string, name: string): BacktestRepo {
  return {
    owner,
    name,
    url: `https://github.com/${owner}/${name}`,
    license: "MIT",
    branch: "main",
    startSha: sha("1"),
    endSha: sha("2"),
    why: "test",
    measured: { mergedPrs: 3, files: 10, httpToRoute: 20, appHttpToRoute: 20 },
  };
}

const broken: BrokenEdge = {
  edge: "calls:symbol:api/src/a.ts#run->symbol:api/src/b.ts#B.parse",
  from: "symbol:api/src/a.ts#run",
  to: "symbol:api/src/b.ts#B.parse",
  reason: "TARGET_REMOVED",
  detail: "B.parse was removed",
  sites: [{ file: "api/src/a.ts", line: 3, column: 1 }],
};

function prsFile(repo: string, overrides: Partial<PrsFile> = {}): PrsFile {
  return {
    repo,
    listed: "2026-11-06",
    branch: "main",
    startSha: sha("1"),
    endSha: sha("2"),
    search: "q",
    found: 2,
    prs: [
      {
        number: 1,
        title: "one",
        mergedAt: "2026-07-01T10:00:00Z",
        mergeSha: sha("b"),
        baseSha: sha("a"),
        kind: "squash",
        commits: 1,
      },
      {
        number: 2,
        title: "two",
        mergedAt: "2026-07-02T10:00:00Z",
        mergeSha: sha("c"),
        baseSha: sha("b"),
        kind: "merge",
        commits: 2,
      },
    ],
    excluded: [],
    overCap: [],
    ...overrides,
  };
}

/** Two repos: `t/flagged` has one broken edge, fixed; `t/quiet` has a failure, an exclusion, and a capped PR. */
function inputs(): BacktestInputs {
  const flaggedRaw: RawFile = {
    repo: "t/flagged",
    run,
    prs: [
      {
        number: 1,
        baseSha: sha("a"),
        mergeSha: sha("b"),
        outcome: "diffed",
        summary: summary({ added: 4, removed: 1 }, 1),
        broken: [broken],
      },
      {
        number: 2,
        baseSha: sha("b"),
        mergeSha: sha("c"),
        outcome: "diffed",
        summary: summary({ updated: 3 }),
        broken: [],
      },
    ],
  };
  const quietRaw: RawFile = {
    repo: "t/quiet",
    run: { ...run, started: "2026-11-06" },
    prs: [
      {
        number: 1,
        baseSha: sha("a"),
        mergeSha: sha("b"),
        outcome: "diffed",
        summary: summary({ added: 2 }),
        broken: [],
        renameLimit: { removed: 9, added: 9 },
      },
      {
        number: 2,
        baseSha: sha("b"),
        mergeSha: sha("c"),
        outcome: "failed",
        stage: "head",
        error: "out of memory\nat stack",
      },
    ],
  };
  const followUp: FollowUpFile = {
    repo: "t/flagged",
    run,
    replay: run.gitinside,
    endSha: sha("2"),
    prs: [
      {
        number: 1,
        baseSha: sha("a"),
        mergeSha: sha("b"),
        mergedAt: "2026-07-01T10:00:00Z",
        later: 5,
        checked: 2,
        unreadable: [],
        breaks: [
          {
            edge: broken.edge,
            reason: "TARGET_REMOVED",
            fixed: {
              sha: sha("d"),
              committedAt: "2026-07-01T10:54:46Z",
              how: "restored",
              pr: null,
            },
            offLine: null,
            atEnd: "clear",
          },
        ],
      },
    ],
  };
  const classified: ClassifiedFile = {
    repo: "t/flagged",
    followUp: run.gitinside,
    classifiedBy: "Claude (draft)",
    drafted: "2026-11-08",
    prs: [
      {
        number: 1,
        breaks: [
          {
            edge: broken.edge,
            verdict: "true",
            why: "run still calls B.parse.",
            evidence: ["https://github.com/t/flagged/pull/1"],
            fix: { verdict: "real", why: "d restores B." },
            reviewedBy: null,
          },
        ],
      },
    ],
  };
  return {
    repos: {
      pinned: "2026-11-06",
      window: { from: "2026-07-01", to: "2026-09-30" },
      maxPrsPerRepo: 2,
      followUpDays: 30,
      rules: ["1. a rule"],
      candidates: "a list",
      repos: [pin("t", "flagged"), pin("t", "quiet")],
      rejected: [{ repo: "t/other", rule: 1, reason: "a library" }],
    },
    prs: [
      { f: "t__flagged.json", file: prsFile("t/flagged") },
      {
        f: "t__quiet.json",
        file: prsFile("t/quiet", {
          found: 4,
          excluded: [
            { number: 3, mergedAt: "2026-07-03T10:00:00Z", reason: "dropped by a force-push" },
          ],
          overCap: [{ number: 4, mergedAt: "2026-07-04T10:00:00Z" }],
        }),
      },
    ],
    raw: [
      { f: "t__flagged.json", file: flaggedRaw },
      { f: "t__quiet.json", file: quietRaw },
    ],
    followUp: [
      { f: "t__flagged.json", file: followUp },
      {
        f: "t__quiet.json",
        file: { repo: "t/quiet", run, replay: run.gitinside, endSha: sha("2"), prs: [] },
      },
    ],
    classified: [{ f: "t__flagged.json", file: classified }],
  };
}

const LIMITS = "- Only two repos.\n";

describe("renderBacktestReport", () => {
  it("states the counts and the claim exactly as measured", () => {
    const text = renderBacktestReport(inputs(), LIMITS);
    expect(text).toContain("# PR backtest: 2026-11-08\n");
    expect(text).toContain(
      "- **Replayed:** 4 merged PRs of 2 repos, merged 2026-07-01 to 2026-09-30 (UTC): 3 diffed, 1 failed. 6 PRs merged in the window in all; 1 excluded with a reason and 1 past the 2-per-repo cap.",
    );
    expect(text).toContain(
      "- **Flagged:** 1 broken edge in 1 PR. By edge kind: 1 `calls`. Cross-service (`http`) edges flagged: 0.",
    );
    expect(text).toContain(
      "- **Verdicts:** 1 true, 0 false positive, 0 unclear, drafted by Claude (draft). **Reviewed by Abhinav: 0 of 1.**",
    );
    expect(text).toContain(
      "- **Precision of flags:** 100.0% (1/1) true among breaks judged true or false, from verdicts that are still drafts; over reviewed verdicts only: n/a.",
    );
    expect(text).toContain(
      "**Claim, exactly as measured:** flagged 1 broken edge across 3 merged PRs; 1 was classified as a true break (0 of them reviewed by Abhinav, the rest drafts), and 1 of those was fixed in a later commit judged a real fix.",
    );
  });

  it("counts each repo and the total, failures and the rename budget included", () => {
    const text = renderBacktestReport(inputs(), LIMITS);
    expect(text).toContain(
      "| [t/flagged](https://github.com/t/flagged) | 2 | 2 | 0 | 0 | 0 | 1 | 4 | 1 | 0 | 1 | 1 |",
    );
    expect(text).toContain(
      "| [t/quiet](https://github.com/t/quiet) | 4 | 2 | 1 | 1 | 1 | 1 | 2 | 0 | 1 | 0 | 0 |",
    );
    expect(text).toContain("| **All** | 6 | 4 | 1 | 1 | 1 | 2 | 6 | 1 | 1 | 1 | 1 |");
  });

  it("lists each break with its fix, time to fix, verdict, and evidence", () => {
    const text = renderBacktestReport(inputs(), LIMITS);
    expect(text).toContain("### t/flagged [#1](https://github.com/t/flagged/pull/1)");
    expect(text).toContain(
      "| 1 | `calls` | `run` → `B.parse` | `TARGET_REMOVED` | true | [ddddddd](https://github.com/t/flagged/commit/dddddddddddddddddddddddddddddddddddddddd) | `restored` | 54 min 46 s | no pinned PR | clear | real | draft |",
    );
    expect(text).toContain(
      "1. B.parse was removed (`api/src/a.ts:3`). **Verdict:** run still calls B.parse. **Fix:** d restores B. Evidence: [1](https://github.com/t/flagged/pull/1).",
    );
  });

  it("notes a side branch's commit that stopped flagging a break before the branch's fix", () => {
    const i = inputs();
    expect(renderBacktestReport(i, LIMITS)).not.toContain("Off the branch's first-parent line");
    i.followUp[0]!.file.prs[0]!.breaks[0]!.offLine = {
      sha: sha("c"),
      committedAt: "2026-07-01T10:30:00Z",
      how: "sourceRemoved",
      pr: null,
    };
    expect(renderBacktestReport(i, LIMITS)).toContain(
      "Evidence: [1](https://github.com/t/flagged/pull/1). Off the branch's first-parent line, [ccccccc](https://github.com/t/flagged/commit/cccccccccccccccccccccccccccccccccccccccc) (30 min 0 s after the merge) stopped flagging it first; the branch never held that state, so it isn't counted as the fix.",
    );
  });

  it("lists excluded, capped, and failed PRs", () => {
    const text = renderBacktestReport(inputs(), LIMITS);
    expect(text).toContain(
      "- t/quiet [#3](https://github.com/t/quiet/pull/3) (merged 2026-07-03T10:00:00Z): excluded, dropped by a force-push",
    );
    expect(text).toContain(
      "- t/quiet: 1 PR merged after the first 2 (2026-07-04T10:00:00Z to 2026-07-04T10:00:00Z) past the cap, not replayed.",
    );
    expect(text).toContain(
      "- t/quiet [#2](https://github.com/t/quiet/pull/2): failed at head: out of memory",
    );
    expect(text).not.toContain("at stack");
  });

  it("names every run and ends with the limitations", () => {
    const text = renderBacktestReport(inputs(), LIMITS);
    expect(text).toContain("2 repos pinned of 3 candidates (1 rejected");
    expect(text).toContain("| t/quiet | ");
    expect(text).toContain("Test CPU (4 cores, 15.6 GiB), linux 6, Node v22.0.0 | no flagged PR |");
    expect(text).toContain("drafted 2026-11-08 by Claude (draft); 0 of 1 break reviewed.");
    expect(text.endsWith("## Limitations\n\n- Only two repos.\n")).toBe(true);
  });

  it("counts a reviewed verdict and an unclear one apart", () => {
    const i = inputs();
    const b = i.classified[0]!.file.prs[0]!.breaks[0]!;
    b.reviewedBy = "AbhinavGonthina";
    let text = renderBacktestReport(i, LIMITS);
    expect(text).toContain("**Reviewed by Abhinav: 1 of 1.**");
    expect(text).toContain("over reviewed verdicts only: 100.0% (1/1).");
    expect(text).toContain("(1 of them reviewed by Abhinav)");
    b.verdict = "unclear";
    text = renderBacktestReport(i, LIMITS);
    expect(text).toContain("n/a true among breaks judged true or false (1 unclear left out)");
    expect(text).toContain("0 were classified as true breaks");
  });

  it("refuses a partial replay or a missing file", () => {
    const partial = inputs();
    partial.raw[1]!.file.prs.pop();
    expect(() => renderBacktestReport(partial, LIMITS)).toThrow(
      /backtest\/raw\/t__quiet\.json \(1 of 2 PRs replayed\)/,
    );
    const missing = inputs();
    missing.followUp.pop();
    expect(() => renderBacktestReport(missing, LIMITS)).toThrow(BacktestReportError);
    expect(() => renderBacktestReport(missing, LIMITS)).toThrow(
      /backtest\/followup\/t__quiet\.json/,
    );
  });

  it("is dated by its newest input, not today", () => {
    const i = inputs();
    expect(backtestReportDate(i)).toBe("2026-11-08");
    i.classified = [];
    expect(backtestReportFileName(i)).toBe("2026-11-07.md");
  });
});

describe("helpers", () => {
  it("groups thousands", () => {
    expect([0, 999, 1000, 12917, 1234567].map(group)).toEqual([
      "0",
      "999",
      "1,000",
      "12,917",
      "1,234,567",
    ]);
  });

  it("says how long a fix took in its two largest units", () => {
    expect(elapsed("2026-08-03T11:04:59Z", "2026-08-03T11:59:45Z")).toBe("54 min 46 s");
    expect(elapsed("2026-08-03T11:04:59Z", "2026-08-03T14:10:00Z")).toBe("3 h 5 min");
    expect(elapsed("2026-08-03T11:00:00Z", "2026-08-05T15:00:00Z")).toBe("2 d 4 h");
  });

  it("reads an edge's kind from its ID", () => {
    expect(edgeKind(broken.edge)).toBe("calls");
    expect(edgeKind("http:a->b")).toBe("http");
  });

  it("doesn't count a diff of only updated facts as a change", () => {
    expect(changed(summary({ updated: 5 }))).toBe(false);
    expect(changed(summary({ renamed: 1 }))).toBe(true);
    expect(changed(summary({}, 1))).toBe(true);
  });
});

describe("the committed report", () => {
  it("is what the committed inputs render", () => {
    const evalDir = fileURLToPath(new URL("../../", import.meta.url));
    const committed = loadBacktestInputs(evalDir);
    expect(backtestProblems(committed)).toEqual([]);
    const limitations = readFileSync(join(evalDir, "backtest", "limitations.md"), "utf8");
    const report = join(evalDir, "backtest", "results", backtestReportFileName(committed));
    expect(renderBacktestReport(committed, limitations)).toBe(readFileSync(report, "utf8"));
  });
});
