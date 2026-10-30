// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const css = read("../styles/drill.css");
const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("drill.css", () => {
  it("is part of the stylesheet entry", () => {
    expect(read("../styles/index.css")).toContain('@import "./drill.css";');
  });

  it("takes every color from tokens and times motion with the duration tokens", () => {
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(|\bhsla?\(/);
    const timed = body.match(/\b(?:transition|animation):[^;]*;/g) ?? [];
    expect(timed.length).toBeGreaterThan(0);
    for (const t of timed) expect(t).not.toMatch(/\d+m?s\b/);
    expect(body).toMatch(
      /\.gi-drill__stage \{[^}]*width var\(--duration-layout\) var\(--ease-layout\)/,
    );
  });

  it("layers open frames under the lines, and boxes and pills over them", () => {
    const z = (selector: string) =>
      new RegExp(`${selector.replace(/[.[\]>]/g, "\\$&")} \\{[^}]*z-index: (\\d)`).exec(body)?.[1];
    expect(z(".gi-drill__node[data-open]")).toBe("0");
    expect(z(".gi-drill__lines")).toBe("1");
    expect(z(".gi-drill__node")).toBe("2");
    expect(z(".gi-drill__labels")).toBe("3");
  });

  it("keeps an open file's own row at the top, above its children (M4b.3a)", () => {
    expect(body).toMatch(
      /\.gi-drill__node\[data-open\] > \.gi-node:not\(\[data-tier="frame"\]\) \{\s*align-items: flex-start;/,
    );
  });

  it("lets clicks through the pills' layer and past a folding box", () => {
    expect(body).toMatch(/\.gi-drill__labels \{[^}]*pointer-events: none/);
    expect(body).toMatch(/\.gi-drill__node\[data-leaving\] \{[^}]*pointer-events: none/);
  });
});
