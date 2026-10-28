import type { Theme } from "@gitinside/viewer";

/**
 * The visitor's theme choice, kept in a cookie so the server renders the
 * right `data-theme` on `<html>` and the page never flashes the wrong theme
 * (and needs no inline script, which the CSP would have to allow).
 */

/** Cookie name for the theme choice. */
export const THEME_COOKIE = "gi-theme";

/** Dark first (DESIGN_SYSTEM.md §1): anything but an explicit "light" is dark. */
export function parseTheme(value: string | undefined): Theme {
  return value === "light" ? "light" : "dark";
}

/** The `document.cookie` assignment that remembers `theme` for a year, site-wide. */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}
