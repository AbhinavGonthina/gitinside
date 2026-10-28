import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import "@gitinside/viewer/fonts";
import "@gitinside/viewer/styles.css";
import "./globals.css";
import { parseTheme, THEME_COOKIE } from "../lib/theme";
import { SiteHeader } from "./SiteHeader";

export const metadata: Metadata = {
  title: { default: "GitInside: Git inside your repo.", template: "%s · GitInside" },
  description:
    "Paste a GitHub repo and get an interactive system design diagram built by parsing the code, never guessed.",
};

export const viewport: Viewport = {
  colorScheme: "dark light",
};

/**
 * The page root. `<html>` itself is the viewer's themed root (`.gi-root` with
 * `data-theme`), so the whole page, scrollbars included, uses the same tokens
 * as the diagram, and the theme comes from the cookie on the server: no flash
 * and no inline script.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" className="gi-root" data-theme={theme}>
      <body>
        <SiteHeader theme={theme} />
        {children}
      </body>
    </html>
  );
}
