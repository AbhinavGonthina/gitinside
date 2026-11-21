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
  type PrRules,
  type PrRuleViolation,
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

describe("architecture rules in the PR texts (M15.1a)", () => {
  const site = (file: string, line: number, column = 1) => ({ file, line, column });
  const violation = (
    over: Partial<PrRuleViolation> & Pick<PrRuleViolation, "rule" | "level">,
  ): PrRuleViolation => ({
    message: `broke ${over.rule}`,
    edges: [{ sites: [site("src/client.ts", 8)] }],
    ...over,
  });
  const checked = (
    violations: PrRuleViolation[],
    uncertain: PrRuleViolation[] = [],
    configChanged = false,
  ): PrRules => ({ result: { ok: true, report: { violations, uncertain } }, configChanged });
  const withRules = (rules: PrRules) => ({ ...SITE, rules });
  const routesSkipBilling = violation({
    rule: "routes-skip-billing",
    level: "error",
    message: "function placeOrder (routes) depends on function charge (billing) through calls",
    edges: [
      // Two edges: their sites merge, sorted by file, line, column, a repeat listed once.
      { sites: [site("src/routes/orders.ts", 12), site("src/routes/orders.ts", 4, 9)] },
      { sites: [site("src/routes/cart.ts", 30), site("src/routes/orders.ts", 4, 9)] },
    ],
  });
  const knownHosts = violation({
    rule: "known-hosts",
    level: "warning",
    message: "the code calls api.example.com, a host not on the rule's allow list",
  });
  const RULES_SECTION = [
    "#### Architecture rules",
    "**2 new rule violations:** 1 error, 1 warning. An error-level rule broken fails this check.",
    [
      "- **Error**, rule `routes-skip-billing`: `function placeOrder (routes) depends on function charge (billing) through calls`",
      `  - [\`src/routes/cart.ts:30\`](${blob("src/routes/cart.ts", 30)})`,
      `  - [\`src/routes/orders.ts:4\`](${blob("src/routes/orders.ts", 4)})`,
      `  - [\`src/routes/orders.ts:12\`](${blob("src/routes/orders.ts", 12)})`,
      "- **Warning**, rule `known-hosts`: `the code calls api.example.com, a host not on the rule's allow list`",
      `  - [\`src/client.ts:8\`](${blob("src/client.ts", 8)})`,
    ].join("\n"),
  ].join("\n\n");

  it("lists each new violation with its rule, level, message, and sites, and fails on an error", () => {
    const rules = checked([routesSkipBilling, knownHosts]);
    expect(renderCheckRun(diff, base, head, withRules(rules))).toEqual({
      name: "GitInside",
      conclusion: "failure",
      title: "2 rule violations, 6 broken connections",
      summary:
        [
          "**6 broken connections.** Each worked at the base commit and no longer does at the head commit.",
          "Compared base `1111111` with head `2222222`.",
          BROKEN_LIST,
          RULES_SECTION,
          DIFF_LINK,
        ].join("\n\n") + "\n",
    });
    // The comment has the same section, after its broken list and before the diagram.
    expect(renderPrComment(diff, base, head, withRules(rules))).toContain(
      `\n\n${BROKEN_LIST}\n\n${RULES_SECTION}\n\n#### What changed\n\n`,
    );
  });

  it("only warns (neutral) when every new violation is a warning", () => {
    const none = { ...diff, broken: [] };
    const run = renderCheckRun(none, base, head, withRules(checked([knownHosts])));
    expect([run.conclusion, run.title]).toEqual([
      "neutral",
      "1 rule violation, no broken connections",
    ]);
    expect(run.summary).toContain(
      "**1 new rule violation:** 0 errors, 1 warning. Warnings don't fail this check.",
    );
    // A broken connection beside a warning is still neutral, never failure.
    expect(renderCheckRun(diff, base, head, withRules(checked([knownHosts]))).conclusion).toBe(
      "neutral",
    );
  });

  it("says so when the rules pass, and succeeds when nothing broke", () => {
    const none = { ...diff, broken: [] };
    const run = renderCheckRun(none, base, head, withRules(checked([])));
    expect([run.conclusion, run.title]).toEqual([
      "success",
      "No broken connections or rule violations",
    ]);
    expect(run.summary).toContain(
      "\n\n#### Architecture rules\n\n**No new rule violations.** The head commit breaks no rule in `.gitinside.yml` that the base commit didn't.\n\n",
    );
    const broken = renderCheckRun(diff, base, head, withRules(checked([])));
    expect([broken.conclusion, broken.title]).toEqual([
      "neutral",
      "6 broken connections, no rule violations",
    ]);
  });

  it("counts new unresolved connections and notes a changed config, without failing", () => {
    const none = { ...diff, broken: [] };
    const one = renderCheckRun(
      none,
      base,
      head,
      withRules(checked([], [violation({ rule: "a", level: "error" })], true)),
    );
    expect(one.conclusion).toBe("success");
    expect(one.summary).toContain(
      "that the base commit didn't.\n\n" +
        "_1 new unresolved connection may also break a rule. GitInside couldn't tell where it goes, so it isn't judged._\n\n" +
        "_This PR changes `.gitinside.yml`, so the head commit's rules were used._\n\n" +
        DIFF_LINK,
    );
    const two = renderCheckRun(
      none,
      base,
      head,
      withRules(
        checked(
          [],
          [violation({ rule: "a", level: "error" }), violation({ rule: "b", level: "warning" })],
        ),
      ),
    );
    expect(two.summary).toContain(
      "_2 new unresolved connections may also break a rule. GitInside couldn't tell where they go, so they aren't judged._",
    );
    expect(two.summary).not.toContain("This PR changes");
  });

  it("reports a config it couldn't check, each problem with its place and line, as neutral", () => {
    const rules: PrRules = {
      result: {
        ok: false,
        issues: [
          { path: "", message: "the file is 70000 bytes; the limit is 65536" },
          { path: "rules.2.from", line: 7, message: 'no layer named "routs"' },
        ],
      },
      configChanged: false,
    };
    const run = renderCheckRun({ ...diff, broken: [] }, base, head, withRules(rules));
    expect([run.conclusion, run.title]).toEqual([
      "neutral",
      "No broken connections, rules not checked",
    ]);
    expect(run.summary).toContain(
      [
        "#### Architecture rules",
        "**`.gitinside.yml` couldn't be checked:** 2 problems. Fix them to have its rules checked.",
        [
          "- The file: `the file is 70000 bytes; the limit is 65536`",
          '- `rules.2.from`, line 7: `no layer named "routs"`',
        ].join("\n"),
        DIFF_LINK,
      ].join("\n\n"),
    );
  });

  it("never passes the limit by the paragraph break a list's first item adds", () => {
    // n small rule violations listed, then 100 big ones that don't fit, so the rules' count
    // line stays as long and leaves no slack; n leaves 100–360 characters. The broken list's
    // first item is then swept through every length up to that room, so one needs it exactly,
    // paragraph break included.
    const first = diff.broken[0] as BrokenEdge;
    // A site whose link alone is longer than the limit: an item holding it never fits.
    const huge = [site(`src/${"p".repeat(MAX_CHECK_SUMMARY_LENGTH)}.ts`, 1)];
    const brokenOf = (k: number): GraphDiff => ({
      ...diff,
      broken: Array.from({ length: 3 }, (_, i) => ({
        ...first,
        edge: `${first.edge}#${i}`,
        from: `${"f".repeat(Math.max(0, Math.min(k, 150)))}${i}`,
        detail: "d".repeat(Math.max(0, k - 150)),
        sites: k < 0 ? huge : [],
      })),
    });
    const ruleList = (n: number) =>
      withRules(
        checked([
          ...Array.from({ length: n }, (_, i) =>
            violation({
              rule: `r-${String(i).padStart(3, "0")}`,
              level: "error",
              message: "m".repeat(50),
            }),
          ),
          // 100 left out, so the count line keeps its length from "And 3xx more" to "And 100 more".
          ...Array.from({ length: 100 }, (_, i) =>
            violation({ rule: `big-${i}`, level: "error", message: "b".repeat(300) }),
          ),
        ]),
      );
    // With broken items too long to list (k = -1): the room left once exactly the n small
    // rules are listed and every big one is cut, else undefined.
    const room = (n: number): number | undefined => {
      const text = renderCheckRun(brokenOf(-1), base, head, ruleList(n)).summary;
      const small = text.split("\n").filter((l) => l.startsWith("- **Error**, rule `r-")).length;
      const cut = text.includes("\n\nAnd 100 more rule violations, not listed here.\n\n");
      return small === n && cut ? MAX_CHECK_SUMMARY_LENGTH - text.length : undefined;
    };
    let n = 1;
    for (; n < 1000; n += 1) {
      const left = room(n);
      if (left !== undefined && left > 100 && left <= 360) break;
    }
    expect(n).toBeLessThan(1000);
    const rules = ruleList(n);
    let listedBroken = 0;
    for (let k = 0; k <= 310; k += 1) {
      const summary = renderCheckRun(brokenOf(k), base, head, rules).summary;
      expect(summary.length, `k = ${k}`).toBeLessThanOrEqual(MAX_CHECK_SUMMARY_LENGTH);
      // Cut (the big rule left out) and a broken item listed in what was left.
      const cut = summary.includes("\n\nAnd 100 more rule violations, not listed here.\n\n");
      if (cut && summary.includes("\n\n- `f")) listedBroken += 1;
    }
    expect(listedBroken).toBeGreaterThan(0);
  });

  it("lists 5 call sites per violation and counts the rest", () => {
    const sites = Array.from({ length: 7 }, (_, i) => site(`src/s${i}.ts`, 1));
    const run = renderCheckRun(
      diff,
      base,
      head,
      withRules(checked([violation({ rule: "r", level: "error", edges: [{ sites }] })])),
    );
    expect(run.summary).toContain("src/s4.ts:1");
    expect(run.summary).not.toContain("src/s5.ts");
    expect(run.summary).toContain(`(${blob("src/s4.ts", 1)})\n  - and 2 more call sites\n`);
  });

  it("is unchanged without rules", () => {
    expect(renderCheckRun(diff, base, head, { ...SITE })).toEqual(
      renderCheckRun(diff, base, head, SITE),
    );
    expect(renderCheckRun(diff, base, head, SITE).summary).not.toContain("Architecture rules");
  });

  it("keeps rule IDs, messages, and config problems inside code spans (SECURITY.md T10)", () => {
    const hostile = "x` <img src=//e.example/p.png> @octocat #1 [a](javascript:alert(1)) --> **b**";
    const evil = checked([
      violation({
        rule: hostile,
        level: "error",
        message: `${hostile}\n\n# Heading${RLO}`,
        edges: [{ sites: [site(`src/${hostile}.ts`, 3)] }],
      }),
    ]);
    const bad: PrRules = {
      result: { ok: false, issues: [{ path: hostile, line: 2, message: `${hostile}\n# Heading` }] },
      configChanged: true,
    };
    for (const rules of [evil, bad]) {
      for (const text of [
        renderPrComment(diff, base, head, withRules(rules)),
        renderCheckRun(diff, base, head, withRules(rules)).summary,
      ]) {
        const outside = outsideCode(text).replace(PR_COMMENT_MARKER, "");
        for (const word of ["<img", "@octocat", "#1", "javascript:", "-->", "# Heading", RLO]) {
          expect(outside, word).not.toContain(word);
        }
        expect(text).not.toContain(RLO);
      }
    }
  });

  it("fits GitHub's limits, listing rule violations before broken connections", () => {
    const first = diff.broken[0] as BrokenEdge;
    const manyBroken: GraphDiff = {
      ...diff,
      broken: Array.from({ length: 3000 }, (_, i) => ({
        ...first,
        edge: `${first.edge}#${String(i).padStart(4, "0")}`,
        from: `${first.from}#${i}`,
        detail: `${"d".repeat(200)} ${i}`,
      })),
    };
    const manyRules = checked(
      Array.from({ length: 3000 }, (_, i) =>
        violation({
          rule: `rule-${String(i).padStart(4, "0")}`,
          level: "error",
          message: "m".repeat(150),
        }),
      ),
    );
    const fewRules = checked([routesSkipBilling, knownHosts]);
    const cases = [
      [manyRules, "rule-0000"],
      [fewRules, "routes-skip-billing"],
    ] as const;
    for (const [rules, firstRule] of cases) {
      const run = renderCheckRun(manyBroken, base, head, withRules(rules));
      expect(run.summary.length).toBeLessThanOrEqual(MAX_CHECK_SUMMARY_LENGTH);
      const comment = renderPrComment(manyBroken, base, head, withRules(rules));
      expect(comment.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
      for (const text of [run.summary, comment]) {
        expect(text).toContain(`\n\n- **Error**, rule \`${firstRule}\`: `);
        expect(text.endsWith(`${DIFF_LINK}\n`)).toBe(true);
      }
    }
    // A handful of violations are all listed; the broken list gives way to them.
    const few = renderCheckRun(manyBroken, base, head, withRules(fewRules)).summary;
    expect(few).toContain(`\n\n${RULES_SECTION}\n\n${DIFF_LINK}\n`);
    expect(few).toMatch(
      /\n\nAnd \d+ more broken connections, listed in the interactive diff\.\n\n/,
    );
    expect(few).not.toContain("more rule violation");
    // Thousands are cut too, counted in words that don't send the reader to the diff.
    const many = renderCheckRun(manyBroken, base, head, withRules(manyRules)).summary;
    const listed = many.split("\n").filter((l) => l.startsWith("- **Error**")).length;
    expect(listed).toBeGreaterThan(10);
    expect(many).toContain(`\n\nAnd ${3000 - listed} more rule violations, not listed here.\n\n`);
    expect(many).toContain(
      "\n\nAnd 3000 more broken connections, listed in the interactive diff.\n\n",
    );
  });
});
