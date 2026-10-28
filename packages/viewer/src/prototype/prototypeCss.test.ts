// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const css = read("../styles/prototype.css");
const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("prototype.css", () => {
  it("is part of the stylesheet entry", () => {
    expect(read("../styles/index.css")).toContain('@import "./prototype.css";');
  });

  it("takes every color from tokens, so both themes style it", () => {
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(|\bhsla?\(/);
  });

  it("moves boxes with the layout duration token, so reduced motion makes it instant", () => {
    const timed = body.match(/\b(?:transition|animation):[^;]*;/g) ?? [];
    expect(timed.length).toBeGreaterThan(0);
    for (const t of timed) expect(t).not.toMatch(/\d+m?s\b/);
    expect(body).toMatch(/\.gi-proto__node \{[^}]*transform var\(--duration-layout\)/);
    expect(body).toMatch(
      /\.gi-proto__node\[data-inner\] \{\s*animation: gi-proto-emerge var\(--duration-layout\)/,
    );
  });

  it("layers the open frame under the edges, and boxes and labels over them", () => {
    const z = (selector: string) =>
      new RegExp(`${selector.replace(/[.[\]>]/g, "\\$&")} \\{[^}]*z-index: (\\d)`).exec(body)?.[1];
    expect(z(".gi-proto__node[data-open]")).toBe("0");
    expect(z(".gi-proto__edges")).toBe("1");
    expect(z(".gi-proto__node")).toBe("2");
    expect(z(".gi-proto__stage > .gi-edge-label")).toBe("3");
  });
});
