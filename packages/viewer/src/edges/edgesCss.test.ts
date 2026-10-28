// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../contrast.js";
import { themeTokens, type ThemeTokenName } from "../tokens.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const css = read("../styles/edges.css");
const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** `color-mix(in srgb, a p%, b)` on #RRGGBB colors, as the browser computes it. */
function mix(a: string, b: string, p: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(channel(a, i) * p + channel(b, i) * (1 - p))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

describe("edges.css", () => {
  it("is part of the stylesheet entry", () => {
    expect(read("../styles/index.css")).toContain('@import "./edges.css";');
  });

  it("takes every color from tokens, so both themes style it", () => {
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(|\bhsla?\(/);
  });

  it("animates only with the duration tokens, so reduced motion makes it instant", () => {
    const timed = body.match(/(?:transition|animation):[^;]*;/g) ?? [];
    expect(timed.length).toBeGreaterThan(0);
    for (const t of timed) expect(t).not.toMatch(/\d+m?s\b/);
  });

  it("turns off flow particles and the broken pulse under reduced motion", () => {
    const reduced = body.slice(body.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.gi-edge__particle\s*\{\s*display: none;/);
    expect(reduced).toMatch(/\[data-broken\] \.gi-edge__line\s*\{\s*animation: none;/);
  });

  it.each([
    ["solid", false],
    ["dashed", true],
    ["dotted", true],
  ] as const)("gives the %s line style its dashes", (style, dashed) => {
    expect(body.includes(`[data-line="${style}"] .gi-edge__line`)).toBe(dashed);
  });

  it.each([
    "data-hover",
    "data-selected",
    "data-broken",
    'data-emphasis="dimmed"',
    'data-emphasis="traced"',
    'data-diff="added"',
    'data-diff="changed"',
    'data-diff="removed"',
  ])("styles the %s state on the line and the label", (attr) => {
    const escaped = attr.replace(/[[\]"]/g, "\\$&");
    expect(body).toMatch(new RegExp(`^\\.gi-edge(?!-)[^{\\n]*\\[${escaped}\\]`, "m"));
    expect(body).toMatch(new RegExp(`^\\.gi-edge-label[^{\\n]*\\[${escaped}\\]`, "m"));
  });

  // WCAG 1.4.11: edges are essential graphics, so the resting line must
  // reach 3:1 on the canvas and every surface it can cross, for every layer.
  const restMix =
    /--gi-edge-color: color-mix\(in srgb, var\(--gi-layer\) (\d+)%, var\(--text-muted\)\);/;

  it("mixes the resting line from the layer and muted text", () => {
    expect(body).toMatch(restMix);
  });

  const percent = Number(restMix.exec(body)?.[1] ?? "0") / 100;
  const layers = ["frontend", "backend", "data", "infra", "external"] as const;
  const grounds: ThemeTokenName[] = ["canvas", "surface-1", "surface-2"];
  describe.each(["dark", "light"] as const)("in the %s theme", (theme) => {
    const t = themeTokens[theme];
    it.each(layers)("keeps a %s edge at 3:1 or more", (layer) => {
      const stroke = mix(t[`layer-${layer}`], t["text-muted"], percent);
      for (const ground of grounds) {
        expect(contrastRatio(stroke, t[ground])).toBeGreaterThanOrEqual(3);
      }
    });
  });
});
