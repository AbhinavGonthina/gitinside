// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const css = read("../styles/nodes.css");

describe("nodes.css", () => {
  it("is part of the stylesheet entry", () => {
    expect(read("../styles/index.css")).toContain('@import "./nodes.css";');
  });

  it("takes every color from tokens, so both themes style it", () => {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(|\bhsla?\(/);
  });

  it("animates only with the duration tokens, so reduced motion makes it instant", () => {
    const transitions = css.match(/transition:[^;]*;/g) ?? [];
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) expect(t).not.toMatch(/\d+m?s\b/);
  });

  it("changes a shape's drawn parts with the box, so the band and tab don't snap ahead (M4b.0e)", () => {
    const rule =
      /\.gi-node::before,\s*\.gi-node \.gi-node__fields \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("background-color var(--duration-fast) var(--ease-standard)");
    expect(rule).toContain("border-color var(--duration-fast) var(--ease-standard)");
  });

  it.each([
    "data-hover",
    "data-selected",
    'data-emphasis="dimmed"',
    'data-emphasis="traced"',
    'data-emphasis="current"',
  ])("styles the %s state", (attr) => {
    expect(css).toContain(`[${attr}]`);
  });

  it("rings only the current hop's nodes; the rest of the path keeps a hairline (design gate)", () => {
    const rule = (emphasis: string) =>
      new RegExp(`\\.gi-node\\[data-emphasis="${emphasis}"\\] \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule("current")).toContain("--gi-state-shadow");
    expect(rule("current")).toContain("--gi-node-border: var(--trace);");
    expect(rule("traced")).not.toContain("--gi-state-shadow");
    expect(rule("traced")).toContain("--gi-node-border: var(--trace);");
  });

  it.each(["added", "changed", "removed"])("styles the %s diff state", (diff) => {
    expect(css).toContain(`.gi-node[data-diff="${diff}"]`);
  });
});
