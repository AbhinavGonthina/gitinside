import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EvalRepo, LabelFile } from "./format.js";
import {
  compareReportNames,
  DIRTY_MARK,
  firstDifference,
  parseRun,
  percent,
  renderReport,
  ReportError,
  reportFileName,
  resolveReportArg,
  type ReportInput,
  type ReportRun,
} from "./report.js";
import type { Counts, EvalScore, RepoScore } from "./score.js";

const SHA = "b".repeat(40);
const RUN: ReportRun = {
  date: "2026-10-28",
  gitinsideSha: "c".repeat(40),
  analyzerVersion: "0.1.0",
  machine: "dev machine: Test CPU (8 logical cores), 16 GiB RAM, linux 6.0, Node v22.0.0",
};

function repo(owner: string, name: string): EvalRepo {
  return {
    owner,
    name,
    url: `https://github.com/${owner}/${name}`,
    sha: SHA,
    license: "MIT",
    shape: "spa-plus-express",
    why: "test",
  };
}

function counts(over: Partial<Counts> = {}): Counts {
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    labels: 0,
    positiveLabels: 0,
    nullLabels: 0,
    abstentions: 0,
    missing: 0,
    byConfidence: {
      exact: { truePositives: 0, falsePositives: 0 },
      pattern: { truePositives: 0, falsePositives: 0 },
      heuristic: { truePositives: 0, falsePositives: 0 },
    },
    ...over,
  };
}

const LABELS_A: LabelFile = {
  repo: "acme/shop",
  sha: SHA,
  labeler: "claude-draft",
  reviewedBy: null,
  scope: ["."],
  edges: [
    {
      callSite: { file: "web/api.ts", line: 3 },
      method: "GET",
      target: { file: "api/server.ts", line: 10, route: "GET /api/items" },
    },
    {
      callSite: { file: "web/api.ts", line: 7 },
      method: "POST",
      target: { file: "api/server.ts", line: 12, route: "POST /api/items" },
    },
    { callSite: { file: "web/api.ts", line: 9 }, method: null, target: null },
  ],
};

const LABELS_B: LabelFile = { ...LABELS_A, repo: "zed/app", edges: [] };

const SCORE_A: RepoScore = {
  repo: "acme/shop",
  sha: SHA,
  counts: counts({
    truePositives: 1,
    falsePositives: 1,
    falseNegatives: 1,
    labels: 3,
    positiveLabels: 2,
    nullLabels: 1,
    abstentions: 0,
    missing: 1,
    byConfidence: {
      exact: { truePositives: 1, falsePositives: 0 },
      pattern: { truePositives: 0, falsePositives: 0 },
      heuristic: { truePositives: 0, falsePositives: 1 },
    },
  }),
  falsePositives: [
    {
      kind: "route-for-null-label",
      site: { file: "web/api.ts", line: 9, column: 5 },
      predicted: { file: "api/server.ts", line: 10, route: "GET /api/items" },
      confidence: "heuristic",
      reason: "AMBIGUOUS",
      expected: [null],
    },
  ],
  falseNegatives: [
    {
      callSite: { file: "web/api.ts", line: 7 },
      method: "POST",
      expected: { file: "api/server.ts", line: 12, route: "POST /api/items" },
      predicted: [],
    },
  ],
  missing: [
    {
      callSite: { file: "web/api.ts", line: 7 },
      method: "POST",
      target: { file: "api/server.ts", line: 12, route: "POST /api/items" },
    },
  ],
};

const SCORE_B: RepoScore = {
  repo: "zed/app",
  sha: SHA,
  counts: counts(),
  falsePositives: [],
  falseNegatives: [],
  missing: [],
};

function input(over: Partial<ReportInput> = {}): ReportInput {
  const overall: EvalScore["overall"] = { ...SCORE_A.counts };
  return {
    run: RUN,
    repos: [repo("acme", "shop"), repo("zed", "app")],
    labels: [LABELS_A, LABELS_B],
    score: { overall, repos: [SCORE_A, SCORE_B] },
    ...over,
  };
}

describe("percent", () => {
  it("prints one decimal plus the raw fraction", () => {
    expect(percent(2, 3)).toBe("66.7% (2/3)");
    expect(percent(3, 3)).toBe("100.0% (3/3)");
    expect(percent(0, 4)).toBe("0.0% (0/4)");
  });

  it("prints n/a for an empty denominator, never 0% or 100%", () => {
    expect(percent(0, 0)).toBe("n/a");
  });
});

describe("reportFileName", () => {
  it("is <date>-<analyzerVersion>.md", () => {
    expect(reportFileName(RUN)).toBe("2026-10-28-0.1.0.md");
  });
});

describe("compareReportNames", () => {
  it("sorts by date, then analyzer version numerically (M3 review)", () => {
    const names = [
      "2026-11-01-0.1.0.md",
      "2026-10-28-0.10.0.md",
      "notes.md",
      "2026-10-28-1.0.0.md",
      "2026-10-28-0.9.0.md",
    ];
    expect([...names].sort(compareReportNames)).toEqual([
      "notes.md",
      "2026-10-28-0.9.0.md",
      "2026-10-28-0.10.0.md",
      "2026-10-28-1.0.0.md",
      "2026-11-01-0.1.0.md",
    ]);
  });
});

describe("resolveReportArg", () => {
  it("resolves against the folder pnpm was run from, not the eval package (M3 review)", () => {
    const root = resolve("/repo");
    expect(resolveReportArg("eval/results/2026-10-28-0.1.0.md", root)).toBe(
      join(root, "eval", "results", "2026-10-28-0.1.0.md"),
    );
    const abs = resolve("/elsewhere/r.md");
    expect(resolveReportArg(abs, root)).toBe(abs);
  });
});

describe("renderReport", () => {
  const text = renderReport(input());

  it("is headed Pending owner review while any label file is unreviewed", () => {
    expect(text).toContain("> **Pending owner review.**");
    const reviewed = renderReport(
      input({
        labels: [
          { ...LABELS_A, reviewedBy: "AbhinavGonthina" },
          { ...LABELS_B, reviewedBy: "AbhinavGonthina" },
        ],
      }),
    );
    expect(reviewed).not.toContain("Pending owner review");
    expect(reviewed).toContain("> **Labels reviewed** by `AbhinavGonthina`");
    expect(reviewed).toContain("the owner reviewed a seeded random 20% of call sites");
    expect(reviewed).not.toContain("until the owner review is done");
  });

  it("derives who labeled and how many repos from the inputs (M3 review)", () => {
    expect(text).toContain("The labels were drafted by Claude from reading");
    expect(text).toContain("- **Small set:** two small and mid-size apps");
    expect(text).toContain("until the owner review is done");
    const own = renderReport(
      input({
        repos: [repo("acme", "shop")],
        labels: [{ ...LABELS_A, labeler: "abhinav" }],
        score: { overall: SCORE_A.counts, repos: [SCORE_A] },
      }),
    );
    expect(own).toContain("The labels were written by Abhinav from reading");
    expect(own).toContain("- **Small set:** one small and mid-size app (");
    expect(own).toContain("- **Who labeled:** Abhinav wrote the labels");
    const mixed = renderReport(input({ labels: [LABELS_A, { ...LABELS_B, labeler: "abhinav" }] }));
    expect(mixed).toContain("drafted by Claude or written by Abhinav (see each label file)");
  });

  it("records the run: date, commit, analyzer version, machine", () => {
    expect(text).toContain("- **Date:** 2026-10-28\n");
    expect(text).toContain(`- **GitInside commit:** \`${RUN.gitinsideSha}\`\n`);
    expect(text).toContain("- **Analyzer version:** 0.1.0\n");
    expect(text).toContain(`- **Machine:** ${RUN.machine}\n`);
  });

  it("lists every pinned repo with its commit, in repos.json order", () => {
    expect(text).toContain(
      `| [acme/shop](https://github.com/acme/shop) | spa-plus-express | \`${SHA}\` | MIT | 3 | 3 |`,
    );
    expect(text.indexOf("[acme/shop]")).toBeLessThan(text.indexOf("[zed/app]"));
  });

  it("prints counts with raw fractions, n/a for empty ratios, and a total row", () => {
    expect(text).toContain(
      "| acme/shop | 3 | 2 | 1 | 1 | 1 | 50.0% (1/2) | 50.0% (1/2) | 1 | 0 | 1 |",
    );
    expect(text).toContain("| zed/app | 0 | 0 | 0 | 0 | 0 | n/a | n/a | 0 | 0 | 0 |");
    expect(text).toContain("| **All repos** | 3 | 2 | 1 | 1 | 1 | 50.0% (1/2) | 50.0% (1/2) |");
    expect(text).toContain("Precision 50.0% (1/2), recall 50.0% (1/2) over 3 labels in 2 repos.");
  });

  it("gives per-level recall over all real targets", () => {
    expect(text).toContain("| exact | 1 | 0 | 100.0% (1/1) | 50.0% (1/2) |");
    expect(text).toContain("| pattern | 0 | 0 | n/a | 0.0% (0/2) |");
    expect(text).toContain("| heuristic | 0 | 1 | 0.0% (0/1) | 0.0% (0/2) |");
  });

  it("lists every false positive, false negative, and missing site with file:line", () => {
    expect(text).toContain(
      "- `web/api.ts:9:5`: predicted `GET /api/items` in `api/server.ts:10` (heuristic, AMBIGUOUS). route where the label says none; labeled: no route in the repo (`null`).",
    );
    expect(text).toContain(
      "- `web/api.ts:7` (POST): expected `POST /api/items` in `api/server.ts:12`; nothing predicted at the site.",
    );
    expect(text).toContain(
      '**Missing call sites (1)**\n\n1 with a real target is listed above as false negatives ("nothing predicted at the site").\n\n### zed/app',
    );
    expect(text).toContain("### zed/app\n\n**False positives (0)**\n\nNone.");
    expect(text).toContain("**Missing call sites (0)**\n\nNone.\n");
  });

  it("lists dropped null-labeled sites, which no false negative covers", () => {
    const nullLabel = LABELS_A.edges[2];
    if (!nullLabel) throw new Error("fixture changed");
    const repoScore: RepoScore = { ...SCORE_A, missing: [...SCORE_A.missing, nullLabel] };
    const out = renderReport(
      input({ score: { overall: SCORE_A.counts, repos: [repoScore, SCORE_B] } }),
    );
    expect(out).toContain(
      '**Missing call sites (2)**\n\n1 with a real target is listed above as false negatives ("nothing predicted at the site"). The rest:\n\n- `web/api.ts:9` (runtime method): labeled no route in the repo (`null`).\n',
    );
    const onlyNull = renderReport(
      input({
        score: { overall: SCORE_A.counts, repos: [{ ...SCORE_A, missing: [nullLabel] }, SCORE_B] },
      }),
    );
    expect(onlyNull).toContain(
      "**Missing call sites (1)**\n\n- `web/api.ts:9` (runtime method): labeled no route in the repo (`null`).\n",
    );
  });

  it("says what was predicted instead for a false negative, and names unlabeled sites", () => {
    const repoScore: RepoScore = {
      ...SCORE_A,
      falsePositives: [
        {
          kind: "unlabeled-site",
          site: { file: "web/x.ts", line: 1, column: 1 },
          predicted: { file: "api/server.ts", line: 10, route: "GET /api/items" },
          confidence: "exact",
          expected: [],
        },
      ],
      falseNegatives: [
        {
          callSite: { file: "web/api.ts", line: 7, column: 3 },
          method: null,
          expected: { file: "api/server.ts", line: 12, route: "POST /api/items" },
          predicted: ["external api.example.com", "unresolved DYNAMIC_URL"],
        },
      ],
    };
    const out = renderReport(
      input({ score: { overall: SCORE_A.counts, repos: [repoScore, SCORE_B] } }),
    );
    expect(out).toContain(
      "- `web/x.ts:1:1`: predicted `GET /api/items` in `api/server.ts:10` (exact). unlabeled call site.",
    );
    expect(out).toContain(
      "- `web/api.ts:7:3` (runtime method): expected `POST /api/items` in `api/server.ts:12`; predicted instead: `external api.example.com`, `unresolved DYNAMIC_URL`.",
    );
  });

  it("includes method, limitations, and the reproduce command for its own file", () => {
    expect(text).toContain("## Method");
    expect(text).toContain("## Limitations");
    expect(text).toContain("pnpm eval --check eval/results/2026-10-28-0.1.0.md");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is deterministic", () => {
    expect(renderReport(input())).toBe(text);
  });

  it("throws when a pinned repo has no score", () => {
    expect(() =>
      renderReport(input({ score: { overall: SCORE_A.counts, repos: [SCORE_A] } })),
    ).toThrow(ReportError);
  });
});

describe("parseRun", () => {
  it("reads back the run record of a rendered report", () => {
    expect(parseRun(renderReport(input()))).toEqual(RUN);
  });

  it("keeps the dirty mark", () => {
    const run = { ...RUN, gitinsideSha: `${RUN.gitinsideSha}${DIRTY_MARK}` };
    expect(parseRun(renderReport(input({ run }))).gitinsideSha).toBe(run.gitinsideSha);
  });

  it("throws on a report without a run record", () => {
    expect(() => parseRun("# Something else\n")).toThrow(ReportError);
    expect(() => parseRun("- **Date:** 2026-10-28\n- **GitInside commit:** abc\n")).toThrow(
      /backticks/,
    );
  });
});

describe("firstDifference", () => {
  it("is null for identical texts", () => {
    expect(firstDifference("a\nb\n", "a\nb\n")).toBeNull();
  });

  it("names the first differing line", () => {
    expect(firstDifference("a\nb\nc", "a\nx\nc")).toEqual({ line: 2, expected: "b", actual: "x" });
  });

  it("reports a missing line as the end of file", () => {
    expect(firstDifference("a\nb", "a")).toEqual({
      line: 2,
      expected: "b",
      actual: "<end of file>",
    });
    expect(firstDifference("a", "a\nb")).toEqual({
      line: 2,
      expected: "<end of file>",
      actual: "b",
    });
  });
});
