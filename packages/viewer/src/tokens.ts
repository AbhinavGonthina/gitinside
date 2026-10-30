import type { Theme } from "./ViewerRoot.js";

/**
 * Design tokens (DESIGN_SYSTEM.md §4). `styles/tokens.css` turns these into
 * CSS custom properties on `.gi-root`, and `tokens.test.ts` checks that the
 * stylesheet and this module agree value for value, so components style with
 * `var(--…)` while canvas code (layout, export, minimap) reads the same values
 * from here.
 */

/** Names of the tokens whose values differ between dark and light. */
export type ThemeTokenName =
  | "canvas"
  | "surface-1"
  | "surface-2"
  | "surface-raised"
  | "border"
  | "text"
  | "text-muted"
  | "accent"
  | "layer-frontend"
  | "layer-backend"
  | "layer-data"
  | "layer-infra"
  | "layer-external"
  | "trace"
  | "diff-added"
  | "diff-changed"
  | "diff-removed"
  | "scrim"
  | "shadow-2"
  | "shadow-3"
  | "syntax-keyword"
  | "syntax-string"
  | "syntax-function"
  | "syntax-type"
  | "syntax-constant";

/**
 * Per-theme values. Colors are lowercase `#rrggbb` (Prettier's CSS spelling,
 * so the stylesheet can match) and can be contrast-checked;
 * `scrim` and the shadows are the only translucent values.
 *
 * Contrast (checked in tests, both themes, on the canvas and every surface):
 * `text` and `text-muted` are at least 4.5:1, so they work for any text.
 * `accent`, the layers, `trace`, and the diff colors are at least 3:1, so
 * they work for strokes, rings, icons, and focus, but not for small text.
 * The `syntax-*` colors are for the code preview only: at least 4.5:1 on the
 * canvas (its background) and on the selected line's accent tint.
 */
export const themeTokens: Record<Theme, Record<ThemeTokenName, string>> = {
  dark: {
    canvas: "#0b0e14",
    "surface-1": "#12161f",
    "surface-2": "#181e2a",
    // Popovers and the palette (elevation 2–3). Shadows barely show on a
    // near-black canvas, so on dark the raised fill does most of the lifting.
    "surface-raised": "#1c2332",
    border: "#252c3a",
    text: "#e8ecf4",
    "text-muted": "#8e97ab",
    accent: "#8db0ff",
    "layer-frontend": "#79a6ff",
    "layer-backend": "#b794f6",
    "layer-data": "#34d3a6",
    "layer-infra": "#f0a35e",
    "layer-external": "#f38bc4",
    trace: "#ffd37a",
    "diff-added": "#4ade80",
    "diff-changed": "#f5c451",
    "diff-removed": "#ff6b6b",
    scrim: "rgba(5, 7, 11, 0.6)",
    "shadow-2": "0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.45)",
    "shadow-3": "0 2px 6px rgba(0, 0, 0, 0.4), 0 24px 64px rgba(0, 0, 0, 0.6)",
    "syntax-keyword": "#c2a3f7",
    "syntax-string": "#6ad8b0",
    "syntax-function": "#8fb6ff",
    "syntax-type": "#f5a3cf",
    "syntax-constant": "#f2b27a",
  },
  // Tuned for the cool off-white canvas, not inverted: hues stay, lightness
  // drops until each color clears its AA bar on every light surface.
  light: {
    canvas: "#f5f7fa",
    "surface-1": "#ffffff",
    "surface-2": "#edf0f5",
    "surface-raised": "#ffffff",
    border: "#d9dee7",
    text: "#121722",
    "text-muted": "#556073",
    accent: "#2f5fd0",
    "layer-frontend": "#2e6be6",
    "layer-backend": "#7a4fd1",
    "layer-data": "#0e8a6a",
    "layer-infra": "#b8641c",
    "layer-external": "#c0418a",
    trace: "#a66f00",
    "diff-added": "#1e8e4e",
    "diff-changed": "#a87700",
    "diff-removed": "#d23b3b",
    scrim: "rgba(18, 23, 34, 0.32)",
    "shadow-2": "0 1px 2px rgba(18, 23, 34, 0.06), 0 8px 24px rgba(18, 23, 34, 0.1)",
    "shadow-3": "0 2px 6px rgba(18, 23, 34, 0.08), 0 24px 64px rgba(18, 23, 34, 0.18)",
    "syntax-keyword": "#6b3fc4",
    "syntax-string": "#0a6f54",
    "syntax-function": "#2459c9",
    "syntax-type": "#a8336f",
    "syntax-constant": "#95500f",
  },
};

/** Motion durations in milliseconds, for JS-driven animation (layout glides, trace hops). */
export const durations = {
  fast: 120,
  standard: 240,
  layout: 600,
  "trace-hop": 900,
} as const;

/**
 * Tokens shared by both themes: type, spacing, radius, and motion. Under
 * `prefers-reduced-motion: reduce` the stylesheet sets every duration to 0ms;
 * JS animation must check the same media query (UX.md).
 */
export const scaleTokens = {
  "font-sans": '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  "font-mono": '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  "font-size-12": "12px",
  "font-size-13": "13px",
  "font-size-14": "14px",
  "font-size-16": "16px",
  "font-size-20": "20px",
  "font-size-28": "28px",
  "font-weight-regular": "400",
  "font-weight-medium": "500",
  "font-weight-semibold": "600",
  "line-height-tight": "1.25",
  "line-height-body": "1.5",
  "space-4": "4px",
  "space-8": "8px",
  "space-12": "12px",
  "space-16": "16px",
  "space-24": "24px",
  "space-32": "32px",
  "space-48": "48px",
  "radius-service": "16px",
  "radius-module": "12px",
  "radius-card": "10px",
  "radius-tile": "12px",
  "radius-chip": "6px",
  "radius-pill": "9999px",
  "duration-fast": `${durations.fast}ms`,
  "duration-standard": `${durations.standard}ms`,
  "duration-layout": `${durations.layout}ms`,
  "duration-trace-hop": `${durations["trace-hop"]}ms`,
  "ease-standard": "cubic-bezier(0.2, 0, 0, 1)",
  "ease-layout": "cubic-bezier(0.65, 0, 0.35, 1)",
  "ease-exit": "cubic-bezier(0.4, 0, 1, 1)",
} as const;

/** Names of the theme-independent tokens. */
export type ScaleTokenName = keyof typeof scaleTokens;

/** `var(--name)` for a token, so components can't misspell a token name. */
export function cssVar(name: ThemeTokenName | ScaleTokenName): string {
  return `var(--${name})`;
}
