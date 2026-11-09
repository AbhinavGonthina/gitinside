import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseGraph,
  type ArchitectureGraph,
  type BrokenEdge,
  type GraphDiff,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import {
  diffGraphs,
  markdownCode,
  MAX_CHECK_SUMMARY_LENGTH,
  MAX_COMMENT_LENGTH,
  MAX_MERMAID_LENGTH,
  PR_COMMENT_MARKER,
  renderCheckRun,
  renderMermaidSummary,
  renderPrComment,
} from "./index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const fixture = (name: string, sha: string): ArchitectureGraph => {
  const graph = parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));
  return { ...graph, repo: { ...graph.repo, sha } };
};
const BASE_SHA = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_SHA = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SITE = { siteOrigin: "https://gitinside.example" };
const DIFF_LINK =
  "[Open the interactive diff](https://gitinside.example/fixtures/diff-broken-head/" +
  `${HEAD_SHA}?base=${BASE_SHA})`;
const blob = (path: string, line: number): string =>
  `https://github.com/fixtures/diff-broken-head/blob/${HEAD_SHA}/${path}#L${line}`;

const base = fixture("diff-broken-base", BASE_SHA);
const head = fixture("diff-broken-head", HEAD_SHA);
const diff = diffGraphs(base, head);

/** The broken list for the diff-broken pair, as both texts write it. */
const BROKEN_LIST = [
  "- `function quote` → `function withTax`: **needs more arguments** — `withTax now needs 2 arguments (was 1)`",
  `  - [\`src/pricing.ts:6\`](${blob("src/pricing.ts", 6)})`,
  "- `function cancelOrder` → `DELETE /api/orders/:id`: **target removed** — `DELETE /api/orders/:id was removed`",
  `  - [\`src/client.ts:12\`](${blob("src/client.ts", 12)})`,
  "- `function placeOrder` → `POST /api/orders`: **route changed** — `POST /api/orders is now PUT /api/orders`",
  `  - [\`src/client.ts:8\`](${blob("src/client.ts", 8)})`,
  "- `file client.ts` → `file legacy.ts`: **target removed** — `src/legacy.ts was removed`",
  `  - [\`src/client.ts:1\`](${blob("src/client.ts", 1)})`,
  "- `function invoiceTotal` → `model Invoice`: **target removed** — `model Invoice was removed`",
  `  - [\`src/handlers.ts:13\`](${blob("src/handlers.ts", 13)})`,
  "- `function openOrders` → `model Order`: **field removed** — `Order.status was removed`",
  `  - [\`src/handlers.ts:18\`](${blob("src/handlers.ts", 18)})`,
].join("\n");

/** The text with every Markdown code span removed (CommonMark's matching backtick runs). */
const outsideCode = (text: string): string => text.replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, "");

describe("renderPrComment", () => {
  it("writes the marker, the broken list with call sites, the summary, and the link", () => {
    expect(renderPrComment(diff, base, head, SITE)).toBe(
      [
        `${PR_COMMENT_MARKER}\n### GitInside architecture check`,
        "**6 broken connections.** Each worked at the base commit and no longer does at the head commit.",
        "Compared base `1111111` with head `2222222`.",
        "#### Broken connections",
        BROKEN_LIST,
        "#### What changed",
        `\`\`\`mermaid\n${renderMermaidSummary(diff, base, head)}\`\`\``,
        DIFF_LINK,
      ].join("\n\n") + "\n",
    );
  });

  it("says nothing broke, with no broken heading, when the PR changes nothing", () => {
    const same = diffGraphs(base, { ...base, repo: head.repo });
    const text = renderPrComment(same, base, { ...base, repo: head.repo }, SITE);
    expect(text).toContain(
      "\n\n**No broken connections.** Every connection that worked at the base commit still does.\n\n",
    );
    expect(text).not.toContain("#### Broken connections");
    expect(text).toContain(
      '```mermaid\nflowchart LR\n  none["No architecture-level changes"]\n```',
    );
    expect(text.startsWith(`${PR_COMMENT_MARKER}\n`)).toBe(true);
  });

  it("names one broken connection in the singular", () => {
    const one = { ...diff, broken: diff.broken.slice(0, 1) };
    expect(renderPrComment(one, base, head, SITE)).toContain(
      "**1 broken connection.** It worked at the base commit and no longer does at the head commit.",
    );
  });

  it("notes a rename budget that stopped, before the link", () => {
    const limited = { ...diff, renameLimit: { removed: 401, added: 2 } };
    expect(renderPrComment(limited, base, head, SITE)).toContain(
      "```\n\n_Moves not checked for 401 removed and 2 added files, so a moved file may show as removed and added._\n\n" +
        DIFF_LINK,
    );
    expect(renderPrComment(diff, base, head, SITE)).not.toContain("Moves");
  });

  it("is deterministic and doesn't depend on the graphs' order", () => {
    const shuffled = {
      ...head,
      nodes: [...head.nodes].reverse(),
      edges: [...head.edges].reverse(),
    };
    expect(renderPrComment(diffGraphs(base, shuffled), base, shuffled, SITE)).toBe(
      renderPrComment(diff, base, head, SITE),
    );
  });

  it("lists 5 call sites per connection and counts the rest, paths percent-encoded", () => {
    const first = diff.broken[0] as BrokenEdge;
    const sites = Array.from({ length: 7 }, (_, i) => ({
      file: `src/a b (${i})/x#y.ts`,
      line: i + 1,
      column: 1,
    }));
    const text = renderPrComment({ ...diff, broken: [{ ...first, sites }] }, base, head, SITE);
    expect(text).toContain(
      `  - [\`src/a b (0)/x#y.ts:1\`](https://github.com/fixtures/diff-broken-head/blob/${HEAD_SHA}/src/a%20b%20%280%29/x%23y.ts#L1)\n`,
    );
    expect(text).toContain("src/a b (4)/x#y.ts:5");
    expect(text).not.toContain("src/a b (5)");
    expect(text).toContain("\n  - and 2 more call sites\n");
  });

  it("refuses an origin with a path and a diff without SHAs", () => {
    expect(() =>
      renderPrComment(diff, base, head, { siteOrigin: "https://x.example/app" }),
    ).toThrow(/must be an origin/);
    expect(renderPrComment(diff, base, head, { siteOrigin: "https://gitinside.example/" })).toBe(
      renderPrComment(diff, base, head, SITE),
    );
    const noSha = { ...diff, base: { repo: { owner: "fixtures", name: "diff-broken-base" } } };
    expect(() => renderPrComment(noSha, base, head, SITE)).toThrow(/SHAs/);
  });
});

/** U+202E RIGHT-TO-LEFT OVERRIDE, built so the source holds no invisible character. */
const RLO = String.fromCharCode(0x202e);

describe("repo text in the PR texts (SECURITY.md T10)", () => {
  const hostile = "x` <img src=//e.example/p.png> @octocat #1 [a](javascript:alert(1)) --> **b**";
  const first = diff.broken[0] as BrokenEdge;
  const evil: GraphDiff = {
    ...diff,
    broken: [
      {
        ...first,
        detail: `${hostile}\n\n# Heading${RLO}`,
        sites: [{ file: `src/${hostile}.ts`, line: 3, column: 1 }],
      },
    ],
  };
  const evilHead: ArchitectureGraph = {
    ...head,
    nodes: head.nodes.map((n) => (n.id === first.from ? { ...n, label: hostile } : n)),
  };

  it("keeps it inside code spans, on one line, so nothing renders or pings", () => {
    for (const text of [
      renderPrComment(evil, base, evilHead, SITE),
      renderCheckRun(evil, base, evilHead, SITE).summary,
    ]) {
      const outside = outsideCode(text).replace(PR_COMMENT_MARKER, "");
      for (const bad of ["<img", "@octocat", "#1", "javascript:", "-->", "# Heading", RLO]) {
        expect(outside, bad).not.toContain(bad);
      }
      expect(text).not.toContain("\n\n# Heading");
      // A bidi override reorders what a reviewer sees even inside a code span.
      expect(text).not.toContain(RLO);
    }
    const comment = renderPrComment(evil, base, evilHead, SITE);
    expect(comment.split(PR_COMMENT_MARKER)).toHaveLength(2);
    // The path's slashes stay separators; everything else that could end the link is encoded.
    expect(comment).toContain(
      `(https://github.com/fixtures/diff-broken-head/blob/${HEAD_SHA}/src/x%60%20%3Cimg%20src%3D//e.example/p.png%3E%20%40octocat%20%231%20%5Ba%5D%28javascript%3Aalert%281%29%29%20--%3E%20%2A%2Ab%2A%2A.ts#L3)\n`,
    );
  });

  it("fences a code span past its longest backtick run and pads one at an edge", () => {
    expect(markdownCode("plain")).toBe("`plain`");
    expect(markdownCode("a ``b`` c")).toBe("```a ``b`` c```");
    expect(markdownCode("`edge")).toBe("`` `edge ``");
    expect(markdownCode(String.fromCharCode(0, 0x200b))).toBe("` `");
    expect(markdownCode("  a \n\t b  ")).toBe("`a b`");
    expect(markdownCode("abcdef", 5)).toBe("`ab...`");
    expect(markdownCode("😀😀😀😀😀😀", 5)).toBe("`😀😀...`");
  });
});

describe("GitHub's size limits", () => {
  const first = diff.broken[0] as BrokenEdge;
  /** 3000 breaks with long details and 6 sites each; `onePair` keeps them all on first's pair. */
  const many = (onePair: boolean): GraphDiff => ({
    ...diff,
    broken: Array.from({ length: 3000 }, (_, i) => ({
      ...first,
      edge: `${first.edge}#${String(i).padStart(4, "0")}`,
      // A source the graphs don't hold isn't drawn, so the diagram stays small.
      from: onePair ? first.from : `${first.from}#${i}`,
      detail: `${"d".repeat(200)} ${i}`,
      sites: Array.from({ length: 6 }, (_, j) => ({
        file: `src/f${j}.ts`,
        line: i + 1,
        column: 1,
      })),
    })),
  });
  const listedIn = (text: string): number =>
    text.split("\n").filter((l) => l.startsWith("- ")).length;

  it("lists the first broken connections that fit and counts the rest", () => {
    const text = renderPrComment(many(false), base, head, SITE);
    expect(text.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(text.length).toBeGreaterThan(MAX_COMMENT_LENGTH - 2000);
    const listed = listedIn(text);
    expect(listed).toBeGreaterThan(10);
    expect(text).toContain(`\n- \`${first.from}#0\` → \`function withTax\``);
    expect(text).toContain(`\n- \`${first.from}#${listed - 1}\` → \`function withTax\``);
    expect(text).not.toContain(`\n- \`${first.from}#${listed}\` → `);
    expect(text).toContain(
      `\n\nAnd ${3000 - listed} more broken connections, listed in the interactive diff.\n\n#### What changed\n\n\`\`\`mermaid\n`,
    );
    expect(text.startsWith(`${PR_COMMENT_MARKER}\n`)).toBe(true);
    expect(text.endsWith(`${DIFF_LINK}\n`)).toBe(true);
    expect(text).toContain("**3000 broken connections.**");

    const check = renderCheckRun(many(false), base, head, SITE);
    expect(check.summary.length).toBeLessThanOrEqual(MAX_CHECK_SUMMARY_LENGTH);
    expect(check.summary.length).toBeGreaterThan(MAX_CHECK_SUMMARY_LENGTH - 2000);
    expect(check.summary).toContain(
      `\n\nAnd ${3000 - listedIn(check.summary)} more broken connections, listed in the interactive diff.\n\n${DIFF_LINK}\n`,
    );
    expect(check.title).toBe("3000 broken connections");
  });

  it("leaves out a summary diagram too large for a comment", () => {
    const big = many(true);
    expect(renderMermaidSummary(big, base, head).length).toBeGreaterThan(MAX_COMMENT_LENGTH);
    expectNoSummary(big);
  });

  it(`leaves out a summary past Mermaid's ${MAX_MERMAID_LENGTH} characters though the comment fits (M8.10d, F9)`, () => {
    // The fewest breaks on one pair whose diagram passes Mermaid's limit.
    const all = many(true);
    const onFirst = (n: number): GraphDiff => ({ ...all, broken: all.broken.slice(0, n) });
    const fits = (k: number) =>
      renderMermaidSummary(onFirst(k), base, head).length <= MAX_MERMAID_LENGTH;
    // Bisect: onFirst(lo) fits, onFirst(hi) doesn't.
    let [lo, hi] = [1, all.broken.length];
    expect([fits(lo), fits(hi)]).toEqual([true, false]);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    const n = hi;
    const over = onFirst(n);
    const summary = renderMermaidSummary(over, base, head);
    // A comment holding the whole diagram would still fit GitHub's comment limit.
    expect(summary.length + 2000).toBeLessThan(MAX_COMMENT_LENGTH);
    expectNoSummary(over);
    // One break fewer keeps it.
    expect(renderPrComment(onFirst(n - 1), base, head, SITE)).toContain(
      `\`\`\`mermaid\n${renderMermaidSummary(onFirst(n - 1), base, head)}\`\`\``,
    );
  });

  function expectNoSummary(big: GraphDiff): void {
    const text = renderPrComment(big, base, head, SITE);
    expect(text.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(text).not.toContain("```mermaid");
    const more = big.broken.length - listedIn(text);
    expect(text).toContain(
      `\n\n${more > 0 ? `And ${more} more broken connections, listed in the interactive diff.\n\n` : ""}` +
        `_The change summary is too large for a comment; open the interactive diff._\n\n${DIFF_LINK}\n`,
    );
  }
});

describe("renderCheckRun", () => {
  it("titles the run with the broken count and concludes neutral", () => {
    expect(renderCheckRun(diff, base, head, SITE)).toEqual({
      name: "GitInside",
      conclusion: "neutral",
      title: "6 broken connections",
      summary:
        [
          "**6 broken connections.** Each worked at the base commit and no longer does at the head commit.",
          "Compared base `1111111` with head `2222222`.",
          BROKEN_LIST,
          DIFF_LINK,
        ].join("\n\n") + "\n",
    });
  });

  it("concludes success when nothing broke, singular for one", () => {
    const none = renderCheckRun({ ...diff, broken: [] }, base, head, SITE);
    expect(none.conclusion).toBe("success");
    expect(none.title).toBe("No broken connections");
    expect(none.summary).not.toContain("- `");
    const one = renderCheckRun({ ...diff, broken: diff.broken.slice(0, 1) }, base, head, SITE);
    expect([one.conclusion, one.title]).toEqual(["neutral", "1 broken connection"]);
    const limited = renderCheckRun(
      { ...diff, renameLimit: { removed: 0, added: 0 } },
      base,
      head,
      SITE,
    );
    expect(limited.summary).toContain(
      "\n\n_Moves checked only between files of the same name, so a moved file may show as removed and added._\n\n",
    );
  });
});
