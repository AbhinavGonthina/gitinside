// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const css = read("../styles/explorer.css");
const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("explorer.css", () => {
  it("is part of the stylesheet entry, after the canvas it adjusts", () => {
    const entry = read("../styles/index.css");
    expect(entry).toContain('@import "./explorer.css";');
    expect(entry.indexOf("explorer.css")).toBeGreaterThan(entry.indexOf("drill.css"));
  });

  it("takes every color from tokens, so both themes style it", () => {
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(|\bhsla?\(/);
  });

  it("moves a refit with the layout duration token, but not the first fit on load", () => {
    const timed = body.match(/\b(?:transition|animation):[^;]*;/g) ?? [];
    expect(timed.length).toBeGreaterThan(0);
    for (const t of timed) expect(t).not.toMatch(/\d+m?s\b/);
    expect(body).toMatch(/\.gi-explorer__drill \{[^}]*transform-origin: 0 0;/);
    expect(body).toMatch(
      /\.gi-explorer\[data-settled\] \.gi-explorer__drill \{\s*transition: transform var\(--duration-layout\)/,
    );
    expect(body).toMatch(
      /\.gi-explorer\[data-settled\] \.gi-explorer__fit \{[^}]*width var\(--duration-layout\)/,
    );
    // Unsettled, nothing on the fit moves.
    expect(body).not.toMatch(/^\.gi-explorer__(?:fit|drill) \{[^}]*transition/m);
  });

  it("never sets text in the trace color, which is only 3:1 in light (M4a review)", () => {
    // --trace meets the 3:1 graphics bar, not the 4.5:1 text bar, so the current
    // step is marked with a bar and its text stays --text.
    for (const rule of body.match(/\{[^}]*\}/g) ?? []) {
      expect(rule).not.toMatch(/(?:^|[\s;{])color:[^;]*var\(--trace\)/);
    }
    expect(body).toMatch(/aria-current="step"\] \{[^}]*box-shadow: inset 3px 0 0 var\(--trace\)/);
  });
});
