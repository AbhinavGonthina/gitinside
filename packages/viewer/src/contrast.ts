/**
 * WCAG 2.2 contrast helpers. The token tests use them to hold both themes to
 * AA, and the icon system (M4a.3) uses them to pick a monochrome logo when a
 * brand color fails against its tile.
 */

/**
 * Relative luminance of a `#RRGGBB` color (WCAG 2.2, "relative luminance").
 * Throws on anything else, so a typo in a token can't silently score 0.
 */
export function relativeLuminance(hex: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`Expected a #RRGGBB color, got ${JSON.stringify(hex)}`);
  }
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast ratio between two `#RRGGBB` colors, from 1 (identical) to 21
 * (black on white). Order doesn't matter. AA needs 4.5 for body text and 3
 * for large text and essential graphics (WCAG 1.4.3, 1.4.11).
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
