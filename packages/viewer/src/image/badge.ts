import { markMarkup } from "../mark.js";
import { themeTokens } from "../tokens.js";
import { attrs, esc, num, textWidth } from "./markup.js";

/**
 * The README badge (SPEC §3 F1, M5.9): a 20px pill in the shape readers know
 * from shields.io, "GitInside" on the left and a short message on the right.
 *
 * - **One look on both GitHub themes:** a badge sits on white and on near-black
 *   pages alike, so it doesn't follow `prefers-color-scheme`. It takes the
 *   dark theme's raised surface and text on the left, and the accent (or
 *   muted text, for states that aren't a diagram) on the right with canvas
 *   text; every pair clears 4.5:1 (tested).
 * - **Text fits whatever font the reader has:** widths are estimated and the
 *   text is drawn with `textLength`, so it is squeezed or spread to exactly
 *   that width instead of overflowing.
 * - **The message is the caller's** (lib code in apps/web picks it from the
 *   repo's state); it is escaped here like any other text.
 */

/** Badge colors on the right: `accent` for a diagram, `muted` for everything else. */
export type BadgeTone = "accent" | "muted";

/** What the badge says. */
export interface BadgeOptions {
  /** The right-hand text, e.g. "3 services · 2 datastores" or "view diagram". */
  message: string;
  /** Default `accent`. */
  tone?: BadgeTone;
}

const dark = themeTokens.dark;

/** The badge's colors, exported for the contrast test. */
export const BADGE_COLORS = {
  label: { fill: dark["surface-raised"], text: dark.text, mark: dark.accent },
  accent: { fill: dark.accent, text: dark.canvas },
  muted: { fill: dark["text-muted"], text: dark.canvas },
} as const;

/** Height of the badge, in px. */
export const BADGE_HEIGHT = 20;
const FONT_SIZE = 11;
const PAD = 6;
const MARK = 12;
const MARK_GAP = 4;
const LABEL = "GitInside";
/** Longest message drawn; longer ones are cut (the caller's messages are short). */
const MAX_MESSAGE = 48;

const FONT = 'Geist, "Geist Variable", -apple-system, "Segoe UI", Verdana, sans-serif';

/** The badge as a standalone SVG document. */
export function renderBadge({ message, tone = "accent" }: BadgeOptions): string {
  const chars = [...message];
  const text =
    chars.length > MAX_MESSAGE ? `${chars.slice(0, MAX_MESSAGE - 1).join("")}…` : message;
  const labelText = Math.ceil(textWidth(LABEL, FONT_SIZE));
  const messageText = Math.ceil(textWidth(text, FONT_SIZE));
  const left = PAD + MARK + MARK_GAP + labelText + PAD;
  const right = PAD + messageText + PAD;
  const width = left + right;
  const colors = BADGE_COLORS[tone];
  const label = BADGE_COLORS.label;
  const baseline = 14;
  const markY = (BADGE_HEIGHT - MARK) / 2;
  const s = MARK / 24;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg"${attrs({
      width,
      height: BADGE_HEIGHT,
      viewBox: `0 0 ${width} ${BADGE_HEIGHT}`,
      role: "img",
      "aria-label": `GitInside: ${text}`,
    })}>`,
    `<title>${esc(`GitInside: ${text}`)}</title>`,
    `<clipPath id="r"><rect width="${width}" height="${BADGE_HEIGHT}" rx="4"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${left}" height="${BADGE_HEIGHT}" fill="${label.fill}"/>`,
    `<rect x="${left}" width="${right}" height="${BADGE_HEIGHT}" fill="${colors.fill}"/>`,
    `</g>`,
    // The logo mark (mark.ts) on its 24px grid, scaled down.
    `<g transform="translate(${PAD} ${num(markY)}) scale(${num(s)})">`,
    markMarkup({ frame: label.text, node: label.mark, size: MARK }),
    `</g>`,
    `<g font-family="${esc(FONT)}" font-size="${FONT_SIZE}" font-weight="600">`,
    `<text x="${PAD + MARK + MARK_GAP}" y="${baseline}" fill="${label.text}" textLength="${labelText}" lengthAdjust="spacingAndGlyphs">${LABEL}</text>`,
    `<text x="${left + PAD}" y="${baseline}" fill="${colors.text}" textLength="${messageText}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
