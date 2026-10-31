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

  it("moves the camera with duration tokens, by kind of move, but not the first fit on load", () => {
    const timed = body.match(/\b(?:transition|animation):[^;]*;/g) ?? [];
    expect(timed.length).toBeGreaterThan(0);
    for (const t of timed) expect(t).not.toMatch(/\d+m?s\b/);
    expect(body).toMatch(/\.gi-explorer__drill \{[^}]*transform-origin: 0 0;/);
    expect(body).toMatch(
      /\.gi-explorer\[data-settled\] \.gi-explorer__drill\[data-camera-motion="layout"\] \{\s*transition: transform var\(--duration-layout\) var\(--ease-layout\)/,
    );
    expect(body).toMatch(
      /\.gi-explorer\[data-settled\] \.gi-explorer__drill\[data-camera-motion="standard"\] \{\s*transition: transform var\(--duration-standard\) var\(--ease-standard\)/,
    );
    // Unsettled, or moved by the pointer ("none"), the camera doesn't glide.
    expect(body).not.toMatch(/^\.gi-explorer__drill \{[^}]*transition/m);
    expect(body).not.toMatch(/data-camera-motion="none"/);
  });

  it("pans the canvas instead of the page or a text selection", () => {
    expect(body).toMatch(/\.gi-explorer__canvas \{[^}]*touch-action: none;[^}]*user-select: none;/);
    expect(body).toMatch(/\.gi-explorer__canvas\[data-panning\] \{\s*cursor: grabbing;/);
  });

  it("wraps a trace step's title instead of cutting it at the inspector's edge (M4b.6a)", () => {
    // The node header's h2 is one clipped line; a step title is a sentence.
    expect(body).toMatch(
      /\.gi-inspector__title h2\.gi-explorer__hop \{[^}]*overflow: visible;[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/,
    );
  });

  it("brings a hint in without a fill and fades it out faster, like the other overlays (M4b.12a)", () => {
    // An entrance with `both` stays in effect after it ends and moved Linux baselines (M4b.0e).
    expect(body).toMatch(
      /\.gi-hint \{[^}]*animation: gi-rise-in var\(--duration-standard\) var\(--ease-standard\);/,
    );
    expect(body).toMatch(
      /\.gi-hint\[data-state="closing"\] \{[^}]*animation: gi-fade-out var\(--duration-fast\) var\(--ease-exit\) both;[^}]*pointer-events: none;/,
    );
    expect(body).toMatch(
      /\.gi-hint__body \{[^}]*animation: gi-swap-in var\(--duration-standard\)[^;]*;/,
    );
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
