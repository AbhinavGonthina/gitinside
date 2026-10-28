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

  it.each(["data-hover", "data-selected", 'data-emphasis="dimmed"', 'data-emphasis="traced"'])(
    "styles the %s state",
    (attr) => {
      expect(css).toContain(`[${attr}]`);
    },
  );

  it.each(["added", "changed", "removed"])("styles the %s diff state", (diff) => {
    expect(css).toContain(`.gi-node[data-diff="${diff}"]`);
  });
});
