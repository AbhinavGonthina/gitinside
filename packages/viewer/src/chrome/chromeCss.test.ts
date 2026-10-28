// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const css = read("../styles/chrome.css");
const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("chrome.css", () => {
  it("is part of the stylesheet entry", () => {
    expect(read("../styles/index.css")).toContain('@import "./chrome.css";');
  });

  it("takes every color from tokens, so both themes style it", () => {
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(|\bhsla?\(/);
  });

  it("animates only with the duration tokens, so reduced motion makes it instant", () => {
    const timed = body.match(/\b(?:transition|animation):[^;]*;/g) ?? [];
    expect(timed.length).toBeGreaterThan(0);
    for (const t of timed) expect(t).not.toMatch(/\d+m?s\b/);
  });

  it("stops the trace status pulse under reduced motion", () => {
    const reduced = body.slice(body.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(
      /\.gi-status\[data-tone="trace"\] \.gi-status__dot \{\s*animation: none;/,
    );
  });

  it("styles each button variant and the palette's active result", () => {
    for (const v of ["primary", "secondary", "quiet"]) {
      expect(css).toContain(`.gi-button[data-variant="${v}"]`);
    }
    expect(css).toContain('.gi-palette__result[aria-selected="true"]');
    expect(css).toContain('.gi-toggle[aria-checked="true"]');
    expect(css).toContain('.gi-segmented__option[aria-checked="true"]');
  });
});
