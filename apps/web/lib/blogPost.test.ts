// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The blog post draft (M9.5, `docs/blog/resolver-post.md`): unpublished until Abhinav decides
 * (D13.2, D13.3), and quoting its numbers exactly as the committed reports measured them
 * (docs/EVALUATION.md), so an edit to either side that makes them disagree fails here.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const POST = "docs/blog/resolver-post.md";
const text = (path: string) => readFileSync(join(ROOT, path), "utf8");
const post = text(POST);

/** The report the post quotes for batch 6 (0.3.1: every score is 0.3.0's). */
const REPORT = "eval/results/2026-11-11-0.3.1.md";

/** The numbers in a report row's `100.0% (521/521)` cell, as `[part, whole]`. */
function fraction(cell: string | undefined): [number, number] {
  const match = /\((\d+)\/(\d+)\)/.exec(cell ?? "");
  if (!match) throw new Error(`no fraction in ${String(cell)}`);
  return [Number(match[1]), Number(match[2])];
}

const percent = ([part, whole]: [number, number]) => ((part / whole) * 100).toFixed(1);

describe("the blog post draft", () => {
  it("says it's an unpublished draft before anything else", () => {
    const banner = post.split("-->")[0] ?? "";
    expect(post.startsWith("<!--")).toBe(true);
    expect(banner).toContain("DRAFT (M9.5), not published");
  });

  it("has the title D13.3 chose", () => {
    expect(post.split(/\r?\n/)).toContain(
      "# How GitInside matches frontend calls to backend routes without running code",
    );
  });

  it("quotes batch 6's precision and recall from the committed report", () => {
    const row = text(REPORT)
      .split(/\r?\n/)
      .find((line) => line.startsWith("| **All of batch 6** |"));
    const cells = row?.split("|").map((cell) => cell.trim()) ?? [];
    // | name | labels | real targets | TP | FP | FN | precision | recall | …
    const precision = fraction(cells[7]);
    const recall = fraction(cells[8]);
    expect(post).toContain(
      `**Precision: ${percent(precision)}% (${precision[0]} of ${precision[1]}).**`,
    );
    expect(post).toContain(`**Recall: ${percent(recall)}% (${recall[0]} of ${recall[1]}),**`);
    expect(post).toContain(`${cells[2]} labels`);
    expect(post).toContain(`all ${cells[6]} misses`);
  });

  it("quotes batch 6's levels from the committed report", () => {
    const levels = text(REPORT).split("### Batch 6, by confidence level")[1] ?? "";
    const tp = (level: string) =>
      new RegExp(`^\\| ${level} \\| (\\d+) \\| 0 \\|`, "m").exec(levels)?.[1];
    expect(post).toContain(
      `\`exact\` ${tp("exact") ?? "?"}, \`heuristic\` ${tp("heuristic") ?? "?"}`,
    );
  });

  it("quotes the demo check as the README does", () => {
    const match =
      /(\d[\d,]*) inferred edges .*?: (\d+) correct, \*\*0 wrong\*\*, and (\d+) unresolved/.exec(
        text("README.md"),
      );
    expect(match).not.toBeNull();
    const [, edges, correct, unresolved] = match ?? [];
    expect(post).toContain(
      `${edges ?? "?"} inferred edges are ${correct ?? "?"} correct, 0 wrong, and ${unresolved ?? "?"} unresolved`,
    );
  });

  it("links only files that exist", () => {
    const links = [...post.matchAll(/\]\((?!https?:)([^)#]+)(#[^)]*)?\)/g)].map((m) => m[1] ?? "");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(existsSync(join(ROOT, dirname(POST), link)), link).toBe(true);
    }
  });
});
