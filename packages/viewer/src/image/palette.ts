import type { Layer } from "@gitinside/schema";
import { brandFill, type Brand } from "../icons/brands.js";
import { themeTokens } from "../tokens.js";
import type { Theme } from "../ViewerRoot.js";

/**
 * Colors for the README images (M5.9), from the same tokens as the canvas
 * (DESIGN_SYSTEM.md §4). The canvas mixes colors with CSS `color-mix`; image
 * renderers (GitHub's proxy hands the SVG to the reader's browser, but other
 * viewers vary) may not, so the mixes are worked out here as plain hex.
 */

/** Which colors an image uses: one theme, or `auto` (the reader's `prefers-color-scheme`, dark first). */
export type ImageTheme = Theme | "auto";

/** The layers, in column order. */
export const LAYERS: readonly Layer[] = ["frontend", "backend", "data", "infra", "external"];

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * `color-mix(in srgb, a p%, b)` as `#rrggbb`: each channel `p` of the way
 * from `b` to `a`, rounded. Both colors are `#rrggbb`.
 */
export function mix(a: string, percent: number, b: string): string {
  const ca = channels(a);
  const cb = channels(b);
  const t = percent / 100;
  return `#${ca
    .map((c, i) => Math.round(c * t + (cb[i] as number) * (1 - t)))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** The custom properties an image's markup refers to, as `name → value` for one theme. */
export function imageColors(theme: Theme, brands: readonly Brand[]): Record<string, string> {
  const t = themeTokens[theme];
  const out: Record<string, string> = {
    canvas: t.canvas,
    s1: t["surface-1"],
    s2: t["surface-2"],
    border: t.border,
    text: t.text,
    muted: t["text-muted"],
    accent: t.accent,
  };
  for (const layer of LAYERS) {
    const color = t[`layer-${layer}`];
    // The same mixes as nodes.css (closed frame), icons.css (tile ring), and edges.css (line).
    out[`frame-${layer}`] = mix(color, 10, t["surface-1"]);
    // A window's title band: 22% of the layer over the closed frame's fill.
    out[`band-${layer}`] = mix(color, 22, mix(color, 10, t["surface-1"]));
    out[`lip-${layer}`] = mix(color, 5, t["surface-1"]);
    out[`frame-border-${layer}`] = mix(color, 45, t.border);
    out[`ring-${layer}`] = mix(color, 60, t.border);
    out[`edge-${layer}`] = mix(color, 70, t["text-muted"]);
  }
  for (const brand of brands) {
    const fill = brandFill(brand, theme);
    out[`brand-${brand.slug}`] = fill.startsWith("#") ? fill : t.text;
  }
  return out;
}

function declarations(colors: Record<string, string>): string {
  return Object.entries(colors)
    .map(([name, value]) => `--${name}:${value}`)
    .join(";");
}

/**
 * The `<style>` body that defines every color on `.gi` (the image's root):
 * one theme, or dark with a light override under `prefers-color-scheme: light`.
 */
export function paletteCss(theme: ImageTheme, brands: readonly Brand[]): string {
  if (theme !== "auto") return `.gi{${declarations(imageColors(theme, brands))}}`;
  return (
    `.gi{${declarations(imageColors("dark", brands))}}` +
    `@media (prefers-color-scheme: light){.gi{${declarations(imageColors("light", brands))}}}`
  );
}

/** `var(--name)`, for the markup. */
export function v(name: string): string {
  return `var(--${name})`;
}
