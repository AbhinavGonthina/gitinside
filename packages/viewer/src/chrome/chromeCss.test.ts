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

  it("brings overlays in at the standard duration and takes them out faster, inert (M4b.0e)", () => {
    const rule = (selector: string) =>
      new RegExp(`(?:^|\\n)${selector.replace(/[.[\]"=*]/g, "\\$&")} \\{([^}]*)\\}`).exec(
        body,
      )?.[1] ?? "";
    for (const enter of [".gi-popover", ".gi-palette-scrim", ".gi-palette", ".gi-status"]) {
      expect(rule(enter)).toMatch(
        /animation: gi-[a-z-]+-in var\(--duration-standard\) var\(--ease-standard\)/,
      );
    }
    for (const exit of [
      '.gi-popover[data-state="closing"]',
      '.gi-palette-scrim[data-state="closing"]',
    ]) {
      expect(rule(exit)).toMatch(
        /animation: gi-fade-out var\(--duration-fast\) var\(--ease-exit\)/,
      );
      expect(rule(exit)).toContain("pointer-events: none;");
    }
    expect(rule(".gi-inspector > *")).toMatch(/animation: gi-swap-in var\(--duration-standard\)/);
  });

  it("moves overlays without AI-looking defaults: no scale, blur, or bounce (ADR-0104)", () => {
    const keyframes = body.match(/@keyframes gi-[a-z-]+ \{[\s\S]*?\n\}/g) ?? [];
    expect(keyframes.length).toBeGreaterThan(4);
    for (const k of keyframes) {
      expect(k).not.toMatch(/\bscale\b|blur\(|rotate/);
      // Movement stays a few pixels: a nudge, not a slide.
      for (const [, px] of k.matchAll(/translate: 0 (-?\d+)px/g)) {
        expect(Math.abs(Number(px))).toBeLessThanOrEqual(6);
      }
    }
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
